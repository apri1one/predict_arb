/**
 * Polymarket Trader - Polymarket CLOB 订单执行封装
 *
 * 功能:
 * - Taker 订单提交 (IOC 立即成交)
 * - 订单状态查询
 * - 订单取消
 * - HMAC L2 认证
 */

import { Wallet } from 'ethers';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { TelegramNotifier, createTelegramNotifier, type OrderAlert } from '../notification/telegram.js';
import { PolymarketUserWsClient, getPolymarketUserWsClient } from '../polymarket/user-ws-client.js';

// ============================================================================
// 常量
// ============================================================================

const CLOB_BASE_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

// poly-slugs.json 缓存类型
interface PolySlugEntry {
    eventSlug: string;
    marketSlug: string;
    question?: string;  // 完整问题形式，优先使用
}
type PolySlugsCache = Record<string, PolySlugEntry>;

// 加载 poly-slugs.json 缓存
let polySlugsCache: PolySlugsCache = {};
try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // dashboard -> src -> bot -> data
    const slugsPath = path.resolve(__dirname, '../../data/poly-slugs.json');
    if (fs.existsSync(slugsPath)) {
        polySlugsCache = JSON.parse(fs.readFileSync(slugsPath, 'utf-8'));
        console.log(`[PolymarketTrader] Loaded ${Object.keys(polySlugsCache).length} poly-slugs entries`);
    }
} catch (e: any) {
    console.warn(`[PolymarketTrader] Failed to load poly-slugs.json: ${e?.message || e}`);
}

// 从缓存获取市场标题（优先 question，fallback 到 marketSlug）
function getMarketTitleFromCache(conditionId: string): string | undefined {
    const entry = polySlugsCache[conditionId];
    if (!entry) return undefined;
    return entry.question || entry.marketSlug;
}

// 合约地址
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// EIP-712 Order 类型
const ORDER_TYPES = {
    Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
    ],
};

// ============================================================================
// 类型定义
// ============================================================================

export interface PolyOrderInput {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;        // 0-1 小数价格
    quantity: number;     // shares 数量
    orderType?: 'GTC' | 'IOC';  // 默认 IOC
    negRisk?: boolean;
    outcome?: 'YES' | 'NO';     // YES/NO 方向，用于通知显示
    outcomeName?: string;       // 多选市场的选项名（如 "Trump"），二元市场可省略
    marketTitle?: string;       // 市场标题，用于 TG 通知显示（优先级最高）
    conditionId?: string;       // Polymarket conditionId，用于从 poly-slugs 缓存查找标题
}

export interface PolyOrderResult {
    success: boolean;
    orderId?: string;
    error?: string;
}

export interface PolyOrderStatus {
    status: 'LIVE' | 'MATCHED' | 'CANCELLED';
    filledQty: number;
    remainingQty: number;
    avgPrice: number;
}

export interface PolyPosition {
    tokenId: string;
    quantity: number;
    avgPrice: number;
}

// ============================================================================
// WS 订单簿提供者（依赖注入，避免循环依赖）
// ============================================================================

type WsOrderbookProvider = (tokenId: string) => { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null;
let wsOrderbookProvider: WsOrderbookProvider | null = null;

/**
 * 设置 WS 订单簿提供者（由 start-dashboard 注入）
 * 任务执行时优先使用 WS 缓存，减少 API 调用
 */
export function setPolymarketWsOrderbookProvider(provider: WsOrderbookProvider): void {
    wsOrderbookProvider = provider;
    console.log('[PolymarketTrader] WS 订单簿提供者已注入');
}

// ============================================================================
// PolymarketTrader 类
// ============================================================================

export class PolymarketTrader extends EventEmitter {
    private wallet: Wallet;
    private proxyAddress: string;
    private apiKey: string;
    private apiSecret: string;
    private passphrase: string;
    private traderAddress: string;
    private initialized = false;
    private telegram: TelegramNotifier | null = null;

    // User WS（用于加速订单状态确认）
    private userWs: PolymarketUserWsClient | null = null;
    private userWsListenerIds: string[] = [];
    private useWsForPolling: boolean = true;

    // tokenId/orderId -> marketTitle 缓存（用于 TG 通知显示）
    private tokenTitleCache = new Map<string, string>();
    private orderTitleCache = new Map<string, string>();

    constructor() {
        super();

        const privateKey = process.env.POLYMARKET_TRADER_PRIVATE_KEY;
        const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;
        const apiKey = process.env.POLYMARKET_API_KEY;
        const apiSecret = process.env.POLYMARKET_API_SECRET;
        const passphrase = process.env.POLYMARKET_PASSPHRASE;
        const traderAddress = process.env.POLYMARKET_TRADER_ADDRESS;

        if (!privateKey) throw new Error('POLYMARKET_TRADER_PRIVATE_KEY is required');
        if (!proxyAddress) throw new Error('POLYMARKET_PROXY_ADDRESS is required');
        if (!apiKey) throw new Error('POLYMARKET_API_KEY is required');
        if (!apiSecret) throw new Error('POLYMARKET_API_SECRET is required');
        if (!passphrase) throw new Error('POLYMARKET_PASSPHRASE is required');

        this.wallet = new Wallet(privateKey);
        this.proxyAddress = proxyAddress;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.passphrase = passphrase;
        this.traderAddress = traderAddress || this.wallet.address;

        // 初始化 Telegram 通知
        const tgToken = process.env.TELEGRAM_BOT_TOKEN;
        const tgChatId = process.env.TELEGRAM_CHAT_ID;
        if (tgToken && tgChatId) {
            this.telegram = createTelegramNotifier({
                botToken: tgToken,
                chatId: tgChatId,
                enabled: true,
            });
        }
    }

    /**
     * 初始化
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        // 验证地址匹配
        if (this.traderAddress.toLowerCase() !== this.wallet.address.toLowerCase()) {
            console.warn(`[PolymarketTrader] Address mismatch: env=${this.traderAddress}, wallet=${this.wallet.address}`);
        }

        // 初始化 User WebSocket 客户端（可选；失败则回退到纯 REST 轮询）
        if (this.useWsForPolling) {
            try {
                this.userWs = getPolymarketUserWsClient({
                    apiKey: this.apiKey,
                    secret: this.apiSecret,
                    passphrase: this.passphrase,
                });

                // 仅用于调试/可观测性；不要影响其他模块的监听器
                this.userWsListenerIds = this.userWs.setHandlers({
                    onConnect: () => console.log('[PolymarketTrader] User WS connected'),
                    onDisconnect: (code, reason) => console.log(`[PolymarketTrader] User WS disconnected: ${code} ${reason}`),
                    onError: (error) => console.warn(`[PolymarketTrader] User WS error: ${error.message}`),
                });

                await this.userWs.connect();
                console.log('[PolymarketTrader] User WS initialized for real-time order tracking');
            } catch (e: any) {
                console.warn(`[PolymarketTrader] Failed to initialize User WS: ${e?.message || e}, falling back to polling`);
                this.useWsForPolling = false;
                this.userWs = null;
                this.userWsListenerIds = [];
            }
        }

        this.initialized = true;
        console.log(`[PolymarketTrader] Initialized: signer=${this.wallet.address.slice(0, 10)}..., proxy=${this.proxyAddress.slice(0, 10)}...`);
    }

    /** 发送订单通知（fire-and-forget，不阻塞订单流程） */
    notifyOrderAlert(alert: OrderAlert): void {
        if (!this.telegram) return;
        this.telegram.alertOrder(alert).catch(error =>
            console.warn('[PolymarketTrader] Failed to send Telegram order alert:', error?.message || error)
        );
    }

    /**
     * 提交买单 (Taker)
     */
    async placeBuyOrder(input: PolyOrderInput): Promise<PolyOrderResult> {
        return this.placeOrder({ ...input, side: 'BUY' });
    }

    /**
     * 提交卖单 (Taker)
     */
    async placeSellOrder(input: PolyOrderInput): Promise<PolyOrderResult> {
        return this.placeOrder({ ...input, side: 'SELL' });
    }

    /**
     * 提交订单 (默认 IOC)
     */
    async placeOrder(input: PolyOrderInput): Promise<PolyOrderResult> {
        if (!this.initialized) await this.init();

        // 验证 tokenId 存在
        if (!input.tokenId) {
            const error = 'tokenId is required for placeOrder';
            console.error(`[PolymarketTrader] ${error}`);
            return { success: false, error };
        }

        try {
            const orderType = input.orderType || 'IOC';
            const negRisk = input.negRisk || false;

            // 计算金额 (对齐到两位小数，支持小数精度)
            const alignedQty = Math.floor(input.quantity * 100) / 100;  // 对齐到两位小数 (如 9.9477 → 9.94)
            const sizeInUnits = BigInt(Math.round(alignedQty * 1e6));   // 小数 * 1e6 (USDC 6位精度)
            const priceInUnits = BigInt(Math.floor(input.price * 1e6));

            if (alignedQty !== input.quantity) {
                console.log(`[PolymarketTrader] Quantity aligned: ${input.quantity} → ${alignedQty} (truncated ${(input.quantity - alignedQty).toFixed(6)})`);
            }

            let makerAmount: bigint;
            let takerAmount: bigint;

            if (input.side === 'BUY') {
                makerAmount = (sizeInUnits * priceInUnits) / BigInt(1e6);
                takerAmount = sizeInUnits;
            } else {
                makerAmount = sizeInUnits;
                takerAmount = (sizeInUnits * priceInUnits) / BigInt(1e6);
            }

            // 构建订单
            const salt = Math.round(Math.random() * Date.now());
            // GTC 和 IOC 订单的 expiration 都必须为 0
            // 只有 GTD (Good-Till-Date) 订单才需要设置过期时间
            const expiration = BigInt(0);

            const orderForSigning = {
                salt: salt,
                maker: this.proxyAddress,
                signer: this.wallet.address,
                taker: '0x0000000000000000000000000000000000000000',
                tokenId: BigInt(input.tokenId),
                makerAmount: makerAmount,
                takerAmount: takerAmount,
                expiration: expiration,
                nonce: 0,
                feeRateBps: 0,  // Taker 0 手续费
                side: input.side === 'BUY' ? 0 : 1,
                signatureType: 2,  // POLY_GNOSIS_SAFE
            };

            // 获取 domain
            const domain = this.getDomain(negRisk);

            // 签署订单
            const signature = await this.wallet.signTypedData(domain, ORDER_TYPES, orderForSigning);

            // 构建请求体
            const body = JSON.stringify({
                order: {
                    salt: salt,
                    maker: this.proxyAddress,
                    signer: this.wallet.address,
                    taker: '0x0000000000000000000000000000000000000000',
                    tokenId: input.tokenId,
                    makerAmount: makerAmount.toString(),
                    takerAmount: takerAmount.toString(),
                    expiration: expiration.toString(),
                    nonce: '0',
                    feeRateBps: '0',
                    side: input.side,
                    signatureType: 2,  // POLY_GNOSIS_SAFE
                    signature: signature,
                },
                owner: this.apiKey,
                orderType: orderType,
            });

            // 发送请求
            const path = '/order';
            const headers = this.buildHeaders('POST', path, body);

            const res = await fetch(`${CLOB_BASE_URL}${path}`, {
                method: 'POST',
                headers,
                body,
            });

            if (!res.ok) {
                const errorText = await res.text();
                const errorMsg = `HTTP ${res.status}: ${errorText}`;
                // 发送 TG 通知: HTTP 错误
                if (this.telegram) {
                    const marketName = input.marketTitle
                        || this.tokenTitleCache.get(input.tokenId)
                        || (input.conditionId && getMarketTitleFromCache(input.conditionId))
                        || `Token ${input.tokenId.slice(0, 10)}...`;
                    this.telegram.alertError({
                        operation: '下单',
                        platform: 'POLYMARKET',
                        marketName,
                        error: errorMsg,
                        requiresManualIntervention: false,
                    }).catch(() => {});
                }
                return { success: false, error: errorMsg };
            }

            const data = await res.json() as any;
            const orderId = data.orderID || data.id || data.order_id;

            // 记录 tokenId/orderId -> marketTitle 缓存
            if (input.marketTitle) {
                this.tokenTitleCache.set(input.tokenId, input.marketTitle);
                if (orderId) {
                    this.orderTitleCache.set(orderId, input.marketTitle);
                }
            }

            this.emit('order:placed', { orderId, input });

            // 发送 TG 通知: 下单成功（fire-and-forget）
            if (this.telegram) {
                const marketName = input.marketTitle
                    || this.tokenTitleCache.get(input.tokenId)
                    || (input.conditionId && getMarketTitleFromCache(input.conditionId))
                    || `Token ${input.tokenId.slice(0, 10)}...`;
                this.telegram.alertOrder({
                    type: 'PLACED',
                    platform: 'POLYMARKET',
                    marketName,
                    action: input.side,  // BUY/SELL
                    side: input.outcome || 'NO',  // YES/NO 方向
                    outcome: input.outcomeName,  // 多选市场的选项名
                    price: input.price,
                    quantity: input.quantity,
                    timestamp: Date.now(),
                }).catch(() => {});
            }

            return { success: true, orderId };
        } catch (error: any) {
            // 发送 TG 通知: 下单失败（fire-and-forget）
            if (this.telegram) {
                const marketName = input.marketTitle
                    || this.tokenTitleCache.get(input.tokenId)
                    || (input.conditionId && getMarketTitleFromCache(input.conditionId))
                    || `Token ${input.tokenId.slice(0, 10)}...`;
                this.telegram.alertError({
                    operation: '下单',
                    platform: 'POLYMARKET',
                    marketName,
                    error: error.message,
                    requiresManualIntervention: false,
                }).catch(() => {});
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * 获取订单状态
     */
    async getOrderStatus(orderId: string): Promise<PolyOrderStatus | null> {
        try {
            const path = `/data/order/${orderId}`;
            const headers = this.buildHeaders('GET', path);

            const res = await fetch(`${CLOB_BASE_URL}${path}`, { headers });

            if (!res.ok) return null;

            const data = await res.json() as any;

            return {
                status: data.status || 'LIVE',
                filledQty: parseFloat(data.size_matched || '0'),
                remainingQty: parseFloat(data.original_size || '0') - parseFloat(data.size_matched || '0'),
                avgPrice: parseFloat(data.price || '0'),
            };
        } catch {
            return null;
        }
    }

    /**
     * 轮询订单状态
     *
     * 订单状态:
     * - LIVE: 正在等待成交，继续轮询
     * - MATCHED: 完全成交
     * - CANCELLED: 已取消（IOC 部分成交后剩余被取消时 filledQty > 0）
     */
    async pollOrderStatus(
        orderId: string,
        maxRetries: number = 3,
        intervalMs: number = 150
    ): Promise<PolyOrderStatus | null> {
        if (this.useWsForPolling && this.userWs?.connected()) {
            return this.pollOrderStatusViaWs(orderId, maxRetries, intervalMs);
        }

        return this.pollOrderStatusViaApi(orderId, maxRetries, intervalMs);
    }

    private async pollOrderStatusViaWs(
        orderId: string,
        maxRetries: number,
        intervalMs: number
    ): Promise<PolyOrderStatus | null> {
        if (!this.userWs) return null;

        let lastStatus: PolyOrderStatus | null = null;

        for (let i = 0; i < maxRetries; i++) {
            const signal = await this.userWs.waitForOrderFinal(orderId, intervalMs);

            // WS-first: return immediately on final WS status; REST is fallback only.
            if (signal.status === 'MATCHED' || signal.status === 'CANCELLED') {
                const wsStatus: PolyOrderStatus = {
                    status: signal.status,
                    filledQty: signal.filledQty,
                    remainingQty: 0,
                    avgPrice: 0,
                };
                if (signal.status === 'MATCHED') {
                    this.emit('order:filled', { orderId, status: wsStatus });
                }
                return wsStatus;
            }

            if (signal.status === 'LIVE' && signal.filledQty > 0) {
                lastStatus = {
                    status: 'LIVE',
                    filledQty: signal.filledQty,
                    remainingQty: 0,
                    avgPrice: 0,
                };
            }

            // No final WS signal; REST as fallback.
            const status = await this.getOrderStatus(orderId);
            if (status) {
                lastStatus = status;
                if (status.status === 'MATCHED') {
                    this.emit('order:filled', { orderId, status });
                    return status;
                }
                if (status.status === 'CANCELLED') {
                    return status;
                }
            } else if (signal.filledQty > 0 && (!lastStatus || lastStatus.filledQty === 0)) {
                lastStatus = { status: 'LIVE', filledQty: signal.filledQty, remainingQty: 0, avgPrice: 0 };
            }
        }

        return lastStatus;
    }

    private async pollOrderStatusViaApi(
        orderId: string,
        maxRetries: number,
        intervalMs: number
    ): Promise<PolyOrderStatus | null> {
        let lastStatus: PolyOrderStatus | null = null;

        for (let i = 0; i < maxRetries; i++) {
            const status = await this.getOrderStatus(orderId);

            if (status) {
                lastStatus = status;

                // MATCHED: 完全成交
                if (status.status === 'MATCHED') {
                    this.emit('order:filled', { orderId, status });
                    return status;
                }

                // CANCELLED: IOC 订单未完全成交时，剩余部分会被取消
                // 但可能已有部分成交（filledQty > 0）
                if (status.status === 'CANCELLED') {
                    if (status.filledQty > 0) {
                        console.log(`[PolyTrader] IOC order partially filled: ${status.filledQty}`);
                    }
                    return status;
                }

                // LIVE: 订单还在等待成交，继续轮询
                console.log(`[PolyTrader] Order ${orderId.slice(0, 10)}... status: LIVE, filled: ${status.filledQty}, retry: ${i + 1}/${maxRetries}`);
            }

            await this.delay(intervalMs);
        }

        // 超时后返回最后已知的状态（可能还是 LIVE）
        if (lastStatus) {
            console.log(`[PolyTrader] Poll timeout, last status: ${lastStatus.status}, filled: ${lastStatus.filledQty}`);
        }
        return lastStatus;
    }

    /**
     * 取消订单
     */
    async cancelOrder(
        orderId: string,
        options?: {
            timeoutMs?: number;
            skipTelegram?: boolean;
            marketTitle?: string;   // 市场标题，用于 TG 通知（优先级最高）
            conditionId?: string;   // conditionId，用于从 poly-slugs 查找标题
        }
    ): Promise<boolean> {
        const timeoutMs = options?.timeoutMs ?? 5000;
        try {
            const path = '/order';
            const body = JSON.stringify({ orderID: orderId });
            const headers = this.buildHeaders('DELETE', path, body);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            let res: Response;
            try {
                res = await fetch(`${CLOB_BASE_URL}${path}`, {
                    method: 'DELETE',
                    headers,
                    body,
                    signal: controller.signal,
                });
            } catch (e: any) {
                if (e?.name === 'AbortError') {
                    console.warn(`[PolyTrader] ⚠️ Timeout cancelling order ${orderId}`);
                    return false;
                }
                throw e;
            } finally {
                clearTimeout(timeoutId);
            }

            if (res.ok) {
                this.emit('order:cancelled', { orderId });

                // 发送 TG 通知: 订单取消成功
                if (this.telegram && !options?.skipTelegram) {
                    const marketName = options?.marketTitle
                        || this.orderTitleCache.get(orderId)
                        || (options?.conditionId && getMarketTitleFromCache(options.conditionId))
                        || `Order ${orderId.slice(0, 10)}...`;
                    this.telegram.alertOrder({
                        type: 'CANCELLED',
                        platform: 'POLYMARKET',
                        marketName,
                        action: 'BUY',
                        side: 'NO',
                        price: 0,
                        quantity: 0,
                    }).catch(() => {});
                }
            }

            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * 获取订单簿
     * 优先使用 WS 缓存（实时），fallback 到 REST API
     */
    async getOrderbook(tokenId: string): Promise<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null> {
        // 优先使用 WS 缓存（实时数据，减少 API 调用）
        if (wsOrderbookProvider) {
            const wsBook = wsOrderbookProvider(tokenId);
            if (wsBook && (wsBook.bids.length > 0 || wsBook.asks.length > 0)) {
                return wsBook;
            }
        }

        // Fallback: REST API
        try {
            const res = await fetch(`${CLOB_BASE_URL}/book?token_id=${tokenId}`);
            if (!res.ok) return null;

            const data = await res.json() as {
                bids: { price: string; size: string }[];
                asks: { price: string; size: string }[];
            };

            return {
                bids: (data.bids || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
                    .sort((a, b) => b.price - a.price),
                asks: (data.asks || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
                    .sort((a, b) => a.price - b.price),
            };
        } catch {
            return null;
        }
    }

    /**
     * 获取市场信息 (包含 tickSize)
     */
    async getMarketInfo(conditionId: string): Promise<{ tickSize: number; negRisk: boolean; tokens: { tokenId: string; outcome: string }[] } | null> {
        try {
            const res = await fetch(`${CLOB_BASE_URL}/markets/${conditionId}`);
            if (!res.ok) return null;

            const data = await res.json() as any;

            return {
                tickSize: parseFloat(data.minimum_tick_size || '0.01'),
                negRisk: data.neg_risk === true,
                tokens: (data.tokens || []).map((t: any) => ({
                    tokenId: t.token_id,
                    outcome: t.outcome,
                })),
            };
        } catch {
            return null;
        }
    }

    /**
     * 获取余额
     */
    async getBalance(): Promise<number> {
        try {
            const path = '/balance-allowance?asset_type=COLLATERAL';
            const headers = this.buildHeaders('GET', path);

            const res = await fetch(`${CLOB_BASE_URL}${path}`, { headers });
            if (!res.ok) return 0;

            const data = await res.json() as { balance?: string };
            return parseFloat(data.balance || '0') / 1e6;
        } catch {
            return 0;
        }
    }

    // ========================================================================
    // 私有方法
    // ========================================================================

    private getDomain(negRisk: boolean) {
        return {
            name: 'Polymarket CTF Exchange',
            version: '1',
            chainId: CHAIN_ID,
            verifyingContract: negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE,
        };
    }

    private buildHeaders(method: string, path: string, body: string = ''): Record<string, string> {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const message = timestamp + method + path + body;
        const secretBuffer = Buffer.from(this.apiSecret, 'base64');
        const signature = crypto
            .createHmac('sha256', secretBuffer)
            .update(message, 'utf-8')
            .digest('base64');
        const urlSafeSignature = signature.replace(/\+/g, '-').replace(/\//g, '_');

        return {
            'POLY_API_KEY': this.apiKey,
            'POLY_SIGNATURE': urlSafeSignature,
            'POLY_TIMESTAMP': timestamp,
            'POLY_PASSPHRASE': this.passphrase,
            'POLY_ADDRESS': this.traderAddress,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================================
// 单例
// ============================================================================

let instance: PolymarketTrader | null = null;

export function getPolymarketTrader(): PolymarketTrader {
    if (!instance) {
        instance = new PolymarketTrader();
    }
    return instance;
}
