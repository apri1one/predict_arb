/**
 * BSC 链上订单通知服务
 *
 * 订阅 BscOrderWatcher 的 orderFilled 事件，将 Predict 订单成交推送到 Telegram。
 * 默认只通知“自己的订单”（需要 PREDICT_SMART_WALLET_ADDRESS），避免刷屏。
 */

import { EventEmitter } from 'events';
import { getBscOrderWatcher, getSharesFromFillEvent, getFillDirection, type OrderFilledEvent } from '../services/bsc-order-watcher.js';
import { getTokenMarketCache } from '../services/token-market-cache.js';
import { TelegramNotifier, createTelegramNotifier } from './telegram.js';

export interface BscOrderNotifierConfig {
    telegramBotToken: string;
    telegramChatId: string;

    enabled?: boolean;
    notifyAllOrders?: boolean;
    smartWalletAddress?: string;

    silencePeriodMs?: number;
}

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
                const best = this.pickBestEvent(entry.events, myAddress);
                void this.notifyOrderFilled(best, myAddress).catch(e => {
                    console.warn('[BscOrderNotifier] notifyOrderFilled failed:', e?.message || e);
                });
            }, 150),
        };
        this.pendingTxEvents.set(event.txHash, entry);
    }

    /**
     * 从同一 txHash 的多个 OrderFilled 事件中选出最佳的发通知
     *
     * CTF 交易所 YES/NO 配对结算会产生两个事件:
     * - 我方实际订单 (通常 fee=0 即 Maker，或 fee>0 即 Taker)
     * - 互补面 (对手方订单的另一侧，我方钱包作为 settlement 参与方)
     *
     * 选择策略: 优先选我方是 maker 的事件 (fee=0)，其次选 fee 更低的
     */
    private pickBestEvent(events: OrderFilledEvent[], myAddress: string): OrderFilledEvent {
        if (events.length === 1) return events[0];

        // 优先选我方是 maker 的事件 (我方实际挂单)
        const makerEvent = events.find(e => e.maker.toLowerCase() === myAddress);
        const takerEvent = events.find(e => e.taker.toLowerCase() === myAddress);

        if (makerEvent && takerEvent) {
            // 两个都有我方参与 → 选 fee 更低的 (maker fee 通常为 0)
            return makerEvent.fee <= takerEvent.fee ? makerEvent : takerEvent;
        }

        return makerEvent || takerEvent || events[0];
    }

    private async notifyOrderFilled(event: OrderFilledEvent, myAddress: string): Promise<void> {
        const key = `bsc:${event.txHash}`;
        if (this.isDuplicateNotification(key)) return;

        // 提取 token ID: 非零的 assetId 是 token
        const tokenId = event.takerAssetId !== '0' ? event.takerAssetId : event.makerAssetId;
        const tokenCache = getTokenMarketCache();
        let lookup = tokenCache.isReady() ? tokenCache.getMarketByTokenId(tokenId) : null;

        // 如果首个 tokenId 查不到，尝试另一个 assetId (CTF 配对事件可能携带对侧 tokenId)
        if (!lookup) {
            const altTokenId = event.takerAssetId !== '0' ? event.makerAssetId : event.takerAssetId;
            if (altTokenId !== '0') {
                lookup = tokenCache.isReady() ? tokenCache.getMarketByTokenId(altTokenId) : null;
            }
        }

        const marketTitle = lookup?.market.title || '未知市场';
        const tokenSide = lookup?.side || '?';  // YES/NO
        // 体育市场显示队名 (如 "NO (Wizards)")，普通市场仅显示 YES/NO
        const outcomeName = tokenSide === 'YES' ? lookup?.market.yesName : lookup?.market.noName;
        const sideDisplay = outcomeName && outcomeName !== 'Yes' && outcomeName !== 'No'
            ? `${tokenSide} (${outcomeName})`
            : tokenSide;

        // 使用统一工具函数
        const shares = getSharesFromFillEvent(event);
        const direction = getFillDirection(event, myAddress);  // 'BUY' | 'SELL' | null

        // 计算 USDC 金额：哪边的 assetId 是 0，那边的 amount 就是 USDC
        const usdcAmount = event.takerAssetId === '0'
            ? event.takerAmountFilled
            : event.makerAmountFilled;

        // 计算成交价格
        const price = shares > 0 ? usdcAmount / shares : 0;

        // 角色：挂单方还是吃单方
        const role = event.maker.toLowerCase() === myAddress ? 'Maker' : 'Taker';

        // 交易类型：买入开仓 / 卖出平仓
        const actionEmoji = direction === 'BUY' ? '📈' : '📉';
        const actionText = direction === 'BUY' ? '买入开仓' : '卖出平仓';

        const feeAmount = role === 'Maker' ? 0 : event.fee;
        const message = `🟠 ✅ <b>Predict 订单成交</b> (链上确认)

<b>类型:</b> ${actionEmoji} ${actionText}
<b>市场:</b> ${this.escapeHtml(marketTitle.slice(0, 60))}${marketTitle.length > 60 ? '...' : ''}
<b>方向:</b> ${sideDisplay}
<b>角色:</b> ${role}
<b>成交价:</b> ${(price * 100).toFixed(1)}¢
<b>成交量:</b> ${shares.toFixed(2)} 股
<b>成交额:</b> $${usdcAmount.toFixed(2)}
<b>手续费:</b> $${feeAmount.toFixed(4)}

<b>订单:</b> <code>${event.orderHash.slice(0, 16)}...</code>
<b>交易:</b> <a href="https://bscscan.com/tx/${event.txHash}">查看</a>
<b>区块:</b> #${event.blockNumber}
<b>时间:</b> ${new Date(event.timestamp).toLocaleString('zh-CN')}

📡 <i>via BSC WebSocket</i>`;

        await this.telegram.sendText(message);
        this.emit('notified', event);
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
