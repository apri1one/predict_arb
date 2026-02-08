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
import { PolymarketRestClient } from '../polymarket/rest-client.js';
import { calculatePredictFee } from '../trading/depth-calculator.js';

// ============================================================================
// 常量
// ============================================================================

const MAX_PAUSE_COUNT = 5;          // 最大价格守护暂停次数
const HEDGE_TIMEOUT_MS = 30000;     // 对冲超时
const PREDICT_POLL_INTERVAL = 500;  // Predict 轮询间隔
const UNWIND_MAX_RETRIES = 3;       // 反向平仓最大重试
const BSC_WATCHER_TIMEOUT = 4 * 60 * 60 * 1000; // BSC watcher 超时 (4小时，Maker 订单可存活数小时)
const MIN_HEDGE_QTY = 1;            // 最小对冲数量阈值 (shares)，低于此值跳过对冲
const POLY_WS_STALE_MS = 15000;

// Polymarket 最小订单名义金额阈值 ($1)
// 小额成交先累计，避免 Polymarket 400 "invalid amounts" 拒单
const MIN_HEDGE_NOTIONAL = Number(process.env.MIN_HEDGE_NOTIONAL) || 1.0;  // USD

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
    isTerminal?: boolean;  // MATCHED/CANCELLED 已确认，refreshTrackedPolyFills 可跳过
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

    // ====== 累计对冲机制 (Polymarket $1 最小订单) ======
    /** 待对冲累计数量 (等待达到 $1 名义阈值) */
    pendingHedgeQty: number;
    /** 最后一次对冲价格估算 (用于计算名义金额) */
    lastHedgePriceEstimate: number;

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
    /** 幽灵深度检测：对冲 IOC 0 成交但订单簿显示有深度，通知深度保护触发 PAUSE */
    phantomDepthDetected?: boolean;
    /** 防止 onPriceValid 与 checkDepth 并发提交订单 */
    isSubmitting?: boolean;
    /** 上次深度调整时间戳，防止扩缩振荡 */
    lastDepthAdjustTime?: number;

    // ====== 延迟结算填充检测 ======
    /** 当前订单之前的已成交基线（从 monitorAndHedge 局部变量提升） */
    baseFilledBeforeOrder: number;
    /** 最近被取消的订单 hash，用于延迟结算验证 */
    cancelledOrderHash?: string;
    /** 取消时的 totalPredictFilled 快照 */
    cancelledOrderBaseQty?: number;
    /** 结算验证定时器 */
    cancelSettlementTimer?: ReturnType<typeof setTimeout>;
}

// ============================================================================
// TaskExecutor 类
// ============================================================================

export class TaskExecutor extends EventEmitter {
    private taskService: TaskService;
    private predictTrader: PredictTrader;
    private polyTrader: PolymarketTrader;
    private polyWsClient: PolymarketWebSocketClient | null = null;
    private polyRestClient: PolymarketRestClient;
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
        this.polyRestClient = new PolymarketRestClient();
        this.orderMonitor = getOrderMonitor();
        this.taskLogger = getTaskLogger();

        // 非体育市场 Polymarket WS 断连 → 暂停所有非体育任务
        this.orderMonitor.on('priceGuard:wsDisconnect', ({ tokenId }: { tokenId: string }) => {
            this.pauseAllNonSportsTasks(tokenId).catch(err => {
                console.error(`[TaskExecutor] pauseAllNonSportsTasks error:`, err);
            });
        });
    }

    /**
     * 初始化
     * 注意：任务恢复 (autoRecoverTasks) 不在这里执行，
     * 需要等 WS 客户端注入后通过 triggerAutoRecovery() 单独调用
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

        // 注意：autoRecoverTasks() 不再在这里调用
        // 改为由 start-dashboard.ts 在 WS 客户端注入后调用 triggerAutoRecovery()
    }

    /**
     * 触发任务自动恢复
     * 由启动入口在 WS 客户端注入后调用（避免 WS miss REST fallback 造成启动缓慢）
     */
    async triggerAutoRecovery(): Promise<void> {
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
        // 互斥: 如果任务已有运行中的上下文（price guard/depth monitor 已启动），跳过
        if (this.runningTasks.has(task.id)) {
            console.log(`[TaskExecutor] Task ${task.id}: 已有运行上下文，跳过启动恢复重挂`);
            return;
        }

        // 如果有残留的 hash（上次取消失败），先尝试取消
        if (task.currentOrderHash) {
            console.log(`[TaskExecutor] Task ${task.id}: 发现残留订单 ${task.currentOrderHash.slice(0, 20)}...，尝试清理`);
            try {
                await this.predictTrader.cancelOrder(task.currentOrderHash);
                console.log(`[TaskExecutor] Task ${task.id}: 残留订单已清理`);
            } catch (e: any) {
                console.warn(`[TaskExecutor] Task ${task.id}: 清理残留订单失败: ${e.message}`);
            }
            this.updateTask(task.id, { currentOrderHash: undefined });
        }

        // 额外安全检查：查询 Predict 该市场是否有本钱包的活跃订单
        try {
            const activeOrders = await this.predictTrader.getOpenOrdersForMarket(task.marketId);
            if (activeOrders.length > 0) {
                console.warn(`[TaskExecutor] Task ${task.id}: 发现 ${activeOrders.length} 个活跃订单，逐一取消`);
                for (const order of activeOrders) {
                    try {
                        await this.predictTrader.cancelOrder(order.id);
                        console.log(`[TaskExecutor] Task ${task.id}: 取消活跃订单 ${order.id}`);
                    } catch (e: any) {
                        console.warn(`[TaskExecutor] Task ${task.id}: 取消活跃订单 ${order.id} 失败: ${e.message}`);
                    }
                }
            }
        } catch (e: any) {
            console.warn(`[TaskExecutor] Task ${task.id}: 查询活跃订单失败: ${e.message}`);
        }

        const remainingQty = (task.quantity || 0) - (task.predictFilledQty || 0);
        if (remainingQty <= 0) {
            console.log(`[TaskExecutor] Task ${task.id}: PAUSED 但无剩余量，跳过重挂`);
            return;
        }

        const side: 'BUY' | 'SELL' = task.type === 'SELL' ? 'SELL' : 'BUY';

        // 挂单价格安全检查：确保不会作为 Taker 立即成交
        const priceCheck = await this.isPredictPriceSafeForMaker(task, side);
        if (!priceCheck.safe) {
            console.log(`[TaskExecutor] Task ${task.id}: PAUSED 但挂单价格不安全 (${priceCheck.reason})，保持暂停`);
            return;
        }

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
        // 浮点精度容差 - 允许 yes + no = 1 的边界情况
        const EPSILON = 0.0001;

        try {
            const hedgeTokenId = this.getHedgeTokenId(task);
            const orderbook = await this.getPolymarketOrderbook(hedgeTokenId, task.isSportsMarket);

            if (!orderbook) {
                return { valid: false, reason: '无法获取订单簿' };
            }

            if (task.type === 'BUY') {
                // BUY 任务: 检查 polyAsk <= polymarketMaxAsk + epsilon
                const bestAsk = orderbook.asks[0]?.price;
                if (bestAsk === undefined) {
                    return { valid: false, reason: '无可用卖单' };
                }
                if (bestAsk > task.polymarketMaxAsk + EPSILON) {
                    return {
                        valid: false,
                        reason: `polyAsk(${bestAsk.toFixed(4)}) > maxAsk(${task.polymarketMaxAsk.toFixed(4)})`,
                    };
                }
            } else {
                // SELL 任务: 检查 polyBid >= polymarketMinBid - epsilon
                const bestBid = orderbook.bids[0]?.price;
                if (bestBid === undefined) {
                    return { valid: false, reason: '无可用买单' };
                }
                if (bestBid < task.polymarketMinBid - EPSILON) {
                    return {
                        valid: false,
                        reason: `polyBid(${bestBid.toFixed(4)}) < minBid(${task.polymarketMinBid.toFixed(4)})`,
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
     * 优先使用 WS 缓存，缓存 miss 时回退到 REST API
     * 注: 体育市场没有 WS 订阅，总是需要 REST 回退
     */
    private async getPolymarketOrderbook(
        tokenId: string,
        isSportsMarket: boolean = false
    ): Promise<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null> {
        // 尝试 WS 缓存
        const wsClient = this.polyWsClient;
        if (wsClient && wsClient.isConnected()) {
            const wsBook = wsClient.getOrderBook(tokenId);
            if (wsBook && wsBook.bids.length > 0 && wsBook.asks.length > 0) {
                return {
                    bids: wsBook.bids.map(([price, size]) => ({ price, size })),
                    asks: wsBook.asks.map(([price, size]) => ({ price, size })),
                };
            }
            // WS 已连接但缓存无数据：确保 token 已订阅（自愈：防止重连时订阅丢失）
            if (!isSportsMarket) {
                wsClient.subscribe([tokenId]);
            }
        }

        // WS 缓存 miss 时回退到 REST API
        // 注: 总是尝试 REST 回退，以支持旧任务和体育市场
        try {
            if (isSportsMarket) {
                console.log(`[TaskExecutor] Sports market REST fallback for token: ${tokenId.slice(0, 10)}...`);
            } else {
                console.log(`[TaskExecutor] WS miss, REST fallback for token: ${tokenId.slice(0, 10)}...`);
            }
            const restBook = await this.polyRestClient.getOrderBook(tokenId);
            if (restBook && restBook.bids.length > 0 && restBook.asks.length > 0) {
                // REST 返回的格式是 { price: string, size: string }[]
                return {
                    bids: restBook.bids.map((b: any) => ({
                        price: parseFloat(b.price),
                        size: parseFloat(b.size),
                    })).sort((a, b) => b.price - a.price),  // 按价格降序排列
                    asks: restBook.asks.map((a: any) => ({
                        price: parseFloat(a.price),
                        size: parseFloat(a.size),
                    })).sort((a, b) => a.price - b.price),  // 按价格升序排列
                };
            }
        } catch (error: any) {
            console.error(`[TaskExecutor] REST orderbook failed:`, error.message);
        }

        return null;
    }

    /**
     * 检查是否应该触发对冲 (考虑 Polymarket $1 最小名义金额阈值)
     *
     * @param ctx 任务上下文
     * @param newFilledQty 本次新成交的数量
     * @param isPredictFullyFilled Predict 订单是否已完全成交
     * @returns { shouldHedge: boolean, hedgeQty: number, reason: string }
     */
    private async checkShouldHedge(
        ctx: TaskContext,
        newFilledQty: number,
        isPredictFullyFilled: boolean
    ): Promise<{ shouldHedge: boolean; hedgeQty: number; reason: string }> {
        const task = ctx.task;

        // 累计待对冲数量
        ctx.pendingHedgeQty += newFilledQty;

        // 计算总未对冲量
        const totalUnhedged = ctx.totalPredictFilled - ctx.totalHedged;

        // 如果未对冲量 < MIN_HEDGE_QTY，无需对冲
        if (totalUnhedged < MIN_HEDGE_QTY) {
            return { shouldHedge: false, hedgeQty: 0, reason: `Unhedged ${totalUnhedged.toFixed(4)} < MIN_HEDGE_QTY ${MIN_HEDGE_QTY}` };
        }

        // 获取当前对冲价格估算
        const hedgeTokenId = this.getHedgeTokenId(task);
        const orderbook = await this.getPolymarketOrderbook(hedgeTokenId, task.isSportsMarket);
        let hedgePrice = ctx.lastHedgePriceEstimate;  // 默认使用上次估算

        if (orderbook) {
            // BUY 任务: 买入对冲，看 asks
            // SELL 任务: 卖出对冲，看 bids
            if (task.type === 'BUY' && orderbook.asks.length > 0) {
                hedgePrice = orderbook.asks[0].price;
            } else if (task.type === 'SELL' && orderbook.bids.length > 0) {
                hedgePrice = orderbook.bids[0].price;
            }
            ctx.lastHedgePriceEstimate = hedgePrice;
        }

        // 计算名义金额 = 待对冲量 × 对冲价格
        const notionalAmount = ctx.pendingHedgeQty * hedgePrice;

        // 如果 Predict 已完全成交，强制对冲剩余量（无论金额大小）
        if (isPredictFullyFilled && totalUnhedged >= MIN_HEDGE_QTY) {
            const hedgeQty = totalUnhedged;
            ctx.pendingHedgeQty = 0;  // 清空累计
            console.log(`[TaskExecutor] Predict fully filled, force hedge remaining ${hedgeQty.toFixed(4)} (notional: $${(hedgeQty * hedgePrice).toFixed(2)})`);
            return { shouldHedge: true, hedgeQty, reason: 'Predict fully filled' };
        }

        // 检查名义金额是否达到阈值
        if (notionalAmount >= MIN_HEDGE_NOTIONAL) {
            const hedgeQty = ctx.pendingHedgeQty;
            ctx.pendingHedgeQty = 0;  // 清空累计
            console.log(`[TaskExecutor] Notional $${notionalAmount.toFixed(2)} >= $${MIN_HEDGE_NOTIONAL}, triggering hedge for ${hedgeQty.toFixed(4)} shares`);
            return { shouldHedge: true, hedgeQty, reason: `Notional $${notionalAmount.toFixed(2)} >= threshold` };
        }

        // 金额未达阈值，继续累计
        console.log(`[TaskExecutor] Accumulating: pending=${ctx.pendingHedgeQty.toFixed(4)}, notional=$${notionalAmount.toFixed(2)} < $${MIN_HEDGE_NOTIONAL}, waiting...`);
        return { shouldHedge: false, hedgeQty: 0, reason: `Notional $${notionalAmount.toFixed(2)} < $${MIN_HEDGE_NOTIONAL}` };
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
            // 累计对冲机制
            pendingHedgeQty: 0,
            lastHedgePriceEstimate: task.polymarketMaxAsk || 0.5,  // 默认使用任务配置的最大 ask
            polyOrderFills: new Map(),
            // WSS-first 成交追踪
            wssFilledQty: 0,
            wssFillEvents: new Set<string>(),
            restFilledQty: task.predictFilledQty || 0,
            // 延迟结算填充检测
            baseFilledBeforeOrder: task.predictFilledQty || 0,
            cancelledOrderHash: undefined,
            cancelledOrderBaseQty: undefined,
            cancelSettlementTimer: undefined,
        };
        this.runningTasks.set(taskId, ctx);

        // 订阅对冲 token 到 Polymarket WS（arb-service 只订阅了 YES token，对冲常用 NO token）
        if (!task.isSportsMarket) {
            const hedgeTokenId = this.getHedgeTokenId(task);
            this.polyWsClient?.subscribe([hedgeTokenId]);
        }

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

            // 取消未完成的 Predict 订单
            const latestTask = this.taskService.getTask(taskId);
            if (latestTask?.currentOrderHash) {
                try {
                    console.log(`[TaskExecutor] 任务失败，取消 Predict 订单: ${latestTask.currentOrderHash.slice(0, 20)}...`);
                    await this.predictTrader.cancelOrder(latestTask.currentOrderHash);
                } catch (cancelError: any) {
                    console.warn(`[TaskExecutor] 取消订单失败: ${cancelError.message}`);
                }
            }

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
            console.log(`[TaskExecutor] 取消 Predict 订单: ${orderHashToCancel.slice(0, 20)}... (状态: ${task.status}, 已成交: ${task.predictFilledQty}/${task.quantity})`);
            try {
                // 先获取当前订单状态
                const orderStatus = await this.predictTrader.getOrderStatus(orderHashToCancel);
                const remainingQty = orderStatus?.remainingQty ?? (task.quantity - task.predictFilledQty);

                if (orderStatus && (orderStatus.status === 'FILLED' || orderStatus.remainingQty === 0)) {
                    console.log(`[TaskExecutor] ℹ️ Predict 订单已全部成交，无需取消`);
                } else if (orderStatus && (orderStatus.status === 'CANCELLED' || orderStatus.status === 'EXPIRED')) {
                    console.log(`[TaskExecutor] ℹ️ Predict 订单已取消/过期，无需操作`);
                } else {
                    // 尝试取消订单
                    const cancelled = await this.predictTrader.cancelOrder(orderHashToCancel);
                    if (cancelled) {
                        console.log(`[TaskExecutor] ✅ Predict 订单已取消 (剩余: ${remainingQty})`);
                        // 记录订单取消事件（触发 TG 通知）
                        await this.taskLogger.logOrderEvent(taskId, 'ORDER_CANCELLED', {
                            platform: 'predict',
                            orderId: orderHashToCancel,
                            side: task.type,
                            outcome: task.arbSide || 'YES',
                            price: task.predictPrice,
                            quantity: task.quantity,
                            filledQty: task.predictFilledQty,
                            remainingQty: remainingQty,
                            avgPrice: task.avgPredictPrice,
                            cancelReason: 'User cancelled',
                        });
                    } else {
                        console.warn(`[TaskExecutor] ⚠️ Predict 订单取消失败 (hash: ${orderHashToCancel.slice(0, 20)}..., 状态: ${task.status}, 已成交: ${task.predictFilledQty}/${task.quantity})`);
                    }
                }
            } catch (e: any) {
                console.warn(`[TaskExecutor] ❌ 取消 Predict 订单异常:`, e.message);
            }
        } else {
            console.log(`[TaskExecutor] 无 Predict 订单需要取消 (task.currentOrderHash: ${task.currentOrderHash || 'none'})`);
        }

        // 撤单后调度延迟结算验证（即使用户取消，也需要检测链上延迟成交并对冲）
        if (orderHashToCancel && ctx) {
            this.schedulePostCancelVerification(ctx, orderHashToCancel, task.type as 'BUY' | 'SELL');
        }

        if (task.currentPolyOrderId) {
            console.log(`[TaskExecutor] 取消 Polymarket 订单: ${task.currentPolyOrderId}`);
            try {
                await this.polyTrader.cancelOrder(task.currentPolyOrderId, {
                    marketTitle: task.title,
                    conditionId: task.polymarketConditionId,
                });
                console.log(`[TaskExecutor] ✅ Polymarket 订单已取消`);
                // 记录订单取消事件（触发 TG 通知）
                await this.taskLogger.logOrderEvent(taskId, 'ORDER_CANCELLED', {
                    platform: 'polymarket',
                    orderId: task.currentPolyOrderId,
                    side: task.type === 'BUY' ? 'BUY' : 'SELL',
                    outcome: task.arbSide === 'YES' ? 'NO' : 'YES',  // 对冲方向相反
                    price: task.avgPolymarketPrice || 0,
                    quantity: task.hedgedQty || 0,
                    filledQty: task.hedgedQty || 0,
                    remainingQty: 0,
                    avgPrice: task.avgPolymarketPrice || 0,
                    cancelReason: 'User cancelled',
                });
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
     * 检查任务是否正在运行
     */
    isTaskRunning(taskId: string): boolean {
        return this.runningTasks.has(taskId);
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

    /**
     * Polymarket WS 断连时暂停所有非体育任务
     *
     * 非体育市场完全依赖 WS 监控 Polymarket 订单簿，
     * WS 断连意味着价格保护失效，必须立即撤单暂停以避免单边风险。
     * WS 自动重连后，价格守护 onPriceValid 会触发恢复。
     */
    private async pauseAllNonSportsTasks(disconnectedTokenId: string): Promise<void> {
        const tasksToPause: string[] = [];
        for (const [taskId, ctx] of this.runningTasks) {
            if (!ctx.task.isSportsMarket && !ctx.isPaused) {
                tasksToPause.push(taskId);
            }
        }

        if (tasksToPause.length === 0) return;

        console.warn(`[TaskExecutor] Polymarket WS 断连 (token: ${disconnectedTokenId.slice(0, 10)}...) → 暂停 ${tasksToPause.length} 个非体育任务`);

        for (const taskId of tasksToPause) {
            const ctx = this.runningTasks.get(taskId);
            if (!ctx || ctx.isPaused) continue;

            ctx.isPaused = true;

            // 取消 Predict 挂单
            let cancelSuccess = false;
            if (ctx.currentOrderHash) {
                try {
                    cancelSuccess = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                    if (cancelSuccess) {
                        await this.taskLogger.logOrderEvent(taskId, 'ORDER_CANCELLED', {
                            platform: 'predict',
                            orderId: ctx.currentOrderHash,
                            side: ctx.task.type,
                            price: ctx.task.predictPrice,
                            quantity: ctx.task.quantity,
                            filledQty: ctx.totalPredictFilled,
                            remainingQty: ctx.task.quantity - ctx.totalPredictFilled,
                            avgPrice: ctx.task.predictPrice,
                            cancelReason: `WS 断连 (token: ${disconnectedTokenId.slice(0, 10)}...)`,
                        }, ctx.currentOrderHash);
                    }
                } catch (e: any) {
                    console.warn(`[TaskExecutor] 取消订单失败 (WS断连暂停): ${e.message}`);
                }
                ctx.predictWatchAbort?.abort();
                ctx.predictWatchAbort = new AbortController();
                if (cancelSuccess) {
                    this.schedulePostCancelVerification(ctx, ctx.currentOrderHash!, ctx.task.type as 'BUY' | 'SELL');
                    ctx.currentOrderHash = undefined;
                }
                // 取消失败时保留 hash，让恢复路径可以重试取消
            }

            const reason = `Polymarket WS 断连 (token: ${disconnectedTokenId.slice(0, 10)}...)`;
            await this.taskLogger.logTaskLifecycle(taskId, 'TASK_PAUSED', {
                status: 'PAUSED',
                previousStatus: ctx.task.status,
                reason,
            });

            const task = this.updateTask(taskId, {
                status: 'PAUSED',
                pauseCount: ctx.task.pauseCount + 1,
                ...(cancelSuccess ? { currentOrderHash: undefined } : {}),
            });
            ctx.task = task;

            console.log(`[TaskExecutor] 任务 ${taskId} 已暂停 (WS断连)`);
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
                // 累计对冲机制
                pendingHedgeQty: 0,
                lastHedgePriceEstimate: task.polymarketMaxAsk || 0.5,
                signal,
                abortController: ctx.abortController,
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
            // Maker 价格安全检查: 等待挂单价 < 卖一价，防止被吃单成交
            let waited = false;
            while (!signal.aborted) {
                const priceCheck = await this.isPredictPriceSafeForMaker(task, 'BUY');
                if (priceCheck.safe) break;
                if (!waited) {
                    console.warn(`[TaskExecutor] Task ${task.id}: Maker BUY 价格不安全 (${priceCheck.reason})，等待卖一价上移后下单`);
                    waited = true;
                }
                await this.delay(1000);
            }
            if (signal.aborted) return;

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
                // 累计对冲机制
                pendingHedgeQty: 0,
                lastHedgePriceEstimate: task.polymarketMinBid || 0.5,
                signal,
                abortController: ctx.abortController,
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
            // Maker 价格安全检查: 等待挂单价 > 买一价，防止被吃单成交
            let waited = false;
            while (!signal.aborted) {
                const priceCheck = await this.isPredictPriceSafeForMaker(task, 'SELL');
                if (priceCheck.safe) break;
                if (!waited) {
                    console.warn(`[TaskExecutor] Task ${task.id}: Maker SELL 价格不安全 (${priceCheck.reason})，等待买一价下移后下单`);
                    waited = true;
                }
                await this.delay(1000);
            }
            if (signal.aborted) return;

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

        // Predict 价格复查: 当 onPriceValid 因 Predict 价格不安全而阻塞时，
        // 使用 generation 计数器确保 onPriceInvalid 能中断旧的复查循环
        let priceGuardGeneration = 0;

        this.orderMonitor.startPriceGuard(
            {
                predictPrice: task.predictPrice,
                polymarketTokenId: hedgeTokenId,
                feeRateBps: 0, // Maker 无费用
                maxPolymarketPrice: maxPrice,
                minPolymarketPrice: minPrice,
                side: side,
                isSportsMarket: task.isSportsMarket,
            },
            {
                onPriceInvalid: async (currentPrice) => {
                    if (signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;

                    priceGuardGeneration++; // 中断旧的 onPriceValid 复查循环

                    const priceType = side === 'BUY' ? 'ask' : 'bid';
                    const threshold = side === 'BUY' ? maxPrice : minPrice;
                    console.log(`[TaskExecutor] Price guard triggered: poly ${priceType}=${currentPrice.toFixed(4)}, threshold=${threshold.toFixed(4)}`);

                    ctx.isPaused = true;

                    // 构造取消原因
                    const priceReasonMsg = side === 'BUY'
                        ? `价格保护: poly ask=${currentPrice.toFixed(4)} > max=${threshold.toFixed(4)}`
                        : `价格保护: poly bid=${currentPrice.toFixed(4)} < min=${threshold.toFixed(4)}`;

                    // Cancel-first: 立即取消 Predict 订单，最高优先级
                    let cancelSuccess = false;
                    if (ctx.currentOrderHash) {
                        try {
                            cancelSuccess = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                            // 取消后查询最终成交量
                            const postStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                            if (postStatus && postStatus.filledQty > ctx.restFilledQty) {
                                ctx.restFilledQty = postStatus.filledQty;
                            }
                            if (postStatus && postStatus.status === 'FILLED') {
                                // 订单已完全成交 (cancel 为 noop)，让主循环处理对冲
                                console.log(`[TaskExecutor] Price guard: order FILLED after cancel → main loop will hedge`);
                                // 日志和快照 fire-and-forget
                                this.taskLogger.logPriceGuard(task.id, 'PRICE_GUARD_TRIGGERED', {
                                    polymarketTokenId: hedgeTokenId,
                                    triggerPrice: currentPrice,
                                    thresholdPrice: threshold,
                                    predictPrice: task.predictPrice,
                                    arbValid: false,
                                    pauseCount: task.pauseCount + 1,
                                }).catch(() => {});
                                this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                                    status: task.status as any,
                                    reason: 'Price guard: order FILLED after cancel (noop), resuming for hedge',
                                }).catch(() => {});
                                ctx.isPaused = false;
                                return;
                            }
                            if (cancelSuccess) {
                                // 正常取消成功 — 日志后置 fire-and-forget
                                this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                                    platform: 'predict',
                                    orderId: ctx.currentOrderHash,
                                    side: side,
                                    price: task.predictPrice,
                                    quantity: task.quantity,
                                    filledQty: ctx.totalPredictFilled,
                                    remainingQty: task.quantity - ctx.totalPredictFilled,
                                    avgPrice: task.predictPrice,
                                    cancelReason: priceReasonMsg,
                                }, ctx.currentOrderHash).catch(() => {});
                            }
                        } catch (e) {
                            console.warn('[TaskExecutor] Failed to cancel order on pause:', e);
                        }
                        // 中断当前的订单监控
                        ctx.predictWatchAbort?.abort();
                        ctx.predictWatchAbort = new AbortController();
                        if (cancelSuccess) {
                            this.schedulePostCancelVerification(ctx, ctx.currentOrderHash!, side);
                            ctx.currentOrderHash = undefined;
                        }
                        // 取消失败时保留 hash，主循环 Fix1 会 REST 轮询检测成交
                    }

                    // 日志和快照后置 (fire-and-forget，不阻塞关键路径)
                    this.taskLogger.logPriceGuard(task.id, 'PRICE_GUARD_TRIGGERED', {
                        polymarketTokenId: hedgeTokenId,
                        triggerPrice: currentPrice,
                        thresholdPrice: threshold,
                        predictPrice: task.predictPrice,
                        arbValid: false,
                        pauseCount: task.pauseCount + 1,
                    }).catch(() => {});
                    this.captureSnapshot(task.id, 'price_guard', task).catch(() => {});

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
                        ...(cancelSuccess ? { currentOrderHash: undefined } : {}),
                    });
                    ctx.task = task;

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

                    // 关键检查：任务可能已在其他地方被取消，不应再提交订单
                    const currentTask = this.taskService.getTask(task.id);
                    const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
                    if (!currentTask || terminalStatuses.includes(currentTask.status)) {
                        console.log(`[TaskExecutor] Task ${task.id} is in terminal state ${currentTask?.status}, skipping order re-submit`);
                        ctx.priceGuardAbort?.abort();
                        return;
                    }

                    // 挂单价格安全检查：确保不会作为 Taker 立即成交
                    // 如果 Predict 价格暂不安全，每秒重试，直到安全或被 onPriceInvalid 中断
                    const gen = priceGuardGeneration;
                    let priceCheck = await this.isPredictPriceSafeForMaker(task, side);
                    while (!priceCheck.safe) {
                        console.log(`[TaskExecutor] Price guard: recovery blocked (${priceCheck.reason}), 1s 后重试`);
                        await this.delay(1000);
                        // 被 onPriceInvalid 中断 (generation 变化) 或信号中止
                        if (gen !== priceGuardGeneration || signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;
                        if (ctx.currentOrderHash) return; // 已有订单 (其他路径提交)
                        priceCheck = await this.isPredictPriceSafeForMaker(task, side);
                    }
                    // 再次检查: 循环退出后可能被中断
                    if (gen !== priceGuardGeneration || signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;

                    // 防重: 深度监控可能在 async 间隙已恢复并提交了订单
                    if (!ctx.isPaused || ctx.currentOrderHash) {
                        console.log(`[TaskExecutor] Price guard resume skipped: already resumed by another path (isPaused=${ctx.isPaused}, hash=${!!ctx.currentOrderHash})`);
                        return;
                    }

                    // 互斥: 防止 onPriceValid 与 checkDepth 并发提交
                    if (ctx.isSubmitting) {
                        console.log(`[TaskExecutor] Price guard resume skipped: another path is submitting`);
                        return;
                    }
                    ctx.isSubmitting = true;

                    const priceType = side === 'BUY' ? 'ask' : 'bid';
                    console.log(`[TaskExecutor] Price valid again: poly ${priceType}=${currentPrice.toFixed(4)}`);

                    try {

                    // 计算剩余量 (原始数量 - 已成交量)
                    const remainingQty = task.quantity - ctx.totalPredictFilled;
                    if (remainingQty <= 0) {
                        console.log(`[TaskExecutor] No remaining quantity, skipping re-submit`);
                        return;
                    }

                    // 检查对冲深度是否足够，避免下单后被深度监控立即暂停
                    const hedgeDepthForResume = await this.getHedgeDepth(hedgeTokenId, side, maxPrice, minPrice, task.isSportsMarket);
                    if (hedgeDepthForResume < 0) {
                        console.log(`[TaskExecutor] Price guard resume: hedge depth API failed, staying paused`);
                        return; // API 失败时保持暂停，等待下一次检查
                    }
                    if (hedgeDepthForResume < remainingQty) {
                        console.log(`[TaskExecutor] Price guard resume: hedge depth insufficient (${hedgeDepthForResume.toFixed(2)} < ${remainingQty}), staying paused`);
                        return; // ctx.isPaused 保持 true，等待深度恢复
                    }

                    // 深度充足，正式恢复
                    ctx.isPaused = false;

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
                            error: undefined, // 清除旧 error (如 "Hedge depth insufficient")
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

                    } finally {
                        ctx.isSubmitting = false;
                    }
                },
                onDepthUnstable: async (flipCount) => {
                    if (signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;
                    if (ctx.phantomDepthDetected) return; // 已触发过，避免重复

                    const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
                    const currentTask = this.taskService.getTask(task.id);
                    if (!currentTask || terminalStatuses.includes(currentTask.status)) return;

                    console.warn(`[TaskExecutor] 🛑 幽灵深度 (WebSocket): 对冲价位深度 30s 内翻转 ${flipCount} 次`);
                    ctx.phantomDepthDetected = true;
                    ctx.isPaused = true;

                    // 取消 Predict 订单，防止继续成交
                    let cancelSuccess = false;
                    if (ctx.currentOrderHash) {
                        try {
                            cancelSuccess = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                            if (cancelSuccess) {
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
                            }
                        } catch (e: any) {
                            console.warn(`[TaskExecutor] ⚠️ 取消 Predict 订单出错: ${e.message}`);
                        }
                        ctx.predictWatchAbort?.abort();
                        ctx.predictWatchAbort = new AbortController();
                        if (cancelSuccess) {
                            ctx.currentOrderHash = undefined;
                        }
                        // 取消失败时保留 hash，让恢复路径可以重试取消
                    }

                    const phantomReason = `幽灵深度: 对冲价位深度 30s 内翻转 ${flipCount} 次，疑似机器人高频挂撤`;

                    // 记录 TASK_PAUSED 生命周期 (触发 SSE taskEvent → 前端 toast)
                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                        status: 'PAUSED',
                        previousStatus: task.status,
                        reason: phantomReason,
                    });

                    task = this.updateTask(task.id, {
                        status: 'PAUSED',
                        pauseCount: task.pauseCount + 1,
                        ...(cancelSuccess ? { currentOrderHash: undefined } : {}),
                        error: phantomReason,
                    });
                    ctx.task = task;
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
        // 基准偏移初始化：
        // - 正常场景（新订单）: base = 已成交总量，rest/wss 从 0 开始累加
        // - 恢复场景（已有 currentOrderHash 且已有成交）:
        //   Predict API filledQty 是“订单累计成交”，不能再叠加 base，否则会双计数
        const isResumingLiveOrderWithHistory = Boolean(ctx.currentOrderHash && ctx.totalPredictFilled > 0);
        if (!isResumingLiveOrderWithHistory) {
            ctx.baseFilledBeforeOrder = ctx.totalPredictFilled;
        }
        // REST 连续失败计数（防止无限静默重试）
        let restConsecutiveFailures = 0;
        const REST_MAX_CONSECUTIVE_FAILURES = 20; // 连续 20 次 (~10s) 后告警

        /**
         * 合并 WSS 和 REST 成交量，更新 totalPredictFilled
         * 规则: total = ctx.baseFilledBeforeOrder + max(wssFilledQty, restFilledQty)
         * 这样重挂订单时不会"低估成交量"
         */
        const mergeFilledQty = (): boolean => {
            const merged = ctx.baseFilledBeforeOrder + Math.max(ctx.wssFilledQty, ctx.restFilledQty);
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
            const preBase = ctx.baseFilledBeforeOrder;
            const preWss = ctx.wssFilledQty;
            const preRest = ctx.restFilledQty;
            mergeFilledQty();
            console.log(`[TaskExecutor] Task ${task.id}: resetForNewOrder merge (prevBase=${preBase.toFixed(2)}, wss=${preWss.toFixed(2)}, rest=${preRest.toFixed(2)}) -> total=${ctx.totalPredictFilled.toFixed(2)}`);

            // 设置基准偏移：当前已累计的成交量
            ctx.baseFilledBeforeOrder = ctx.totalPredictFilled;

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
                        BSC_WATCHER_TIMEOUT
                    );
                    console.log(`[TaskExecutor] Task ${task.id}: WSS watcher registered for ${orderHash.slice(0, 10)}... (base=${ctx.baseFilledBeforeOrder.toFixed(2)})`);
                }
            } catch {
                console.log(`[TaskExecutor] Task ${task.id}: BSC WSS not available for ${orderHash.slice(0, 10)}...`);
            }

            // 重置 REST 连续失败计数，避免旧订单的失败计数影响新订单告警
            restConsecutiveFailures = 0;
        };

        // 初始注册（如果有订单）
        if (ctx.currentOrderHash) {
            // 重要：
            // 恢复已有订单且已有历史成交时，restFilledQty 需要保留“累计成交基线”，
            // 并将 base 置 0，避免 merged = base + rest 造成双计数。
            // 新订单场景仍按原逻辑：base=已有总成交，rest/wss 从 0 开始。
            if (isResumingLiveOrderWithHistory) {
                const baseline = Math.max(ctx.restFilledQty, ctx.totalPredictFilled);
                ctx.baseFilledBeforeOrder = 0;
                ctx.wssFilledQty = 0;
                ctx.restFilledQty = baseline;
                console.log(
                    `[TaskExecutor] Task ${task.id}: resume existing order with historical fills, ` +
                    `baseline=${baseline.toFixed(4)}, base=0`,
                );
            } else {
                ctx.wssFilledQty = 0;
                ctx.restFilledQty = 0;
            }
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
                        BSC_WATCHER_TIMEOUT
                    );
                    console.log(`[TaskExecutor] Task ${task.id}: WSS watcher initialized (base=${ctx.baseFilledBeforeOrder.toFixed(2)})`);
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
                        // 取消失败时订单仍然活跃，继续 REST 轮询以检测成交
                        // 否则 BSC watcher 超时后成交将永远不会被检测到
                        if (!ctx.currentOrderHash) {
                            continue;
                        }
                        // fall through: 对活跃订单执行 REST 轮询
                    } else {
                        wssEventPending = false;
                    }
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

                            // 检查是否应该触发对冲 (考虑 $1 名义金额阈值)
                            const isPredictFullyFilled = orderEventType === 'ORDER_FILLED';
                            const hedgeCheck = await this.checkShouldHedge(ctx, newlyObservedFilled, isPredictFullyFilled);

                            if (hedgeCheck.shouldHedge) {
                                // 价格保护触发后 hash 被清除进入此分支，放宽价格检查优先对冲
                                const hedgeResult = await this.executeIncrementalHedge(ctx, hedgeCheck.hedgeQty, side, ctx.isPaused ? 0.02 : 0);

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

                        // 更新基准偏移并清零增量，避免下次 mergeFilledQty 双重计数
                        console.log(`[TaskExecutor] Task ${task.id}: Order hash -> null, reset increments (base=${ctx.baseFilledBeforeOrder.toFixed(2)}, wss=${ctx.wssFilledQty.toFixed(2)}, rest=${ctx.restFilledQty.toFixed(2)}, total=${ctx.totalPredictFilled.toFixed(2)})`);
                        ctx.baseFilledBeforeOrder = ctx.totalPredictFilled;
                        ctx.wssFilledQty = 0;
                        ctx.restFilledQty = 0;
                        ctx.wssFillEvents.clear();
                        ctx.wssFirstFillTime = undefined;
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
                    restConsecutiveFailures++;
                    if (restConsecutiveFailures === REST_MAX_CONSECUTIVE_FAILURES) {
                        console.error(`[TaskExecutor] ⚠️ Task ${task.id}: REST getOrderStatus 连续 ${restConsecutiveFailures} 次失败，API 可能异常`);
                    } else if (restConsecutiveFailures > 0 && restConsecutiveFailures % 60 === 0) {
                        // 每 60 次 (~30s) 持续告警
                        console.error(`[TaskExecutor] ⚠️ Task ${task.id}: REST getOrderStatus 持续失败 (${restConsecutiveFailures} 次)`);
                    }
                    // REST 失败时也允许 WSS 事件打断等待
                    await Promise.race([this.delay(PREDICT_POLL_INTERVAL), wssEventPromise]);
                    continue;
                }
                restConsecutiveFailures = 0; // 成功后重置

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

                const shouldCheckHedge = (newlyObservedFilled > 0) || status.status === 'FILLED';
                if (shouldCheckHedge) {
                    // 对冲/UNWIND 等关键动作前先刷新 Poly 迟到成交，降低误判触发重复对冲/UNWIND
                    await this.refreshTrackedPolyFills(ctx);

                    // 检查是否应该触发对冲 (考虑 $1 名义金额阈值)
                    const isPredictFullyFilled = status.status === 'FILLED';
                    const hedgeCheck = await this.checkShouldHedge(ctx, newlyObservedFilled, isPredictFullyFilled);

                    // 若 Predict 已完全成交但存在未对冲余量，也需要补齐对冲（否则会卡在 FILLED 状态无法自愈）
                    if (hedgeCheck.shouldHedge) {
                        const hedgeResult = await this.executeIncrementalHedge(ctx, hedgeCheck.hedgeQty, side);

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
                        // 有未对冲的部分
                        const unhedgedQty = ctx.totalPredictFilled - ctx.totalHedged;

                        // 检查是否是深度/价格保护导致的取消 (hash 变化 = guard 已处理, isPaused = guard 正在处理)
                        const isGuardCancel = ctx.currentOrderHash !== watchedOrderHash || ctx.isPaused;
                        const cancelSource = isGuardCancel ? 'guard' : 'external';
                        console.log(`[TaskExecutor] Task ${task.id}: Order ${status.status} with fills (${ctx.totalPredictFilled.toFixed(2)} filled, ${unhedgedQty.toFixed(2)} unhedged), source=${cancelSource}`);

                        // 记录订单取消事件
                        await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                            platform: 'predict',
                            orderId: watchedOrderHash!,
                            side: side,
                            price: task.predictPrice,
                            quantity: task.quantity,
                            filledQty: ctx.totalPredictFilled,
                            remainingQty: task.quantity - ctx.totalPredictFilled,
                            avgPrice: task.predictPrice,
                            cancelReason: `${cancelSource}: ${status.cancelReason || status.status}`,
                            rawResponse: status.rawResponse,
                        }, watchedOrderHash ?? undefined);

                        // 对冲已成交部分 (无论 guard 还是 external，都尝试对冲，绝不触发反向平仓)
                        const hedgeCheck = await this.checkShouldHedge(ctx, unhedgedQty, false);
                        if (hedgeCheck.shouldHedge) {
                            // 价格保护触发后的取消，放宽价格检查优先对冲
                            const hedgeResult = await this.executeIncrementalHedge(ctx, hedgeCheck.hedgeQty, side, ctx.isPaused ? 0.02 : 0);
                            if (hedgeResult.filledQty > 0) {
                                console.log(`[TaskExecutor] Hedge delta after ${cancelSource} cancel: ${hedgeResult.filledQty}, total hedged: ${ctx.totalHedged}`);
                                const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
                                task = this.updateTask(task.id, {
                                    hedgedQty: ctx.totalHedged,
                                    avgPolymarketPrice: avgHedgePrice,
                                    remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                                });
                                ctx.task = task;
                            }
                            if (!hedgeResult.success) {
                                // 对冲失败 — 绝不触发反向平仓，标记错误等待人工处理
                                const hedgeErrorMsg = `Hedge incomplete after ${cancelSource} cancel: ${ctx.totalHedged.toFixed(2)}/${ctx.totalPredictFilled.toFixed(2)} hedged`;
                                console.error(`[TaskExecutor] ${hedgeErrorMsg}`);
                                await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                                    status: 'HEDGE_FAILED',
                                    previousStatus: task.status,
                                    error: new Error(hedgeErrorMsg),
                                });
                                task = this.updateTask(task.id, {
                                    status: 'HEDGE_FAILED',
                                    error: hedgeErrorMsg,
                                });
                                ctx.task = task;
                                return;
                            }
                        }

                        if (isGuardCancel) {
                            // Guard cancel: 继续监控新订单
                            if (ctx.currentOrderHash && ctx.currentOrderHash !== watchedOrderHash) {
                                resetForNewOrder(ctx.currentOrderHash);
                            } else {
                                // isPaused 场景: hash 未变化 (cancel 失败但订单已取消)，清除旧 hash
                                ctx.currentOrderHash = undefined;
                                cancelWatcherIfAny();
                                watchedOrderHash = null;
                            }
                            continue;
                        }

                        // 外部取消 — 仍不触发反向平仓，标记 HEDGE_FAILED 等待人工处理
                        console.error(`[TaskExecutor] External cancel with unhedged position, marking HEDGE_FAILED (no UNWIND)`);
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                            status: 'HEDGE_FAILED',
                            previousStatus: task.status,
                            reason: `External ${status.status} with ${unhedgedQty.toFixed(2)} unhedged`,
                        });
                        task = this.updateTask(task.id, {
                            status: 'HEDGE_FAILED',
                            error: `External ${status.status}: ${unhedgedQty.toFixed(2)} unhedged (hedged: ${ctx.totalHedged.toFixed(2)}/${ctx.totalPredictFilled.toFixed(2)})`,
                        });
                        ctx.task = task;
                        return;
                    } else if (ctx.totalPredictFilled === 0) {
                        // 没有成交，检查是否是深度/价格保护导致的取消
                        // hash 变化 = guard 已处理, isPaused = guard 正在处理 (cancel 失败但订单已取消)
                        if (ctx.currentOrderHash !== watchedOrderHash || ctx.isPaused) {
                            console.log(`[TaskExecutor] Task ${task.id}: Order cancelled by guard (hash changed: ${watchedOrderHash?.slice(0, 10)} → ${ctx.currentOrderHash?.slice(0, 10) || 'null'}), continuing...`);
                            // 记录订单取消事件
                            await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                                platform: 'predict',
                                orderId: watchedOrderHash!,
                                side: side,
                                price: task.predictPrice,
                                quantity: task.quantity,
                                filledQty: 0,
                                remainingQty: task.quantity,
                                avgPrice: task.predictPrice,
                                cancelReason: status.cancelReason,
                                rawResponse: status.rawResponse,
                            }, watchedOrderHash ?? undefined);
                            // 不取消任务，继续监控循环
                            if (ctx.currentOrderHash && ctx.currentOrderHash !== watchedOrderHash) {
                                // 已有新订单，重置监控状态
                                resetForNewOrder(ctx.currentOrderHash);
                            } else {
                                // isPaused 场景或等待新订单提交
                                ctx.currentOrderHash = undefined;
                                cancelWatcherIfAny();
                                watchedOrderHash = null;
                            }
                            continue;
                        }

                        // 订单确实被外部取消（非保护机制），取消任务
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
        side: 'BUY' | 'SELL',
        emergencyBuffer: number = 0
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

        // 捕获订单簿快照 (fire-and-forget，不阻塞对冲下单)
        this.captureSnapshot(task.id, 'hedge_start', task).catch(() => {});

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
                // 防超额对冲: 用全局 totalHedged 重新校准局部 remaining
                // 场景: 上一轮 watchResult 低报/漏报，异步 refresh 或 refreshTrackedPolyFills
                //        已发现"迟到成交"并更新了 ctx.totalHedged，此时 remaining 已过时
                const currentUnhedged = ctx.totalPredictFilled - ctx.totalHedged;
                if (currentUnhedged < MIN_HEDGE_QTY) {
                    console.log(`[TaskExecutor] Hedge calibration: totalHedged=${ctx.totalHedged.toFixed(4)} covers totalPredictFilled=${ctx.totalPredictFilled.toFixed(4)}, done`);
                    break;
                }
                if (currentUnhedged < remaining) {
                    console.log(`[TaskExecutor] Hedge calibration: remaining ${remaining.toFixed(4)} → ${currentUnhedged.toFixed(4)} (async refresh discovered late fills)`);
                    remaining = currentUnhedged;
                }

                // 记录对冲尝试
                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_ATTEMPT', {
                    hedgeQty: remaining,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                    retryCount,
                }, attemptId);

                // 获取当前订单簿
                const orderbook = await this.getPolymarketOrderbook(hedgeTokenId, task.isSportsMarket);
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

                    const maxAllowed = task.polymarketMaxAsk + emergencyBuffer;
                    if (hedgePrice > maxAllowed) {
                        throw new Error(`Hedge price ${hedgePrice} exceeds max ${maxAllowed}${emergencyBuffer > 0 ? ` (incl. emergency buffer ${emergencyBuffer})` : ''}`);
                    }
                } else {
                    // SELL 任务: 卖出 Poly (NO/YES based on isInverted) 对冲
                    if (orderbook.bids.length === 0) {
                        throw new Error('No bids available');
                    }
                    hedgePrice = orderbook.bids[0].price;
                    hedgeSide = 'SELL';

                    const minAllowed = task.polymarketMinBid - emergencyBuffer;
                    if (hedgePrice < minAllowed) {
                        throw new Error(`Hedge price ${hedgePrice} below min ${minAllowed}${emergencyBuffer > 0 ? ` (incl. emergency buffer ${emergencyBuffer})` : ''}`);
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

                // 等待成交（WS+REST 双轨，intervalMs=250 加速 IOC 确认）
                const hedgeResult = await new Promise<OrderWatchResult>((resolve) => {
                    this.orderMonitor.watchPolymarketOrder(
                        polyResult.orderId!,
                        (result) => resolve(result),
                        { intervalMs: 250, maxRetries: 8 }
                    );
                });

                // 信任 watchResult (WS+REST 双轨已确认)，直接用于更新累计
                // 异步启动 refreshSinglePolyFill 做延迟校验（不阻塞下一步决策）
                const watchFilledQty = hedgeResult.filledQty;
                const watchAvgPrice = hedgePrice;

                // 先用 watchResult 立即更新
                const watchDelta = this.applyPolyFillDelta(ctx, polyResult.orderId!, watchFilledQty, watchAvgPrice);

                // 异步校验：不阻塞主流程，发现差异会通过 ctx.totalHedged 传递给下轮校准
                // 注意: watchFilledQty=0 时也必须启动，否则"迟到成交"无法被及时发现
                this.refreshSinglePolyFill(ctx, polyResult.orderId!, {
                    fallbackFilledQty: watchFilledQty,
                    fallbackAvgPrice: watchAvgPrice,
                    force: true,
                }).catch(err => {
                    console.warn(`[TaskExecutor] Async refresh failed for ${polyResult.orderId!.slice(0, 10)}...: ${err.message}`);
                });

                if (watchDelta > 0) {
                    totalFilled += watchDelta;
                    priceSum += watchDelta * watchAvgPrice;
                    remaining -= watchDelta;

                    // 记录 Polymarket 订单成交
                    const orderEventType = remaining <= 0 ? 'ORDER_FILLED' : 'ORDER_PARTIAL_FILL';
                    await this.taskLogger.logOrderEvent(task.id, orderEventType, {
                        platform: 'polymarket',
                        orderId: polyResult.orderId!,
                        side: hedgeSide,
                        price: hedgePrice,
                        quantity: quantity,
                        filledQty: watchFilledQty,
                        remainingQty: remaining,
                        avgPrice: watchAvgPrice,
                    });

                    // 记录部分对冲
                    if (remaining > 0) {
                        await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_PARTIAL', {
                            hedgeQty: watchDelta,
                            totalHedged: ctx.totalHedged,
                            totalPredictFilled: ctx.totalPredictFilled,
                            avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                            retryCount,
                        }, attemptId);
                    }

                    console.log(`[TaskExecutor] Hedge filled (watch): ${watchDelta} @ ${watchAvgPrice.toFixed(4)}`);
                }

                if (remaining <= 0 || remaining < MIN_HEDGE_QTY) {
                    // 对冲成功，清除幽灵深度标记
                    ctx.phantomDepthDetected = false;

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

                // 幽灵深度检测: 订单簿显示有深度但 IOC 0 成交
                // 立即取消 Predict 挂单，防止在对冲重试期间继续成交扩大敞口
                if (watchDelta === 0 && ctx.currentOrderHash) {
                    console.warn(`[TaskExecutor] 🛑 幽灵深度: 订单簿有 ${hedgePrice} asks 但 IOC 0 成交，取消 Predict 订单防止继续成交`);
                    ctx.phantomDepthDetected = true;
                    try {
                        const phantomCancelOk = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                        if (phantomCancelOk) {
                            ctx.currentOrderHash = undefined;
                            console.log(`[TaskExecutor] ✓ Predict 订单已取消 (幽灵深度保护)`);
                        } else {
                            console.warn(`[TaskExecutor] ⚠️ 幽灵深度取消返回 false，保留 hash 待恢复重试`);
                        }
                    } catch (e: any) {
                        console.warn(`[TaskExecutor] ⚠️ 取消 Predict 订单出错: ${e.message}`);
                    }
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
                // watchDelta>0: 已确认成交，快速重试; watchDelta=0: 等异步 refresh 有时间发现迟到成交
                await this.delay(watchDelta > 0 ? 100 : 500);

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
                    await this.delay(Math.min(500 * retryCount, 2000));  // 500ms, 1s, 2s (capped)
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
     * 处理对冲失败 (禁用 UNWIND)
     *
     * 当对冲失败时，不执行反向平仓，仅标记任务状态为 HEDGE_FAILED
     * 用户需要手动处理未对冲的仓位
     */
    private async executeUnwind(ctx: TaskContext): Promise<void> {
        const task = ctx.task;

        // 刷新 Poly 迟到成交，获取准确的未对冲数量
        await this.refreshTrackedPolyFills(ctx);

        const unhedgedQty = ctx.totalPredictFilled - ctx.totalHedged;

        if (unhedgedQty <= 0) {
            console.log('[TaskExecutor] No unhedged position');
            return;
        }

        // 计算潜在损失（仅用于记录）
        const estimatedLoss = this.calculateUnwindLoss(task, ctx, unhedgedQty);

        console.warn(`[TaskExecutor] ⚠️ HEDGE_FAILED: ${unhedgedQty} shares unhedged (Predict filled: ${ctx.totalPredictFilled}, hedged: ${ctx.totalHedged})`);
        console.warn(`[TaskExecutor] ⚠️ UNWIND 已禁用，需要手动处理未对冲仓位`);

        // 记录对冲失败事件
        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
            status: 'HEDGE_FAILED',
            previousStatus: task.status,
            reason: `Hedge failed, ${unhedgedQty} shares unhedged, est. loss: $${estimatedLoss.toFixed(2)} (UNWIND disabled)`,
        });

        // 更新任务状态
        this.updateTask(task.id, {
            status: 'HEDGE_FAILED',
            error: `Hedge failed, ${unhedgedQty} shares unhedged`,
            remainingQty: unhedgedQty,
            completedAt: Date.now(),
        });

        // 生成任务汇总
        await this.taskLogger.generateSummary(task.id, {
            type: task.type,
            marketId: task.marketId,
            title: task.title,
            status: 'HEDGE_FAILED',
            predictFilledQty: ctx.totalPredictFilled,
            hedgedQty: ctx.totalHedged,
            avgPredictPrice: task.predictPrice,
            avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
            actualProfit: 0,
            unwindLoss: 0,  // 未执行 UNWIND，无实际损失
            pauseCount: task.pauseCount,
            hedgeRetryCount: task.hedgeRetryCount,
            createdAt: task.createdAt,
        });
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
     * 检查挂单价格是否安全（不会立即被吃单）
     *
     * BUY: 挂单价 < 卖一价 (确保以 Maker 身份挂在买盘)
     * SELL: 挂单价 > 买一价 (确保以 Maker 身份挂在卖盘)
     *
     * 如果挂单价 >= 卖一价 (BUY) 或 <= 买一价 (SELL)，说明会被立即成交为 Taker
     */
    private async isPredictPriceSafeForMaker(task: Task, side: 'BUY' | 'SELL'): Promise<{ safe: boolean; reason?: string }> {
        try {
            const book = await this.predictTrader.getOrderbook(task.marketId);
            if (!book) {
                // 获取不到订单簿时放行（避免因 API 临时故障永久卡住）
                return { safe: true, reason: 'orderbook unavailable' };
            }

            if (side === 'BUY') {
                // BUY: 挂单价必须 < 卖一价
                const bestAsk = book.asks.length > 0 ? book.asks[0][0] : null;
                if (bestAsk !== null && task.predictPrice >= bestAsk) {
                    return {
                        safe: false,
                        reason: `BUY price ${task.predictPrice} >= bestAsk ${bestAsk}`,
                    };
                }
            } else {
                // SELL: 挂单价必须 > 买一价
                const bestBid = book.bids.length > 0 ? book.bids[0][0] : null;
                if (bestBid !== null && task.predictPrice <= bestBid) {
                    return {
                        safe: false,
                        reason: `SELL price ${task.predictPrice} <= bestBid ${bestBid}`,
                    };
                }
            }

            return { safe: true };
        } catch {
            // 异常时放行
            return { safe: true, reason: 'check failed' };
        }
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
     * @param isSportsMarket 是否是体育市场 (体育市场使用 REST 回退)
     * @returns 在价格范围内的可用深度
     */
    private async getHedgeDepth(
        tokenId: string,
        side: 'BUY' | 'SELL',
        maxPrice: number,
        minPrice: number,
        isSportsMarket: boolean = false
    ): Promise<number> {
        try {
            const orderbook = await this.getPolymarketOrderbook(tokenId, isSportsMarket);
            if (!orderbook) {
                console.warn('[TaskExecutor] getHedgeDepth: orderbook is null (API failed)');
                return -1;  // 返回 -1 表示 API 失败，区别于真正的 0 深度
            }

            let totalDepth = 0;

            // 浮点容差: 1e-9 防止 0.68 <= 0.6799999999999999 判断失败
            const PRICE_EPSILON = 1e-9;

            if (side === 'BUY') {
                // 买入时看 asks，累计价格 <= maxPrice 的深度
                const bestAsk = orderbook.asks[0]?.price;
                for (const ask of orderbook.asks) {
                    if (ask.price <= maxPrice + PRICE_EPSILON) {
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
                    if (bid.price >= minPrice - PRICE_EPSILON) {
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
        const DEPTH_CHECK_INTERVAL = 1000; // 1秒检查一次
        const DEPTH_EXPAND_COOLDOWN_MS = 10_000; // 扩增冷却期，防止扩缩振荡

        const checkDepth = async () => {
            if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;

            // 检查任务是否已进入终态，避免在取消后继续操作
            const currentTask = this.taskService.getTask(ctx.task.id);
            const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
            if (!currentTask || terminalStatuses.includes(currentTask.status)) {
                console.log(`[TaskExecutor] Depth monitor: task ${ctx.task.id} in terminal state ${currentTask?.status}, stopping`);
                return;
            }

            if (ctx.isPaused) {
                // 暂停时检查深度是否已恢复，如果恢复则重新提交订单
                // 以 totalQuantity 为上限，恢复到深度支持的最大数量
                const task = ctx.task;
                const originalRemaining = task.totalQuantity - ctx.totalPredictFilled;
                if (originalRemaining > 0) {
                    let recoveredDepth = await this.getHedgeDepth(hedgeTokenId, side, maxPrice, minPrice, task.isSportsMarket);
                    // API 失败 (返回 -1)，跳过本次检查
                    if (recoveredDepth < 0) {
                        setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                        return;
                    }
                    const recoverableQty = Math.min(originalRemaining, Math.floor(recoveredDepth));
                    if (recoverableQty > 0) {
                        // 挂单价格安全检查：确保不会作为 Taker 立即成交
                        const priceCheck = await this.isPredictPriceSafeForMaker(task, side);
                        if (!priceCheck.safe) {
                            console.log(`[TaskExecutor] Depth recovered but price unsafe (${priceCheck.reason}), staying PAUSED`);
                            setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                            return;
                        }

                        // 防重: onPriceValid 可能在 async 间隙已恢复并提交了订单
                        if (!ctx.isPaused || ctx.currentOrderHash) {
                            console.log(`[TaskExecutor] Depth resume skipped: already resumed by another path (isPaused=${ctx.isPaused}, hash=${!!ctx.currentOrderHash})`);
                            setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                            return;
                        }

                        // 互斥: 防止 onPriceValid 与 checkDepth 并发提交
                        if (ctx.isSubmitting) {
                            console.log(`[TaskExecutor] Depth resume skipped: another path is submitting`);
                            setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                            return;
                        }
                        ctx.isSubmitting = true;

                        // 深度恢复：更新 task.quantity 到深度支持的量（不超过 totalQuantity）
                        const oldQuantity = task.quantity;
                        const newQuantity = ctx.totalPredictFilled + recoverableQty;
                        console.log(`[TaskExecutor] Depth recovered: ${recoveredDepth.toFixed(2)}, resumable=${recoverableQty}, resuming task`);

                        try {
                        // 重新提交 Predict 订单
                        const taskWithRemaining = { ...task, quantity: recoverableQty };
                        const result = await this.submitPredictOrder(taskWithRemaining, side);
                        if (result.success) {
                            ctx.isPaused = false;
                            ctx.currentOrderHash = result.hash;

                            await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                                platform: 'predict',
                                orderId: result.hash!,
                                side: side,
                                price: task.predictPrice,
                                quantity: recoverableQty,
                                filledQty: 0,
                                remainingQty: recoverableQty,
                                avgPrice: 0,
                            }, result.hash);

                            // 如果 quantity 有扩增，记录 DEPTH_RESTORED
                            if (newQuantity > oldQuantity) {
                                await this.taskLogger.logTaskLifecycle(task.id, 'DEPTH_RESTORED', {
                                    status: 'PREDICT_SUBMITTED',
                                    reason: `Depth recovered: ${oldQuantity} → ${newQuantity} (depth=${recoveredDepth.toFixed(2)})`,
                                });
                            }

                            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                                status: 'PREDICT_SUBMITTED',
                                previousStatus: 'PAUSED',
                                reason: `Depth recovered: ${recoveredDepth.toFixed(2)} shares, qty=${newQuantity}`,
                            });

                            ctx.task = this.updateTask(task.id, {
                                status: 'PREDICT_SUBMITTED',
                                quantity: newQuantity,
                                currentOrderHash: result.hash,
                                error: undefined,
                            });
                        } else {
                            console.warn(`[TaskExecutor] Depth recovered but re-submit failed: ${result.error}, staying PAUSED`);
                            // isPaused 未变，保持 PAUSED，下一轮 checkDepth 重试
                        }
                        } finally {
                            ctx.isSubmitting = false;
                        }
                    }
                }
                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                return;
            }

            const task = ctx.task;
            const remainingQty = task.quantity - ctx.totalPredictFilled;

            if (remainingQty <= 0) return; // 已完成，无需监控

            let hedgeDepth = await this.getHedgeDepth(hedgeTokenId, side, maxPrice, minPrice, task.isSportsMarket);

            // API 失败 (返回 -1)，跳过本次检查，继续监控
            if (hedgeDepth < 0) {
                console.warn('[TaskExecutor] Depth check skipped (API failed), will retry');
                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                return;
            }

            // 幽灵深度: 对冲 IOC 已报告 0 成交但订单簿显示有深度
            // 视实际可用深度为 0，触发 PAUSE 取消 Predict 订单
            if (ctx.phantomDepthDetected && hedgeDepth > 0) {
                console.warn(`[TaskExecutor] 🛑 Depth monitor: phantom depth override (orderbook=${hedgeDepth.toFixed(2)} → 0)`);
                hedgeDepth = 0;
            }

            // 如果深度充足（>= 剩余挂单量）
            if (hedgeDepth >= remainingQty) {
                // 检查是否可以向上扩增：quantity 被缩减过且深度能支持更多
                if (task.quantity < task.totalQuantity) {
                    const cooldownElapsed = !ctx.lastDepthAdjustTime || (Date.now() - ctx.lastDepthAdjustTime >= DEPTH_EXPAND_COOLDOWN_MS);
                    if (cooldownElapsed) {
                        const originalRemaining = task.totalQuantity - ctx.totalPredictFilled;
                        const expandableQty = Math.min(originalRemaining, Math.floor(hedgeDepth));
                        if (expandableQty > remainingQty) {
                            // 深度支持更多量，取消当前订单并扩增重下
                            console.log(`[TaskExecutor] Depth expand: depth=${hedgeDepth.toFixed(2)} supports ${expandableQty} > current remaining ${remainingQty}`);

                            let cancelSuccess = false;
                            if (ctx.currentOrderHash) {
                                try {
                                    // 取消前先检查订单是否已 FILLED，避免对已成交订单的误操作
                                    const preStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                                    if (preStatus && preStatus.filledQty > ctx.restFilledQty) {
                                        ctx.restFilledQty = preStatus.filledQty;
                                    }
                                    if (preStatus && preStatus.status === 'FILLED') {
                                        console.log(`[TaskExecutor] Depth expand: order already FILLED, skip expand → main loop will hedge`);
                                        setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                                        return;
                                    }
                                    cancelSuccess = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                                    if (cancelSuccess) {
                                        // 取消后确认最终成交量
                                        const postStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                                        if (postStatus && postStatus.filledQty > ctx.restFilledQty) {
                                            ctx.restFilledQty = postStatus.filledQty;
                                        }
                                        if (postStatus && postStatus.status === 'FILLED') {
                                            console.log(`[TaskExecutor] Depth expand: cancel noop but order FILLED → main loop will hedge`);
                                            setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                                            return;
                                        }
                                        await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                                            platform: 'predict',
                                            orderId: ctx.currentOrderHash,
                                            side: side,
                                            price: task.predictPrice,
                                            quantity: remainingQty,
                                            filledQty: ctx.totalPredictFilled,
                                            remainingQty: 0,
                                            avgPrice: task.predictPrice,
                                            cancelReason: `深度扩增: ${task.quantity} → ${ctx.totalPredictFilled + expandableQty} (depth=${hedgeDepth.toFixed(2)})`,
                                        }, ctx.currentOrderHash);
                                    }
                                } catch (e) {
                                    console.warn('[TaskExecutor] Failed to cancel order on depth expand:', e);
                                }
                                ctx.predictWatchAbort?.abort();
                                ctx.predictWatchAbort = new AbortController();
                                if (cancelSuccess) {
                                    ctx.currentOrderHash = undefined;
                                } else {
                                    // 取消失败，跳过本次扩增
                                    setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                                    return;
                                }
                            }

                            // 互斥
                            if (ctx.isSubmitting) {
                                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                                return;
                            }
                            ctx.isSubmitting = true;

                            try {
                                const oldQuantity = task.quantity;
                                const newQuantity = ctx.totalPredictFilled + expandableQty;
                                ctx.lastDepthAdjustTime = Date.now();

                                const taskWithExpandedQty = { ...task, quantity: expandableQty };
                                const result = await this.submitPredictOrder(taskWithExpandedQty, side);
                                if (result.success) {
                                    ctx.currentOrderHash = result.hash;
                                    const updatedTask = this.updateTask(task.id, {
                                        quantity: newQuantity,
                                        status: 'PREDICT_SUBMITTED',
                                        currentOrderHash: result.hash,
                                    });
                                    ctx.task = updatedTask;

                                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                                        platform: 'predict',
                                        orderId: result.hash!,
                                        side: side,
                                        price: task.predictPrice,
                                        quantity: expandableQty,
                                        filledQty: 0,
                                        remainingQty: expandableQty,
                                        avgPrice: 0,
                                    }, result.hash);

                                    await this.taskLogger.logTaskLifecycle(task.id, 'DEPTH_RESTORED', {
                                        status: 'PREDICT_SUBMITTED',
                                        reason: `Depth expanded: ${oldQuantity} → ${newQuantity} (depth=${hedgeDepth.toFixed(2)})`,
                                    });
                                } else {
                                    console.warn(`[TaskExecutor] Depth expand submit failed: ${result.error}, keeping current state`);
                                    // 提交失败: quantity 未修改, currentOrderHash 已清除(cancel 已成功)
                                    // 下一轮 checkDepth: 深度充足→再次进入扩增分支→冷却期(10s)后重试
                                }
                            } finally {
                                ctx.isSubmitting = false;
                            }
                        }
                    }
                }
                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                return;
            }

            // 深度不足，需要调整
            console.log(`[TaskExecutor] Depth guard triggered: depth=${hedgeDepth.toFixed(2)}, remaining=${remainingQty}`);
            ctx.lastDepthAdjustTime = Date.now();

            // 计算新的目标数量 = 已成交量 + 可用深度
            const newQuantity = ctx.totalPredictFilled + Math.floor(hedgeDepth);

            if (newQuantity <= ctx.totalPredictFilled) {
                // 深度为 0，需要暂停
                console.warn(`[TaskExecutor] No hedge depth available (depth=${hedgeDepth}), pausing task`);
                ctx.isPaused = true;

                // 取消当前订单
                const depthReason = ctx.phantomDepthDetected
                    ? `幽灵深度: IOC 0 成交 (订单簿显示 ${hedgeDepth.toFixed(2)})`
                    : `深度保护: depth=${hedgeDepth.toFixed(2)} < remaining=${remainingQty}`;
                let cancelSuccess = false;
                if (ctx.currentOrderHash) {
                    try {
                        // 取消前先查订单状态，避免取消已成交订单
                        const preStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                        if (preStatus && preStatus.filledQty > ctx.restFilledQty) {
                            ctx.restFilledQty = preStatus.filledQty;
                        }
                        // 订单已完全成交，跳过取消，让主循环处理对冲
                        if (preStatus && preStatus.status === 'FILLED') {
                            console.log(`[TaskExecutor] Depth guard: order already FILLED, skip cancel → main loop will hedge`);
                            this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                                status: task.status as any,
                                reason: 'Depth guard: order already FILLED before cancel, resuming for hedge',
                            }).catch(() => {});
                            ctx.isPaused = false;
                            setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                            return;
                        }
                        cancelSuccess = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                        if (cancelSuccess) {
                            // 取消后再查一次确认最终成交量 (处理竞态: cancel noop 但订单实际已成交)
                            const postStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                            if (postStatus && postStatus.filledQty > ctx.restFilledQty) {
                                ctx.restFilledQty = postStatus.filledQty;
                            }
                            if (postStatus && postStatus.status === 'FILLED') {
                                // cancel 返回 noop 但订单实际已成交，让主循环处理对冲
                                console.log(`[TaskExecutor] Depth guard: cancel noop but order FILLED → main loop will hedge`);
                                this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                                    status: task.status as any,
                                    reason: 'Depth guard: order FILLED after cancel (noop), resuming for hedge',
                                }).catch(() => {});
                                ctx.isPaused = false;
                                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                                return;
                            }
                            await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                                platform: 'predict',
                                orderId: ctx.currentOrderHash,
                                side: side,
                                price: task.predictPrice,
                                quantity: remainingQty,
                                filledQty: ctx.totalPredictFilled,
                                remainingQty: 0,
                                avgPrice: task.predictPrice,
                                cancelReason: depthReason,
                            }, ctx.currentOrderHash);
                        }
                    } catch (e) {
                        console.warn('[TaskExecutor] Failed to cancel order on depth guard:', e);
                    }
                    ctx.predictWatchAbort?.abort();
                    ctx.predictWatchAbort = new AbortController();
                    if (cancelSuccess) {
                        this.schedulePostCancelVerification(ctx, ctx.currentOrderHash!, side);
                        ctx.currentOrderHash = undefined;
                    }
                    // 取消失败时保留 hash，让恢复路径可以重试取消
                }

                // 记录深度暂停生命周期事件 (之前缺失，导致排障链路不完整)
                await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                    status: 'PAUSED',
                    previousStatus: task.status,
                    reason: depthReason,
                });

                this.updateTask(task.id, {
                    status: 'PAUSED',
                    ...(cancelSuccess ? { currentOrderHash: undefined } : {}),
                    error: `Hedge depth insufficient: ${hedgeDepth.toFixed(2)}`,
                });

                // 继续监控，等待深度恢复
                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                return;
            }

            // 深度部分可用，调整数量
            console.log(`[TaskExecutor] Adjusting task quantity: ${task.quantity} → ${newQuantity}`);

            // 取消当前订单
            let depthAdjustCancelSuccess = false;
            if (ctx.currentOrderHash) {
                try {
                    depthAdjustCancelSuccess = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                    if (depthAdjustCancelSuccess) {
                        await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                            platform: 'predict',
                            orderId: ctx.currentOrderHash,
                            side: side,
                            price: task.predictPrice,
                            quantity: remainingQty,
                            filledQty: ctx.totalPredictFilled,
                            remainingQty: 0,
                            avgPrice: task.predictPrice,
                            cancelReason: `深度调整: ${task.quantity} → ${newQuantity} (depth=${hedgeDepth.toFixed(2)})`,
                        }, ctx.currentOrderHash);
                    }
                } catch (e) {
                    console.warn('[TaskExecutor] Failed to cancel order on depth adjustment:', e);
                }
                ctx.predictWatchAbort?.abort();
                ctx.predictWatchAbort = new AbortController();
                if (depthAdjustCancelSuccess) {
                    ctx.currentOrderHash = undefined;
                } else {
                    // 取消失败，不能安全地重新下单，跳过本次调整
                    console.warn('[TaskExecutor] Depth adjustment skipped: cancel failed, retaining current order');
                    setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                    return;
                }
            }

            // 更新任务数量
            const updatedTask = this.updateTask(task.id, {
                quantity: newQuantity,
            });
            ctx.task = updatedTask;

            // 重新下单前再次检查任务状态（取消订单后可能触发任务取消）
            const taskBeforeResubmit = this.taskService.getTask(ctx.task.id);
            if (!taskBeforeResubmit || terminalStatuses.includes(taskBeforeResubmit.status)) {
                console.log(`[TaskExecutor] Depth adjustment: task ${ctx.task.id} became ${taskBeforeResubmit?.status} after order cancel, aborting resubmit`);
                return;
            }

            // 互斥: 防止并发提交
            if (ctx.isSubmitting) {
                console.log(`[TaskExecutor] Depth adjustment skipped: another path is submitting`);
                setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
                return;
            }
            ctx.isSubmitting = true;

            try {
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
            } finally {
                ctx.isSubmitting = false;
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

    // ========================================================================
    // 延迟结算填充检测
    // ========================================================================

    /**
     * 撤单后调度延迟结算验证
     *
     * Predict 使用 BSC 链上结算，off-chain CLOB 匹配和 on-chain 结算之间存在 3-30 秒窗口。
     * 撤单后 getOrderStatus 返回的 filledQty 可能过时（链上未确认），导致成交丢失。
     * 此方法在撤单后每 5 秒查一次订单状态，持续 30 秒，检测延迟到达的成交并紧急对冲。
     *
     * 关键设计：定时器不依赖 signal.aborted，即使用户取消任务也会继续运行直到超时。
     */
    private schedulePostCancelVerification(
        ctx: TaskContext,
        orderHash: string,
        side: 'BUY' | 'SELL'
    ): void {
        const task = ctx.task;
        const baseQty = ctx.totalPredictFilled;

        ctx.cancelledOrderHash = orderHash;
        ctx.cancelledOrderBaseQty = baseQty;

        let checks = 0;
        const MAX_CHECKS = 6;
        const INTERVAL = 5000;

        console.log(`[TaskExecutor] 📋 调度延迟结算验证: task=${task.id}, hash=${orderHash.slice(0, 16)}..., baseQty=${baseQty.toFixed(2)}, 每${INTERVAL / 1000}s检查一次, 共${MAX_CHECKS}次`);

        const verify = async () => {
            checks++;
            try {
                const status = await this.predictTrader.getOrderStatus(orderHash);
                if (!status) {
                    console.log(`[TaskExecutor] 延迟验证 ${checks}/${MAX_CHECKS}: hash=${orderHash.slice(0, 16)}... 状态查询失败，跳过`);
                    if (checks < MAX_CHECKS) {
                        ctx.cancelSettlementTimer = setTimeout(verify, INTERVAL);
                    } else {
                        this.cleanupCancelVerification(ctx);
                    }
                    return;
                }

                if (status.filledQty > baseQty) {
                    const delta = status.filledQty - baseQty;

                    console.warn(`[TaskExecutor] 🚨 延迟结算检测: task=${task.id}, hash=${orderHash.slice(0, 16)}..., 新增成交=${delta.toFixed(2)} (${baseQty.toFixed(2)} → ${status.filledQty.toFixed(2)})`);

                    // 更新跟踪
                    ctx.totalPredictFilled += delta;
                    ctx.baseFilledBeforeOrder = ctx.totalPredictFilled;
                    ctx.cancelledOrderBaseQty = status.filledQty;

                    this.updateTask(task.id, {
                        predictFilledQty: ctx.totalPredictFilled,
                        remainingQty: task.quantity - ctx.totalPredictFilled,
                    });

                    // 记录 DELAYED_FILL_DETECTED 事件（触发 Telegram 通知）
                    this.taskLogger.logTaskLifecycle(task.id, 'DELAYED_FILL_DETECTED', {
                        status: task.status as any,
                        reason: `延迟结算: hash=${orderHash.slice(0, 16)}..., 新增${delta.toFixed(2)}股 (总成交 ${ctx.totalPredictFilled.toFixed(2)}/${task.quantity})`,
                    }).catch(() => {});

                    // 记录 Predict 订单部分成交事件
                    this.taskLogger.logOrderEvent(task.id, 'ORDER_PARTIAL_FILL', {
                        platform: 'predict',
                        orderId: orderHash,
                        side: side,
                        price: task.predictPrice,
                        quantity: task.quantity,
                        filledQty: status.filledQty,
                        remainingQty: task.quantity - status.filledQty,
                        avgPrice: task.predictPrice,
                        cancelReason: '延迟结算',
                    }, orderHash).catch(() => {});

                    // 紧急对冲
                    this.emergencyHedgeDelayedFills(ctx, delta, side).catch(err => {
                        console.error(`[TaskExecutor] 延迟成交紧急对冲异常: ${err.message}`);
                    });
                }

                if (checks < MAX_CHECKS) {
                    ctx.cancelSettlementTimer = setTimeout(verify, INTERVAL);
                } else {
                    console.log(`[TaskExecutor] 延迟验证完成: task=${task.id}, hash=${orderHash.slice(0, 16)}..., 共${MAX_CHECKS}次检查`);
                    this.cleanupCancelVerification(ctx);
                }
            } catch (err: any) {
                console.warn(`[TaskExecutor] 延迟验证异常 ${checks}/${MAX_CHECKS}: ${err.message}`);
                if (checks < MAX_CHECKS) {
                    ctx.cancelSettlementTimer = setTimeout(verify, INTERVAL);
                } else {
                    this.cleanupCancelVerification(ctx);
                }
            }
        };

        // 如果已有定时器（重复撤单），先清除
        if (ctx.cancelSettlementTimer) {
            clearTimeout(ctx.cancelSettlementTimer);
        }
        ctx.cancelSettlementTimer = setTimeout(verify, INTERVAL);
    }

    /**
     * 清理延迟结算验证状态
     */
    private cleanupCancelVerification(ctx: TaskContext): void {
        ctx.cancelledOrderHash = undefined;
        ctx.cancelledOrderBaseQty = undefined;
        ctx.cancelSettlementTimer = undefined;
    }

    /**
     * 延迟成交紧急对冲
     *
     * 独立于主对冲流程，不检查 signal.aborted。
     * 在延迟结算验证检测到新成交后立即执行，放宽价格保护 (+0.02) 优先平仓。
     */
    private async emergencyHedgeDelayedFills(
        ctx: TaskContext,
        fillQty: number,
        side: 'BUY' | 'SELL'
    ): Promise<void> {
        const task = ctx.task;
        const unhedgedQty = ctx.totalPredictFilled - ctx.totalHedged;

        if (unhedgedQty < MIN_HEDGE_QTY) {
            console.log(`[TaskExecutor] 紧急对冲: 未对冲数量 ${unhedgedQty.toFixed(2)} < ${MIN_HEDGE_QTY}，跳过`);
            return;
        }

        const hedgeTokenId = this.getHedgeTokenId(task);
        const attemptId = `emergency-${Math.random().toString(36).substring(2, 8)}`;

        console.warn(`[TaskExecutor] 🚨 紧急对冲启动: task=${task.id}, unhedged=${unhedgedQty.toFixed(2)}, side=${side}`);

        await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
            hedgeQty: unhedgedQty,
            totalHedged: ctx.totalHedged,
            totalPredictFilled: ctx.totalPredictFilled,
            avgHedgePrice: 0,
            retryCount: 0,
            reason: 'delayed fill emergency',
        }, attemptId);

        for (let retry = 0; retry < 3; retry++) {
            try {
                const orderbook = await this.getPolymarketOrderbook(hedgeTokenId, task.isSportsMarket);
                if (!orderbook) {
                    console.warn(`[TaskExecutor] 紧急对冲: 获取订单簿失败 (retry ${retry + 1}/3)`);
                    await this.delay(2000);
                    continue;
                }

                let hedgePrice: number;
                let hedgeSide: 'BUY' | 'SELL';

                if (side === 'BUY') {
                    if (orderbook.asks.length === 0) {
                        console.warn(`[TaskExecutor] 紧急对冲: 无 asks (retry ${retry + 1}/3)`);
                        await this.delay(2000);
                        continue;
                    }
                    hedgePrice = orderbook.asks[0].price;
                    hedgeSide = 'BUY';

                    // 放宽价格保护 (+0.02) 优先平仓
                    const maxAllowed = task.polymarketMaxAsk + 0.02;
                    if (hedgePrice > maxAllowed) {
                        console.warn(`[TaskExecutor] 紧急对冲: ask ${hedgePrice.toFixed(4)} > maxAllowed ${maxAllowed.toFixed(4)} (retry ${retry + 1}/3)`);
                        await this.delay(2000);
                        continue;
                    }
                } else {
                    if (orderbook.bids.length === 0) {
                        console.warn(`[TaskExecutor] 紧急对冲: 无 bids (retry ${retry + 1}/3)`);
                        await this.delay(2000);
                        continue;
                    }
                    hedgePrice = orderbook.bids[0].price;
                    hedgeSide = 'SELL';

                    // 放宽价格保护 (-0.02) 优先平仓
                    const minAllowed = task.polymarketMinBid - 0.02;
                    if (hedgePrice < minAllowed) {
                        console.warn(`[TaskExecutor] 紧急对冲: bid ${hedgePrice.toFixed(4)} < minAllowed ${minAllowed.toFixed(4)} (retry ${retry + 1}/3)`);
                        await this.delay(2000);
                        continue;
                    }
                }

                // 重新计算未对冲数量（对冲可能在并发中进行）
                const currentUnhedged = ctx.totalPredictFilled - ctx.totalHedged;
                if (currentUnhedged < MIN_HEDGE_QTY) {
                    console.log(`[TaskExecutor] 紧急对冲: 已被其他路径对冲 (unhedged=${currentUnhedged.toFixed(2)})`);
                    return;
                }

                const hedgeQty = currentUnhedged;

                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_ATTEMPT', {
                    hedgeQty,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    avgHedgePrice: 0,
                    retryCount: retry,
                    reason: 'delayed fill emergency',
                }, attemptId);

                const polyResult = await this.polyTrader.placeOrder({
                    tokenId: hedgeTokenId,
                    side: hedgeSide,
                    price: hedgePrice,
                    quantity: hedgeQty,
                    orderType: 'IOC',
                    negRisk: task.negRisk,
                    marketTitle: task.title,
                    conditionId: task.polymarketConditionId,
                });

                if (!polyResult.success) {
                    console.warn(`[TaskExecutor] 紧急对冲: 下单失败 ${polyResult.error} (retry ${retry + 1}/3)`);
                    await this.delay(2000);
                    continue;
                }

                // 等待成交确认
                const hedgeResult = await new Promise<OrderWatchResult>((resolve) => {
                    this.orderMonitor.watchPolymarketOrder(
                        polyResult.orderId!,
                        (result) => resolve(result),
                        { intervalMs: 250, maxRetries: 8 }
                    );
                });

                const watchDelta = this.applyPolyFillDelta(ctx, polyResult.orderId!, hedgeResult.filledQty, hedgePrice);

                if (watchDelta > 0) {
                    console.log(`[TaskExecutor] ✅ 紧急对冲成交: ${watchDelta.toFixed(2)} @ ${hedgePrice.toFixed(4)}, totalHedged=${ctx.totalHedged.toFixed(2)}`);

                    await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_COMPLETED', {
                        hedgeQty: watchDelta,
                        totalHedged: ctx.totalHedged,
                        totalPredictFilled: ctx.totalPredictFilled,
                        avgHedgePrice: hedgePrice,
                        retryCount: retry,
                        reason: 'delayed fill emergency',
                    }, attemptId);

                    const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
                    this.updateTask(task.id, {
                        hedgedQty: ctx.totalHedged,
                        avgPolymarketPrice: avgHedgePrice,
                        remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                    });
                    return;
                }

                // IOC 0 成交，重试
                console.warn(`[TaskExecutor] 紧急对冲: IOC 0 成交 (retry ${retry + 1}/3)`);
                await this.delay(2000);
            } catch (err: any) {
                console.error(`[TaskExecutor] 紧急对冲异常: ${err.message} (retry ${retry + 1}/3)`);
                await this.delay(2000);
            }
        }

        // 所有重试失败
        console.error(`[TaskExecutor] 🚨 紧急对冲失败: task=${task.id}, unhedged=${unhedgedQty.toFixed(2)}`);
        await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
            hedgeQty: unhedgedQty,
            totalHedged: ctx.totalHedged,
            totalPredictFilled: ctx.totalPredictFilled,
            avgHedgePrice: 0,
            retryCount: 3,
            reason: 'delayed fill emergency hedge failed after 3 retries',
        }, attemptId);
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
            // WS 缓存短路: 先查 WS 缓存（同步，0ms），终态直接返回，避免 REST poll 的 2.4s
            const wsCached = this.polyTrader.getWsCachedFillStatus(orderId);
            if (wsCached && wsCached.isTerminal) {
                const filledQty = wsCached.filledQty > 0 ? wsCached.filledQty
                    : (options?.fallbackFilledQty ?? current.filledQty);
                const avgPrice = options?.fallbackAvgPrice ?? current.avgPrice;
                const delta = this.applyPolyFillDelta(ctx, orderId, filledQty, avgPrice);
                const updated = ctx.polyOrderFills.get(orderId)!;
                updated.isTerminal = true;  // 标记终态，后续 refreshTrackedPolyFills 跳过

                if (delta > 0) {
                    const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
                    ctx.task = this.updateTask(ctx.task.id, {
                        hedgedQty: ctx.totalHedged,
                        avgPolymarketPrice: avgHedgePrice,
                        remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                    });
                }

                return { filledQty: updated.filledQty, avgPrice: updated.avgPrice, delta };
            }

            // WS 缓存未命中或非终态，降级到 REST poll
            const status = await this.polyTrader.pollOrderStatus(
                orderId,
                POLY_FILL_RECHECK_MAX_RETRIES,
                POLY_FILL_RECHECK_INTERVAL_MS
            );

            const filledQty = status?.filledQty ?? options?.fallbackFilledQty ?? current.filledQty;
            const avgPrice = options?.fallbackAvgPrice ?? current.avgPrice;
            const delta = this.applyPolyFillDelta(ctx, orderId, filledQty, avgPrice);
            const updated = ctx.polyOrderFills.get(orderId)!;

            // REST poll 也标记终态
            if (status?.status === 'MATCHED' || status?.status === 'CANCELLED') {
                updated.isTerminal = true;
            }

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

        // 顺序刷新，跳过已确认终态的订单
        for (const [orderId, tracker] of ctx.polyOrderFills) {
            if (tracker.isTerminal) continue;
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
            const polyBook = await this.getPolymarketOrderbook(hedgeTokenId, task.isSportsMarket);

            // 构建快照数据
            const polyBookData = polyBook ? {
                bids: polyBook.bids.map(b => [b.price, b.size] as [number, number]),
                asks: polyBook.asks.map(a => [a.price, a.size] as [number, number]),
                updateTimestampMs: Date.now(),
            } : null;

            // 计算套利指标
            // MAKER 模式不需要手续费，TAKER 模式需要计算手续费
            const bestPolyAsk = polyBook?.asks[0]?.price ?? 1;
            const isTaker = task.strategy === 'TAKER';
            const predictFee = isTaker && task.feeRateBps
                ? calculatePredictFee(task.predictPrice, task.feeRateBps)
                : 0;
            const totalCost = task.predictPrice + bestPolyAsk + predictFee;
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
