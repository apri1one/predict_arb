/**
 * Order Monitor - 订单状态监控
 *
 * 功能:
 * - Predict 订单轮询监控
 * - Polymarket 订单簿 WebSocket 监控
 * - 价格守护 (Price Guard) - 监控套利机会有效性
 */

import { EventEmitter } from 'events';
import { PolymarketWebSocketClient } from '../polymarket/ws-client.js';
import { getPredictTrader } from './predict-trader.js';
import { getPolymarketTrader } from './polymarket-trader.js';
import { getSportsService } from './sports-service.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface PriceGuardConfig {
    predictPrice: number;           // Predict 挂单价格
    polymarketTokenId: string;      // Polymarket token ID (NO)
    feeRateBps: number;             // 费率基点
    maxPolymarketPrice: number;     // 最大可接受 Polymarket 价格 (BUY 用)
    minPolymarketPrice?: number;    // 最小可接受 Polymarket 价格 (SELL 用)
    side: 'BUY' | 'SELL';           // 任务方向
    isSportsMarket?: boolean;       // 体育市场: Polymarket WS 不支持，纯 REST 轮询
}

export interface OrderWatchResult {
    filled: boolean;
    filledQty: number;
    avgPrice: number;
    error?: string;
}

// ============================================================================
// OrderMonitor 类
// ============================================================================

export class OrderMonitor extends EventEmitter {
    private predictWatches: Map<string, { active: boolean; intervalId?: NodeJS.Timeout }> = new Map();
    private polymarketWatches: Map<string, { active: boolean }> = new Map();
    private priceGuards: Map<string, { active: boolean; wsClient?: PolymarketWebSocketClient; restTimer?: NodeJS.Timeout }> = new Map();

    constructor() {
        super();
    }

    // ========================================================================
    // Predict 订单监控 (轮询)
    // ========================================================================

    /**
     * 监控 Predict 订单直到成交
     */
    async watchPredictOrder(
        hash: string,
        onFill: (result: OrderWatchResult) => void,
        options?: {
            intervalMs?: number;
            timeoutMs?: number;
        }
    ): Promise<void> {
        const intervalMs = options?.intervalMs ?? 500;
        const timeoutMs = options?.timeoutMs ?? 300000; // 5分钟超时

        // 避免重复监控
        if (this.predictWatches.has(hash)) {
            console.warn(`[OrderMonitor] Already watching Predict order: ${hash.slice(0, 10)}...`);
            return;
        }

        const watch = { active: true, intervalId: undefined as NodeJS.Timeout | undefined };
        this.predictWatches.set(hash, watch);

        const predictTrader = getPredictTrader();
        const startTime = Date.now();

        console.log(`[OrderMonitor] Watching Predict order: ${hash.slice(0, 10)}...`);

        const poll = async () => {
            if (!watch.active) return;

            // 超时检查
            if (Date.now() - startTime > timeoutMs) {
                this.stopPredictWatch(hash);
                onFill({ filled: false, filledQty: 0, avgPrice: 0, error: 'Timeout' });
                return;
            }

            try {
                const status = await predictTrader.getOrderStatus(hash);

                if (status) {
                    this.emit('predict:status', { hash, status });

                    if (status.status === 'FILLED') {
                        this.stopPredictWatch(hash);
                        onFill({
                            filled: true,
                            filledQty: status.filledQty,
                            avgPrice: status.avgPrice,
                        });
                        return;
                    }

                    if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
                        this.stopPredictWatch(hash);
                        onFill({
                            filled: false,
                            filledQty: status.filledQty,
                            avgPrice: status.avgPrice,
                            error: status.status,
                        });
                        return;
                    }

                    if (status.status === 'PARTIALLY_FILLED' && status.filledQty > 0) {
                        this.emit('predict:partial', { hash, filledQty: status.filledQty });
                    }
                }
            } catch (error: any) {
                console.error(`[OrderMonitor] Predict poll error:`, error.message);
            }

            // 继续轮询
            if (watch.active) {
                watch.intervalId = setTimeout(poll, intervalMs);
            }
        };

        // 开始轮询
        poll();
    }

    /**
     * 停止 Predict 订单监控
     */
    stopPredictWatch(hash: string): void {
        const watch = this.predictWatches.get(hash);
        if (watch) {
            watch.active = false;
            if (watch.intervalId) {
                clearTimeout(watch.intervalId);
            }
            this.predictWatches.delete(hash);
            console.log(`[OrderMonitor] Stopped watching Predict order: ${hash.slice(0, 10)}...`);
        }
    }

    // ========================================================================
    // Polymarket 订单监控 (轮询)
    // ========================================================================

    /**
     * 监控 Polymarket 订单直到成交
     * 注: Polymarket CLOB 目前使用轮询，因为 WS 订单状态订阅需要特殊认证
     */
    async watchPolymarketOrder(
        orderId: string,
        onFill: (result: OrderWatchResult) => void,
        options?: {
            intervalMs?: number;
            maxRetries?: number;
        }
    ): Promise<void> {
        const intervalMs = options?.intervalMs ?? 200;
        const maxRetries = options?.maxRetries ?? 10;

        if (this.polymarketWatches.has(orderId)) {
            console.warn(`[OrderMonitor] Already watching Polymarket order: ${orderId.slice(0, 10)}...`);
            return;
        }

        const watch = { active: true };
        this.polymarketWatches.set(orderId, watch);

        const polyTrader = getPolymarketTrader();

        console.log(`[OrderMonitor] Watching Polymarket order: ${orderId.slice(0, 10)}...`);

        const status = await polyTrader.pollOrderStatus(orderId, maxRetries, intervalMs);

        this.polymarketWatches.delete(orderId);

        if (status) {
            // MATCHED: 完全成交
            if (status.status === 'MATCHED') {
                onFill({
                    filled: true,
                    filledQty: status.filledQty,
                    avgPrice: status.avgPrice,
                });
            }
            // CANCELLED: 可能部分成交
            else if (status.status === 'CANCELLED') {
                onFill({
                    filled: status.filledQty > 0,
                    filledQty: status.filledQty,
                    avgPrice: status.avgPrice,
                    error: status.filledQty > 0 ? undefined : 'Order cancelled without fill',
                });
            }
            // LIVE: 还在等待成交（可能有部分成交）
            else {
                // LIVE 状态不是错误，只是还在等待
                // 返回当前的成交量，让上层决定是否继续等待
                onFill({
                    filled: status.filledQty > 0,
                    filledQty: status.filledQty,
                    avgPrice: status.avgPrice,
                    // 不设置 error，因为 LIVE 不是失败状态
                });
            }
        } else {
            onFill({
                filled: false,
                filledQty: 0,
                avgPrice: 0,
                error: 'Order not found',
            });
        }
    }

    /**
     * 停止 Polymarket 订单监控
     */
    stopPolymarketWatch(orderId: string): void {
        const watch = this.polymarketWatches.get(orderId);
        if (watch) {
            watch.active = false;
            this.polymarketWatches.delete(orderId);
            console.log(`[OrderMonitor] Stopped watching Polymarket order: ${orderId.slice(0, 10)}...`);
        }
    }

    // ========================================================================
    // 价格守护 (Price Guard)
    // ========================================================================

    /**
     * 启动价格守护
     *
     * 当 Polymarket 价格上移导致套利无效时触发 onPriceInvalid
     * 当价格回落套利有效时触发 onPriceValid
     */
    async startPriceGuard(
        config: PriceGuardConfig,
        callbacks: {
            onPriceInvalid: (currentPolyPrice: number) => void;
            onPriceValid: (currentPolyPrice: number) => void;
            /** 幽灵深度检测: 对冲价位深度在短时间内频繁出现/消失 */
            onDepthUnstable?: (flipCount: number) => void;
        }
    ): Promise<void> {
        const guardId = config.polymarketTokenId;

        if (this.priceGuards.has(guardId)) {
            console.warn(`[OrderMonitor] Price guard already active for: ${guardId.slice(0, 10)}...`);
            return;
        }

        console.log(`[OrderMonitor] Starting price guard for token: ${guardId.slice(0, 10)}...`);
        console.log(`  Side: ${config.side}`);
        console.log(`  Predict price: ${config.predictPrice}`);
        console.log(`  Max Poly price: ${config.maxPolymarketPrice}`);
        console.log(`  Min Poly price: ${config.minPolymarketPrice ?? 'N/A'}`);
        console.log(`  Fee: ${config.feeRateBps} bps`);

        // 创建 WebSocket 客户端监控订单簿
        const wsClient = new PolymarketWebSocketClient();
        const guard: { active: boolean; wsClient?: PolymarketWebSocketClient; restTimer?: NodeJS.Timeout } = { active: true, wsClient };
        this.priceGuards.set(guardId, guard);

        let lastValidState = true; // 假设初始有效
        let lastWsUpdateTime = Date.now();

        // ====== REST 轮询配置 (仅体育市场) ======
        const isSports = config.isSportsMarket ?? false;
        const REST_SPORTS_INTERVAL_MS = 200;  // 体育市场: 从 SportsService 0.1s 缓存读取

        // ====== 幽灵深度检测: 追踪对冲价位深度翻转 ======
        let lastHadHedgeableDepth: boolean | null = null;
        let depthFlipCount = 0;
        let depthFlipWindowStart = Date.now();
        let depthUnstableNotified = false;
        const DEPTH_FLIP_WINDOW_MS = 30_000;  // 30 秒窗口
        const DEPTH_FLIP_THRESHOLD = 6;       // 6 次翻转 = 3 轮出现/消失

        // ====== 核心检查逻辑 (WS 和 REST 共用) ======
        const checkOrderBook = (
            bids: [number, number][],
            asks: [number, number][],
            source: 'WS' | 'REST'
        ) => {
            if (!guard.active) return;

            let checkPrice: number | null = null;
            let isValid: boolean;

            if (config.side === 'BUY') {
                const bestAsk = asks.length > 0
                    ? Math.min(...asks.map(([price]) => price))
                    : null;

                if (bestAsk === null) return;

                checkPrice = bestAsk;
                isValid = this.isArbValidBuy(
                    config.predictPrice,
                    bestAsk,
                    config.feeRateBps,
                    config.maxPolymarketPrice
                );
            } else {
                const bestBid = bids.length > 0
                    ? Math.max(...bids.map(([price]) => price))
                    : null;

                if (bestBid === null) return;

                checkPrice = bestBid;
                isValid = this.isArbValidSell(
                    config.predictPrice,
                    bestBid,
                    config.minPolymarketPrice ?? 0
                );
            }

            // 状态变化时触发回调
            if (isValid !== lastValidState) {
                const priceType = config.side === 'BUY' ? 'ask' : 'bid';
                if (isValid) {
                    console.log(`[OrderMonitor] Price guard: ARB VALID (poly ${priceType}: ${checkPrice.toFixed(4)}, src: ${source})`);
                    callbacks.onPriceValid(checkPrice);
                } else {
                    console.log(`[OrderMonitor] Price guard: ARB INVALID (poly ${priceType}: ${checkPrice.toFixed(4)}, src: ${source})`);
                    callbacks.onPriceInvalid(checkPrice);
                }
                lastValidState = isValid;
            }

            // ====== 幽灵深度检测 (仅 WS 数据触发) ======
            if (source === 'WS' && callbacks.onDepthUnstable) {
                let hedgeableDepth = 0;
                if (config.side === 'BUY') {
                    for (const [price, size] of asks) {
                        if (price <= config.maxPolymarketPrice) hedgeableDepth += size;
                        else break;
                    }
                } else {
                    for (const [price, size] of bids) {
                        if (price >= (config.minPolymarketPrice ?? 0)) hedgeableDepth += size;
                        else break;
                    }
                }

                const hasDepth = hedgeableDepth >= 1;

                if (lastHadHedgeableDepth !== null && hasDepth !== lastHadHedgeableDepth) {
                    depthFlipCount++;
                }
                lastHadHedgeableDepth = hasDepth;

                const now = Date.now();
                if (now - depthFlipWindowStart > DEPTH_FLIP_WINDOW_MS) {
                    depthFlipCount = hasDepth !== lastHadHedgeableDepth ? 1 : 0;
                    depthFlipWindowStart = now;
                    depthUnstableNotified = false;
                }

                if (depthFlipCount >= DEPTH_FLIP_THRESHOLD && !depthUnstableNotified) {
                    console.warn(`[OrderMonitor] 🛑 幽灵深度: 对冲价位深度在 ${((now - depthFlipWindowStart) / 1000).toFixed(0)}s 内翻转 ${depthFlipCount} 次`);
                    callbacks.onDepthUnstable(depthFlipCount);
                    depthUnstableNotified = true;
                }
            }

            this.emit('priceGuard:update', {
                tokenId: guardId,
                polyPrice: checkPrice,
                isValid,
                side: config.side,
            });
        };

        // ====== WebSocket 事件处理 ======
        wsClient.setHandlers({
            onOrderBookUpdate: (book) => {
                if (!guard.active) return;
                if (book.assetId !== guardId) return;

                lastWsUpdateTime = Date.now();
                checkOrderBook(book.bids, book.asks, 'WS');
            },
            onConnect: () => {
                console.log(`[OrderMonitor] Price guard WS connected`);
                lastWsUpdateTime = Date.now();
            },
            onDisconnect: (code, reason) => {
                if (!guard.active) return; // stopPriceGuard 主动断开，忽略
                if (!isSports) {
                    // 非体育 WS 断连 → 触发全局任务暂停
                    console.warn(`[OrderMonitor] 非体育 WS 断连: code=${code} reason=${reason} → 触发全局任务暂停`);
                    lastValidState = false;
                    this.emit('priceGuard:wsDisconnect', { tokenId: guardId });
                } else {
                    console.log(`[OrderMonitor] Price guard WS disconnected: ${code} ${reason}`);
                }
            },
            onError: (error) => {
                console.error(`[OrderMonitor] Price guard WS error:`, error.message);
            },
        });

        if (isSports) {
            // ====== 体育市场: 跳过 WS，从 SportsService 缓存轮询 ======
            console.log(`[OrderMonitor] Sports market: skipping WS, REST-only mode (${REST_SPORTS_INTERVAL_MS}ms interval)`);
            const sportsRestPoll = async () => {
                if (!guard.active) return;
                try {
                    const cached = getSportsService().getPolyOrderbookFromCache(guardId);
                    if (cached && guard.active) {
                        checkOrderBook(cached.bids, cached.asks, 'REST');
                    }
                } catch (err: any) {
                    console.warn(`[OrderMonitor] Price guard REST poll failed:`, err?.message || err);
                }
                if (guard.active) {
                    guard.restTimer = setTimeout(sportsRestPoll, REST_SPORTS_INTERVAL_MS);
                }
            };
            guard.restTimer = setTimeout(sportsRestPoll, 1_000);
        } else {
            // ====== 非体育: WS only，断连时由 onDisconnect 触发全局暂停 ======
            try {
                await wsClient.connect();
                wsClient.subscribe([guardId]);
            } catch (error: any) {
                console.error(`[OrderMonitor] Price guard WS connect failed:`, error.message);
                // 连接失败也触发全局暂停
                lastValidState = false;
                this.emit('priceGuard:wsDisconnect', { tokenId: guardId });
            }
        }
    }

    /**
     * 停止价格守护
     */
    stopPriceGuard(tokenId: string): void {
        const guard = this.priceGuards.get(tokenId);
        if (guard) {
            guard.active = false;
            guard.wsClient?.disconnect();
            if (guard.restTimer) clearTimeout(guard.restTimer);
            this.priceGuards.delete(tokenId);
            console.log(`[OrderMonitor] Stopped price guard for: ${tokenId.slice(0, 10)}...`);
        }
    }

    /**
     * 检查 BUY 套利是否有效
     *
     * Buy 套利公式: predict_yes_bid + polymarket_no_ask + fee <= 1.0
     * 同时检查 polymarket 价格是否在可接受范围内
     *
     * 注: 使用 <= 1.0 + EPSILON 是因为:
     * - Maker 模式允许零利润 (有积分奖励)
     * - 体育市场互斥事件 (yes + no = 1) 不应触发价格保护
     * - 浮点精度问题 (0.39 + 0.61 可能等于 1.0000000000000002)
     */
    private isArbValidBuy(
        predictPrice: number,
        polyNoAsk: number,
        feeRateBps: number,
        maxPolyPrice: number
    ): boolean {
        // 浮点精度容差
        const EPSILON = 0.0001;

        // 检查价格是否超过最大可接受价格 (加 epsilon 容差)
        if (polyNoAsk > maxPolyPrice + EPSILON) {
            return false;
        }

        // 计算 Predict Taker 费用 (Maker 费用为 0)
        // Taker Fee = BaseFee% * min(Price, 1-Price) * (1 - rebate)
        // Predict 有 10% 返点
        const FEE_REBATE = 0.10;
        const baseFeeRate = feeRateBps / 10000;
        const grossFee = baseFeeRate * Math.min(predictPrice, 1 - predictPrice);
        const fee = grossFee * (1 - FEE_REBATE);

        // 套利条件: total cost <= 1.0 + epsilon (允许零利润，容忍浮点精度误差)
        const totalCost = predictPrice + polyNoAsk + fee;

        return totalCost <= 1.0 + EPSILON;
    }

    /**
     * 检查 SELL 套利是否有效
     *
     * Sell 套利公式: predict_yes_ask + polymarket_no_bid >= entryCost (或 > minBid)
     * SELL 任务需要 Polymarket bid 不低于 minBid
     */
    private isArbValidSell(
        predictPrice: number,
        polyNoBid: number,
        minPolyPrice: number
    ): boolean {
        // 检查价格是否低于最小可接受价格
        if (polyNoBid < minPolyPrice) {
            return false;
        }

        // SELL 任务: 收回资金 = predictPrice + polyNoBid
        // 只要 polyNoBid >= minBid 就认为有效
        return true;
    }

    // ========================================================================
    // 工具方法
    // ========================================================================

    /**
     * 停止所有监控
     */
    stopAll(): void {
        // 停止 Predict 监控
        for (const hash of this.predictWatches.keys()) {
            this.stopPredictWatch(hash);
        }

        // 停止 Polymarket 监控
        for (const orderId of this.polymarketWatches.keys()) {
            this.stopPolymarketWatch(orderId);
        }

        // 停止价格守护
        for (const tokenId of this.priceGuards.keys()) {
            this.stopPriceGuard(tokenId);
        }

        console.log('[OrderMonitor] All watches stopped');
    }

    /**
     * 获取活跃监控数量
     */
    getActiveWatchCount(): {
        predict: number;
        polymarket: number;
        priceGuard: number;
    } {
        return {
            predict: this.predictWatches.size,
            polymarket: this.polymarketWatches.size,
            priceGuard: this.priceGuards.size,
        };
    }
}

// ============================================================================
// 单例
// ============================================================================

let instance: OrderMonitor | null = null;

export function getOrderMonitor(): OrderMonitor {
    if (!instance) {
        instance = new OrderMonitor();
    }
    return instance;
}
