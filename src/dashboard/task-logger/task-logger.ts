/**
 * 任务日志系统 - 核心服务
 *
 * 功能：
 * - 异步队列 + 批量 flush
 * - JSONL 追加写入
 * - 订单簿快照
 * - 7天日志清理
 * - 退出时 flush
 * - 敏感信息脱敏
 * - 通知集成
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
    TaskLogEvent,
    TaskLogEventType,
    OrderBookSnapshot,
    TaskSummary,
    TaskConfigSnapshot,
    ArbOpportunitySnapshot,
    TrimmedOrderBook,
    ArbMetrics,
    StructuredError,
    EventPriority,
    SnapshotTrigger,
    TaskLoggerConfig,
    DEFAULT_LOGGER_CONFIG,
    LOG_SCHEMA_VERSION,
    PRIORITY_LEVEL,
    EVENT_PRIORITY_MAP,
    NOTIFY_EVENTS,
    TaskLifecycleEventType,
    TaskLifecyclePayload,
    OrderEventType,
    OrderEventPayload,
    PriceGuardEventType,
    PriceGuardPayload,
    HedgeEventType,
    HedgePayload,
    UnwindEventType,
    UnwindPayload,
    // 集中管理的枚举类型
    CostGuardStopReason,
    CostCheckTriggerSource,
    TaskCancelReason,
} from './types.js';
import { TaskStatus } from '../types.js';

// ============================================================================
// 队列项类型
// ============================================================================

interface QueueItem {
    type: 'event' | 'snapshot';
    taskId: string;
    data: TaskLogEvent | OrderBookSnapshot;
    priority: EventPriority;
}

// ============================================================================
// 枚举显示辅助函数 (带 fallback，未知值不崩溃)
// ============================================================================

/** 成本守护停止原因 -> 显示文本 */
const COST_GUARD_REASON_LABELS: Record<string, string> = {
    COST_EXCEEDED: '成本超限',
    COST_INVALID: '成本失效',
    ORDER_FILLED: '订单成交',
    ORDER_CANCELLED: '订单取消',
    TASK_COMPLETED: '任务完成',
};

/** 任务取消原因 -> 显示文本 */
const TASK_CANCEL_REASON_LABELS: Record<string, string> = {
    ORDER_TIMEOUT: '订单超时',
    COST_INVALID: '成本失效',
    USER_CANCELLED: '用户取消',
};

/**
 * 安全获取 reason 显示文本（未知值返回原值 + 标记）
 * 前端/日志消费方应使用此函数，避免未知枚举导致崩溃
 */
export function formatReasonLabel(reason: string | undefined, type: 'costGuard' | 'taskCancel' = 'costGuard'): string {
    if (!reason) return '-';
    const labels = type === 'costGuard' ? COST_GUARD_REASON_LABELS : TASK_CANCEL_REASON_LABELS;
    return labels[reason] || `${reason} (未知)`;
}

// ============================================================================
// TaskLogger 类
// ============================================================================

export class TaskLogger extends EventEmitter {
    private config: TaskLoggerConfig;
    private baseDir: string;

    // 序号管理
    private sequenceMap: Map<string, number> = new Map();

    // 异步队列
    private queue: QueueItem[] = [];
    private flushTimer: NodeJS.Timeout | null = null;
    private isFlushing = false;

    // 快照频率控制
    private lastSnapshotTime: Map<string, number> = new Map();

    // 执行器ID (用于关联)
    private executorId: string;

    // 是否已关闭
    private closed = false;

    // 清理定时器
    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor(config?: Partial<TaskLoggerConfig>) {
        super();
        this.config = this.mergeConfig(DEFAULT_LOGGER_CONFIG, config);
        this.baseDir = path.resolve(this.config.baseDir);
        this.executorId = this.generateId();

        // 确保基础目录存在
        this.ensureDir(this.baseDir);

        // 启动定时 flush
        if (this.config.asyncQueue) {
            this.startFlushTimer();
        }

        // 启动定期清理 (每24小时)
        this.startCleanupTimer();

        // 注册退出处理
        this.registerExitHandlers();
    }

    /**
     * 深度合并配置 (修复浅拷贝问题)
     */
    private mergeConfig(
        defaults: TaskLoggerConfig,
        overrides?: Partial<TaskLoggerConfig>
    ): TaskLoggerConfig {
        if (!overrides) return { ...defaults };

        return {
            baseDir: overrides.baseDir ?? defaults.baseDir,
            asyncQueue: overrides.asyncQueue ?? defaults.asyncQueue,
            queue: {
                ...defaults.queue,
                ...overrides.queue,
            },
            snapshot: {
                ...defaults.snapshot,
                ...overrides.snapshot,
            },
            retention: {
                ...defaults.retention,
                ...overrides.retention,
            },
            sanitize: {
                ...defaults.sanitize,
                ...overrides.sanitize,
                fields: overrides.sanitize?.fields ?? defaults.sanitize.fields,
            },
            notify: {
                ...defaults.notify,
                ...overrides.notify,
            },
        };
    }

    /**
     * 启动定期清理定时器
     */
    private startCleanupTimer(): void {
        // 启动时立即执行一次清理
        this.cleanupOldLogs().then(result => {
            if (result.deleted.length > 0) {
                console.log(`[TaskLogger] Cleanup: deleted ${result.deleted.length} old task logs`);
            }
        }).catch(err => {
            console.error('[TaskLogger] Startup cleanup error:', err);
        });

        // 每24小时执行一次清理
        const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
        this.cleanupTimer = setInterval(() => {
            this.cleanupOldLogs().then(result => {
                if (result.deleted.length > 0) {
                    console.log(`[TaskLogger] Periodic cleanup: deleted ${result.deleted.length} old task logs`);
                }
            }).catch(err => {
                console.error('[TaskLogger] Periodic cleanup error:', err);
            });
        }, CLEANUP_INTERVAL_MS);
    }

    // ========================================================================
    // 公共方法 - 事件记录
    // ========================================================================

    /**
     * 记录任务生命周期事件
     */
    async logTaskLifecycle(
        taskId: string,
        type: TaskLifecycleEventType,
        payload: Omit<TaskLifecyclePayload, 'error'> & { error?: Error | StructuredError }
    ): Promise<void> {
        const event: TaskLogEvent = {
            timestamp: Date.now(),
            taskId,
            sequence: this.nextSequence(taskId),
            logSchemaVersion: LOG_SCHEMA_VERSION,
            executorId: this.executorId,
            priority: EVENT_PRIORITY_MAP[type],
            type,
            payload: {
                ...payload,
                error: payload.error ? this.structureError(payload.error) : undefined,
            },
        };

        await this.enqueue({ type: 'event', taskId, data: event, priority: event.priority });

        // 通知
        if (this.config.notify.enabled && NOTIFY_EVENTS.has(type)) {
            this.emit('notify', { taskId, event });
        }
    }

    /**
     * 记录订单事件
     */
    async logOrderEvent(
        taskId: string,
        type: OrderEventType,
        payload: Omit<OrderEventPayload, 'error'> & { error?: Error | StructuredError },
        orderHash?: string
    ): Promise<void> {
        const event: TaskLogEvent = {
            timestamp: Date.now(),
            taskId,
            sequence: this.nextSequence(taskId),
            logSchemaVersion: LOG_SCHEMA_VERSION,
            executorId: this.executorId,
            orderId: payload.orderId,
            orderHash,
            priority: EVENT_PRIORITY_MAP[type],
            type,
            payload: {
                ...payload,
                error: payload.error ? this.structureError(payload.error) : undefined,
            },
        };

        await this.enqueue({ type: 'event', taskId, data: event, priority: event.priority });

        if (this.config.notify.enabled && NOTIFY_EVENTS.has(type)) {
            this.emit('notify', { taskId, event });
        }
    }

    /**
     * 记录价格守护事件
     */
    async logPriceGuard(
        taskId: string,
        type: PriceGuardEventType,
        payload: PriceGuardPayload
    ): Promise<void> {
        const event: TaskLogEvent = {
            timestamp: Date.now(),
            taskId,
            sequence: this.nextSequence(taskId),
            logSchemaVersion: LOG_SCHEMA_VERSION,
            executorId: this.executorId,
            priority: EVENT_PRIORITY_MAP[type],
            type,
            payload,
        };

        await this.enqueue({ type: 'event', taskId, data: event, priority: event.priority });

        if (this.config.notify.enabled && NOTIFY_EVENTS.has(type)) {
            this.emit('notify', { taskId, event });
        }
    }

    /**
     * 记录对冲事件
     */
    async logHedgeEvent(
        taskId: string,
        type: HedgeEventType,
        payload: Omit<HedgePayload, 'error'> & { error?: Error | StructuredError },
        attemptId?: string
    ): Promise<void> {
        const event: TaskLogEvent = {
            timestamp: Date.now(),
            taskId,
            sequence: this.nextSequence(taskId),
            logSchemaVersion: LOG_SCHEMA_VERSION,
            executorId: this.executorId,
            attemptId,
            priority: EVENT_PRIORITY_MAP[type],
            type,
            payload: {
                ...payload,
                error: payload.error ? this.structureError(payload.error) : undefined,
            },
        };

        await this.enqueue({ type: 'event', taskId, data: event, priority: event.priority });

        if (this.config.notify.enabled && NOTIFY_EVENTS.has(type)) {
            this.emit('notify', { taskId, event });
        }
    }

    /**
     * 记录 UNWIND 事件
     */
    async logUnwindEvent(
        taskId: string,
        type: UnwindEventType,
        payload: Omit<UnwindPayload, 'error'> & { error?: Error | StructuredError }
    ): Promise<void> {
        const event: TaskLogEvent = {
            timestamp: Date.now(),
            taskId,
            sequence: this.nextSequence(taskId),
            logSchemaVersion: LOG_SCHEMA_VERSION,
            executorId: this.executorId,
            priority: EVENT_PRIORITY_MAP[type],
            type,
            payload: {
                ...payload,
                error: payload.error ? this.structureError(payload.error) : undefined,
            },
        };

        await this.enqueue({ type: 'event', taskId, data: event, priority: event.priority });

        if (this.config.notify.enabled && NOTIFY_EVENTS.has(type)) {
            this.emit('notify', { taskId, event });
        }
    }

    // ========================================================================
    // 公共方法 - Taker 模式事件
    // ========================================================================

    /**
     * 记录成本守护事件
     */
    async logCostGuard(
        taskId: string,
        type: 'COST_GUARD_STARTED' | 'COST_GUARD_TRIGGERED' | 'COST_GUARD_STOPPED',
        payload: {
            maxTotalCost: number;
            predictMarketId: number;
            polymarketTokenId: string;
            feeRateBps: number;
            pollInterval?: number;
            currentCost?: number;
            predictAsk?: number;
            polyAsk?: number;
            fee?: number;
            reason?: CostGuardStopReason;                // 使用集中管理的枚举
            eventDriven?: boolean;                       // 是否使用事件驱动
            triggeredBy?: CostCheckTriggerSource;        // 使用集中管理的枚举
            bscWssEnabled?: boolean;                     // Predict 链上 WSS 是否启用
        }
    ): Promise<void> {
        const event: TaskLogEvent = {
            timestamp: Date.now(),
            taskId,
            sequence: this.nextSequence(taskId),
            logSchemaVersion: LOG_SCHEMA_VERSION,
            executorId: this.executorId,
            priority: EVENT_PRIORITY_MAP[type],
            type,
            payload,
        };

        await this.enqueue({ type: 'event', taskId, data: event, priority: event.priority });

        if (this.config.notify.enabled && NOTIFY_EVENTS.has(type)) {
            this.emit('notify', { taskId, event });
        }
    }

    /**
     * 记录 Taker 专用事件
     */
    async logTakerEvent(
        taskId: string,
        type: 'ORDER_TIMEOUT' | 'FORCED_FILL_REFRESH' | 'HEDGE_PRICE_SOURCE' | 'HEDGE_PRICE_INVALID' | 'SHARES_MISALIGNMENT' | 'IOC_FORCE_CANCEL',
        payload: {
            orderHash?: string;
            timeoutMs?: number;
            filledQty?: number;
            remainingQty?: number;
            previousFilled?: number;
            actualFilled?: number;
            source?: 'WS_CACHE' | 'REST_FALLBACK';
            price?: number;
            cacheAgeMs?: number;
            side?: 'BUY' | 'SELL';  // 对冲方向
            hedgePrice?: number;
            maxAllowed?: number;    // BUY 时的最高可接受价格
            minAllowed?: number;    // SELL 时的最低可接受价格
            // SHARES_MISALIGNMENT
            predictFilled?: number;
            polyHedged?: number;
            difference?: number;
            // IOC_FORCE_CANCEL
            orderId?: string;
            statusBeforeCancel?: string;
            statusAfterCancel?: string;
            finalFilledQty?: number;
        }
    ): Promise<void> {
        const event: TaskLogEvent = {
            timestamp: Date.now(),
            taskId,
            sequence: this.nextSequence(taskId),
            logSchemaVersion: LOG_SCHEMA_VERSION,
            executorId: this.executorId,
            priority: EVENT_PRIORITY_MAP[type],
            type,
            payload,
        };

        await this.enqueue({ type: 'event', taskId, data: event, priority: event.priority });

        if (this.config.notify.enabled && NOTIFY_EVENTS.has(type)) {
            this.emit('notify', { taskId, event });
        }
    }

    // ========================================================================
    // 公共方法 - 订单簿快照
    // ========================================================================

    /**
     * 捕获订单簿快照
     */
    async captureOrderBookSnapshot(
        taskId: string,
        trigger: SnapshotTrigger,
        predictBook?: { bids: [number, number][]; asks: [number, number][]; updateTimestampMs: number } | null,
        polyBook?: { bids: [number, number][]; asks: [number, number][]; updateTimestampMs: number } | null,
        arbMetrics?: Partial<ArbMetrics>
    ): Promise<number> {
        if (!this.config.snapshot.enabled) {
            return -1;
        }

        // 频率控制
        const lastTime = this.lastSnapshotTime.get(taskId) || 0;
        const now = Date.now();
        if (now - lastTime < this.config.snapshot.minIntervalMs) {
            return -1;
        }
        this.lastSnapshotTime.set(taskId, now);

        const seq = this.nextSequence(taskId);
        const depthLimit = this.config.snapshot.depthLimit;

        const snapshot: OrderBookSnapshot = {
            timestamp: now,
            taskId,
            sequence: seq,
            trigger,
            logSchemaVersion: LOG_SCHEMA_VERSION,
            predict: predictBook ? this.trimOrderBook(predictBook, depthLimit) : null,
            polymarket: polyBook ? this.trimOrderBook(polyBook, depthLimit) : null,
            arbMetrics: {
                totalCost: arbMetrics?.totalCost ?? 0,
                profitPercent: arbMetrics?.profitPercent ?? 0,
                isValid: arbMetrics?.isValid ?? false,
                maxDepth: arbMetrics?.maxDepth ?? 0,
            },
            priority: 'SNAPSHOT',
        };

        await this.enqueue({ type: 'snapshot', taskId, data: snapshot, priority: 'SNAPSHOT' });
        return seq;
    }

    // ========================================================================
    // 公共方法 - 初始化与汇总
    // ========================================================================

    /**
     * 初始化任务日志目录 (幂等)
     *
     * 只在首次调用时设置 sequence=0，后续调用不会重置
     */
    async initTaskLogDir(taskId: string): Promise<void> {
        const taskDir = path.join(this.baseDir, taskId);
        this.ensureDir(taskDir);

        // 幂等：只在首次调用时初始化 sequence
        if (!this.sequenceMap.has(taskId)) {
            // 检查是否有已存在的日志文件，恢复 sequence
            const eventsPath = path.join(taskDir, 'events.jsonl');
            const snapshotsPath = path.join(taskDir, 'orderbooks.jsonl');

            let maxSequence = 0;

            // 从已有日志中恢复最大 sequence
            if (fs.existsSync(eventsPath)) {
                const events = await this.readJsonl<{ sequence: number }>(eventsPath);
                for (const e of events) {
                    if (e.sequence > maxSequence) maxSequence = e.sequence;
                }
            }
            if (fs.existsSync(snapshotsPath)) {
                const snapshots = await this.readJsonl<{ sequence: number }>(snapshotsPath);
                for (const s of snapshots) {
                    if (s.sequence > maxSequence) maxSequence = s.sequence;
                }
            }

            this.sequenceMap.set(taskId, maxSequence);
        }
    }

    /**
     * 生成任务汇总
     */
    async generateSummary(taskId: string, task: {
        type: 'BUY' | 'SELL';
        marketId: number;
        title: string;
        status: TaskStatus;
        predictFilledQty: number;
        hedgedQty: number;
        avgPredictPrice: number;
        avgPolymarketPrice: number;
        actualProfit: number;
        unwindLoss: number;
        pauseCount: number;
        hedgeRetryCount: number;
        createdAt: number;
        // Taker 模式字段
        strategy?: 'MAKER' | 'TAKER';
        cancelReason?: TaskCancelReason;  // 使用集中管理的枚举
        maxTotalCost?: number;
    }): Promise<void> {
        // 先 flush 确保所有事件已写入
        await this.flush();

        const taskDir = path.join(this.baseDir, taskId);
        const eventsPath = path.join(taskDir, 'events.jsonl');
        const snapshotsPath = path.join(taskDir, 'orderbooks.jsonl');

        // 读取事件
        const events = await this.readJsonl<TaskLogEvent>(eventsPath);
        const snapshots = await this.readJsonl<OrderBookSnapshot>(snapshotsPath);

        // 统计事件类型
        const eventCounts: Record<string, number> = {};
        for (const e of events) {
            eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
        }

        // 构建时间线
        const timeline = events
            .filter(e => EVENT_PRIORITY_MAP[e.type as TaskLogEventType] === 'CRITICAL')
            .map(e => ({
                timestamp: e.timestamp,
                event: e.type,
                detail: this.getEventDetail(e),
            }));

        const endTime = Date.now();
        const profitPercent = task.actualProfit && task.avgPredictPrice
            ? (task.actualProfit / (task.avgPredictPrice * task.predictFilledQty)) * 100
            : 0;

        // 计算 Taker 模式专用统计
        const costGuardTriggerCount = events.filter(e => e.type === 'COST_GUARD_TRIGGERED').length;
        const orderTimeoutCount = events.filter(e => e.type === 'ORDER_TIMEOUT').length;

        const summary: TaskSummary = {
            taskId,
            type: task.type,
            marketId: task.marketId,
            title: task.title,
            logSchemaVersion: LOG_SCHEMA_VERSION,
            status: task.status,
            isSuccess: task.status === 'COMPLETED',

            // Taker 模式字段
            strategy: task.strategy ?? 'MAKER',
            cancelReason: task.cancelReason,
            maxTotalCost: task.maxTotalCost,
            avgTotalCost: task.avgPredictPrice && task.avgPolymarketPrice
                ? task.avgPredictPrice + task.avgPolymarketPrice
                : undefined,
            costGuardTriggerCount,
            orderTimeoutCount,

            totalEvents: events.length,
            totalSnapshots: snapshots.length,
            eventCounts,
            startTime: task.createdAt,
            endTime,
            durationMs: endTime - task.createdAt,
            predictFilledQty: task.predictFilledQty,
            hedgedQty: task.hedgedQty,
            avgPredictPrice: task.avgPredictPrice,
            avgPolymarketPrice: task.avgPolymarketPrice,
            actualProfit: task.actualProfit,
            profitPercent,
            unwindLoss: task.unwindLoss,
            pauseCount: task.pauseCount,
            hedgeRetryCount: task.hedgeRetryCount,
            timeline,
            generatedAt: Date.now(),
        };

        const summaryPath = path.join(taskDir, 'summary.json');
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    }

    // ========================================================================
    // 公共方法 - 清理
    // ========================================================================

    /**
     * 清理过期日志
     */
    async cleanupOldLogs(): Promise<{ deleted: string[]; errors: string[] }> {
        const deleted: string[] = [];
        const errors: string[] = [];
        const cutoffTime = Date.now() - this.config.retention.days * 24 * 60 * 60 * 1000;

        try {
            const taskDirs = fs.readdirSync(this.baseDir);

            for (const taskId of taskDirs) {
                const taskDir = path.join(this.baseDir, taskId);
                const stat = fs.statSync(taskDir);

                if (!stat.isDirectory()) continue;

                // 检查 summary.json 的创建时间
                const summaryPath = path.join(taskDir, 'summary.json');
                if (fs.existsSync(summaryPath)) {
                    const summaryStr = fs.readFileSync(summaryPath, 'utf-8');
                    const summary = JSON.parse(summaryStr) as TaskSummary;

                    if (summary.generatedAt < cutoffTime) {
                        // 删除整个目录
                        fs.rmSync(taskDir, { recursive: true, force: true });
                        deleted.push(taskId);
                    }
                } else {
                    // 没有 summary 的，检查目录修改时间
                    if (stat.mtimeMs < cutoffTime) {
                        fs.rmSync(taskDir, { recursive: true, force: true });
                        deleted.push(taskId);
                    }
                }
            }
        } catch (error) {
            errors.push(`Cleanup error: ${(error as Error).message}`);
        }

        return { deleted, errors };
    }

    // ========================================================================
    // 公共方法 - 关闭
    // ========================================================================

    /**
     * 关闭日志服务 (flush 所有待写入数据)
     */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;

        // 停止定时器
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        // 最终 flush
        await this.flush();

        console.log('[TaskLogger] Closed');
    }

    /**
     * 连接通知处理器
     *
     * @param handler 接收 { taskId, event } 的回调函数
     * @returns 返回取消订阅的函数
     *
     * 示例 (连接 Telegram):
     * ```typescript
     * const logger = getTaskLogger();
     * const telegram = new TelegramNotifier(config);
     *
     * logger.connectNotifier(async ({ taskId, event }) => {
     *     const text = formatEventForTelegram(taskId, event);
     *     await telegram.sendText(text);
     * });
     * ```
     */
    connectNotifier(handler: (data: { taskId: string; event: TaskLogEvent }) => void | Promise<void>): () => void {
        const wrappedHandler = (data: { taskId: string; event: TaskLogEvent }) => {
            try {
                const result = handler(data);
                if (result instanceof Promise) {
                    result.catch(err => {
                        console.error('[TaskLogger] Notification handler error:', err);
                    });
                }
            } catch (err) {
                console.error('[TaskLogger] Notification handler error:', err);
            }
        };

        this.on('notify', wrappedHandler);

        // 返回取消订阅函数
        return () => {
            this.off('notify', wrappedHandler);
        };
    }

    /**
     * 格式化事件为通知文本 (完整版)
     */
    formatEventForNotification(taskId: string, event: TaskLogEvent): string {
        const time = new Date(event.timestamp).toLocaleTimeString('zh-CN');
        const emoji = this.getEventEmoji(event.type as TaskLogEventType);

        // 提取事件详细信息
        const { title, platform, side, detail } = this.extractEventInfo(event);

        // 构建消息
        let message = `${emoji} <b>${event.type}</b>\n`;
        message += `<b>时间:</b> ${time}\n`;

        // 显示市场标题 (如果有)
        if (title) {
            message += `<b>市场:</b> ${title}\n`;
        }

        // 显示平台和方向 (如果有)
        if (platform) {
            message += `<b>平台:</b> ${platform.toUpperCase()}\n`;
        }
        if (side) {
            message += `<b>方向:</b> ${side}\n`;
        }

        // 显示详细信息
        if (detail) {
            message += detail;
        }

        // 任务 ID (完整显示)
        message += `<b>任务:</b> <code>${taskId}</code>`;

        return message;
    }

    /**
     * 提取事件关键信息
     */
    private extractEventInfo(event: TaskLogEvent): {
        title?: string;
        platform?: string;
        side?: string;
        detail: string;
    } {
        const payload = event.payload as unknown as Record<string, unknown>;
        let title: string | undefined;
        let platform: string | undefined;
        let side: string | undefined;
        let detail = '';

        // 直接从 payload.title 提取标题 (Order/Hedge 事件)
        if (payload.title) {
            title = payload.title as string;
        }

        // TaskLifecycle 事件 - 提取 taskConfig
        if (payload.taskConfig) {
            const config = payload.taskConfig as { title?: string; type?: string; quantity?: number; predictPrice?: number };
            if (!title) title = config.title;
            side = config.type;
            if (config.quantity !== undefined && config.predictPrice !== undefined) {
                detail += `<b>数量:</b> ${config.quantity} shares\n`;
                detail += `<b>价格:</b> $${config.predictPrice.toFixed(2)}\n`;
            }
        }

        // Order/Hedge 事件 - 提取 side/outcome
        if (payload.platform !== undefined) {
            platform = payload.platform as string;
        }
        if (payload.side !== undefined && !side) {
            // 格式化方向: BUY YES 🟢 / BUY NO 🔴 / SELL YES 🟢 / SELL NO 🔴
            const sideText = payload.side as string;
            const outcomeText = payload.outcome as string | undefined;
            if (outcomeText) {
                const outcomeIcon = outcomeText === 'YES' ? '🟢' : '🔴';
                side = `${sideText} ${outcomeText} ${outcomeIcon}`;
            } else {
                side = sideText;
            }
        }
        if (payload.price !== undefined) {
            detail += `<b>价格:</b> $${(payload.price as number).toFixed(2)}\n`;
        }
        if (payload.quantity !== undefined) {
            detail += `<b>数量:</b> ${payload.quantity} shares\n`;
        }
        if (payload.filledQty !== undefined) {
            const filled = payload.filledQty as number;
            const remaining = (payload.remainingQty as number | undefined) ?? 0;
            detail += `<b>成交:</b> ${filled} / ${filled + remaining}\n`;
        }

        // Hedge 事件
        if (payload.hedgeQty !== undefined) {
            detail += `<b>对冲数量:</b> ${payload.hedgeQty}\n`;
            if (payload.totalHedged !== undefined) {
                detail += `<b>累计对冲:</b> ${payload.totalHedged}\n`;
            }
            if (payload.avgHedgePrice !== undefined) {
                detail += `<b>平均价格:</b> $${(payload.avgHedgePrice as number).toFixed(2)}\n`;
            }
            // 对冲完成时显示总成本
            if (payload.avgTotalCost !== undefined) {
                detail += `<b>总成本/share:</b> $${(payload.avgTotalCost as number).toFixed(4)}\n`;
            }
        }

        // Unwind 事件
        if (payload.unwoundQty !== undefined) {
            detail += `<b>平仓数量:</b> ${payload.unwoundQty}\n`;
            if (payload.estimatedLoss !== undefined) {
                detail += `<b>预计亏损:</b> $${(payload.estimatedLoss as number).toFixed(2)}\n`;
            }
        }

        // PriceGuard 事件
        if (payload.triggerPrice !== undefined) {
            detail += `<b>触发价格:</b> $${(payload.triggerPrice as number).toFixed(2)}\n`;
            if (payload.thresholdPrice !== undefined) {
                detail += `<b>阈值价格:</b> $${(payload.thresholdPrice as number).toFixed(2)}\n`;
            }
        }

        // 完成事件 - 显示利润
        if (payload.profit !== undefined) {
            const profit = payload.profit as number;
            const profitEmoji = profit >= 0 ? '📈' : '📉';
            detail += `${profitEmoji} <b>利润:</b> $${profit.toFixed(2)}\n`;
        }
        if (payload.profitPercent !== undefined) {
            detail += `<b>利润率:</b> ${(payload.profitPercent as number).toFixed(2)}%\n`;
        }

        // 延迟统计 (ORDER_FILLED 事件)
        if (payload.latency) {
            const latency = payload.latency as {
                submitToFirstStatus?: number;
                submitToFill?: number;
                statusFetchAttempts?: number;
            };
            detail += `\n<b>⏱️ 延迟统计:</b>\n`;
            if (latency.submitToFill !== undefined) {
                detail += `  下单到成交: ${(latency.submitToFill / 1000).toFixed(2)}s\n`;
            }
            if (latency.submitToFirstStatus !== undefined) {
                detail += `  首次状态: ${(latency.submitToFirstStatus / 1000).toFixed(2)}s\n`;
            }
            if (latency.statusFetchAttempts !== undefined) {
                detail += `  轮询次数: ${latency.statusFetchAttempts}\n`;
            }
        }

        // 错误信息
        if (payload.error) {
            const err = payload.error as { message?: string };
            detail += `<b>错误:</b> ${err.message || 'Unknown error'}\n`;
        }

        // 原因 (使用 fallback 辅助函数，未知值不崩溃)
        if (payload.reason) {
            detail += `<b>原因:</b> ${formatReasonLabel(payload.reason as string)}\n`;
        }

        // 取消原因 (订单级别，使用 taskCancel 类型的 fallback)
        if (payload.cancelReason) {
            detail += `<b>取消原因:</b> ${formatReasonLabel(payload.cancelReason as string, 'taskCancel')}\n`;
        }

        return { title, platform, side, detail };
    }

    private getEventEmoji(type: TaskLogEventType): string {
        const emojiMap: Record<string, string> = {
            'TASK_CREATED': '📝',
            'TASK_STARTED': '🚀',
            'TASK_COMPLETED': '✅',
            'TASK_FAILED': '❌',
            'TASK_CANCELLED': '🛑',
            'TASK_PAUSED': '⏸️',
            'TASK_RESUMED': '▶️',
            'ORDER_SUBMITTED': '📤',
            'ORDER_FILLED': '💰',
            'ORDER_PARTIAL_FILL': '🔄',
            'ORDER_CANCELLED': '❌',
            'ORDER_FAILED': '⚠️',
            'ORDER_EXPIRED': '⏰',
            'PRICE_GUARD_TRIGGERED': '🛡️',
            'PRICE_GUARD_RESUMED': '✅',
            'HEDGE_STARTED': '🔀',
            'HEDGE_COMPLETED': '✅',
            'HEDGE_FAILED': '❌',
            'HEDGE_SKIPPED': '⏭️',
            'UNWIND_STARTED': '↩️',
            'UNWIND_COMPLETED': '✅',
            'UNWIND_FAILED': '❌',
        };
        return emojiMap[type] || '📋';
    }

    // ========================================================================
    // 私有方法 - 队列管理
    // ========================================================================

    private async enqueue(item: QueueItem): Promise<void> {
        if (this.closed) {
            console.warn('[TaskLogger] Logger is closed, dropping event');
            return;
        }

        // 队列满时的丢弃策略 (按优先级: CRITICAL > INFO > SNAPSHOT)
        if (this.queue.length >= this.config.queue.maxSize) {
            // 新项目是 SNAPSHOT，直接丢弃
            if (item.priority === 'SNAPSHOT') {
                return;
            }

            // 尝试移除队列中优先级较低的项目
            // 优先级顺序: CRITICAL(最高) > INFO > SNAPSHOT(最低)
            const priorityOrder = { 'SNAPSHOT': 0, 'INFO': 1, 'CRITICAL': 2 };
            const itemPriority = priorityOrder[item.priority];

            // 找到优先级最低的项目
            let lowestIdx = -1;
            let lowestPriority = itemPriority;

            for (let i = 0; i < this.queue.length; i++) {
                const qPriority = priorityOrder[this.queue[i].priority];
                if (qPriority < lowestPriority) {
                    lowestPriority = qPriority;
                    lowestIdx = i;
                }
            }

            if (lowestIdx >= 0) {
                // 移除优先级较低的项目
                this.queue.splice(lowestIdx, 1);
            } else {
                // 没有优先级更低的项目，新项目也无法入队
                // 对于 CRITICAL 事件，强制丢弃最旧的非 CRITICAL 项目
                if (item.priority === 'CRITICAL') {
                    const nonCriticalIdx = this.queue.findIndex(q => q.priority !== 'CRITICAL');
                    if (nonCriticalIdx >= 0) {
                        this.queue.splice(nonCriticalIdx, 1);
                    } else {
                        // 全是 CRITICAL，丢弃最旧的
                        this.queue.shift();
                    }
                } else {
                    // INFO 事件且队列已满且无法腾出空间，丢弃新事件
                    console.warn(`[TaskLogger] Queue full, dropping ${item.priority} event for task ${item.taskId}`);
                    return;
                }
            }
        }

        this.queue.push(item);

        // 同步模式或达到阈值时立即 flush
        if (!this.config.asyncQueue || this.queue.length >= this.config.queue.flushThreshold) {
            await this.flush();
        }
    }

    private startFlushTimer(): void {
        this.flushTimer = setInterval(() => {
            if (this.queue.length > 0) {
                this.flush().catch(err => {
                    console.error('[TaskLogger] Flush error:', err);
                });
            }
        }, this.config.queue.flushIntervalMs);
    }

    /**
     * 批量写入队列中的数据 (异步非阻塞)
     */
    async flush(): Promise<void> {
        if (this.isFlushing || this.queue.length === 0) return;

        this.isFlushing = true;
        const items = [...this.queue];
        this.queue = [];

        try {
            // 按 taskId 分组
            const grouped = new Map<string, { events: TaskLogEvent[]; snapshots: OrderBookSnapshot[] }>();

            for (const item of items) {
                if (!grouped.has(item.taskId)) {
                    grouped.set(item.taskId, { events: [], snapshots: [] });
                }
                const g = grouped.get(item.taskId)!;

                if (item.type === 'event') {
                    g.events.push(item.data as TaskLogEvent);
                } else {
                    g.snapshots.push(item.data as OrderBookSnapshot);
                }
            }

            // 异步并行写入文件
            const writePromises: Promise<void>[] = [];

            for (const [taskId, data] of grouped) {
                const taskDir = path.join(this.baseDir, taskId);
                await this.ensureDirAsync(taskDir);

                // 写入事件 (异步)
                if (data.events.length > 0) {
                    const eventsPath = path.join(taskDir, 'events.jsonl');
                    const lines = data.events.map(e => JSON.stringify(this.sanitize(e))).join('\n') + '\n';
                    writePromises.push(fsPromises.appendFile(eventsPath, lines, 'utf-8'));
                }

                // 写入快照 (异步)
                if (data.snapshots.length > 0) {
                    const snapshotsPath = path.join(taskDir, 'orderbooks.jsonl');
                    const lines = data.snapshots.map(s => JSON.stringify(this.sanitize(s))).join('\n') + '\n';
                    writePromises.push(fsPromises.appendFile(snapshotsPath, lines, 'utf-8'));
                }
            }

            // 等待所有写入完成
            await Promise.all(writePromises);
        } catch (error) {
            console.error('[TaskLogger] Flush error:', error);
            // 恢复未写入的项目
            this.queue = [...items, ...this.queue];
        } finally {
            this.isFlushing = false;
        }
    }

    /**
     * 异步确保目录存在
     */
    private async ensureDirAsync(dir: string): Promise<void> {
        try {
            await fsPromises.access(dir);
        } catch {
            await fsPromises.mkdir(dir, { recursive: true });
        }
    }

    // ========================================================================
    // 私有方法 - 工具函数
    // ========================================================================

    private nextSequence(taskId: string): number {
        const current = this.sequenceMap.get(taskId) || 0;
        const next = current + 1;
        this.sequenceMap.set(taskId, next);
        return next;
    }

    private generateId(): string {
        return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    }

    private ensureDir(dir: string): void {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    private trimOrderBook(
        book: { bids: [number, number][]; asks: [number, number][]; updateTimestampMs: number },
        depth: number
    ): TrimmedOrderBook {
        const bids = book.bids.slice(0, depth);
        const asks = book.asks.slice(0, depth);
        const bestBid = bids.length > 0 ? bids[0][0] : null;
        const bestAsk = asks.length > 0 ? asks[0][0] : null;
        const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
        const latencyMs = Date.now() - book.updateTimestampMs;

        return { bids, asks, bestBid, bestAsk, spread, latencyMs };
    }

    private structureError(error: Error | StructuredError): StructuredError {
        if ('errorType' in error) {
            return error as StructuredError;
        }

        const e = error as Error & { code?: string; status?: number; response?: { data?: unknown } };
        return {
            errorType: e.name || 'Error',
            message: e.message,
            stack: e.stack,
            code: e.code,
            httpStatus: e.status,
            responseBody: e.response?.data ? JSON.stringify(e.response.data).substring(0, 500) : undefined,
        };
    }

    private sanitize<T>(data: T): T {
        if (!this.config.sanitize.enabled) return data;

        const str = JSON.stringify(data);
        let result = str;

        for (const field of this.config.sanitize.fields) {
            // 匹配 "field": "value" 或 "field":"value"
            const regex = new RegExp(`"${field}"\\s*:\\s*"[^"]*"`, 'gi');
            result = result.replace(regex, `"${field}":"***"`);
        }

        return JSON.parse(result);
    }

    private getEventDetail(event: TaskLogEvent): string | undefined {
        const p = event.payload as unknown as Record<string, unknown>;
        if (p.profit !== undefined) return `Profit: $${(p.profit as number).toFixed(2)}`;
        if (p.filledQty !== undefined) return `Filled: ${p.filledQty}`;
        if (p.hedgeQty !== undefined) return `Hedge: ${p.hedgeQty}`;
        if (p.reason) return formatReasonLabel(p.reason as string);  // 使用 fallback
        if (p.error) return (p.error as StructuredError).message;
        return undefined;
    }

    private async readJsonl<T>(filePath: string): Promise<T[]> {
        if (!fs.existsSync(filePath)) return [];

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l.trim());
        const results: T[] = [];

        for (const line of lines) {
            try {
                results.push(JSON.parse(line));
            } catch {
                // 忽略解析失败的行 (半行容错)
            }
        }

        return results;
    }

    private registerExitHandlers(): void {
        const handler = async () => {
            console.log('[TaskLogger] Exit signal received, flushing...');
            await this.close();
        };

        process.on('beforeExit', handler);

        let isHandlingSignal = false;
        const handleSignal = async (signal: NodeJS.Signals) => {
            // 如果宿主程序也在处理该信号（比如 dashboard 的优雅关闭），这里不要抢先 close/exit。
            // 由宿主在自己的 shutdown 流程末尾显式关闭 logger（或自然退出时 beforeExit 触发）。
            if (process.listenerCount(signal) > 1) return;

            if (isHandlingSignal) return;
            isHandlingSignal = true;

            await handler();

            process.exit(0);
        };

        const onSigint = () => void handleSignal('SIGINT');
        const onSigterm = () => void handleSignal('SIGTERM');

        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);
    }
}

// ============================================================================
// 单例
// ============================================================================

let instance: TaskLogger | null = null;

export function getTaskLogger(config?: Partial<TaskLoggerConfig>): TaskLogger {
    if (!instance) {
        instance = new TaskLogger(config);
    }
    return instance;
}

export function initTaskLogger(config?: Partial<TaskLoggerConfig>): TaskLogger {
    if (instance) {
        console.warn('[TaskLogger] Logger already initialized, returning existing instance');
        return instance;
    }
    instance = new TaskLogger(config);
    return instance;
}
