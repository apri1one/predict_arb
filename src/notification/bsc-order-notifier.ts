/**
 * BSC 链上订单通知服务
 *
 * 订阅 BscOrderWatcher 的 orderFilled 事件，将 Predict 订单成交推送到 Telegram。
 * 默认只通知“自己的订单”（需要 PREDICT_SMART_WALLET_ADDRESS），避免刷屏。
 */

import { EventEmitter } from 'events';
import { getBscOrderWatcher, getSharesFromFillEvent, getFillDirection, type OrderFilledEvent } from '../services/bsc-order-watcher.js';
import { getTokenMarketCache, type TokenLookupResult } from '../services/token-market-cache.js';
import { getTaskService } from '../dashboard/task-service.js';
import type { TaskStatus } from '../dashboard/types.js';
import { TelegramNotifier, createTelegramNotifier } from './telegram.js';

export interface BscOrderNotifierConfig {
    telegramBotToken: string;
    telegramChatId: string;

    enabled?: boolean;
    notifyAllOrders?: boolean;
    smartWalletAddress?: string;

    silencePeriodMs?: number;
}

interface TaskIntentMatch {
    taskId: string;
    side: 'BUY' | 'SELL';
    outcome: 'YES' | 'NO';
    title: string;
}

const TASK_INTENT_LOOKBACK_MS = 10 * 60 * 1000;
const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
    'PENDING',
    'VALIDATING',
    'PREDICT_SUBMITTED',
    'PARTIALLY_FILLED',
    'PAUSED',
    'HEDGING',
    'HEDGE_PENDING',
    'HEDGE_RETRY',
    'LOSS_HEDGE',
    'UNWINDING',
    'UNWIND_PENDING',
]);

export class BscOrderNotifier extends EventEmitter {
    private telegram: TelegramNotifier;
    private config: Required<BscOrderNotifierConfig>;
    private isRunning = false;
    private eventHandler: ((event: OrderFilledEvent) => void) | null = null;

    private recentNotifications: Map<string, number> = new Map();
    private cleanupTimer: NodeJS.Timeout | null = null;

    // CTF 交易所同一笔 tx 产生两个 OrderFilled 事件 (YES/NO 配对结算)
    // 缓冲同一 txHash 的事件，选最佳的发送，避免重复通知
    private pendingTxEvents: Map<string, { events: OrderFilledEvent[]; timer: NodeJS.Timeout }> = new Map();

    constructor(config: BscOrderNotifierConfig) {
        super();
        this.config = {
            ...config,
            enabled: config.enabled ?? true,
            notifyAllOrders: config.notifyAllOrders ?? false,
            smartWalletAddress: config.smartWalletAddress ?? '',
            silencePeriodMs: config.silencePeriodMs ?? 5000,
        };

        this.telegram = createTelegramNotifier({
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            enabled: this.config.enabled,
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) return;
        if (!this.config.enabled) return;

        if (!this.config.notifyAllOrders && !this.config.smartWalletAddress) {
            console.warn('[BscOrderNotifier] PREDICT_SMART_WALLET_ADDRESS 未配置，默认不启用以避免刷屏');
            return;
        }

        const bscWatcher = getBscOrderWatcher();
        if (!bscWatcher.isConnected()) {
            await bscWatcher.start();
        }

        this.eventHandler = (event) => {
            void this.handleOrderFilledEvent(event).catch((e) => {
                console.warn('[BscOrderNotifier] handleOrderFilledEvent failed:', e?.message || e);
            });
        };
        bscWatcher.on('orderFilled', this.eventHandler);

        this.cleanupTimer = setInterval(() => this.cleanupRecentNotifications(), 60000);
        this.isRunning = true;

        // fire-and-forget，不阻塞启动流程
        this.telegram.sendText(`🟠 🔗 <b>Predict 链上订单监控已启动</b>

实时推送订单成交通知

<b>数据源:</b> BSC WebSocket
<b>钱包:</b> <code>${this.config.smartWalletAddress.slice(0, 10)}...${this.config.smartWalletAddress.slice(-4)}</code>
<b>时间:</b> ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
            .catch(() => { /* ignore */ });
    }

    stop(): void {
        if (!this.isRunning) return;
        this.isRunning = false;

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        // 清理 pending tx buffers
        for (const [, entry] of this.pendingTxEvents) {
            clearTimeout(entry.timer);
        }
        this.pendingTxEvents.clear();

        if (this.eventHandler) {
            try {
                getBscOrderWatcher().off('orderFilled', this.eventHandler);
            } catch { /* ignore */ }
            this.eventHandler = null;
        }

        this.telegram
            .sendText(`🟠 🛑 <b>Predict 链上订单监控已停止</b>

<b>时间:</b> ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
            .catch(() => { /* ignore */ });
    }

    running(): boolean {
        return this.isRunning;
    }

    private async handleOrderFilledEvent(event: OrderFilledEvent): Promise<void> {
        const myAddress = this.config.smartWalletAddress?.toLowerCase() || '';

        if (!this.config.notifyAllOrders) {
            const isMine = event.maker.toLowerCase() === myAddress || event.taker.toLowerCase() === myAddress;
            if (!isMine) return;
        }

        // CTF 交易所同一笔 tx 产生 YES/NO 配对的两个 OrderFilled 事件
        // 缓冲 150ms，收集同一 txHash 的所有事件后选最佳的发送
        const pending = this.pendingTxEvents.get(event.txHash);
        if (pending) {
            pending.events.push(event);
            return; // timer 已启动，等待收集完毕
        }

        const entry = {
            events: [event],
            timer: setTimeout(() => {
                this.pendingTxEvents.delete(event.txHash);
                void this.notifyFromTxEvents(entry.events, myAddress).catch(e => {
                    console.warn('[BscOrderNotifier] notifyFromTxEvents failed:', e?.message || e);
                });
            }, 150),
        };
        this.pendingTxEvents.set(event.txHash, entry);
    }

    /**
     * 从同一 tx 的所有事件中提取最佳信息并发送通知
     *
     * CTF 交易所同一笔 tx 可能产生多个 OrderFilled 事件 (YES/NO 配对结算)。
     * 策略:
     * 1. 遍历所有事件的所有 tokenId 查找市场（解决互补面 tokenId 不在缓存的问题）
     * 2. 优先使用能解析到市场的事件计算价格/方向
     * 3. 链上 maker/taker 不一定对应 API 层的角色（NegRisk 结算会交换），
     *    方向仅反映链上资产流向
     */
    private async notifyFromTxEvents(events: OrderFilledEvent[], myAddress: string): Promise<void> {
        const key = `bsc:${events[0].txHash}`;
        if (this.isDuplicateNotification(key)) return;

        const tokenCache = getTokenMarketCache();
        const cacheReady = tokenCache.isReady();

        // 从所有事件的所有非零 assetId 中查找市场
        let lookup: TokenLookupResult | null = null;
        let resolvedEvent: OrderFilledEvent | null = null;

        if (cacheReady) {
            for (const evt of events) {
                for (const assetId of [evt.makerAssetId, evt.takerAssetId]) {
                    if (assetId === '0') continue;
                    const result = tokenCache.getMarketByTokenId(assetId);
                    if (result) {
                        lookup = result;
                        resolvedEvent = evt;
                        break;
                    }
                }
                if (lookup) break;
            }
        }

        // 未解析到市场时记录调试信息
        if (!lookup) {
            const allTokenIds = events.flatMap(e =>
                [e.makerAssetId, e.takerAssetId].filter(id => id !== '0')
            );
            console.warn(
                `[BscOrderNotifier] 市场查找失败 tx=${events[0].txHash.slice(0, 16)}`,
                `events=${events.length}`,
                `tokenIds=[${allTokenIds.map(id => id.slice(0, 12) + '...').join(', ')}]`,
                `cacheReady=${cacheReady}`,
            );
        }

        // 使用解析到市场的事件，否则回退到第一个事件
        const event = resolvedEvent || events[0];

        const marketTitle = lookup?.market.title || '未知市场';
        const tokenSide = lookup?.side || '?';  // YES/NO

        // 使用统一工具函数
        const shares = getSharesFromFillEvent(event);
        const direction = getFillDirection(event, myAddress);  // 'BUY' | 'SELL' | null

        // 计算 USDC 金额：哪边的 assetId 是 0，那边的 amount 就是 USDC
        const usdcAmount = event.takerAssetId === '0'
            ? event.takerAmountFilled
            : event.makerAmountFilled;

        // 计算成交价格（链上原始视角）
        const price = shares > 0 ? usdcAmount / shares : 0;

        // 默认展示链上视角；若能匹配到任务意图，优先展示任务视角（修复 T-T 消息反向问题）
        let displayTitle = marketTitle;
        let displaySide: 'YES' | 'NO' | '?' = tokenSide === 'YES' || tokenSide === 'NO' ? tokenSide : '?';
        let displayDirection: 'BUY' | 'SELL' | null = direction;
        let displayPrice = price;
        let displayUsdcAmount = usdcAmount;

        const taskIntent = this.resolveTaskIntent(lookup?.market.marketId, event.timestamp, shares);
        if (taskIntent) {
            displayTitle = taskIntent.title || displayTitle;
            displayDirection = taskIntent.side;

            const shouldFlip = (displaySide === 'YES' || displaySide === 'NO')
                && displaySide !== taskIntent.outcome
                && shares > 0;

            if (shouldFlip) {
                // 互补面换算：p(NO)=1-p(YES)
                displayPrice = Math.max(0, Math.min(1, 1 - displayPrice));
                displayUsdcAmount = Math.max(0, shares - displayUsdcAmount);
            }
            displaySide = taskIntent.outcome;

            console.log(
                `[BscOrderNotifier] 应用任务意图修正 tx=${event.txHash.slice(0, 12)} task=${taskIntent.taskId} ` +
                `chain=${direction || '?'} ${tokenSide} -> task=${taskIntent.side} ${taskIntent.outcome}`,
            );
        }

        // 体育市场显示队名 (如 "NO (Wizards)")，普通市场仅显示 YES/NO
        const outcomeName = displaySide === 'YES'
            ? lookup?.market.yesName
            : displaySide === 'NO'
                ? lookup?.market.noName
                : undefined;
        const sideDisplay = outcomeName && outcomeName !== 'Yes' && outcomeName !== 'No'
            ? `${displaySide} (${outcomeName})`
            : displaySide;

        // 角色：挂单方还是吃单方（链上角色，NegRisk 结算可能与 API 层不同）
        const role = event.maker.toLowerCase() === myAddress ? 'Maker' : 'Taker';

        // 交易类型
        const actionEmoji = displayDirection === 'BUY' ? '📈' : displayDirection === 'SELL' ? '📉' : '❓';
        const actionText = displayDirection === 'BUY' ? '买入' : displayDirection === 'SELL' ? '卖出' : '成交';

        const feeAmount = role === 'Maker' ? 0 : event.fee;
        const message = `🟠 ✅ <b>Predict 订单成交</b> (链上确认)

<b>类型:</b> ${actionEmoji} ${actionText}
<b>市场:</b> ${this.escapeHtml(displayTitle.slice(0, 60))}${displayTitle.length > 60 ? '...' : ''}
<b>方向:</b> ${sideDisplay}
<b>角色:</b> ${role}
<b>成交价:</b> ${(displayPrice * 100).toFixed(1)}¢
<b>成交量:</b> ${shares.toFixed(2)} 股
<b>成交额:</b> $${displayUsdcAmount.toFixed(2)}
<b>手续费:</b> $${feeAmount.toFixed(4)}

<b>订单:</b> <code>${event.orderHash.slice(0, 16)}...</code>
<b>交易:</b> <a href="https://bscscan.com/tx/${event.txHash}">查看</a>
<b>区块:</b> #${event.blockNumber}
<b>时间:</b> ${new Date(event.timestamp).toLocaleString('zh-CN')}

📡 <i>via BSC WebSocket</i>`;

        await this.telegram.sendText(message);
        this.emit('notified', event);
    }

    private resolveTaskIntent(
        marketId: number | undefined,
        fillTimestamp: number,
        shares: number
    ): TaskIntentMatch | null {
        if (!marketId || !Number.isFinite(marketId) || marketId <= 0) return null;

        try {
            const taskService = getTaskService();
            const candidates = taskService.getTasks({ marketId, includeCompleted: true });
            if (candidates.length === 0) return null;

            let best: TaskIntentMatch | null = null;
            let bestScore = Number.POSITIVE_INFINITY;

            for (const task of candidates) {
                const timeDiff = Math.abs(task.updatedAt - fillTimestamp);
                if (timeDiff > TASK_INTENT_LOOKBACK_MS) continue;

                const qtyRef = task.predictFilledQty > 0 ? task.predictFilledQty : task.quantity;
                const qtyDiff = Math.abs(qtyRef - shares);
                const statusPenalty = ACTIVE_TASK_STATUSES.has(task.status) ? 0 : 20000;
                const score = timeDiff + qtyDiff * 1500 + statusPenalty;

                if (score < bestScore) {
                    bestScore = score;
                    best = {
                        taskId: task.id,
                        side: task.type,
                        outcome: task.arbSide,
                        title: task.title || '',
                    };
                }
            }

            return best;
        } catch (e: any) {
            console.warn('[BscOrderNotifier] resolveTaskIntent failed:', e?.message || e);
            return null;
        }
    }

    private isDuplicateNotification(key: string): boolean {
        const now = Date.now();
        const lastTime = this.recentNotifications.get(key);
        if (lastTime && now - lastTime < this.config.silencePeriodMs) return true;
        this.recentNotifications.set(key, now);
        return false;
    }

    private cleanupRecentNotifications(): void {
        const now = Date.now();
        for (const [key, time] of this.recentNotifications.entries()) {
            if (now - time > this.config.silencePeriodMs * 2) {
                this.recentNotifications.delete(key);
            }
        }
    }

    private escapeHtml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}

let globalBscOrderNotifier: BscOrderNotifier | null = null;

export function getBscOrderNotifier(config?: BscOrderNotifierConfig): BscOrderNotifier {
    if (!globalBscOrderNotifier) {
        if (!config) throw new Error('BscOrderNotifier not initialized. Call with config first.');
        globalBscOrderNotifier = new BscOrderNotifier(config);
    }
    return globalBscOrderNotifier;
}

export async function startBscOrderNotifierFromEnv(): Promise<BscOrderNotifier | null> {
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    const smartWalletAddress = process.env.PREDICT_SMART_WALLET_ADDRESS;

    if (!telegramBotToken || !telegramChatId) {
        console.warn('[BscOrderNotifier] Missing Telegram credentials, skipping');
        return null;
    }

    if (!smartWalletAddress) {
        console.warn('[BscOrderNotifier] Missing PREDICT_SMART_WALLET_ADDRESS, skipping');
        return null;
    }

    const notifier = getBscOrderNotifier({
        telegramBotToken,
        telegramChatId,
        smartWalletAddress,
        enabled: true,
        notifyAllOrders: false,
    });

    await notifier.start();
    return notifier;
}

export function stopBscOrderNotifier(): void {
    if (globalBscOrderNotifier) {
        globalBscOrderNotifier.stop();
        globalBscOrderNotifier = null;
    }
}
