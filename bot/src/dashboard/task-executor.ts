/**
 * Task Executor - 任务执行引擎 v2
 *
 * 修复问题:
 * 1. 价格守护流程卡死 - 使用 AbortSignal 控制 Promise
 * 2. 增量对冲 - 部分成交时立即触发对冲
 * 3. 对冲部分成交计算 - 累加 hedgedQty，正确计算加权均价
 * 4. UNWIND 实现 - 对冲失败后反向平仓
 * 5. SELL 价格守护 - 对称风控
 * 6. isInverted 执行逻辑 - 根据 inverted 选择对冲 token
 * 7. 正确的盈亏计算
 */

import { EventEmitter } from 'events';
import { Task, TaskStatus } from './types.js';
import { getTaskService, TaskService } from './task-service.js';
import { getPredictTrader, PredictTrader, PredictOrderInput } from './predict-trader.js';
import { getPolymarketTrader, PolymarketTrader, PolyOrderInput } from './polymarket-trader.js';
import { getOrderMonitor, OrderMonitor, OrderWatchResult } from './order-monitor.js';
import { getTaskLogger, TaskLogger, TaskConfigSnapshot, ArbOpportunitySnapshot, SnapshotTrigger } from './task-logger/index.js';
import { initTakerExecutor, TakerExecutor, TakerExecutorDeps } from './taker-mode/index.js';
import { getBscOrderWatcher, getSharesFromFillEvent, type BscOrderWatcher, type OrderFilledEvent } from '../services/bsc-order-watcher.js';
import type { PolymarketWebSocketClient } from '../polymarket/ws-client.js';

// ============================================================================
// 常量
// ============================================================================

const MAX_PAUSE_COUNT = 5;          // 最大价格守护暂停次数
const HEDGE_TIMEOUT_MS = 30000;     // 对冲超时
const PREDICT_POLL_INTERVAL = 500;  // Predict 轮询间隔
const UNWIND_MAX_RETRIES = 3;       // 反向平仓最大重试
const MIN_HEDGE_QTY = 1;            // 最小对冲数量阈值 (shares)，低于此值跳过对冲
const POLY_WS_STALE_MS = 15000;

// Polymarket 成交状态可能有延迟：关键决策前做一次短暂再确认，降低误判导致的重复对冲/误触发 UNWIND
const POLY_FILL_RECHECK_MAX_RETRIES = Number(process.env.POLY_FILL_RECHECK_MAX_RETRIES) || 6;   // 6 * 400ms = 2.4s
const POLY_FILL_RECHECK_INTERVAL_MS = Number(process.env.POLY_FILL_RECHECK_INTERVAL_MS) || 400;

// ============================================================================
// 类型
// ============================================================================

interface PolyOrderFillTracker {
    filledQty: number;
    avgPrice: number;
    lastCheckedAt: number;
}

interface TaskContext {
    task: Task;
    signal: AbortSignal;
    abortController: AbortController;
    // 价格守护控制
    priceGuardAbort?: AbortController;
    predictWatchAbort?: AbortController;
    isPaused: boolean;
    currentOrderHash?: string;
    // 增量对冲跟踪
    totalPredictFilled: number;
    totalHedged: number;
    hedgePriceSum: number;  // 用于计算加权均价

    // 仅追踪本次进程内发出的 Poly 订单，用于处理"迟到成交/状态延迟"导致的漏记和误触发
    polyOrderFills: Map<string, PolyOrderFillTracker>;

    // ====== WSS-first 成交追踪 (与 TakerExecutor 对齐) ======
    /** WSS 累计成交量 (BSC 链上事件增量累加) */
    wssFilledQty: number;
    /** WSS 成交事件去重集合 key: `${txHash}:${logIndex}` */
    wssFillEvents: Set<string>;
    /** REST API 返回的累计成交量 */
    restFilledQty: number;
    /** WSS 首次成交时间戳 */
    wssFirstFillTime?: number;
}

// ============================================================================
// TaskExecutor 类
// ============================================================================

export class TaskExecutor extends EventEmitter {
    private taskService: TaskService;
    private predictTrader: PredictTrader;
    private polyTrader: PolymarketTrader;
    private polyWsClient: PolymarketWebSocketClient | null = null;
    private orderMonitor: OrderMonitor;
    private taskLogger: TaskLogger;
    private takerExecutor!: TakerExecutor;  // 延迟初始化
    private runningTasks: Map<string, TaskContext> = new Map();
    private initialized = false;
    private expiryCheckInterval?: ReturnType<typeof setInterval>;
    private shuttingDown = false;
    private pausing = false;

    constructor() {
        super();
        this.taskService = getTaskService();
        this.predictTrader = getPredictTrader();
        this.polyTrader = getPolymarketTrader();
        this.orderMonitor = getOrderMonitor();
        this.taskLogger = getTaskLogger();
    }

    /**
     * 初始化
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        await this.predictTrader.init();
        await this.polyTrader.init();

        // 初始化 TakerExecutor
        const takerDeps: TakerExecutorDeps = {
            predictTrader: this.predictTrader,
            polyTrader: this.polyTrader,
            polyWsClient: this.polyWsClient ?? undefined,
            taskLogger: this.taskLogger,
            updateTask: this.updateTask.bind(this),
            getTask: (taskId: string) => this.taskService.getTask(taskId) ?? undefined,
        };
        this.takerExecutor = initTakerExecutor(takerDeps);

        this.initialized = true;
        console.log('[TaskExecutor] Initialized');

        // 启动任务过期检查定时器 (每 30 秒检查一次)
        this.expiryCheckInterval = setInterval(() => this.checkExpiredTasks(), 30_000);

        // 自动恢复中间状态的任务
        await this.autoRecoverTasks();
    }

    /**
     * 由启动入口注入 Polymarket WS 客户端（避免模块循环依赖）
     */
    setPolymarketWsClient(client: PolymarketWebSocketClient | null): void {
        this.polyWsClient = client;
        this.takerExecutor?.setPolymarketWsClient(client);
    }

    /**
     * 检查并取消已过期的任务
     */
    private async checkExpiredTasks(): Promise<void> {
        const now = Date.now();
        const allTasks = this.taskService.getTasks({});

        for (const task of allTasks) {
            // 跳过没有设置过期时间的任务
            if (!task.expiresAt) continue;

            // 跳过已完成/失败/取消的任务
            const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
            if (terminalStatuses.includes(task.status)) continue;

            // 检查是否已过期
            if (now >= task.expiresAt) {
                console.log(`[TaskExecutor] ⏰ 任务 ${task.id} 已过期，正在取消...`);
                await this.cancelExpiredTask(task.id);
            }
        }
    }

    /**
     * 取消过期任务 (取消订单 + 更新状态)
     */
    private async cancelExpiredTask(taskId: string): Promise<void> {
        const task = this.taskService.getTask(taskId);
        if (!task) return;

        const ctx = this.runningTasks.get(taskId);

        // 中止执行
        if (ctx) {
            ctx.abortController.abort();
            ctx.priceGuardAbort?.abort();
            ctx.predictWatchAbort?.abort();
        }

        // 取消 Predict 订单
        const orderHashToCancel = task.currentOrderHash || ctx?.currentOrderHash;
        if (orderHashToCancel) {
            try {
                console.log(`[TaskExecutor] ⏰ 取消过期任务订单: ${orderHashToCancel.slice(0, 20)}...`);
                await this.predictTrader.cancelOrder(orderHashToCancel);
            } catch (e: any) {
                console.warn(`[TaskExecutor] ⚠️ 取消订单出错: ${e.message}`);
            }
        }

        // 清理运行上下文
        this.runningTasks.delete(taskId);

        // 记录日志
        await this.taskLogger.logTaskLifecycle(taskId, 'TASK_CANCELLED', {
            status: 'CANCELLED',
            reason: `Task expired (expiresAt: ${task.expiresAt})`,
        });

        // 更新状态
        this.updateTask(taskId, {
            status: 'CANCELLED',
            cancelReason: 'ORDER_TIMEOUT',
            currentOrderHash: undefined,
        });

        console.log(`[TaskExecutor] ⏰ 任务 ${taskId} 已因过期取消`);
    }

    /**
     * 自动恢复中间状态的任务
     * 在 Dashboard 重启后，恢复那些正在执行中的任务
     */
    private async autoRecoverTasks(): Promise<void> {
        // 需要自动恢复的状态（任务正在执行中被中断）
        const recoverableStatuses: TaskStatus[] = [
            'PREDICT_SUBMITTED',  // 订单已提交，等待成交
            'PARTIALLY_FILLED',   // 部分成交，需要继续监控和对冲
            'HEDGING',            // 正在对冲
            'HEDGE_PENDING',      // 对冲等待重试
            'HEDGE_RETRY',        // 对冲重试中
            'UNWINDING',          // 正在平仓
            'UNWIND_PENDING',     // 准备平仓
            'PAUSED',             // 价格守护暂停，检查价格是否已恢复
        ];

        const tasksToRecover = this.taskService.getTasks({
            status: recoverableStatuses,
        });

        if (tasksToRecover.length === 0) {
            return;
        }

        console.log(`[TaskExecutor] 发现 ${tasksToRecover.length} 个需要恢复的任务`);

        for (const task of tasksToRecover) {
            console.log(`[TaskExecutor] 恢复任务: ${task.id} (${task.status})`);
            try {
                // 检查价格有效性（仅对非 UNWINDING 状态的任务）
                if (!['UNWINDING', 'UNWIND_PENDING'].includes(task.status)) {
                    const priceCheck = await this.checkPriceValidity(task);
                    if (!priceCheck.valid) {
                        console.warn(`[TaskExecutor] ⚠️ 任务 ${task.id} 价格无效: ${priceCheck.reason}`);
                        // 记录价格无效
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                            status: 'PAUSED',
                            previousStatus: task.status,
                            reason: `自动恢复时价格无效: ${priceCheck.reason}`,
                        });
                        // 更新任务状态为暂停
                        this.updateTask(task.id, {
                            status: 'PAUSED',
                            pauseCount: (task.pauseCount || 0) + 1,
                            error: `价格无效: ${priceCheck.reason}`,
                        });
                        continue;
                    }
                }

                // 特殊处理：PAUSED 任务在重启后如果价格已恢复，需要立即重挂剩余量的订单
                // 否则会出现：状态 PAUSED 且无 currentOrderHash，但价格守护未触发 onPriceValid（无状态变化），导致任务卡住
                const strategy = task.strategy ?? 'MAKER';
                if (task.status === 'PAUSED' && strategy !== 'TAKER' && !task.currentOrderHash) {
                    await this.resubmitRemainingPredictOrderFromPaused(task);
                }

                // 使用 startTask 而不是 resumeTask，因为 startTask 支持更多状态
                await this.startTask(task.id);
                console.log(`[TaskExecutor] ✅ 任务 ${task.id} 已恢复执行`);
            } catch (error: any) {
                console.error(`[TaskExecutor] ❌ 恢复任务 ${task.id} 失败:`, error.message);
                // 记录恢复失败的日志
                await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                    status: 'FAILED',
                    previousStatus: task.status,
                    reason: `自动恢复失败: ${error.message}`,
                });
                // 更新任务状态为失败
                this.updateTask(task.id, {
                    status: 'FAILED',
                    error: `自动恢复失败: ${error.message}`,
                });
            }
        }
    }

    /**
     * 重启恢复：当任务处于 PAUSED 且价格已恢复时，立即重挂剩余量订单
     * 仅用于 MAKER 模式（TAKER 任务由 takerExecutor 自己处理）
     */
    private async resubmitRemainingPredictOrderFromPaused(task: Task): Promise<void> {
        const remainingQty = (task.quantity || 0) - (task.predictFilledQty || 0);
        if (remainingQty <= 0) {
            console.log(`[TaskExecutor] Task ${task.id}: PAUSED 但无剩余量，跳过重挂`);
            return;
        }

        const side: 'BUY' | 'SELL' = task.type === 'SELL' ? 'SELL' : 'BUY';
        console.log(`[TaskExecutor] Task ${task.id}: PAUSED 自动恢复，重挂剩余量 ${remainingQty} (${side})`);

        // 使用剩余量提交订单（注意：不改变任务的总 quantity，仅在提交时使用 remainingQty）
        const taskWithRemaining = { ...task, quantity: remainingQty };
        const result = await this.submitPredictOrder(taskWithRemaining, side);
        if (!result.success || !result.hash) {
            throw new Error(`Auto resubmit failed: ${result.error || 'Unknown error'}`);
        }

        // 记录订单提交
        await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
            platform: 'predict',
            orderId: result.hash,
            side,
            price: task.predictPrice,
            quantity: remainingQty,
            filledQty: 0,
            remainingQty,
            avgPrice: 0,
        }, result.hash);

        // 记录恢复（与 onPriceValid 的语义一致）
        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
            status: 'PREDICT_SUBMITTED',
            previousStatus: 'PAUSED',
            reason: 'Auto resume from PAUSED on startup',
        });

        // 更新任务状态：恢复为已提交订单
        this.updateTask(task.id, {
            status: 'PREDICT_SUBMITTED',
            currentOrderHash: result.hash,
        });
    }

    /**
     * 检查任务的 Polymarket 价格是否仍然有效
     * BUY: polyAsk < polymarketMaxAsk
     * SELL: polyBid > polymarketMinBid
     */
    private async checkPriceValidity(task: Task): Promise<{ valid: boolean; reason?: string }> {
        try {
            const hedgeTokenId = this.getHedgeTokenId(task);
            const orderbook = await this.getPolymarketOrderbook(hedgeTokenId);

            if (!orderbook) {
                return { valid: false, reason: '无法获取订单簿' };
            }

            if (task.type === 'BUY') {
                // BUY 任务: 检查 polyAsk < polymarketMaxAsk
                const bestAsk = orderbook.asks[0]?.price;
                if (bestAsk === undefined) {
                    return { valid: false, reason: '无可用卖单' };
                }
                if (bestAsk >= task.polymarketMaxAsk) {
                    return {
                        valid: false,
                        reason: `polyAsk(${bestAsk.toFixed(4)}) >= maxAsk(${task.polymarketMaxAsk.toFixed(4)})`,
                    };
                }
            } else {
                // SELL 任务: 检查 polyBid > polymarketMinBid
                const bestBid = orderbook.bids[0]?.price;
                if (bestBid === undefined) {
                    return { valid: false, reason: '无可用买单' };
                }
                if (bestBid <= task.polymarketMinBid) {
                    return {
                        valid: false,
                        reason: `polyBid(${bestBid.toFixed(4)}) <= minBid(${task.polymarketMinBid.toFixed(4)})`,
                    };
                }
            }

            return { valid: true };
        } catch (error: any) {
            return { valid: false, reason: `检查失败: ${error.message}` };
        }
    }

    /**
     * 获取 Polymarket 订单簿
     * WS-only 激进模式：只使用 WS 缓存，不回退到 REST
     * 移除 POLY_WS_STALE_MS 过滤，只要 WS 连接在线缓存就有效
     */
    private async getPolymarketOrderbook(tokenId: string): Promise<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null> {
        const wsClient = this.polyWsClient;
        if (wsClient && wsClient.isConnected()) {
            const wsBook = wsClient.getOrderBook(tokenId);
            if (wsBook && wsBook.bids.length > 0 && wsBook.asks.length > 0) {
                // WS-only 激进模式：移除 POLY_WS_STALE_MS 过滤
                // 只要 WS 连接在线，缓存数据就是有效的
                return {
                    bids: wsBook.bids.map(([price, size]) => ({ price, size })),
                    asks: wsBook.asks.map(([price, size]) => ({ price, size })),
                };
            }
        }

        // WS-only 激进模式：WS miss 直接返回 null，不回退到 REST
        return null;
    }

    // ========================================================================
    // 公共方法
    // ========================================================================

    /**
     * 启动任务执行
     */
    async startTask(taskId: string): Promise<void> {
        const task = this.taskService.getTask(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        // 支持从 PENDING 或可恢复状态启动 (与 resumeTask 保持一致)
        const startableStatuses: TaskStatus[] = [
            'PENDING',
            'PAUSED',
            'PREDICT_SUBMITTED',
            'PARTIALLY_FILLED',
            'HEDGING',
            'HEDGE_PENDING',
        ];
        if (!startableStatuses.includes(task.status)) {
            throw new Error(`Task ${taskId} cannot be started from status: ${task.status}`);
        }

        if (this.runningTasks.has(taskId)) {
            throw new Error(`Task ${taskId} is already running`);
        }

        if (!this.initialized) {
            await this.init();
        }

        // 创建任务上下文 (恢复已有订单和状态)
        const abortController = new AbortController();
        const ctx: TaskContext = {
            task,
            signal: abortController.signal,
            abortController,
            isPaused: false,
            currentOrderHash: task.currentOrderHash, // 恢复已提交的订单 hash
            totalPredictFilled: task.predictFilledQty || 0,
            totalHedged: task.hedgedQty || 0,
            hedgePriceSum: (task.avgPolymarketPrice || 0) * (task.hedgedQty || 0),
            polyOrderFills: new Map(),
            // WSS-first 成交追踪
            wssFilledQty: 0,
            wssFillEvents: new Set<string>(),
            restFilledQty: task.predictFilledQty || 0,
        };
        this.runningTasks.set(taskId, ctx);

        // 初始化日志目录
        await this.taskLogger.initTaskLogDir(taskId);

        // 记录 TASK_STARTED
        await this.taskLogger.logTaskLifecycle(taskId, 'TASK_STARTED', {
            status: task.status,
            taskConfig: this.buildTaskConfigSnapshot(task),
        });

        // 异步执行任务
        this.executeTask(ctx).catch(async error => {
            console.error(`[TaskExecutor] Task ${taskId} failed:`, error);
            // 记录 TASK_FAILED
            await this.taskLogger.logTaskLifecycle(taskId, 'TASK_FAILED', {
                status: 'FAILED',
                error,
            });
            this.updateTask(taskId, {
                status: 'FAILED',
                error: error.message,
            });
        }).finally(() => {
            this.cleanup(ctx);
            this.runningTasks.delete(taskId);
        });
    }

    /**
     * 恢复任务 (从 PAUSED, HEDGING 等状态)
     */
    async resumeTask(taskId: string): Promise<void> {
        const task = this.taskService.getTask(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        const resumableStatuses: TaskStatus[] = [
            'PAUSED',
            'PREDICT_SUBMITTED',
            'PARTIALLY_FILLED',
            'HEDGING',
            'HEDGE_PENDING',
        ];

        if (!resumableStatuses.includes(task.status)) {
            throw new Error(`Task ${taskId} cannot be resumed from status: ${task.status}`);
        }

        // 如果已经在运行，不重复启动
        if (this.runningTasks.has(taskId)) {
            console.log(`[TaskExecutor] Task ${taskId} already running`);
            return;
        }

        console.log(`[TaskExecutor] Resuming task ${taskId} from ${task.status}`);
        await this.startTask(taskId);
    }

    /**
     * 取消任务
     */
    async cancelTask(taskId: string): Promise<void> {
        let task = this.taskService.getTask(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        console.log(`[TaskExecutor] 🛑 取消任务 ${taskId}, 当前状态: ${task.status}`);

        // 获取运行上下文
        const ctx = this.runningTasks.get(taskId);
        if (ctx) {
            // 中止所有操作
            ctx.abortController.abort();
            ctx.priceGuardAbort?.abort();
            ctx.predictWatchAbort?.abort();

            // 等待异步操作有机会完成状态同步
            await this.delay(100);
        }

        // 重新获取最新的 task 对象（可能已被执行器更新）
        task = this.taskService.getTask(taskId)!;

        // 取消相关订单
        // 优先使用 task 中的 orderHash (TAKER 模式通过 updateTask 回调更新)
        // ctx.currentOrderHash 仅作为 fallback (MAKER 模式直接更新 ctx)
        const orderHashToCancel = task.currentOrderHash || ctx?.currentOrderHash;

        console.log(`[TaskExecutor] Cancel order check: task.currentOrderHash=${task.currentOrderHash?.slice(0, 16) || 'none'}, ctx.currentOrderHash=${ctx?.currentOrderHash?.slice(0, 16) || 'none'}`);

        if (orderHashToCancel) {
            console.log(`[TaskExecutor] 取消 Predict 订单: ${orderHashToCancel.slice(0, 20)}...`);
            try {
                const cancelled = await this.predictTrader.cancelOrder(orderHashToCancel);
                if (cancelled) {
                    console.log(`[TaskExecutor] ✅ Predict 订单已取消`);
                } else {
                    console.warn(`[TaskExecutor] ⚠️ Predict 订单取消失败或已不存在`);
                }
            } catch (e: any) {
                console.warn(`[TaskExecutor] ❌ 取消 Predict 订单异常:`, e.message);
            }
        } else {
            console.log(`[TaskExecutor] 无 Predict 订单需要取消`);
        }

        if (task.currentPolyOrderId) {
            console.log(`[TaskExecutor] 取消 Polymarket 订单: ${task.currentPolyOrderId}`);
            try {
                await this.polyTrader.cancelOrder(task.currentPolyOrderId, {
                    marketTitle: task.title,
                    conditionId: task.polymarketConditionId,
                });
                console.log(`[TaskExecutor] ✅ Polymarket 订单已取消`);
            } catch (e: any) {
                console.warn(`[TaskExecutor] ❌ 取消 Polymarket 订单异常:`, e.message);
            }
        }

        // 停止监控
        this.orderMonitor.stopPredictWatch(orderHashToCancel || '');
        this.orderMonitor.stopPolymarketWatch(task.currentPolyOrderId || '');
        this.orderMonitor.stopPriceGuard(this.getHedgeTokenId(task));

        // 记录 TASK_CANCELLED
        await this.taskLogger.logTaskLifecycle(taskId, 'TASK_CANCELLED', {
            status: 'CANCELLED',
            previousStatus: task.status,
            reason: 'User cancelled',
            cancelledOrderHash: orderHashToCancel,
            cancelledPolyOrderId: task.currentPolyOrderId,
        });

        // 更新状态
        this.updateTask(taskId, { status: 'CANCELLED' });
        console.log(`[TaskExecutor] ✅ 任务 ${taskId} 已取消`);
    }

    /**
     * 获取运行中任务数量
     */
    getRunningTaskCount(): number {
        return this.runningTasks.size;
    }

    /**
     * 优雅关闭 - 暂停所有运行中的任务
     * 在 Dashboard 关闭/重启时调用
     */
    async shutdown(options?: { concurrency?: number; timeoutMs?: number }): Promise<void> {
        console.log('[TaskExecutor] shutdown() 开始执行...');
        if (this.shuttingDown) {
            console.log('[TaskExecutor] shutdown() 已在进行中，跳过重复调用');
            return;
        }
        this.shuttingDown = true;

        // 停止过期检查定时器
        if (this.expiryCheckInterval) {
            clearInterval(this.expiryCheckInterval);
            this.expiryCheckInterval = undefined;
            console.log('[TaskExecutor] 已停止过期检查定时器');
        }

        const taskIdsToPause = this.collectTaskIdsToPause();
        await this.pauseTasksInternal(taskIdsToPause, 'Dashboard 关闭/重启', options);
        console.log('[TaskExecutor] 所有任务已暂停，可以安全关闭');
    }

    /**
     * 暂停所有运行中的任务（不停止过期检查）
     */
    async pauseTasks(reason: string, options?: { concurrency?: number; timeoutMs?: number }): Promise<string[]> {
        if (this.pausing) {
            console.log('[TaskExecutor] pauseTasks() 已在进行中，跳过重复调用');
            return [];
        }
        this.pausing = true;

        try {
            const taskIdsToPause = this.collectTaskIdsToPause();
            if (taskIdsToPause.length === 0) {
                console.log('[TaskExecutor] 没有需要暂停/取消挂单的任务');
                return [];
            }

            console.log(`[TaskExecutor] 正在暂停 ${taskIdsToPause.length} 个任务 (reason=${reason})...`);
            const pausedIds: string[] = [];

            // 标记哪些任务原本不是 PAUSED，用于自动恢复
            const preStatuses = new Map<string, TaskStatus>();
            for (const taskId of taskIdsToPause) {
                const task = this.taskService.getTask(taskId);
                if (task) preStatuses.set(taskId, task.status);
            }

            await this.pauseTasksInternal(taskIdsToPause, reason, options);

            for (const taskId of taskIdsToPause) {
                const prev = preStatuses.get(taskId);
                if (prev && prev !== 'PAUSED') {
                    pausedIds.push(taskId);
                }
            }

            return pausedIds;
        } finally {
            this.pausing = false;
        }
    }

    /**
     * 为关闭/断连而暂停单个任务
     */
    private async pauseTaskWithCancel(taskId: string, reason: string): Promise<void> {
        const task = this.taskService.getTask(taskId);
        if (!task) {
            console.log(`[TaskExecutor] 任务 ${taskId} 不存在，跳过`);
            return;
        }

        const ctx = this.runningTasks.get(taskId);

        // 详细日志：显示所有可能的订单 hash 来源
        console.log(`[TaskExecutor] Pause task ${taskId} (reason=${reason}):`);
        console.log(`  - task.currentOrderHash: ${task.currentOrderHash?.slice(0, 20) || '(none)'}`);
        console.log(`  - ctx?.currentOrderHash: ${ctx?.currentOrderHash?.slice(0, 20) || '(none)'}`);
        console.log(`  - task.status: ${task.status}`);

        if (ctx) {
            // 中止所有操作
            console.log(`[TaskExecutor] 中止任务 ${taskId} 的所有控制器...`);
            ctx.abortController.abort();
            ctx.priceGuardAbort?.abort();
            ctx.predictWatchAbort?.abort();
        }

        // 取消 Predict 订单（如果有）- 同时检查 task 和 ctx 中的订单 hash
        const orderHashToCancel = task.currentOrderHash || ctx?.currentOrderHash;
        let shouldClearPredictOrderHash = false;
        if (orderHashToCancel) {
            try {
                console.log(`[TaskExecutor] 🔴 正在取消 Predict 订单: ${orderHashToCancel.slice(0, 20)}...`);
                const startTime = Date.now();

                // 使用 Promise.race 确保有明确的等待行为
                const cancelPromise = this.predictTrader.cancelOrder(orderHashToCancel);
                const timeoutPromise = new Promise<boolean>((resolve) =>
                    setTimeout(() => {
                        console.log(`[TaskExecutor] ⚠️ 取消订单等待超时 (8s)`);
                        resolve(false);
                    }, 8000)
                );

                const cancelled = await Promise.race([cancelPromise, timeoutPromise]);
                const elapsed = Date.now() - startTime;

                if (cancelled) {
                    console.log(`[TaskExecutor] ✅ 已取消 Predict 订单: ${orderHashToCancel.slice(0, 20)}... (耗时 ${elapsed}ms)`);
                    shouldClearPredictOrderHash = true;
                } else {
                    console.log(`[TaskExecutor] ⚠️ 订单可能已成交或已取消: ${orderHashToCancel.slice(0, 20)}... (耗时 ${elapsed}ms)`);
                }
            } catch (e: any) {
                console.warn(`[TaskExecutor] ⚠️ 取消订单时出错: ${e.message}`);
            }
        } else {
            console.log(`[TaskExecutor] ⚠️ 没有找到需要取消的订单 (task 和 ctx 中都没有 orderHash)`);
        }

        // 取消 Polymarket 订单（如果有）
        const polyOrderIdToCancel = task.currentPolyOrderId;
        let shouldClearPolyOrderId = false;
        if (polyOrderIdToCancel) {
            try {
                console.log(`[TaskExecutor] 🔴 正在取消 Polymarket 订单: ${polyOrderIdToCancel.slice(0, 10)}...`);
                const cancelled = await this.polyTrader.cancelOrder(polyOrderIdToCancel, {
                    timeoutMs: 5000,
                    skipTelegram: true,
                });
                if (cancelled) {
                    console.log(`[TaskExecutor] ✅ Polymarket 订单已取消`);
                    shouldClearPolyOrderId = true;
                } else {
                    console.warn(`[TaskExecutor] ⚠️ Polymarket 订单取消失败或已不存在`);
                }
            } catch (e: any) {
                console.warn(`[TaskExecutor] ⚠️ 取消 Polymarket 订单时出错: ${e.message}`);
            }
        }

        // 停止监控
        console.log(`[TaskExecutor] 停止任务 ${taskId} 的监控...`);
        this.orderMonitor.stopPredictWatch(orderHashToCancel || '');
        this.orderMonitor.stopPolymarketWatch(task.currentPolyOrderId || '');
        this.orderMonitor.stopPriceGuard(this.getHedgeTokenId(task));

        // 清理运行上下文
        this.runningTasks.delete(taskId);

        // 只暂停未完成的任务
        const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
        if (!terminalStatuses.includes(task.status)) {
            // 记录暂停原因 (不 await，避免阻塞关闭)
            this.taskLogger.logTaskLifecycle(taskId, 'TASK_PAUSED', {
                status: 'PAUSED',
                previousStatus: task.status,
                reason,
            }).catch(() => { /* ignore log errors during shutdown */ });

            // 更新状态为暂停（保留原有的 pauseCount）
            this.updateTask(taskId, {
                status: 'PAUSED',
                // 只有在确认取消成功时才清空引用；否则保留用于下次启动继续取消/排查
                currentOrderHash: shouldClearPredictOrderHash ? undefined : orderHashToCancel,
                currentPolyOrderId: shouldClearPolyOrderId ? undefined : polyOrderIdToCancel,
            });
            console.log(`[TaskExecutor] 任务 ${taskId} 状态已更新为 PAUSED`);
        }
    }

    private collectTaskIdsToPause(): string[] {
        const runningTaskIds = Array.from(this.runningTasks.keys());

        // 兜底：除了 runningTasks 外，也暂停所有“可能仍有挂单”的非终态任务
        // 场景：启动/恢复过程中 Ctrl+C，任务还没加入 runningTasks，但 currentOrderHash/currentPolyOrderId 已写入 task
        const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
        const tasksWithPotentialOrders = this.taskService.getTasks({ includeCompleted: true })
            .filter(t => !terminalStatuses.includes(t.status))
            .filter(t => Boolean(t.currentOrderHash || t.currentPolyOrderId))
            .map(t => t.id);

        return Array.from(new Set([...runningTaskIds, ...tasksWithPotentialOrders]));
    }

    private async pauseTasksInternal(
        taskIdsToPause: string[],
        reason: string,
        options?: { concurrency?: number; timeoutMs?: number }
    ): Promise<void> {
        if (taskIdsToPause.length === 0) {
            console.log('[TaskExecutor] 没有需要暂停/取消挂单的任务');
            return;
        }

        const concurrency = Math.max(1, Math.min(options?.concurrency ?? 4, taskIdsToPause.length));
        const timeoutMs = options?.timeoutMs ?? 60000;
        const queue = [...taskIdsToPause];
        const startTime = Date.now();

        const runWorkers = async () => {
            const workers = Array.from({ length: concurrency }, async () => {
                while (queue.length > 0) {
                    const taskId = queue.shift();
                    if (!taskId) break;
                    try {
                        console.log(`[TaskExecutor] 开始暂停任务 ${taskId}...`);
                        await this.pauseTaskWithCancel(taskId, reason);
                        console.log(`[TaskExecutor] ✅ 任务 ${taskId} 已暂停`);
                    } catch (error: any) {
                        console.error(`[TaskExecutor] ❌ 暂停任务 ${taskId} 失败:`, error.message);
                    }
                }
            });
            await Promise.all(workers);
        };

        try {
            await Promise.race([
                runWorkers(),
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error(`TaskExecutor pause timeout (${timeoutMs}ms)`)), timeoutMs)
                ),
            ]);
        } finally {
            const elapsed = Date.now() - startTime;
            console.log(`[TaskExecutor] pause finished in ${elapsed}ms (concurrency=${concurrency}, reason=${reason})`);
        }
    }

    // ========================================================================
    // 任务执行
    // ========================================================================

    private async executeTask(ctx: TaskContext): Promise<void> {
        const { task, signal } = ctx;
        console.log(`[TaskExecutor] Executing ${task.type} task: ${task.id}`);

        if (task.type === 'BUY') {
            await this.executeBuyTask(ctx);
        } else {
            await this.executeSellTask(ctx);
        }
    }

    /**
     * 执行 BUY 任务
     *
     * 流程:
     * - MAKER: Predict 下 Maker 买单 (YES)，等待成交，对冲
     * - TAKER: Predict 下 LIMIT @ ask，超时撤单，对冲
     */
    private async executeBuyTask(ctx: TaskContext): Promise<void> {
        const { signal } = ctx;
        let task = ctx.task;
        const strategy = task.strategy ?? 'MAKER';

        // ===== TAKER 模式路由到 TakerExecutor =====
        if (strategy === 'TAKER') {
            console.log(`[TaskExecutor] Routing to TakerExecutor for task ${task.id}`);
            await this.takerExecutor.executeTakerBuy({
                task,
                currentOrderHash: ctx.currentOrderHash,
                // WSS-first 成交追踪
                wssFilledQty: 0,
                wssFillEvents: new Set<string>(),
                restFilledQty: ctx.totalPredictFilled,
                totalPredictFilled: ctx.totalPredictFilled,
                totalHedged: ctx.totalHedged,
                hedgePriceSum: ctx.hedgePriceSum,
                signal,
                startTime: task.createdAt,
                // 状态预获取相关
                hasReceivedValidStatus: false,
                statusFetchAttempts: 0,
                statusFetchFailures: 0,
            });
            return;
        }

        // ===== MAKER 模式 (原有逻辑) =====
        // 1. 提交 Predict Maker 买单 (如果还没有)
        if (!ctx.currentOrderHash && task.status === 'PENDING') {
            const predictResult = await this.submitPredictOrder(task, 'BUY');
            if (!predictResult.success) {
                // 记录订单失败
                await this.taskLogger.logOrderEvent(task.id, 'ORDER_FAILED', {
                    platform: 'predict',
                    orderId: '',
                    side: 'BUY',
                    price: task.predictPrice,
                    quantity: task.quantity,
                    filledQty: 0,
                    remainingQty: task.quantity,
                    avgPrice: 0,
                    error: new Error(predictResult.error || 'Unknown error'),
                });
                throw new Error(`Predict order failed: ${predictResult.error}`);
            }

            ctx.currentOrderHash = predictResult.hash;

            // 记录订单提交 + 订单簿快照
            await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                platform: 'predict',
                orderId: predictResult.hash!,
                side: 'BUY',
                price: task.predictPrice,
                quantity: task.quantity,
                filledQty: 0,
                remainingQty: task.quantity,
                avgPrice: 0,
            }, predictResult.hash);

            // 捕获订单簿快照
            await this.captureSnapshot(task.id, 'order_submit', task);

            task = this.updateTask(task.id, {
                status: 'PREDICT_SUBMITTED',
                currentOrderHash: predictResult.hash,
            });
            ctx.task = task;
        }

        if (signal.aborted) return;

        // 2. 启动价格守护 + Predict 订单监控
        await this.runWithPriceGuard(ctx, 'BUY');
    }

    /**
     * 执行 SELL 任务
     *
     * 流程:
     * 1. Predict 下 Maker 卖单 (YES)
     * 2. 启动价格守护 (对称风控)
     * 3. 等待成交
     * 4. Polymarket 卖出 (NO/YES based on isInverted)
     */
    private async executeSellTask(ctx: TaskContext): Promise<void> {
        const { signal } = ctx;
        let task = ctx.task;
        const strategy = task.strategy ?? 'MAKER';

        // ===== TAKER 模式路由到 TakerExecutor（NO 端套利: Predict SELL YES ≈ BUY NO） =====
        if (strategy === 'TAKER') {
            console.log(`[TaskExecutor] Routing to TakerExecutor for task ${task.id}`);
            await this.takerExecutor.executeTakerSell({
                task,
                currentOrderHash: ctx.currentOrderHash,
                // WSS-first 成交追踪
                wssFilledQty: 0,
                wssFillEvents: new Set<string>(),
                restFilledQty: ctx.totalPredictFilled,
                totalPredictFilled: ctx.totalPredictFilled,
                totalHedged: ctx.totalHedged,
                hedgePriceSum: ctx.hedgePriceSum,
                signal,
                startTime: task.createdAt,
                // 状态预获取相关
                hasReceivedValidStatus: false,
                statusFetchAttempts: 0,
                statusFetchFailures: 0,
            });
            return;
        }

        // 1. 提交 Predict Maker 卖单
        if (!ctx.currentOrderHash && task.status === 'PENDING') {
            const predictResult = await this.submitPredictOrder(task, 'SELL');
            if (!predictResult.success) {
                // 记录订单失败
                await this.taskLogger.logOrderEvent(task.id, 'ORDER_FAILED', {
                    platform: 'predict',
                    orderId: '',
                    side: 'SELL',
                    price: task.predictPrice,
                    quantity: task.quantity,
                    filledQty: 0,
                    remainingQty: task.quantity,
                    avgPrice: 0,
                    error: new Error(predictResult.error || 'Unknown error'),
                });
                throw new Error(`Predict order failed: ${predictResult.error}`);
            }

            ctx.currentOrderHash = predictResult.hash;

            // 记录订单提交 + 订单簿快照
            await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                platform: 'predict',
                orderId: predictResult.hash!,
                side: 'SELL',
                price: task.predictPrice,
                quantity: task.quantity,
                filledQty: 0,
                remainingQty: task.quantity,
                avgPrice: 0,
            }, predictResult.hash);

            // 捕获订单簿快照
            await this.captureSnapshot(task.id, 'order_submit', task);

            task = this.updateTask(task.id, {
                status: 'PREDICT_SUBMITTED',
                currentOrderHash: predictResult.hash,
            });
            ctx.task = task;
        }

        if (signal.aborted) return;

        // 2. 启动价格守护 + Predict 订单监控 (SELL 也需要价格守护)
        await this.runWithPriceGuard(ctx, 'SELL');
    }

    /**
     * 带价格守护的订单监控
     *
     * 核心改进:
     * - 使用 AbortController 控制 Promise 生命周期
     * - 价格无效时正确中断等待
     * - 支持增量对冲 (部分成交时立即对冲)
     */
    private async runWithPriceGuard(ctx: TaskContext, side: 'BUY' | 'SELL'): Promise<void> {
        const { signal } = ctx;
        let task = ctx.task;

        // 创建价格守护的 AbortController
        ctx.priceGuardAbort = new AbortController();
        ctx.predictWatchAbort = new AbortController();

        const hedgeTokenId = this.getHedgeTokenId(task);

        // 启动价格守护
        const maxPrice = side === 'BUY' ? task.polymarketMaxAsk : 1.0;
        const minPrice = side === 'SELL' ? task.polymarketMinBid : 0.0;

        this.orderMonitor.startPriceGuard(
            {
                predictPrice: task.predictPrice,
                polymarketTokenId: hedgeTokenId,
                feeRateBps: 0, // Maker 无费用
                maxPolymarketPrice: maxPrice,
                minPolymarketPrice: minPrice,
                side: side,
            },
            {
                onPriceInvalid: async (currentPrice) => {
                    if (signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;

                    const priceType = side === 'BUY' ? 'ask' : 'bid';
                    const threshold = side === 'BUY' ? maxPrice : minPrice;
                    console.log(`[TaskExecutor] Price guard triggered: poly ${priceType}=${currentPrice.toFixed(4)}, threshold=${threshold.toFixed(4)}`);

                    ctx.isPaused = true;

                    // 记录价格守护触发
                    await this.taskLogger.logPriceGuard(task.id, 'PRICE_GUARD_TRIGGERED', {
                        polymarketTokenId: hedgeTokenId,
                        triggerPrice: currentPrice,
                        thresholdPrice: threshold,
                        predictPrice: task.predictPrice,
                        arbValid: false,
                        pauseCount: task.pauseCount + 1,
                    });

                    // 捕获订单簿快照
                    await this.captureSnapshot(task.id, 'price_guard', task);

                    // 取消 Predict 订单
                    if (ctx.currentOrderHash) {
                        try {
                            await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                            // 记录订单取消
                            await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                                platform: 'predict',
                                orderId: ctx.currentOrderHash,
                                side: side,
                                price: task.predictPrice,
                                quantity: task.quantity,
                                filledQty: ctx.totalPredictFilled,
                                remainingQty: task.quantity - ctx.totalPredictFilled,
                                avgPrice: task.predictPrice,
                            }, ctx.currentOrderHash);
                        } catch (e) {
                            console.warn('[TaskExecutor] Failed to cancel order on pause:', e);
                        }
                        // 中断当前的订单监控
                        ctx.predictWatchAbort?.abort();
                        ctx.predictWatchAbort = new AbortController();
                    }

                    // 记录任务暂停
                    const reasonMsg = side === 'BUY'
                        ? `poly ask=${currentPrice.toFixed(4)} > max=${threshold.toFixed(4)}`
                        : `poly bid=${currentPrice.toFixed(4)} < min=${threshold.toFixed(4)}`;
                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                        status: 'PAUSED',
                        previousStatus: task.status,
                        reason: `Price guard triggered: ${reasonMsg}`,
                    });

                    task = this.updateTask(task.id, {
                        status: 'PAUSED',
                        pauseCount: task.pauseCount + 1,
                        currentOrderHash: undefined,
                    });
                    ctx.task = task;
                    ctx.currentOrderHash = undefined;

                    // 检查是否超过最大暂停次数
                    if (task.pauseCount >= MAX_PAUSE_COUNT) {
                        console.error(`[TaskExecutor] Max pause count exceeded`);
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                            status: 'FAILED',
                            previousStatus: 'PAUSED',
                            reason: 'Max pause count exceeded',
                        });
                        ctx.priceGuardAbort?.abort();
                        this.updateTask(task.id, {
                            status: 'FAILED',
                            error: 'Max pause count exceeded',
                        });
                    }
                },
                onPriceValid: async (currentPrice) => {
                    if (signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;
                    if (!ctx.isPaused) return;

                    const priceType = side === 'BUY' ? 'ask' : 'bid';
                    console.log(`[TaskExecutor] Price valid again: poly ${priceType}=${currentPrice.toFixed(4)}`);

                    ctx.isPaused = false;

                    // 计算剩余量 (原始数量 - 已成交量)
                    const remainingQty = task.quantity - ctx.totalPredictFilled;
                    if (remainingQty <= 0) {
                        console.log(`[TaskExecutor] No remaining quantity, skipping re-submit`);
                        return;
                    }

                    const threshold = side === 'BUY' ? maxPrice : minPrice;

                    // 记录价格守护恢复
                    await this.taskLogger.logPriceGuard(task.id, 'PRICE_GUARD_RESUMED', {
                        polymarketTokenId: hedgeTokenId,
                        triggerPrice: currentPrice,
                        thresholdPrice: threshold,
                        predictPrice: task.predictPrice,
                        arbValid: true,
                        pauseCount: task.pauseCount,
                    });

                    // 重新提交 Predict 订单 (使用剩余量)
                    const taskWithRemaining = { ...task, quantity: remainingQty };
                    const result = await this.submitPredictOrder(taskWithRemaining, side);
                    if (result.success) {
                        ctx.currentOrderHash = result.hash;

                        // 记录新订单提交
                        await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                            platform: 'predict',
                            orderId: result.hash!,
                            side: side,
                            price: task.predictPrice,
                            quantity: remainingQty,
                            filledQty: 0,
                            remainingQty: remainingQty,
                            avgPrice: 0,
                        }, result.hash);

                        // 记录任务恢复
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                            status: 'PREDICT_SUBMITTED',
                            previousStatus: 'PAUSED',
                        });

                        task = this.updateTask(task.id, {
                            status: 'PREDICT_SUBMITTED',
                            currentOrderHash: result.hash,
                        });
                        ctx.task = task;

                        // 重新监控订单 (不需要这里启动，主循环会处理)
                    } else {
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                            status: 'FAILED',
                            previousStatus: 'PAUSED',
                            error: new Error(result.error || 'Re-submit failed'),
                        });
                        task = this.updateTask(task.id, {
                            status: 'FAILED',
                            error: `Re-submit failed: ${result.error}`,
                        });
                        ctx.task = task;
                        ctx.priceGuardAbort?.abort();
                    }
                },
            }
        ).catch(err => {
            console.error('[TaskExecutor] Price guard error:', err);
        });

        // 启动深度监控（确保 Polymarket 有足够深度对冲）
        this.startDepthMonitor(ctx, side, hedgeTokenId, maxPrice, minPrice);

        // 主监控循环
        try {
            await this.monitorAndHedge(ctx, side);
        } finally {
            // 清理价格守护
            this.orderMonitor.stopPriceGuard(hedgeTokenId);
        }
    }

    /**
     * 监控订单并执行增量对冲
     * WSS-first 架构：优先使用 BSC WebSocket 检测成交，REST 作为兜底
     */
    private async monitorAndHedge(ctx: TaskContext, side: 'BUY' | 'SELL'): Promise<void> {
        const { signal } = ctx;
        let task = ctx.task;
        const startTime = Date.now();

        // ========================================================================
        // BSC WSS 成交事件处理 (WSS-first 架构)
        // ========================================================================
        let bscWssWatcher: BscOrderWatcher | null = null;
        // 使用 ref 对象存储 cancel 函数，避免 TypeScript 闭包类型推断问题
        const wssWatcherRef = { cancel: null as (() => void) | null };
        let wssEventResolve: (() => void) | null = null;
        let wssEventPromise: Promise<void> | null = null;
        let wssEventPending = false;

        const resetWssSignal = () => {
            wssEventPromise = new Promise<void>((resolve) => {
                wssEventResolve = resolve;
            });
        };
        resetWssSignal();

        // 当前正在监听的订单 hash（用于检测 hash 变更）
        let watchedOrderHash: string | null = null;
        // 基准偏移：重挂订单前已累计的成交量，确保 total 单调增长
        let baseFilledBeforeOrder = ctx.totalPredictFilled;

        /**
         * 合并 WSS 和 REST 成交量，更新 totalPredictFilled
         * 规则: total = baseFilledBeforeOrder + max(wssFilledQty, restFilledQty)
         * 这样重挂订单时不会"低估成交量"
         */
        const mergeFilledQty = (): boolean => {
            const merged = baseFilledBeforeOrder + Math.max(ctx.wssFilledQty, ctx.restFilledQty);
            const clamped = Math.min(Math.max(0, merged), task.quantity);
            if (clamped > ctx.totalPredictFilled) {
                ctx.totalPredictFilled = clamped;
                return true;
            }
            return false;
        };

        /**
         * 取消当前 watcher（如果有）
         */
        const cancelWatcherIfAny = () => {
            if (wssWatcherRef.cancel) {
                wssWatcherRef.cancel();
                wssWatcherRef.cancel = null;
                console.log(`[TaskExecutor] Task ${task.id}: WSS watcher cancelled`);
            }
        };

        /**
         * 重置为新订单状态
         * 设置基准偏移，清空 WSS/REST 状态，重新注册 watcher
         */
        const resetForNewOrder = (orderHash: string) => {
            // 切换订单前先合并一次，避免已到达的 WSS/REST 增量被清空
            mergeFilledQty();

            // 设置基准偏移：当前已累计的成交量
            baseFilledBeforeOrder = ctx.totalPredictFilled;

            // 先取消旧 watcher，避免迟到事件污染
            cancelWatcherIfAny();

            // 清空 WSS/REST 状态（新订单从 0 开始累计）
            ctx.wssFilledQty = 0;
            ctx.restFilledQty = 0;
            ctx.wssFillEvents.clear();
            ctx.wssFirstFillTime = undefined;

            watchedOrderHash = orderHash;

            // 注册新 watcher
            try {
                bscWssWatcher = getBscOrderWatcher();
                if (bscWssWatcher.isConnected()) {
                    wssWatcherRef.cancel = bscWssWatcher.watchOrder(
                        orderHash,
                        (event: OrderFilledEvent) => {
                            // 1. 去重: 使用 txHash:logIndex 作为唯一键
                            const dedupKey = `${event.txHash}:${event.logIndex}`;
                            if (ctx.wssFillEvents.has(dedupKey)) return;
                            ctx.wssFillEvents.add(dedupKey);

                            // 2. 累加增量（使用统一工具函数）
                            const fillDelta = getSharesFromFillEvent(event);
                            ctx.wssFilledQty += fillDelta;

                            // 3. 记录首次 WSS 成交时间
                            if (!ctx.wssFirstFillTime) {
                                ctx.wssFirstFillTime = event.timestamp;
                                console.log(`[TaskExecutor] Task ${task.id}: WSS first fill at ${ctx.wssFirstFillTime - startTime}ms, delta=${fillDelta.toFixed(4)}`);
                            }

                            // 4. 唤醒主循环
                            if (wssEventResolve) {
                                wssEventPending = true;
                                wssEventResolve();
                                resetWssSignal();
                            }
                        },
                        300000 // 5分钟超时
                    );
                    console.log(`[TaskExecutor] Task ${task.id}: WSS watcher registered for ${orderHash.slice(0, 10)}... (base=${baseFilledBeforeOrder.toFixed(2)})`);
                }
            } catch {
                console.log(`[TaskExecutor] Task ${task.id}: BSC WSS not available for ${orderHash.slice(0, 10)}...`);
            }
        };

        // 初始注册（如果有订单）
        if (ctx.currentOrderHash) {
            // 首次进入时，base 已经是 ctx.totalPredictFilled（恢复场景）
            // 但 WSS/REST 状态需要从 0 开始（只追踪当前订单的成交）
            ctx.wssFilledQty = 0;
            ctx.restFilledQty = 0;
            watchedOrderHash = ctx.currentOrderHash;

            try {
                bscWssWatcher = getBscOrderWatcher();
                if (bscWssWatcher.isConnected()) {
                    wssWatcherRef.cancel = bscWssWatcher.watchOrder(
                        ctx.currentOrderHash,
                        (event: OrderFilledEvent) => {
                            const dedupKey = `${event.txHash}:${event.logIndex}`;
                            if (ctx.wssFillEvents.has(dedupKey)) return;
                            ctx.wssFillEvents.add(dedupKey);
                            // 使用统一工具函数计算 shares 数量
                            const fillDelta = getSharesFromFillEvent(event);
                            ctx.wssFilledQty += fillDelta;
                            if (!ctx.wssFirstFillTime) {
                                ctx.wssFirstFillTime = event.timestamp;
                                console.log(`[TaskExecutor] Task ${task.id}: WSS first fill, delta=${fillDelta.toFixed(4)}`);
                            }
                            if (wssEventResolve) {
                                wssEventPending = true;
                                wssEventResolve();
                                resetWssSignal();
                            }
                        },
                        300000
                    );
                    console.log(`[TaskExecutor] Task ${task.id}: WSS watcher initialized (base=${baseFilledBeforeOrder.toFixed(2)})`);
                }
            } catch {
                console.log(`[TaskExecutor] Task ${task.id}: BSC WSS not available, REST-only mode`);
            }
        }

        try {
            while (!signal.aborted && !ctx.priceGuardAbort?.signal.aborted) {
                // 如果暂停中，等待恢复（WSS 事件可打断）
                if (ctx.isPaused) {
                    await Promise.race([this.delay(500), wssEventPromise]);
                    if (!wssEventPending) {
                        continue;
                    }
                    wssEventPending = false;
                }

                // 如果没有订单，取消 watcher 并等待重新提交
                if (!ctx.currentOrderHash) {
                    // hash 变为 null 时，先合并已到达的增量，避免丢失成交
                    if (watchedOrderHash !== null) {
                        const previousPredictFilled = ctx.totalPredictFilled;
                        mergeFilledQty();
                        const newlyObservedFilled = ctx.totalPredictFilled - previousPredictFilled;

                        if (newlyObservedFilled > 0) {
                            const effectiveAvgPrice = task.predictPrice;
                            const orderEventType = ctx.totalPredictFilled >= task.quantity ? 'ORDER_FILLED' : 'ORDER_PARTIAL_FILL';

                            await this.taskLogger.logOrderEvent(task.id, orderEventType, {
                                platform: 'predict',
                                orderId: watchedOrderHash,
                                side: side,
                                price: task.predictPrice,
                                quantity: task.quantity,
                                filledQty: ctx.totalPredictFilled,
                                remainingQty: task.quantity - ctx.totalPredictFilled,
                                avgPrice: effectiveAvgPrice,
                            }, watchedOrderHash);

                            await this.captureSnapshot(task.id, 'order_fill', task);

                            task = this.updateTask(task.id, {
                                status: orderEventType === 'ORDER_FILLED' ? 'HEDGING' : 'PARTIALLY_FILLED',
                                predictFilledQty: ctx.totalPredictFilled,
                                avgPredictPrice: effectiveAvgPrice,
                            });
                            ctx.task = task;

                            await this.refreshTrackedPolyFills(ctx);
                            const unhedgedQtyForHedge = Math.max(0, ctx.totalPredictFilled - ctx.totalHedged);
                            if (unhedgedQtyForHedge >= MIN_HEDGE_QTY) {
                                const hedgeResult = await this.executeIncrementalHedge(ctx, unhedgedQtyForHedge, side);

                                if (hedgeResult.filledQty > 0) {
                                    console.log(`[TaskExecutor] Hedge delta: ${hedgeResult.filledQty}, total hedged: ${ctx.totalHedged}`);
                                }

                                if (!hedgeResult.success) {
                                    console.error(`[TaskExecutor] Hedge failed (hedged: ${ctx.totalHedged}/${ctx.totalPredictFilled}), initiating UNWIND`);
                                    await this.executeUnwind(ctx);
                                    return;
                                }

                                const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
                                task = this.updateTask(task.id, {
                                    hedgedQty: ctx.totalHedged,
                                    avgPolymarketPrice: avgHedgePrice,
                                    remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                                });
                                ctx.task = task;
                            }
                        }

                        baseFilledBeforeOrder = ctx.totalPredictFilled;
                        if (!ctx.isPaused) {
                            cancelWatcherIfAny();
                            watchedOrderHash = null;
                        }
                    }
                    await Promise.race([this.delay(500), wssEventPromise]);
                    continue;
                }

                // 检测订单 hash 变化，重置为新订单状态
                if (ctx.currentOrderHash !== watchedOrderHash) {
                    console.log(`[TaskExecutor] Task ${task.id}: Order hash changed from ${watchedOrderHash?.slice(0, 10) || 'null'} to ${ctx.currentOrderHash.slice(0, 10)}`);
                    resetForNewOrder(ctx.currentOrderHash);
                }

                // 查询订单状态 (REST)
                const status = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                if (!status) {
                    // REST 失败时也允许 WSS 事件打断等待
                    await Promise.race([this.delay(PREDICT_POLL_INTERVAL), wssEventPromise]);
                    continue;
                }

                // 更新 REST 成交量 (单调不减)
                if (status.filledQty > ctx.restFilledQty) {
                    ctx.restFilledQty = status.filledQty;
                }

                // 合并 WSS 和 REST 成交量
                const previousPredictFilled = ctx.totalPredictFilled;
                mergeFilledQty();
                const effectivePredictFilled = ctx.totalPredictFilled;
                const newlyObservedFilled = effectivePredictFilled - previousPredictFilled;

                // avgPrice uses order price
                const effectiveAvgPrice = task.predictPrice;

                if (newlyObservedFilled > 0) {
                    const source = ctx.wssFirstFillTime ? 'WSS' : 'REST';
                    console.log(`[TaskExecutor] Predict filled (${source}): +${newlyObservedFilled.toFixed(4)} (total: ${effectivePredictFilled.toFixed(4)}, avgPrice: ${effectiveAvgPrice.toFixed(4)})`);

                    // 记录成交事件
                    const orderEventType = status.status === 'FILLED' ? 'ORDER_FILLED' : 'ORDER_PARTIAL_FILL';
                    await this.taskLogger.logOrderEvent(task.id, orderEventType, {
                        platform: 'predict',
                        orderId: ctx.currentOrderHash!,
                        side: side,
                        price: task.predictPrice,
                        quantity: task.quantity,
                        filledQty: effectivePredictFilled,
                        remainingQty: task.quantity - effectivePredictFilled,
                        avgPrice: effectiveAvgPrice,
                    }, ctx.currentOrderHash);

                    // 捕获订单簿快照
                    await this.captureSnapshot(task.id, 'order_fill', task);

                    task = this.updateTask(task.id, {
                        status: status.status === 'FILLED' ? 'HEDGING' : 'PARTIALLY_FILLED',
                        predictFilledQty: effectivePredictFilled,
                        avgPredictPrice: effectiveAvgPrice,
                    });
                    ctx.task = task;
                }

                const shouldHedgeNow = (newlyObservedFilled > 0) || status.status === 'FILLED';
                if (shouldHedgeNow) {
                    // 对冲/UNWIND 等关键动作前先刷新 Poly 迟到成交，降低误判触发重复对冲/UNWIND
                    await this.refreshTrackedPolyFills(ctx);
                    const unhedgedQtyForHedge = Math.max(0, ctx.totalPredictFilled - ctx.totalHedged);

                    // 若 Predict 已完全成交但存在未对冲余量，也需要补齐对冲（否则会卡在 FILLED 状态无法自愈）
                    if (unhedgedQtyForHedge >= MIN_HEDGE_QTY) {
                        const hedgeResult = await this.executeIncrementalHedge(ctx, unhedgedQtyForHedge, side);

                        if (hedgeResult.filledQty > 0) {
                            console.log(`[TaskExecutor] Hedge delta: ${hedgeResult.filledQty}, total hedged: ${ctx.totalHedged}`);
                        }

                        if (!hedgeResult.success) {
                            // 对冲失败，需要 UNWIND
                            console.error(`[TaskExecutor] Hedge failed (hedged: ${ctx.totalHedged}/${ctx.totalPredictFilled}), initiating UNWIND`);
                            await this.executeUnwind(ctx);
                            return;
                        }

                        const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
                        task = this.updateTask(task.id, {
                            hedgedQty: ctx.totalHedged,
                            avgPolymarketPrice: avgHedgePrice,
                            remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                        });
                        ctx.task = task;
                    }
                }

                // 检查是否完成
                // 考虑跳过的小额对冲：如果未对冲量 < MIN_HEDGE_QTY，视为完成
                const unhedgedQty = ctx.totalPredictFilled - ctx.totalHedged;
                const isHedgeComplete = ctx.totalHedged >= ctx.totalPredictFilled || unhedgedQty < MIN_HEDGE_QTY;
                if (status.status === 'FILLED' && isHedgeComplete) {
                    // 计算实际利润
                    const profit = this.calculateProfit(task, ctx);
                    const profitPercent = task.predictPrice > 0 && ctx.totalPredictFilled > 0
                        ? (profit / (task.predictPrice * ctx.totalPredictFilled)) * 100
                        : 0;

                    // 记录任务完成
                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                        status: 'COMPLETED',
                        previousStatus: task.status,
                        profit,
                        profitPercent,
                        duration: Date.now() - task.createdAt,
                    });

                    task = this.updateTask(task.id, {
                        status: 'COMPLETED',
                        actualProfit: profit,
                        completedAt: Date.now(),
                    });

                    // 生成任务汇总
                    await this.taskLogger.generateSummary(task.id, {
                        type: task.type,
                        marketId: task.marketId,
                        title: task.title,
                        status: 'COMPLETED',
                        predictFilledQty: ctx.totalPredictFilled,
                        hedgedQty: ctx.totalHedged,
                        avgPredictPrice: task.predictPrice,
                        avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
                        actualProfit: profit,
                        unwindLoss: 0,
                        pauseCount: task.pauseCount,
                        hedgeRetryCount: task.hedgeRetryCount,
                        createdAt: task.createdAt,
                    });

                    console.log(`[TaskExecutor] Task ${task.id} completed. Profit: $${profit.toFixed(2)}`);
                    return;
                }

                // 订单已取消或过期
                if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
                    // 构建详细的取消原因
                    const detailReason = status.cancelReason
                        ? `Order ${status.status}: ${status.cancelReason}`
                        : `Order ${status.status}`;

                    console.log(`[TaskExecutor] Task ${task.id} order ${status.status}. Reason: ${detailReason}`);
                    if (status.rawResponse) {
                        console.log(`[TaskExecutor] Raw order data:`, JSON.stringify(status.rawResponse, null, 2));
                    }

                    // 取消/过期触发 UNWIND 前，先刷新 Poly 迟到成交，避免误判未对冲
                    await this.refreshTrackedPolyFills(ctx);

                    if (ctx.totalPredictFilled > ctx.totalHedged) {
                        // 有未对冲的部分，需要 UNWIND
                        console.error(`[TaskExecutor] Order ${status.status} with unhedged position`);

                        // 记录订单过期/取消
                        await this.taskLogger.logOrderEvent(task.id, status.status === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_EXPIRED', {
                            platform: 'predict',
                            orderId: ctx.currentOrderHash!,
                            side: side,
                            price: task.predictPrice,
                            quantity: task.quantity,
                            filledQty: ctx.totalPredictFilled,
                            remainingQty: task.quantity - ctx.totalPredictFilled,
                            avgPrice: task.predictPrice,
                            cancelReason: status.cancelReason,
                            rawResponse: status.rawResponse,
                        }, ctx.currentOrderHash);

                        await this.executeUnwind(ctx);
                        return;
                    } else if (ctx.totalPredictFilled === 0) {
                        // 没有成交，直接取消
                        await this.taskLogger.logOrderEvent(task.id, status.status === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_EXPIRED', {
                            platform: 'predict',
                            orderId: ctx.currentOrderHash!,
                            side: side,
                            price: task.predictPrice,
                            quantity: task.quantity,
                            filledQty: 0,
                            remainingQty: task.quantity,
                            avgPrice: task.predictPrice,
                            cancelReason: status.cancelReason,
                            rawResponse: status.rawResponse,
                        }, ctx.currentOrderHash);

                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_CANCELLED', {
                            status: 'CANCELLED',
                            previousStatus: task.status,
                            reason: detailReason,
                            cancelReason: status.cancelReason,
                        });

                        this.updateTask(task.id, {
                            status: 'CANCELLED',
                            error: detailReason,
                        });
                    } else {
                        // 已完全对冲
                        const profit = this.calculateProfit(task, ctx);
                        const profitPercent = task.predictPrice > 0 && ctx.totalPredictFilled > 0
                            ? (profit / (task.predictPrice * ctx.totalPredictFilled)) * 100
                            : 0;

                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                            status: 'COMPLETED',
                            previousStatus: task.status,
                            profit,
                            profitPercent,
                            duration: Date.now() - task.createdAt,
                        });

                        task = this.updateTask(task.id, {
                            status: 'COMPLETED',
                            actualProfit: profit,
                            completedAt: Date.now(),
                        });

                        // 生成任务汇总
                        await this.taskLogger.generateSummary(task.id, {
                            type: task.type,
                            marketId: task.marketId,
                            title: task.title,
                            status: 'COMPLETED',
                            predictFilledQty: ctx.totalPredictFilled,
                            hedgedQty: ctx.totalHedged,
                            avgPredictPrice: task.predictPrice,
                            avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
                            actualProfit: profit,
                            unwindLoss: 0,
                            pauseCount: task.pauseCount,
                            hedgeRetryCount: task.hedgeRetryCount,
                            createdAt: task.createdAt,
                        });
                    }
                    return;
                }

                // WSS 事件可打断等待：收到 fill 事件后立刻进入下一轮检查
                await Promise.race([
                    this.delay(PREDICT_POLL_INTERVAL),
                    wssEventPromise,
                ]);
            }
        } finally {
            // 清理 BSC WSS watcher
            if (wssWatcherRef.cancel) {
                wssWatcherRef.cancel();
                console.log(`[TaskExecutor] Task ${task.id}: BSC WSS order listener cleaned up`);
            }
        }
    }

    /**
     * 执行增量对冲
     */
    private async executeIncrementalHedge(
        ctx: TaskContext,
        quantity: number,
        side: 'BUY' | 'SELL'
    ): Promise<{ success: boolean; filledQty: number; avgPrice: number }> {
        const task = ctx.task;
        const { signal } = ctx;

        // 最小对冲数量检查：低于阈值时跳过对冲，视为成功
        // 原因：Polymarket 对极小订单 (如 0.01 shares) 会报错 "invalid amounts"
        if (quantity < MIN_HEDGE_QTY) {
            console.log(`[TaskExecutor] Hedge quantity ${quantity.toFixed(4)} below minimum ${MIN_HEDGE_QTY}, skipping (considered complete)`);
            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_SKIPPED', {
                hedgeQty: quantity,
                totalHedged: ctx.totalHedged,
                totalPredictFilled: ctx.totalPredictFilled,
                avgHedgePrice: 0,
                retryCount: 0,
                reason: `Quantity ${quantity.toFixed(4)} below minimum threshold ${MIN_HEDGE_QTY}`,
            });
            return { success: true, filledQty: 0, avgPrice: 0 };
        }

        const hedgeTokenId = this.getHedgeTokenId(task);
        let retryCount = 0;
        let totalFilled = 0;
        let priceSum = 0;
        let remaining = quantity;
        const attemptId = Math.random().toString(36).substring(2, 10);

        // 记录对冲开始
        await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
            hedgeQty: quantity,
            totalHedged: ctx.totalHedged,
            totalPredictFilled: ctx.totalPredictFilled,
            avgHedgePrice: 0,
            retryCount: 0,
        }, attemptId);

        // 捕获订单簿快照
        await this.captureSnapshot(task.id, 'hedge_start', task);

        while (retryCount < task.maxHedgeRetries && remaining >= MIN_HEDGE_QTY) {
            if (signal.aborted) {
                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                    hedgeQty: quantity,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                    retryCount,
                    error: new Error('Aborted'),
                }, attemptId);
                return { success: false, filledQty: totalFilled, avgPrice: totalFilled > 0 ? priceSum / totalFilled : 0 };
            }

            try {
                // 记录对冲尝试
                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_ATTEMPT', {
                    hedgeQty: remaining,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                    retryCount,
                }, attemptId);

                // 获取当前订单簿
                const orderbook = await this.getPolymarketOrderbook(hedgeTokenId);
                if (!orderbook) {
                    throw new Error('Failed to get orderbook');
                }

                // 确定对冲方向和价格
                let hedgePrice: number;
                let hedgeSide: 'BUY' | 'SELL';

                if (side === 'BUY') {
                    // BUY 任务: 买入 Poly (NO/YES based on isInverted) 对冲
                    if (orderbook.asks.length === 0) {
                        throw new Error('No asks available');
                    }
                    hedgePrice = orderbook.asks[0].price;
                    hedgeSide = 'BUY';

                    if (hedgePrice > task.polymarketMaxAsk) {
                        throw new Error(`Hedge price ${hedgePrice} exceeds max ${task.polymarketMaxAsk}`);
                    }
                } else {
                    // SELL 任务: 卖出 Poly (NO/YES based on isInverted) 对冲
                    if (orderbook.bids.length === 0) {
                        throw new Error('No bids available');
                    }
                    hedgePrice = orderbook.bids[0].price;
                    hedgeSide = 'SELL';

                    if (hedgePrice < task.polymarketMinBid) {
                        throw new Error(`Hedge price ${hedgePrice} below min ${task.polymarketMinBid}`);
                    }
                }

                // 提交 Polymarket IOC 订单
                const polyResult = await this.polyTrader.placeOrder({
                    tokenId: hedgeTokenId,
                    side: hedgeSide,
                    price: hedgePrice,
                    quantity: remaining,
                    orderType: 'IOC',
                    negRisk: task.negRisk,  // negRisk 市场需要使用不同的合约地址签名
                    marketTitle: task.title,  // 市场标题用于 TG 通知
                    conditionId: task.polymarketConditionId,  // 用于从 poly-slugs 查找标题
                });

                if (!polyResult.success) {
                    throw new Error(`Polymarket order failed: ${polyResult.error}`);
                }

                // 记录 Polymarket 订单提交
                await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                    platform: 'polymarket',
                    orderId: polyResult.orderId!,
                    side: hedgeSide,
                    price: hedgePrice,
                    quantity: remaining,
                    filledQty: 0,
                    remainingQty: remaining,
                    avgPrice: 0,
                });

                this.updateTask(task.id, {
                    status: 'HEDGING',
                    currentPolyOrderId: polyResult.orderId,
                });

                // 追踪本次进程内创建的 Poly 订单，用于“迟到成交”再确认
                if (!ctx.polyOrderFills.has(polyResult.orderId!)) {
                    ctx.polyOrderFills.set(polyResult.orderId!, {
                        filledQty: 0,
                        avgPrice: hedgePrice,
                        lastCheckedAt: 0,
                    });
                }

                // 等待成交（增加等待时间：500ms × 20 = 10秒）
                const hedgeResult = await new Promise<OrderWatchResult>((resolve) => {
                    this.orderMonitor.watchPolymarketOrder(
                        polyResult.orderId!,
                        (result) => resolve(result),
                        { intervalMs: 500, maxRetries: 20 }
                    );
                });

                // 再确认一次 Poly 成交（应对状态/filledQty 延迟上报），并以“新增确认成交量”更新累计
                const refreshed = await this.refreshSinglePolyFill(
                    ctx,
                    polyResult.orderId!,
                    {
                        fallbackFilledQty: hedgeResult.filledQty,
                        fallbackAvgPrice: hedgePrice,
                        force: true,
                    }
                );

                if (refreshed.delta > 0) {
                    totalFilled += refreshed.delta;
                    priceSum += refreshed.delta * refreshed.avgPrice;
                    remaining -= refreshed.delta;

                    // 记录 Polymarket 订单成交
                    const orderEventType = remaining <= 0 ? 'ORDER_FILLED' : 'ORDER_PARTIAL_FILL';
                    await this.taskLogger.logOrderEvent(task.id, orderEventType, {
                        platform: 'polymarket',
                        orderId: polyResult.orderId!,
                        side: hedgeSide,
                        price: hedgePrice,
                        quantity: quantity,
                        filledQty: refreshed.filledQty,
                        remainingQty: remaining,
                        avgPrice: refreshed.avgPrice,
                    });

                    // 记录部分对冲
                    if (remaining > 0) {
                        await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_PARTIAL', {
                            hedgeQty: refreshed.delta,
                            totalHedged: ctx.totalHedged,
                            totalPredictFilled: ctx.totalPredictFilled,
                            avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                            retryCount,
                        }, attemptId);
                    }

                    console.log(`[TaskExecutor] Hedge filled (confirmed): ${refreshed.delta} @ ${refreshed.avgPrice.toFixed(4)}`);
                }

                if (remaining <= 0 || remaining < MIN_HEDGE_QTY) {
                    // 记录对冲完成
                    await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_COMPLETED', {
                        hedgeQty: quantity,
                        totalHedged: ctx.totalHedged,
                        totalPredictFilled: ctx.totalPredictFilled,
                        avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                        retryCount,
                    }, attemptId);

                    return {
                        success: true,
                        filledQty: totalFilled,
                        avgPrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                    };
                }

                // 部分成交，取消剩余订单后再重试
                // 防止 IOC 订单剩余部分继续在 orderbook 等待，导致重复对冲
                try {
                    console.log(`[TaskExecutor] Cancelling remaining order ${polyResult.orderId!.slice(0, 10)}... before retry`);
                    await this.polyTrader.cancelOrder(polyResult.orderId!, {
                        skipTelegram: true,  // 内部操作，不发 TG 通知
                    });
                } catch (cancelErr: any) {
                    // 取消失败不阻塞流程，可能订单已经被取消或完全成交
                    console.warn(`[TaskExecutor] Cancel order failed (may already be cancelled): ${cancelErr.message}`);
                }

                retryCount++;
                await this.delay(500);

            } catch (error: any) {
                retryCount++;
                const errorMsg = error.message || String(error);
                console.warn(`[TaskExecutor] Hedge attempt ${retryCount} failed:`, errorMsg);

                // 记录对冲尝试失败的详细原因
                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_ATTEMPT', {
                    hedgeQty: remaining,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                    retryCount,
                    error: { errorType: 'Error', message: errorMsg, stack: error.stack },
                }, attemptId);

                this.updateTask(task.id, {
                    hedgeRetryCount: retryCount,
                    error: errorMsg,
                });

                if (retryCount < task.maxHedgeRetries) {
                    await this.delay(1000 * retryCount);
                }
            }
        }

        // 记录对冲失败
        if (totalFilled < quantity) {
            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                hedgeQty: quantity,
                totalHedged: ctx.totalHedged,
                totalPredictFilled: ctx.totalPredictFilled,
                avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                retryCount,
                error: new Error(`Hedge incomplete: ${totalFilled}/${quantity}`),
            }, attemptId);
        }

        // 返回部分成交结果
        return {
            success: (quantity - totalFilled) < MIN_HEDGE_QTY,
            filledQty: totalFilled,
            avgPrice: totalFilled > 0 ? priceSum / totalFilled : 0,
        };
    }

    /**
     * 执行反向平仓 (UNWIND)
     *
     * 当对冲失败时，需要在 Predict 上卖出已买入的 YES 仓位
     */
    private async executeUnwind(ctx: TaskContext): Promise<void> {
        const task = ctx.task;

        // UNWIND 前刷新本次进程内追踪的 Poly 订单，避免“迟到成交”导致过量平仓
        await this.refreshTrackedPolyFills(ctx);

        const theoreticalUnhedged = ctx.totalPredictFilled - ctx.totalHedged;

        if (theoreticalUnhedged <= 0) {
            console.log('[TaskExecutor] No position to unwind');
            return;
        }

        // 查询实际持仓数量（扣除手续费后的可用量）
        const outcome = task.type === 'BUY' ? 'YES' : 'NO';
        const actualPosition = await this.predictTrader.getPositionQuantity(task.marketId, outcome);

        // 使用实际持仓与理论未对冲量中的较小值
        const unhedgedQty = actualPosition > 0
            ? Math.min(theoreticalUnhedged, actualPosition)
            : theoreticalUnhedged;

        if (unhedgedQty <= 0) {
            console.log('[TaskExecutor] No actual position to unwind');
            return;
        }

        console.log(`[TaskExecutor] Unwinding ${unhedgedQty} shares (actual: ${actualPosition}, theoretical: ${theoreticalUnhedged})`);

        // 记录 UNWIND 开始
        await this.taskLogger.logUnwindEvent(task.id, 'UNWIND_STARTED', {
            unhedgedQty,
            unwoundQty: 0,
            estimatedLoss: this.calculateUnwindLoss(task, ctx, unhedgedQty),
            retryCount: 0,
        });

        this.updateTask(task.id, {
            status: 'UNWINDING',
            error: 'Hedge failed, unwinding position',
        });

        let retryCount = 0;
        let totalUnwound = 0;

        let unwindPrice = 0;  // 记录实际 UNWIND 价格

        while (retryCount < UNWIND_MAX_RETRIES && totalUnwound < unhedgedQty) {
            try {
                const remaining = unhedgedQty - totalUnwound;

                // 获取当前订单簿，按卖一价 (best bid) 挂单
                const orderbook = await this.predictTrader.getOrderbook(task.marketId);
                if (!orderbook || orderbook.bids.length === 0) {
                    throw new Error('Cannot get orderbook or no bids available');
                }
                const bestBid = orderbook.bids[0][0];  // [price, size]
                unwindPrice = bestBid;

                console.log(`[TaskExecutor] UNWIND using best bid: ${bestBid.toFixed(4)}`);

                // 记录 UNWIND 尝试
                await this.taskLogger.logUnwindEvent(task.id, 'UNWIND_ATTEMPT', {
                    unhedgedQty,
                    unwoundQty: totalUnwound,
                    estimatedLoss: this.calculateUnwindLoss(task, ctx, remaining),
                    retryCount,
                });

                // 在 Predict 上以卖一价卖出
                // 反向操作: BUY 任务的 UNWIND 是 SELL YES
                const unwindSide = task.type === 'BUY' ? 'SELL' : 'BUY';

                // 创建带有 UNWIND 价格的任务副本
                const unwindTask = { ...task, predictPrice: bestBid, quantity: remaining };
                const result = await this.submitPredictOrder(unwindTask, unwindSide);

                if (!result.success) {
                    throw new Error(`Unwind order failed: ${result.error}`);
                }

                // 记录 UNWIND 订单提交
                await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                    platform: 'predict',
                    orderId: result.hash!,
                    side: unwindSide,
                    price: bestBid,  // 使用实际 UNWIND 价格
                    quantity: remaining,
                    filledQty: 0,
                    remainingQty: remaining,
                    avgPrice: 0,
                }, result.hash);

                // 等待成交
                const status = await this.predictTrader.pollOrderUntilFilled(
                    result.hash!,
                    30000,
                    500
                );

                if (status && status.filledQty > 0) {
                    totalUnwound += status.filledQty;

                    // 记录 UNWIND 订单成交
                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_FILLED', {
                        platform: 'predict',
                        orderId: result.hash!,
                        side: unwindSide,
                        price: unwindPrice,  // 使用实际 UNWIND 挂单价格
                        quantity: remaining,
                        filledQty: status.filledQty,
                        remainingQty: remaining - status.filledQty,
                        avgPrice: unwindPrice,
                    }, result.hash);

                    // 记录部分 UNWIND
                    if (totalUnwound < unhedgedQty) {
                        await this.taskLogger.logUnwindEvent(task.id, 'UNWIND_PARTIAL', {
                            unhedgedQty,
                            unwoundQty: totalUnwound,
                            estimatedLoss: this.calculateUnwindLoss(task, ctx, totalUnwound),
                            retryCount,
                        });
                    }

                    console.log(`[TaskExecutor] Unwound: ${status.filledQty} @ ${unwindPrice}`);
                }

            } catch (error: any) {
                retryCount++;
                console.error(`[TaskExecutor] Unwind attempt ${retryCount} failed:`, error.message);

                if (retryCount < UNWIND_MAX_RETRIES) {
                    await this.delay(2000);
                }
            }
        }

        // 计算 UNWIND 损失
        const unwindLoss = this.calculateUnwindLoss(task, ctx, totalUnwound);

        // 记录 UNWIND 完成或失败
        if (totalUnwound >= unhedgedQty) {
            await this.taskLogger.logUnwindEvent(task.id, 'UNWIND_COMPLETED', {
                unhedgedQty,
                unwoundQty: totalUnwound,
                estimatedLoss: unwindLoss,
                retryCount,
            });
        } else {
            await this.taskLogger.logUnwindEvent(task.id, 'UNWIND_FAILED', {
                unhedgedQty,
                unwoundQty: totalUnwound,
                estimatedLoss: unwindLoss,
                retryCount,
                error: new Error(`Unwind incomplete: ${totalUnwound}/${unhedgedQty}`),
            });
        }

        // 记录任务失败
        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
            status: totalUnwound >= unhedgedQty ? 'UNWIND_COMPLETED' : 'HEDGE_FAILED',
            previousStatus: 'UNWINDING',
            reason: `Hedge failed, unwound ${totalUnwound}/${unhedgedQty}, loss: $${unwindLoss.toFixed(2)}`,
        });

        this.updateTask(task.id, {
            status: totalUnwound >= unhedgedQty ? 'UNWIND_COMPLETED' : 'HEDGE_FAILED',
            unwindQty: totalUnwound,
            unwindLoss: unwindLoss,
            unwindPrice: unwindPrice,  // 记录 UNWIND 挂单价格
            completedAt: Date.now(),
        });

        // 生成任务汇总
        await this.taskLogger.generateSummary(task.id, {
            type: task.type,
            marketId: task.marketId,
            title: task.title,
            status: totalUnwound >= unhedgedQty ? 'UNWIND_COMPLETED' : 'HEDGE_FAILED',
            predictFilledQty: ctx.totalPredictFilled,
            hedgedQty: ctx.totalHedged,
            avgPredictPrice: task.predictPrice,
            avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
            actualProfit: 0,
            unwindLoss,
            pauseCount: task.pauseCount,
            hedgeRetryCount: task.hedgeRetryCount,
            createdAt: task.createdAt,
        });

        console.log(`[TaskExecutor] Unwind completed. Loss: $${unwindLoss.toFixed(2)}`);
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    private async submitPredictOrder(
        task: Task,
        side: 'BUY' | 'SELL'
    ): Promise<{ success: boolean; hash?: string; error?: string }> {
        // 根据套利方向选择 outcome:
        // - YES 端套利: Predict 交易 YES token
        // - NO 端套利: Predict 交易 NO token
        const outcome = task.arbSide || 'YES';

        const input: PredictOrderInput = {
            marketId: task.marketId,
            side,
            price: task.predictPrice,
            quantity: task.quantity,
            outcome,  // 传递套利方向对应的 token
        };

        return this.predictTrader.placeOrder(input);
    }

    /**
     * 获取对冲用的 Polymarket token ID
     *
     * 套利逻辑:
     * - YES 端套利 (arbSide='YES'): Predict 买 YES → Polymarket 买 NO
     * - NO 端套利 (arbSide='NO'): Predict 买 NO → Polymarket 买 YES
     *
     * isInverted 标记表示市场方向是否反转
     */
    private getHedgeTokenId(task: Task): string {
        const arbSide = task.arbSide || 'YES';

        if (arbSide === 'YES') {
            // YES 端套利: 对冲买 Poly NO (或 YES if inverted)
            return task.isInverted ? task.polymarketYesTokenId : task.polymarketNoTokenId;
        } else {
            // NO 端套利: 对冲买 Poly YES (或 NO if inverted)
            return task.isInverted ? task.polymarketNoTokenId : task.polymarketYesTokenId;
        }
    }

    /**
     * 计算 Polymarket 对冲可用深度
     *
     * @param tokenId 对冲代币 ID
     * @param side 对冲方向 (BUY/SELL)
     * @param maxPrice 最大可接受价格 (BUY 时使用)
     * @param minPrice 最小可接受价格 (SELL 时使用)
     * @returns 在价格范围内的可用深度
     */
    private async getHedgeDepth(
        tokenId: string,
        side: 'BUY' | 'SELL',
        maxPrice: number,
        minPrice: number
    ): Promise<number> {
        try {
            const orderbook = await this.getPolymarketOrderbook(tokenId);
            if (!orderbook) {
                console.warn('[TaskExecutor] getHedgeDepth: orderbook is null (API failed)');
                return -1;  // 返回 -1 表示 API 失败，区别于真正的 0 深度
            }

            let totalDepth = 0;

            if (side === 'BUY') {
                // 买入时看 asks，累计价格 <= maxPrice 的深度
                const bestAsk = orderbook.asks[0]?.price;
                for (const ask of orderbook.asks) {
                    if (ask.price <= maxPrice) {
                        totalDepth += ask.size;
                    } else {
                        break; // asks 已排序，后面的价格更高
                    }
                }
                if (totalDepth === 0 && orderbook.asks.length > 0) {
                    console.warn(`[TaskExecutor] getHedgeDepth: no asks <= maxPrice (bestAsk=${bestAsk?.toFixed(4)}, maxPrice=${maxPrice.toFixed(4)})`);
                }
            } else {
                // 卖出时看 bids，累计价格 >= minPrice 的深度
                const bestBid = orderbook.bids[0]?.price;
                for (const bid of orderbook.bids) {
                    if (bid.price >= minPrice) {
                        totalDepth += bid.size;
                    } else {
                        break; // bids 已排序，后面的价格更低
                    }
                }
                if (totalDepth === 0 && orderbook.bids.length > 0) {
                    console.warn(`[TaskExecutor] getHedgeDepth: no bids >= minPrice (bestBid=${bestBid?.toFixed(4)}, minPrice=${minPrice.toFixed(4)})`);
                }
            }

            return totalDepth;
        } catch (err) {
            console.warn('[TaskExecutor] Failed to get hedge depth:', err);
            return -1;  // API 错误返回 -1
        }
    }

    /**
     * 启动深度监控
     *
     * 定期检查 Polymarket 对冲深度，如果深度不足：
     * 1. 取消当前 Predict 订单
     * 2. 调整任务数量为：已成交量 + 可用深度
     * 3. 重新下单
     */
    private startDepthMonitor(
        ctx: TaskContext,
        side: 'BUY' | 'SELL',
        hedgeTokenId: string,
        maxPrice: number,
        minPrice: number
    ): void {
        const DEPTH_CHECK_INTERVAL = 5000; // 5秒检查一次

        const checkDepth = async () => {
            if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;
            if (ctx.isPaused) {
                // 暂停时继续监控，等待深度恢复
                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                return;
            }

            const task = ctx.task;
            const remainingQty = task.quantity - ctx.totalPredictFilled;

            if (remainingQty <= 0) return; // 已完成，无需监控

            const hedgeDepth = await this.getHedgeDepth(hedgeTokenId, side, maxPrice, minPrice);

            // API 失败 (返回 -1)，跳过本次检查，继续监控
            if (hedgeDepth < 0) {
                console.warn('[TaskExecutor] Depth check skipped (API failed), will retry');
                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                return;
            }

            // 如果深度充足（>= 剩余挂单量），继续
            if (hedgeDepth >= remainingQty) {
                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                return;
            }

            // 深度不足，需要调整
            console.log(`[TaskExecutor] Depth guard triggered: depth=${hedgeDepth.toFixed(2)}, remaining=${remainingQty}`);

            // 计算新的目标数量 = 已成交量 + 可用深度
            const newQuantity = ctx.totalPredictFilled + Math.floor(hedgeDepth);

            if (newQuantity <= ctx.totalPredictFilled) {
                // 深度为 0，需要暂停
                console.warn(`[TaskExecutor] No hedge depth available (depth=${hedgeDepth}), pausing task`);
                ctx.isPaused = true;

                // 取消当前订单
                if (ctx.currentOrderHash) {
                    try {
                        await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                        await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                            platform: 'predict',
                            orderId: ctx.currentOrderHash,
                            side: side,
                            price: task.predictPrice,
                            quantity: remainingQty,
                            filledQty: ctx.totalPredictFilled,
                            remainingQty: 0,
                            avgPrice: task.predictPrice,
                        }, ctx.currentOrderHash);
                    } catch (e) {
                        console.warn('[TaskExecutor] Failed to cancel order on depth guard:', e);
                    }
                    ctx.predictWatchAbort?.abort();
                    ctx.predictWatchAbort = new AbortController();
                    ctx.currentOrderHash = undefined;
                }

                this.updateTask(task.id, {
                    status: 'PAUSED',
                    error: `Hedge depth insufficient: ${hedgeDepth.toFixed(2)}`,
                });

                // 继续监控，等待深度恢复
                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                return;
            }

            // 深度部分可用，调整数量
            console.log(`[TaskExecutor] Adjusting task quantity: ${task.quantity} → ${newQuantity}`);

            // 取消当前订单
            if (ctx.currentOrderHash) {
                try {
                    await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                        platform: 'predict',
                        orderId: ctx.currentOrderHash,
                        side: side,
                        price: task.predictPrice,
                        quantity: remainingQty,
                        filledQty: ctx.totalPredictFilled,
                        remainingQty: 0,
                        avgPrice: task.predictPrice,
                    }, ctx.currentOrderHash);
                } catch (e) {
                    console.warn('[TaskExecutor] Failed to cancel order on depth adjustment:', e);
                }
                ctx.predictWatchAbort?.abort();
                ctx.predictWatchAbort = new AbortController();
                ctx.currentOrderHash = undefined;
            }

            // 更新任务数量
            const updatedTask = this.updateTask(task.id, {
                quantity: newQuantity,
            });
            ctx.task = updatedTask;

            // 重新下单（新的剩余量）
            const newRemainingQty = newQuantity - ctx.totalPredictFilled;
            if (newRemainingQty > 0) {
                const taskWithNewQty = { ...updatedTask, quantity: newRemainingQty };
                const result = await this.submitPredictOrder(taskWithNewQty, side);

                if (result.success) {
                    ctx.currentOrderHash = result.hash;

                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                        platform: 'predict',
                        orderId: result.hash!,
                        side: side,
                        price: task.predictPrice,
                        quantity: newRemainingQty,
                        filledQty: 0,
                        remainingQty: newRemainingQty,
                        avgPrice: 0,
                    }, result.hash);

                    this.updateTask(task.id, {
                        status: 'PREDICT_SUBMITTED',
                        currentOrderHash: result.hash,
                    });
                }
            }

            // 继续监控
            setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
        };

        // 启动深度监控（延迟 2 秒开始，给订单提交一些时间）
        setTimeout(checkDepth, 2000);
    }

    /**
     * 计算实际利润
     *
     * BUY 任务: 买入 Predict YES + 买入 Poly NO = 锁定 (1 - cost)
     * SELL 任务: 卖出 Predict YES + 卖出 Poly NO = 收回 (predictPrice + polyPrice) - entryCost
     */
    private calculateProfit(task: Task, ctx: TaskContext): number {
        const avgPredictPrice = task.predictPrice;
        const avgPolyPrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
        const quantity = Math.min(ctx.totalPredictFilled, ctx.totalHedged);

        if (task.type === 'BUY') {
            // BUY: 成本 = predictPrice + polyPrice, 收益 = 1.0 (事件结算)
            // 利润 = (1.0 - avgPredictPrice - avgPolyPrice) * quantity
            return (1.0 - avgPredictPrice - avgPolyPrice) * quantity;
        } else {
            // SELL:
            // 收入 = avgPredictPrice * quantity + avgPolyPrice * quantity
            // 成本 = entryCost (建仓时的总成本)
            // 利润 = 收入 - 成本
            const revenue = (avgPredictPrice + avgPolyPrice) * quantity;
            const entryCost = task.entryCost;

            if (entryCost === undefined || entryCost <= 0) {
                // entryCost 未设置时无法准确计算利润，记录警告并返回 0
                console.warn(`[TaskExecutor] SELL task ${task.id} missing entryCost, profit calculation inaccurate`);
                // 使用基于 quantity 的估算：假设原始成本为 1.0 * quantity
                // 这不一定准确，但至少提供一个参考值
                return revenue - quantity;
            }

            return revenue - entryCost;
        }
    }

    /**
     * 计算 UNWIND 损失
     */
    private calculateUnwindLoss(task: Task, ctx: TaskContext, unwoundQty: number): number {
        // UNWIND 损失 = 买入成本 - 卖出收入
        const avgPredictPrice = task.predictPrice;
        const buyCost = avgPredictPrice * unwoundQty;
        // 假设以 0.9 * 买入价卖出 (滑点损失)
        const sellRevenue = avgPredictPrice * 0.9 * unwoundQty;
        return buyCost - sellRevenue;
    }

    private updateTask(taskId: string, update: Partial<Task>): Task {
        const task = this.taskService.updateTask(taskId, update);
        this.emit('task:updated', task);
        return task;
    }

    private cleanup(ctx: TaskContext): void {
        ctx.priceGuardAbort?.abort();
        ctx.predictWatchAbort?.abort();
        const hedgeTokenId = this.getHedgeTokenId(ctx.task);
        this.orderMonitor.stopPriceGuard(hedgeTokenId);
        if (ctx.currentOrderHash) {
            this.orderMonitor.stopPredictWatch(ctx.currentOrderHash);
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 构建任务配置快照
     */
    private buildTaskConfigSnapshot(task: Task): TaskConfigSnapshot {
        return {
            type: task.type,
            marketId: task.marketId,
            title: task.title,
            predictPrice: task.predictPrice,
            polymarketMaxAsk: task.polymarketMaxAsk,
            polymarketMinBid: task.polymarketMinBid,
            quantity: task.quantity,
            polymarketConditionId: task.polymarketConditionId,
            polymarketNoTokenId: task.polymarketNoTokenId,
            polymarketYesTokenId: task.polymarketYesTokenId,
            isInverted: task.isInverted,
            feeRateBps: 0, // Maker 无费用
            tickSize: task.tickSize || 0.01,
            negRisk: task.negRisk,  // Polymarket negRisk 市场标志
            arbSide: task.arbSide || 'YES',  // 套利方向
        };
    }

    private applyPolyFillDelta(ctx: TaskContext, orderId: string, filledQty: number, avgPrice: number): number {
        const prev = ctx.polyOrderFills.get(orderId)?.filledQty || 0;
        const next = Math.max(prev, filledQty);
        const delta = next - prev;

        const previousAvgPrice = ctx.polyOrderFills.get(orderId)?.avgPrice || 0;
        ctx.polyOrderFills.set(orderId, {
            filledQty: next,
            avgPrice: avgPrice || previousAvgPrice,
            lastCheckedAt: Date.now(),
        });

        if (delta > 0) {
            ctx.totalHedged += delta;
            ctx.hedgePriceSum += delta * (avgPrice || previousAvgPrice || 0);
        }

        return delta;
    }

    private async refreshSinglePolyFill(
        ctx: TaskContext,
        orderId: string,
        options?: {
            fallbackFilledQty?: number;
            fallbackAvgPrice?: number;
            force?: boolean;
        }
    ): Promise<{ filledQty: number; avgPrice: number; delta: number }> {
        if (!ctx.polyOrderFills.has(orderId)) {
            ctx.polyOrderFills.set(orderId, { filledQty: 0, avgPrice: 0, lastCheckedAt: 0 });
        }

        const current = ctx.polyOrderFills.get(orderId)!;
        if (!options?.force && Date.now() - current.lastCheckedAt < POLY_FILL_RECHECK_INTERVAL_MS) {
            return { filledQty: current.filledQty, avgPrice: current.avgPrice, delta: 0 };
        }

        try {
            const status = await this.polyTrader.pollOrderStatus(
                orderId,
                POLY_FILL_RECHECK_MAX_RETRIES,
                POLY_FILL_RECHECK_INTERVAL_MS
            );

            const filledQty = status?.filledQty ?? options?.fallbackFilledQty ?? current.filledQty;
            const avgPrice = options?.fallbackAvgPrice ?? current.avgPrice;
            const delta = this.applyPolyFillDelta(ctx, orderId, filledQty, avgPrice);
            const updated = ctx.polyOrderFills.get(orderId)!;

            if (delta > 0) {
                const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
                ctx.task = this.updateTask(ctx.task.id, {
                    hedgedQty: ctx.totalHedged,
                    avgPolymarketPrice: avgHedgePrice,
                    remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                });
            }

            return { filledQty: updated.filledQty, avgPrice: updated.avgPrice, delta };
        } catch (err: any) {
            console.warn(`[TaskExecutor] Failed to refresh Poly order ${orderId.slice(0, 10)}...: ${err.message}`);
            return { filledQty: current.filledQty, avgPrice: current.avgPrice, delta: 0 };
        }
    }

    private async refreshTrackedPolyFills(ctx: TaskContext): Promise<void> {
        if (ctx.polyOrderFills.size === 0) return;

        // 顺序刷新，避免并发打爆 API（数量通常很小：maxHedgeRetries × 增量次数）
        for (const orderId of ctx.polyOrderFills.keys()) {
            await this.refreshSinglePolyFill(ctx, orderId);
        }
    }

    /**
     * 捕获订单簿快照
     */
    private async captureSnapshot(
        taskId: string,
        trigger: 'task_created' | 'order_submit' | 'order_fill' | 'price_guard' | 'hedge_start',
        task: Task
    ): Promise<void> {
        try {
            // 获取 Polymarket 订单簿
            const hedgeTokenId = this.getHedgeTokenId(task);
            const polyBook = await this.getPolymarketOrderbook(hedgeTokenId);

            // 构建快照数据
            const polyBookData = polyBook ? {
                bids: polyBook.bids.map(b => [b.price, b.size] as [number, number]),
                asks: polyBook.asks.map(a => [a.price, a.size] as [number, number]),
                updateTimestampMs: Date.now(),
            } : null;

            // 计算套利指标
            const bestPolyAsk = polyBook?.asks[0]?.price ?? 1;
            const totalCost = task.predictPrice + bestPolyAsk;
            const profitPercent = (1 - totalCost) * 100;

            await this.taskLogger.captureOrderBookSnapshot(
                taskId,
                trigger,
                null, // Predict 没有 WebSocket，暂不获取
                polyBookData,
                {
                    totalCost,
                    profitPercent,
                    isValid: profitPercent > 0,
                    maxDepth: polyBook?.asks[0]?.size ?? 0,
                }
            );
        } catch (error) {
            console.warn('[TaskExecutor] Failed to capture snapshot:', error);
        }
    }
}

// ============================================================================
// 单例
// ============================================================================

let instance: TaskExecutor | null = null;

export function getTaskExecutor(): TaskExecutor {
    if (!instance) {
        instance = new TaskExecutor();
    }
    return instance;
}
