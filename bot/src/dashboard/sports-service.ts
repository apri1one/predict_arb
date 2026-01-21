/**
 * Sports Market Service
 *
 * 体育市场匹配 + 套利计算服务
 *
 * 功能：
 * 1. 定期扫描 Predict/Polymarket 体育市场
 * 2. 匹配两平台的市场 (conditionId / slug)
 * 3. 获取订单簿并计算套利机会
 * 4. 一致性校验 (互斥性约束)
 * 5. 通过 SSE 广播数据
 */

import { PredictRestClient } from '../predict/rest-client.js';
import { PolymarketRestClient } from '../polymarket/rest-client.js';
import { calculatePredictFee } from '../trading/depth-calculator.js';
import { getPredictSlug, getPredictSlugByTitle } from './url-mapper.js';
import { getPredictOrderbookCache } from '../services/predict-orderbook-cache.js';

// ============================================================================
// Predict 订单簿 Provider (WS 模式支持)
// ============================================================================

type PredictOrderbookProvider = (marketId: number) => { bids: [number, number][]; asks: [number, number][] } | null;
let predictOrderbookProvider: PredictOrderbookProvider | null = null;

/**
 * 设置 Predict 订单簿 provider（供 start-dashboard 注入）
 * WS 模式下使用统一缓存，Legacy 模式下为 null（使用 REST）
 */
export function setSportsPredictOrderbookProvider(provider: PredictOrderbookProvider | null): void {
    predictOrderbookProvider = provider;
    console.log(`[SportsService] Predict 订单簿 provider ${provider ? '已注入' : '已清除'}`);
}
import type {
    SportsMatchedMarket,
    SportsArbOpportunity,
    SportsOrderBook,
    SportsSSEData,
    PolyMarket,
    SportType,
    MatchedMarket,
} from './sports-types.js';
import { POLY_SPORTS_TAGS, SPORTS_KEYWORDS, CONSISTENCY_EPSILON, NBA_CITY_TO_ABBR, NBA_ABBR_TO_TEAM } from './sports-types.js';

// ============================================================================
// Sports 专用 API Key 轮换器
// ============================================================================

class SportsApiKeyRotator {
    private keys: string[] = [];
    private index: number = 0;
    private lastSignature: string | null = null;

    private loadFromEnv(): void {
        const loaded: string[] = [];

        // 加载体育市场专用 API keys (PREDICT_API_KEY_SPORTS_1, _2, _3)
        for (let i = 1; i <= 10; i++) {
            const key = process.env[`PREDICT_API_KEY_SPORTS_${i}`];
            if (key) loaded.push(key);
        }
        // 如果没有专用 key，回退到 SCAN keys
        if (loaded.length === 0) {
            const scanKey = process.env['PREDICT_API_KEY_SCAN'];
            if (scanKey) loaded.push(scanKey);
            for (let i = 2; i <= 3; i++) {
                const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
                if (key) loaded.push(key);
            }
        }
        // 最后回退到主 key
        if (loaded.length === 0) {
            const mainKey = process.env['PREDICT_API_KEY'];
            if (mainKey) loaded.push(mainKey);
        }

        const signature = loaded.join('|');
        this.keys = loaded;
        if (this.index >= this.keys.length) this.index = 0;

        // 仅在变化时输出，避免在 .env 尚未加载时打印 0 keys
        if (this.lastSignature !== signature) {
            this.lastSignature = signature;
            console.log(`[SportsService] API Keys loaded: ${this.keys.length} keys for parallel scanning`);
        }
    }

    getNextKey(): string {
        this.loadFromEnv();
        if (this.keys.length === 0) {
            throw new Error('No API keys available for sports scanning');
        }
        const key = this.keys[this.index];
        this.index = (this.index + 1) % this.keys.length;
        return key;
    }

    getAllKeys(): string[] {
        this.loadFromEnv();
        return [...this.keys];
    }

    getKeyCount(): number {
        this.loadFromEnv();
        return this.keys.length;
    }
}

const sportsApiKeys = new SportsApiKeyRotator();

// ============================================================================
// Types
// ============================================================================

interface InternalMatchedMarket extends MatchedMarket {
    predictMarket: any;  // PredictMarket from API (非 NBA)
    polyMarket: PolyMarket;

    // NBA 双市场支持
    isNbaMultiMarket?: boolean;         // 是否是 NBA 多市场结构
    predictAwayMarket?: any;            // NBA 客队获胜市场
    predictHomeMarket?: any;            // NBA 主队获胜市场
}

// ============================================================================
// Sports Service
// ============================================================================

export class SportsService {
    private predictClient: PredictRestClient;
    private polyClient: PolymarketRestClient;
    private cachedMarkets: SportsMatchedMarket[] = [];
    private matchedMarketsCache: InternalMatchedMarket[] = [];  // 已匹配市场缓存
    private orderbookCache: Map<number, SportsOrderBook> = new Map();  // 订单簿缓存 (防止 API 失败时卡片消失)

    // 分离的订单簿缓存 (支持不同刷新频率)
    private predictOrderbookCache: Map<number, { bids: [number, number][]; asks: [number, number][] }> = new Map();
    private polyOrderbookCache: Map<string, { bids: [number, number][]; asks: [number, number][] }> = new Map();

    private lastUpdateTime: number = 0;
    private isScanning: boolean = false;
    private isRefreshing: boolean = false;
    private isRefreshingPoly: boolean = false;
    private isRefreshingPredict: boolean = false;

    // 刷新计数器 (用于日志)
    private polyRefreshCount: number = 0;
    private predictRefreshCount: number = 0;

    constructor() {
        this.predictClient = new PredictRestClient();
        this.polyClient = new PolymarketRestClient();
    }

    /**
     * 是否已完成初始匹配
     */
    hasMatchedMarkets(): boolean {
        return this.matchedMarketsCache.length > 0;
    }

    // ============================================================================
    // Public API
    // ============================================================================

    /**
     * 获取当前缓存的体育市场数据
     */
    getMarkets(): SportsMatchedMarket[] {
        return this.cachedMarkets;
    }

    /**
     * 获取 SSE 广播数据
     */
    getSSEData(): SportsSSEData {
        const markets = this.cachedMarkets;
        const withArb = markets.filter(m =>
            m.bestOpportunity && m.bestOpportunity.profitPercent > 0
        );

        const profits = withArb.map(m => m.bestOpportunity!.profitPercent);
        const avgProfit = profits.length > 0
            ? profits.reduce((a, b) => a + b, 0) / profits.length
            : 0;
        const maxProfit = profits.length > 0 ? Math.max(...profits) : 0;

        return {
            markets,
            stats: {
                totalMatched: markets.length,
                withArbitrage: withArb.length,
                avgProfit,
                maxProfit,
            },
            lastUpdate: this.lastUpdateTime,
        };
    }

    /**
     * 执行一次完整扫描 (启动时调用一次)
     * 获取市场列表 + 匹配 + 订单簿
     */
    async scan(): Promise<SportsMatchedMarket[]> {
        if (this.isScanning) {
            console.log('[SportsService] Scan already in progress, skipping');
            return this.cachedMarkets;
        }

        this.isScanning = true;
        const startTime = Date.now();

        try {
            // 1. 获取匹配的市场
            const matchedMarkets = await this.fetchAndMatchMarkets();

            if (matchedMarkets.length === 0) {
                console.log('[SportsService] No matched sports markets found');
                this.cachedMarkets = [];
                this.matchedMarketsCache = [];
                return [];
            }

            // 2. 缓存匹配结果 (后续只刷新订单簿)
            this.matchedMarketsCache = matchedMarkets;

            // 3. 获取订单簿并计算套利 (体育市场使用 REST API)
            const marketsWithArb = await this.calculateArbitrage(matchedMarkets);

            // 4. 更新缓存
            this.cachedMarkets = marketsWithArb;
            this.lastUpdateTime = Date.now();

            const elapsed = Date.now() - startTime;
            const withArb = marketsWithArb.filter(m => (m.bestOpportunity?.profitPercent ?? 0) > 0);
            console.log(`[SportsService] Initial scan: ${marketsWithArb.length} markets matched, ${withArb.length} with arb, ${elapsed}ms`);

            return marketsWithArb;
        } catch (error) {
            console.error('[SportsService] Scan error:', error);
            throw error;
        } finally {
            this.isScanning = false;
        }
    }

    /**
     * 刷新已匹配市场的订单簿 (定时调用)
     * 只获取订单簿，不重新匹配市场
     */
    async refreshOrderbooks(): Promise<SportsMatchedMarket[]> {
        if (this.matchedMarketsCache.length === 0) {
            // 尚未完成初始匹配，跳过
            return this.cachedMarkets;
        }

        if (this.isRefreshing) {
            return this.cachedMarkets;
        }

        this.isRefreshing = true;
        const startTime = Date.now();

        try {
            // 使用缓存的匹配结果，只刷新订单簿
            const marketsWithArb = await this.calculateArbitrage(this.matchedMarketsCache);

            // 更新缓存
            this.cachedMarkets = marketsWithArb;
            this.lastUpdateTime = Date.now();

            const elapsed = Date.now() - startTime;
            const withArb = marketsWithArb.filter(m => (m.bestOpportunity?.profitPercent ?? 0) > 0);
            console.log(`[SportsService] Orderbook refresh: ${marketsWithArb.length} markets, ${withArb.length} with arb, ${elapsed}ms`);

            return marketsWithArb;
        } catch (error) {
            console.error('[SportsService] Refresh error:', error);
            throw error;
        } finally {
            this.isRefreshing = false;
        }
    }

    /**
     * 只刷新 Polymarket 订单簿 (高频: 0.1s)
     */
    async refreshPolymarketOrderbooks(): Promise<void> {
        if (this.matchedMarketsCache.length === 0 || this.isRefreshingPoly) {
            return;
        }

        this.isRefreshingPoly = true;
        try {
            const promises = this.matchedMarketsCache.map(async (match) => {
                const clobTokenIds = JSON.parse(match.polyMarket.clobTokenIds || '[]') as string[];
                if (clobTokenIds.length < 2) return;

                const awayTokenId = clobTokenIds[0];
                const homeTokenId = clobTokenIds[1];

                try {
                    const [awayBook, homeBook] = await Promise.all([
                        this.getPolyOrderBook(awayTokenId),
                        this.getPolyOrderBook(homeTokenId),
                    ]);
                    if (awayBook) {
                        this.polyOrderbookCache.set(awayTokenId, awayBook);
                    }
                    if (homeBook) {
                        this.polyOrderbookCache.set(homeTokenId, homeBook);
                    }
                } catch (e) {
                    // 静默失败，使用缓存
                }
            });

            await Promise.all(promises);
            this.rebuildMarketsFromCache();
            this.polyRefreshCount++;

            // 每 50 次输出一次日志 (约 5 秒)
            if (this.polyRefreshCount % 50 === 0) {
                const withArb = this.cachedMarkets.filter(m => (m.bestOpportunity?.profitPercent ?? 0) > 0);
                console.log(`[Sports] Poly刷新 #${this.polyRefreshCount} | ${this.cachedMarkets.length} 市场, ${withArb.length} 有套利`);
            }
        } finally {
            this.isRefreshingPoly = false;
        }
    }

    /**
     * 只刷新 Predict 订单簿 (低频: 1s)
     *
     * WS 模式: 从统一缓存读取（无 REST 调用）
     * Legacy 模式: 使用多个 API key 并发请求
     */
    async refreshPredictOrderbooks(): Promise<void> {
        if (this.matchedMarketsCache.length === 0 || this.isRefreshingPredict) {
            return;
        }

        this.isRefreshingPredict = true;
        try {
            const markets = this.matchedMarketsCache;

            // WS 模式: 从 provider 或统一缓存读取
            if (predictOrderbookProvider) {
                for (const match of markets) {
                    const book = predictOrderbookProvider(match.predictId);
                    if (book) {
                        this.predictOrderbookCache.set(match.predictId, book);
                    }
                }
                this.rebuildMarketsFromCache();
                this.predictRefreshCount++;

                // 每 10 次输出一次日志（WS 模式更频繁，减少日志量）
                if (this.predictRefreshCount % 10 === 0) {
                    const withArb = this.cachedMarkets.filter(m => (m.bestOpportunity?.profitPercent ?? 0) > 0);
                    console.log(`[Sports] Predict(WS) #${this.predictRefreshCount} | ${this.cachedMarkets.length} 市场, ${withArb.length} 有套利`);
                }
                return;
            }

            // Legacy 模式: REST 并发请求
            const keys = sportsApiKeys.getAllKeys();
            const keyCount = keys.length;
            if (keyCount === 0) {
                console.warn('[SportsService] No API keys available for sports scanning, skipping Predict refresh');
                return;
            }

            // 使用多 key 并发：将市场分组，每个 key 负责一组
            const promises = markets.map(async (match, index) => {
                const apiKey = keys[index % keyCount];
                try {
                    const book = await this.fetchPredictOrderbookWithKey(match.predictId, apiKey);
                    this.predictOrderbookCache.set(match.predictId, book);
                } catch (e) {
                    // 静默失败，使用缓存
                }
            });

            await Promise.all(promises);
            this.rebuildMarketsFromCache();
            this.predictRefreshCount++;

            // 每 5 次输出一次日志 (约 5 秒)
            if (this.predictRefreshCount % 5 === 0) {
                const withArb = this.cachedMarkets.filter(m => (m.bestOpportunity?.profitPercent ?? 0) > 0);
                console.log(`[Sports] Predict刷新 #${this.predictRefreshCount} | ${this.cachedMarkets.length} 市场, ${withArb.length} 有套利 (${keyCount} keys)`);
            }
        } finally {
            this.isRefreshingPredict = false;
        }
    }

    /**
     * 使用指定 API key 获取 Predict 订单簿
     */
    private async fetchPredictOrderbookWithKey(
        marketId: number,
        apiKey: string
    ): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey },
            signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json() as any;
        return {
            bids: data.data?.bids || [],
            asks: data.data?.asks || [],
        };
    }

    /**
     * 从缓存重建市场数据并计算套利
     * 优先使用分离缓存，回退到合并缓存
     */
    private rebuildMarketsFromCache(): void {
        const results: SportsMatchedMarket[] = [];

        for (const match of this.matchedMarketsCache) {
            const clobTokenIds = JSON.parse(match.polyMarket.clobTokenIds || '[]') as string[];
            if (clobTokenIds.length < 2) continue;

            const awayTokenId = clobTokenIds[0];
            const homeTokenId = clobTokenIds[1];

            // 优先使用分离缓存
            let predictBook = this.predictOrderbookCache.get(match.predictId);
            let polyAwayBook = this.polyOrderbookCache.get(awayTokenId);
            let polyHomeBook = this.polyOrderbookCache.get(homeTokenId);

            // 如果分离缓存不全，尝试从合并缓存恢复
            if (!predictBook || !polyAwayBook || !polyHomeBook) {
                const combined = this.orderbookCache.get(match.predictId);
                if (combined) {
                    // 从合并缓存重建分离缓存
                    if (!predictBook) {
                        predictBook = {
                            bids: [[combined.predict.awayBid, combined.predict.awayBidDepth]],
                            asks: [[combined.predict.awayAsk, combined.predict.awayAskDepth]],
                        };
                        this.predictOrderbookCache.set(match.predictId, predictBook);
                    }
                    if (!polyAwayBook) {
                        polyAwayBook = {
                            bids: [[combined.polymarket.awayBid, combined.polymarket.awayBidDepth]],
                            asks: [[combined.polymarket.awayAsk, combined.polymarket.awayAskDepth]],
                        };
                        this.polyOrderbookCache.set(awayTokenId, polyAwayBook);
                    }
                    if (!polyHomeBook) {
                        polyHomeBook = {
                            bids: [[combined.polymarket.homeBid, combined.polymarket.homeBidDepth]],
                            asks: [[combined.polymarket.homeAsk, combined.polymarket.homeAskDepth]],
                        };
                        this.polyOrderbookCache.set(homeTokenId, polyHomeBook);
                    }
                }
            }

            // 仍然没有数据则跳过
            if (!predictBook || !polyAwayBook || !polyHomeBook) continue;

            const orderbook: SportsOrderBook = {
                predict: {
                    awayBid: predictBook.bids[0]?.[0] || 0,
                    awayAsk: predictBook.asks[0]?.[0] || 1,
                    awayBidDepth: predictBook.bids[0]?.[1] || 0,
                    awayAskDepth: predictBook.asks[0]?.[1] || 0,
                    homeBid: 1 - (predictBook.asks[0]?.[0] || 1),
                    homeAsk: 1 - (predictBook.bids[0]?.[0] || 0),
                    homeBidDepth: predictBook.asks[0]?.[1] || 0,
                    homeAskDepth: predictBook.bids[0]?.[1] || 0,
                },
                polymarket: {
                    awayBid: polyAwayBook.bids[0]?.[0] || 0,
                    awayAsk: polyAwayBook.asks[0]?.[0] || 1,
                    awayBidDepth: polyAwayBook.bids[0]?.[1] || 0,
                    awayAskDepth: polyAwayBook.asks[0]?.[1] || 0,
                    homeBid: polyHomeBook.bids[0]?.[0] || 0,
                    homeAsk: polyHomeBook.asks[0]?.[0] || 1,
                    homeBidDepth: polyHomeBook.bids[0]?.[1] || 0,
                    homeAskDepth: polyHomeBook.asks[0]?.[1] || 0,
                },
            };

            const market = this.buildSportsMarket(match, orderbook);
            results.push(market);
        }

        this.cachedMarkets = results;
        this.lastUpdateTime = Date.now();
    }

    // ============================================================================
    // Market Matching
    // ============================================================================

    /**
     * 使用分页 API 获取所有 Predict 市场
     * 优化：更长超时，错误时继续尝试（最多重试2次）
     */
    private async fetchAllPredictMarkets(): Promise<any[]> {
        // 使用多个 SCAN key 并发请求不同页面
        const keys = sportsApiKeys.getAllKeys();
        if (keys.length === 0) {
            console.error('[SportsService] Missing API Key for scanning');
            return [];
        }

        const allMarkets: any[] = [];
        let cursor: string | null = null;
        let page = 0;
        const maxPages = 25;  // 增加最大页数
        const timeoutMs = 15000;  // 增加超时时间到 15 秒
        const maxRetries = 2;  // 每页最多重试次数
        let consecutiveErrors = 0;  // 连续错误计数

        while (page < maxPages) {
            const url = cursor
                ? `https://api.predict.fun/v1/markets?first=100&after=${cursor}`
                : `https://api.predict.fun/v1/markets?first=100`;

            let success = false;
            let lastError = '';

            for (let retry = 0; retry <= maxRetries && !success; retry++) {
                const apiKey = keys[(page + retry) % keys.length];  // 轮换 key
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                try {
                    const res = await fetch(url, {
                        headers: { 'x-api-key': apiKey },
                        signal: controller.signal,
                    }).finally(() => clearTimeout(timeoutId));

                    if (!res.ok) {
                        lastError = `HTTP ${res.status}`;
                        continue;  // 尝试下一个 key
                    }
                    const data = await res.json() as any;

                    if (!data.success) {
                        lastError = 'API returned success=false';
                        continue;
                    }

                    if (!data.data?.length) {
                        // 没有更多数据，正常结束
                        success = true;
                        cursor = null;
                        break;
                    }

                    allMarkets.push(...data.data);
                    cursor = data.cursor;
                    success = true;
                    consecutiveErrors = 0;  // 重置连续错误计数
                } catch (e: any) {
                    if (e.name === 'AbortError') {
                        lastError = `timeout (${timeoutMs}ms)`;
                    } else {
                        lastError = e.message;
                    }
                    // 继续重试
                }
            }

            if (!success) {
                consecutiveErrors++;
                console.warn(`[SportsService] Page ${page} failed after ${maxRetries + 1} attempts: ${lastError}`);
                // 连续 3 次失败才停止
                if (consecutiveErrors >= 3) {
                    console.warn(`[SportsService] Stopping after ${consecutiveErrors} consecutive page failures`);
                    break;
                }
                // 继续尝试下一页（可能跳过一些数据）
            }

            page++;
            if (!cursor) break;
        }

        console.log(`[SportsService] Fetched ${allMarkets.length} markets in ${page} pages (${keys.length} keys)`);
        return allMarkets;
    }

    private async fetchAndMatchMarkets(): Promise<InternalMatchedMarket[]> {
        // 1. 使用分页 API 获取所有 Predict 市场 (非分页 API 只返回约 25 个)
        const allMarkets = await this.fetchAllPredictMarkets();

        // 筛选活跃市场
        const predictMarkets = allMarkets.filter(m => m.status === 'REGISTERED');

        // 筛选体育市场 (关键词匹配)
        const predictSportsMarkets = predictMarkets.filter(m => {
            const cat = (m.categorySlug || '').toLowerCase();
            const title = (m.title || '').toLowerCase();
            return SPORTS_KEYWORDS.some(k => cat.includes(k) || title.includes(k));
        });

        // 筛选 NBA "X-at-Y" 格式市场 (城市名匹配)
        const predictNbaMarkets = predictMarkets.filter(m => {
            const parsed = this.parsePredictNbaSlug(m.categorySlug);
            return parsed !== null;
        });

        // 有 Polymarket 链接的市场
        const linkedMarkets = predictMarkets.filter(m =>
            m.polymarketConditionIds && m.polymarketConditionIds.length > 0
        );

        console.log(`[SportsService] Predict: ${predictMarkets.length} total (paginated), ${predictSportsMarkets.length} keyword-sports, ${predictNbaMarkets.length} NBA, ${linkedMarkets.length} linked`);

        // 2. 获取 Polymarket 体育市场
        const polyMarkets = await this.fetchPolymarketSportsMarkets();
        console.log(`[SportsService] Polymarket: ${polyMarkets.length} sports markets`);

        // 3. 匹配
        const matches: InternalMatchedMarket[] = [];

        // 方法 A: conditionId 匹配
        for (const pm of polyMarkets) {
            const matched = linkedMarkets.find(m =>
                m.polymarketConditionIds?.includes(pm.conditionId)
            );

            if (matched) {
                // 如果 Predict title 是通用的 "Match Winner"，使用 Polymarket question 或 categorySlug
                let betterTitle = matched.title;
                if (matched.title.toLowerCase() === 'match winner') {
                    betterTitle = pm.question || this.formatCategorySlugAsTitle(matched.categorySlug) || matched.title;
                }
                matches.push({
                    predictId: matched.id,
                    predictTitle: betterTitle,
                    predictCategorySlug: matched.categorySlug,
                    polymarketId: pm.id,
                    polymarketQuestion: pm.question,
                    polymarketConditionId: pm.conditionId,
                    polymarketSlug: pm.slug,
                    polymarketLiquidity: parseFloat(pm.liquidity),
                    polymarketVolume: parseFloat(pm.volume) || 0,
                    predictVolume: matched.volume || 0,
                    matchMethod: 'conditionId',
                    predictMarket: matched,
                    polyMarket: pm,
                });
            }
        }

        // 方法 B: NBA 匹配 (Predict 一场比赛可能有 1 或 2 个市场)
        // 1. 按 categorySlug 分组 Predict NBA 市场
        const nbaGameGroups = new Map<string, any[]>();
        for (const m of predictNbaMarkets) {
            const slug = m.categorySlug;
            if (!nbaGameGroups.has(slug)) nbaGameGroups.set(slug, []);
            nbaGameGroups.get(slug)!.push(m);
        }

        console.log(`[SportsService] NBA games: ${nbaGameGroups.size} (grouped by categorySlug)`);

        // 2. 匹配每组 (支持单市场和双市场)
        for (const pm of polyMarkets) {
            // 跳过已匹配的
            if (matches.some(m => m.polymarketId === pm.id)) continue;

            const polyParsed = this.parsePolyNbaSlug(pm.slug);
            if (!polyParsed) continue;

            // 遍历 Predict NBA 分组
            for (const [slug, groupMarkets] of nbaGameGroups) {
                // 跳过已匹配的 Predict 分组
                if (matches.some(m => m.predictCategorySlug === slug)) continue;

                const predParsed = this.parsePredictNbaSlugWithCity(slug);
                if (!predParsed) continue;

                // 检查球队组合是否匹配 (顺序可能不同)
                const teamsMatch =
                    (predParsed.awayAbbr === polyParsed.team1 && predParsed.homeAbbr === polyParsed.team2) ||
                    (predParsed.awayAbbr === polyParsed.team2 && predParsed.homeAbbr === polyParsed.team1);

                if (!teamsMatch || groupMarkets.length < 1) continue;

                // 提取 Predict 比赛日期并验证与 Polymarket 日期是否匹配
                // 使用第一个市场来提取日期（同一场比赛的多个市场日期相同）
                const predictGameDate = this.extractPredictGameDate(groupMarkets[0]);
                const polyGameDate = polyParsed.date;

                if (!this.datesMatch(predictGameDate, polyGameDate)) {
                    // 日期不匹配，跳过这个 Polymarket 市场（可能是相同对阵的不同场次）
                    console.log(`[SportsService] Date mismatch: Predict ${slug} (${predictGameDate || 'unknown'}) vs Poly ${pm.slug} (${polyGameDate})`);
                    continue;
                }

                // 使用城市名匹配 title (Predict title 是城市名，如 "Phoenix", "Miami")
                const awayCityName = predParsed.awayCity.replace(/-/g, ' ');  // "san-antonio" -> "san antonio"
                const homeCityName = predParsed.homeCity.replace(/-/g, ' ');

                // 尝试找到客队和主队市场
                const awayMarket = groupMarkets.find(m =>
                    m.title.toLowerCase().includes(awayCityName) ||
                    m.title.toLowerCase() === awayCityName ||
                    m.title.toLowerCase().includes(predParsed.awayAbbr)
                );
                const homeMarket = groupMarkets.find(m =>
                    m.title.toLowerCase().includes(homeCityName) ||
                    m.title.toLowerCase() === homeCityName ||
                    m.title.toLowerCase().includes(predParsed.homeAbbr)
                );

                // 只需要客队市场即可匹配（主队价格通过反演）
                if (awayMarket) {
                    const awayTeamName = NBA_ABBR_TO_TEAM[predParsed.awayAbbr] || predParsed.awayAbbr.toUpperCase();
                    const homeTeamName = NBA_ABBR_TO_TEAM[predParsed.homeAbbr] || predParsed.homeAbbr.toUpperCase();

                    // NBA 双市场的 volume 合计
                    const predictVol = (awayMarket.volume || 0) + (homeMarket ? (homeMarket.volume || 0) : 0);
                    matches.push({
                        predictId: awayMarket.id,  // 使用客队市场 ID 作为主 ID
                        predictTitle: `${awayTeamName} @ ${homeTeamName}`,
                        predictCategorySlug: slug,
                        polymarketId: pm.id,
                        polymarketQuestion: pm.question,
                        polymarketConditionId: pm.conditionId,
                        polymarketSlug: pm.slug,
                        polymarketLiquidity: parseFloat(pm.liquidity),
                        polymarketVolume: parseFloat(pm.volume) || 0,
                        predictVolume: predictVol,
                        matchMethod: 'nba-slug',
                        predictMarket: awayMarket,  // 主市场设为客队市场
                        polyMarket: pm,
                        // NBA 市场信息 (可能是单市场或双市场)
                        isNbaMultiMarket: !!homeMarket,  // 有主队市场才是真正的双市场
                        predictAwayMarket: awayMarket,
                        predictHomeMarket: homeMarket || awayMarket,  // 无主队市场时用客队市场
                    });
                    console.log(`[SportsService] NBA match: ${slug} -> ${pm.slug} (Away: ${awayMarket.id}${homeMarket ? `, Home: ${homeMarket.id}` : ' [单市场]'}) [Date: ${predictGameDate}]`);
                    break;  // 找到匹配，跳出内层循环
                }
            }
        }

        // 方法 C: 其他体育 slug 模式匹配
        for (const pm of polyMarkets) {
            // 跳过已匹配的
            if (matches.some(m => m.polymarketId === pm.id)) continue;

            const parsed = this.parsePolySlug(pm.slug);
            if (!parsed) continue;

            const dateCompact = parsed.date.replace(/-/g, '');

            const matched = predictSportsMarkets.find(m => {
                if (matches.some(x => x.predictId === m.id)) return false;  // 跳过已匹配
                const cat = (m.categorySlug || '').toLowerCase();
                return cat.includes(parsed.team1) &&
                       cat.includes(parsed.team2) &&
                       (cat.includes(parsed.date) || cat.includes(dateCompact));
            });

            if (matched) {
                // 如果 Predict title 是通用的 "Match Winner"，使用 Polymarket question 或 categorySlug
                let betterTitle = matched.title;
                if (matched.title.toLowerCase() === 'match winner') {
                    betterTitle = pm.question || this.formatCategorySlugAsTitle(matched.categorySlug) || matched.title;
                }
                matches.push({
                    predictId: matched.id,
                    predictTitle: betterTitle,
                    predictCategorySlug: matched.categorySlug,
                    polymarketId: pm.id,
                    polymarketQuestion: pm.question,
                    polymarketConditionId: pm.conditionId,
                    polymarketSlug: pm.slug,
                    polymarketLiquidity: parseFloat(pm.liquidity),
                    polymarketVolume: parseFloat(pm.volume) || 0,
                    predictVolume: matched.volume || 0,
                    matchMethod: 'slug',
                    predictMarket: matched,
                    polyMarket: pm,
                });
            }
        }

        // 输出匹配详情
        const conditionIdMatches = matches.filter(m => m.matchMethod === 'conditionId').length;
        const nbaSlugMatches = matches.filter(m => m.matchMethod === 'nba-slug').length;
        const slugMatches = matches.filter(m => m.matchMethod === 'slug').length;
        console.log(`[SportsService] Matched: ${matches.length} markets (conditionId: ${conditionIdMatches}, nba-slug: ${nbaSlugMatches}, slug: ${slugMatches})`);

        // 4. 获取 Predict volume 数据 (单独 API 调用)
        await this.fetchPredictVolumeStats(matches);

        return matches;
    }

    /**
     * 获取 Predict 市场 volume 数据
     * 由于 /v1/markets 列表接口不返回 volume，需要单独调用 /v1/markets/{id}/stats
     */
    private async fetchPredictVolumeStats(matches: InternalMatchedMarket[]): Promise<void> {
        if (matches.length === 0) return;

        const keys = sportsApiKeys.getAllKeys();
        if (keys.length === 0) return;

        // 收集需要查询的市场 ID (去重)
        const marketIds = new Set<number>();
        for (const m of matches) {
            marketIds.add(m.predictId);
            // NBA 双市场: 添加主队市场 ID (如果存在且不同)
            if (m.isNbaMultiMarket && m.predictHomeMarket && m.predictHomeMarket.id !== m.predictId) {
                marketIds.add(m.predictHomeMarket.id);
            }
        }

        const idList = Array.from(marketIds);
        const volumeMap = new Map<number, number>();

        // 并发请求 volume (使用多 key 轮换)
        const timeoutMs = 3000;
        const batchSize = 10;  // 每批并发请求数

        for (let i = 0; i < idList.length; i += batchSize) {
            const batch = idList.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(async (marketId, idx) => {
                const apiKey = keys[(i + idx) % keys.length];
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                    const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/stats`, {
                        headers: { 'x-api-key': apiKey },
                        signal: controller.signal,
                    }).finally(() => clearTimeout(timeoutId));

                    if (!res.ok) return { marketId, volume: 0 };
                    const data = await res.json() as any;
                    return { marketId, volume: data.data?.volumeTotalUsd || 0 };
                } catch {
                    return { marketId, volume: 0 };
                }
            }));

            for (const r of results) {
                volumeMap.set(r.marketId, r.volume);
            }
        }

        // 更新匹配市场的 volume
        for (const m of matches) {
            const vol = volumeMap.get(m.predictId) || 0;
            // NBA 双市场: 合计两个市场的 volume
            if (m.isNbaMultiMarket && m.predictHomeMarket && m.predictHomeMarket.id !== m.predictId) {
                const vol2 = volumeMap.get(m.predictHomeMarket.id) || 0;
                m.predictVolume = vol + vol2;
            } else {
                m.predictVolume = vol;
            }
        }

        console.log(`[SportsService] Fetched volume for ${volumeMap.size} markets`);
    }

    /**
     * 解析 Predict NBA slug: "chicago-at-houston" -> { away: 'chi', home: 'hou' }
     */
    private parsePredictNbaSlug(slug: string): { away: string; home: string } | null {
        if (!slug) return null;
        const match = slug.toLowerCase().match(/^([a-z-]+)-at-([a-z-]+)$/);
        if (!match) return null;

        const awayCity = match[1];
        const homeCity = match[2];

        const awayAbbr = NBA_CITY_TO_ABBR[awayCity];
        const homeAbbr = NBA_CITY_TO_ABBR[homeCity];

        if (!awayAbbr || !homeAbbr) return null;

        return { away: awayAbbr, home: homeAbbr };
    }

    /**
     * 解析 Predict NBA slug 并返回城市名: "chicago-at-houston" -> { awayCity, homeCity, awayAbbr, homeAbbr }
     */
    private parsePredictNbaSlugWithCity(slug: string): { awayCity: string; homeCity: string; awayAbbr: string; homeAbbr: string } | null {
        if (!slug) return null;
        const match = slug.toLowerCase().match(/^([a-z-]+)-at-([a-z-]+)$/);
        if (!match) return null;

        const awayCity = match[1];
        const homeCity = match[2];

        const awayAbbr = NBA_CITY_TO_ABBR[awayCity];
        const homeAbbr = NBA_CITY_TO_ABBR[homeCity];

        if (!awayAbbr || !homeAbbr) return null;

        return { awayCity, homeCity, awayAbbr, homeAbbr };
    }

    /**
     * 解析 Polymarket NBA slug: "nba-chi-hou-2026-01-13" -> { team1: 'chi', team2: 'hou', date: '2026-01-13' }
     */
    private parsePolyNbaSlug(slug: string): { team1: string; team2: string; date: string } | null {
        if (!slug) return null;
        const match = slug.toLowerCase().match(/^nba-([a-z]{3})-([a-z]{3})-(\d{4}-\d{2}-\d{2})$/);
        if (!match) return null;

        return {
            team1: match[1],
            team2: match[2],
            date: match[3],
        };
    }

    /**
     * 从 Predict 市场提取比赛日期
     * 优先级: kalshiMarketTicker > description > categorySlug 后缀
     *
     * @returns 日期字符串 'YYYY-MM-DD' 或 null
     */
    private extractPredictGameDate(market: any): string | null {
        // 1. 从 kalshiMarketTicker 解析
        // 格式: KXNBAGAME-26JAN15MEMORL-MEM -> 2026-01-15
        // 格式: KXNFLGAME-26JAN18LACHI-LA -> 2026-01-18
        const ticker = market.kalshiMarketTicker;
        if (ticker) {
            const tickerMatch = ticker.match(/(\d{2})([A-Z]{3})(\d{2})/i);
            if (tickerMatch) {
                const year = 2000 + parseInt(tickerMatch[1], 10);
                const monthStr = tickerMatch[2].toUpperCase();
                const day = parseInt(tickerMatch[3], 10);

                const monthMap: Record<string, number> = {
                    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
                    'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
                };
                const month = monthMap[monthStr];
                if (month) {
                    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                }
            }
        }

        // 2. 从 description 解析
        // 格式: "originally scheduled for Jan 15, 2026"
        // 格式: "January 15, 2026"
        const desc = market.description;
        if (desc) {
            // 匹配 "Jan 15, 2026" 或 "January 15, 2026" 格式
            const descMatch = desc.match(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})/i);
            if (descMatch) {
                const monthStr = descMatch[1].substring(0, 3).toUpperCase();
                const day = parseInt(descMatch[2], 10);
                const year = parseInt(descMatch[3], 10);

                const monthMap: Record<string, number> = {
                    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
                    'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
                };
                const month = monthMap[monthStr];
                if (month) {
                    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                }
            }
        }

        // 3. 从 categorySlug 后缀解析
        // 格式: "miami-at-chicago-jan8" -> 假设当前年份
        // 格式: "dallas-at-utah-jan15"
        const slug = market.categorySlug;
        if (slug) {
            const slugMatch = slug.match(/-([a-z]{3})(\d{1,2})$/i);
            if (slugMatch) {
                const monthStr = slugMatch[1].toUpperCase();
                const day = parseInt(slugMatch[2], 10);

                const monthMap: Record<string, number> = {
                    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
                    'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
                };
                const month = monthMap[monthStr];
                if (month) {
                    // 使用当前年份（体育赛事通常是近期的）
                    const year = new Date().getFullYear();
                    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                }
            }
        }

        return null;
    }

    /**
     * 检查两个日期是否匹配（允许 ±1 天的时区容差）
     *
     * Polymarket slug 使用美东日期，而 Predict 可能使用不同时区
     * 例如: 美东 1月15日晚上的比赛可能在 UTC 是 1月16日
     */
    private datesMatch(predictDate: string | null, polyDate: string): boolean {
        if (!predictDate) {
            // 无法获取 Predict 日期时，不进行日期过滤（保持向后兼容）
            return true;
        }

        // 解析日期
        const pred = new Date(predictDate + 'T12:00:00Z');
        const poly = new Date(polyDate + 'T12:00:00Z');

        // 计算差异（毫秒）
        const diffMs = Math.abs(pred.getTime() - poly.getTime());
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        // 允许 ±1 天的容差（处理时区差异）
        return diffDays <= 1;
    }

    private async fetchPolymarketSportsMarkets(): Promise<PolyMarket[]> {
        const tagIds = Object.values(POLY_SPORTS_TAGS).filter(id => id > 1);  // 排除 placeholder
        const timeoutMs = 10000;  // 增加超时时间

        // 并发请求所有 tag，记录每个 tag 的获取结果
        const tagResults: { tagId: number; count: number }[] = [];
        const results = await Promise.all(tagIds.map(async (tagId) => {
            try {
                const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&tag_id=${tagId}&sports_market_types=moneyline`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
                if (!res.ok) {
                    console.warn(`[SportsService] Polymarket tag ${tagId} failed: HTTP ${res.status}`);
                    tagResults.push({ tagId, count: 0 });
                    return [];
                }
                const markets = await res.json() as PolyMarket[];
                tagResults.push({ tagId, count: markets.length });
                return markets;
            } catch (error: any) {
                const msg = error.name === 'AbortError' ? 'timeout' : error.message;
                console.warn(`[SportsService] Polymarket tag ${tagId} error: ${msg}`);
                tagResults.push({ tagId, count: 0 });
                return [];
            }
        }));

        // 输出每个 tag 的结果
        const tagSummary = tagResults.map(r => `${r.tagId}:${r.count}`).join(', ');
        console.log(`[SportsService] Polymarket tags: ${tagSummary}`);

        // 合并并去重
        const allMarkets = results.flat();
        return Array.from(new Map(allMarkets.map(m => [m.id, m])).values());
    }

    private parsePolySlug(slug: string): { sport: string; team1: string; team2: string; date: string } | null {
        // Format: nba-mia-chi-2026-01-08
        const match = slug.match(/^([a-z]+)-([a-z]{2,4})-([a-z]{2,4})-(\d{4}-\d{2}-\d{2})$/i);
        if (match) {
            return {
                sport: match[1].toLowerCase(),
                team1: match[2].toLowerCase(),
                team2: match[3].toLowerCase(),
                date: match[4],
            };
        }
        return null;
    }

    // ============================================================================
    // Arbitrage Calculation
    // ============================================================================

    private async calculateArbitrage(matches: InternalMatchedMarket[]): Promise<SportsMatchedMarket[]> {
        const results: SportsMatchedMarket[] = [];

        // 并行获取所有订单簿
        const orderbookPromises = matches.map(async (match) => {
            try {
                const orderbook = await this.fetchOrderBooks(match);
                // 成功获取，更新缓存
                this.orderbookCache.set(match.predictId, orderbook);
                return { match, orderbook, fromCache: false };
            } catch (error) {
                // 获取失败，尝试使用缓存 (不逐个输出日志，最后汇总)
                const cached = this.orderbookCache.get(match.predictId);
                if (cached) {
                    return { match, orderbook: cached, fromCache: true };
                }
                // 无缓存时才报错
                console.error(`[SportsService] No cache for ${match.predictId}`);
                return null;
            }
        });

        const orderbookResults = await Promise.all(orderbookPromises);

        let fromCacheCount = 0;
        for (const result of orderbookResults) {
            if (!result) continue;

            const { match, orderbook, fromCache } = result;
            if (fromCache) fromCacheCount++;
            const market = this.buildSportsMarket(match, orderbook);
            results.push(market);
        }

        if (fromCacheCount > 0) {
            console.log(`[SportsService] ${fromCacheCount}/${results.length} markets using cached orderbook`);
        }

        return results;
    }

    private async fetchOrderBooks(match: InternalMatchedMarket): Promise<SportsOrderBook> {
        // 解析 Polymarket token IDs
        const clobTokenIds = JSON.parse(match.polyMarket.clobTokenIds || '[]') as string[];
        if (clobTokenIds.length < 2) {
            throw new Error(`Invalid clobTokenIds for ${match.polymarketId}`);
        }

        const awayTokenId = clobTokenIds[0];  // outcomes[0] = 客队
        const homeTokenId = clobTokenIds[1];  // outcomes[1] = 主队

        // 分别获取订单簿，记录具体哪个 API 失败
        let predictBook: { bids: [number, number][]; asks: [number, number][] };
        let polyAwayBook: { bids: [number, number][]; asks: [number, number][] } | null;
        let polyHomeBook: { bids: [number, number][]; asks: [number, number][] } | null;

        try {
            predictBook = await this.predictClient.getOrderBook(match.predictId);
            // 填充分离缓存 (供独立刷新使用)
            this.predictOrderbookCache.set(match.predictId, predictBook);
        } catch (e: any) {
            throw new Error(`Predict API failed for ${match.predictId}: ${e.message}`);
        }

        try {
            [polyAwayBook, polyHomeBook] = await Promise.all([
                this.getPolyOrderBook(awayTokenId),
                this.getPolyOrderBook(homeTokenId),
            ]);
            if (!polyAwayBook || !polyHomeBook) {
                throw new Error('Polymarket orderbook empty');
            }
            // 填充分离缓存 (供独立刷新使用)
            this.polyOrderbookCache.set(awayTokenId, polyAwayBook);
            this.polyOrderbookCache.set(homeTokenId, polyHomeBook);
        } catch (e: any) {
            throw new Error(`Polymarket API failed: ${e.message}`);
        }

        // 构建订单簿数据
        const predAwayBid = predictBook.bids[0]?.[0] || 0;
        const predAwayAsk = predictBook.asks[0]?.[0] || 1;
        const predAwayBidDepth = predictBook.bids[0]?.[1] || 0;
        const predAwayAskDepth = predictBook.asks[0]?.[1] || 0;

        // Polymarket 客队订单簿 (直接获取)
        const polyAwayBid = polyAwayBook.bids[0]?.[0] || 0;
        const polyAwayAsk = polyAwayBook.asks[0]?.[0] || 1;
        const polyAwayBidDepth = polyAwayBook.bids[0]?.[1] || 0;
        const polyAwayAskDepth = polyAwayBook.asks[0]?.[1] || 0;

        // Polymarket 主队订单簿 (直接获取，不用反演)
        const polyHomeBid = polyHomeBook.bids[0]?.[0] || 0;
        const polyHomeAsk = polyHomeBook.asks[0]?.[0] || 1;
        const polyHomeBidDepth = polyHomeBook.bids[0]?.[1] || 0;
        const polyHomeAskDepth = polyHomeBook.asks[0]?.[1] || 0;

        return {
            predict: {
                awayBid: predAwayBid,
                awayAsk: predAwayAsk,
                awayBidDepth: predAwayBidDepth,
                awayAskDepth: predAwayAskDepth,
                // Predict 主队价格通过反演 (单市场结构)
                homeBid: 1 - predAwayAsk,
                homeAsk: 1 - predAwayBid,
                homeBidDepth: predAwayAskDepth,
                homeAskDepth: predAwayBidDepth,
            },
            polymarket: {
                // Polymarket 直接使用两个独立订单簿的数据
                awayBid: polyAwayBid,
                awayAsk: polyAwayAsk,
                awayBidDepth: polyAwayBidDepth,
                awayAskDepth: polyAwayAskDepth,
                homeBid: polyHomeBid,
                homeAsk: polyHomeAsk,
                homeBidDepth: polyHomeBidDepth,
                homeAskDepth: polyHomeAskDepth,
            },
        };
    }

    /**
     * 获取 Polymarket 订单簿 (体育市场使用 REST API)
     */
    private async getPolyOrderBook(tokenId: string): Promise<{ bids: [number, number][]; asks: [number, number][] } | null> {
        try {
            const book = await this.polyClient.getOrderBook(tokenId);
            if (book && book.bids && book.asks) {
                // 解析 REST 响应格式
                const bids = book.bids
                    .map((level: any) => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
                    .filter(([price, size]: [number, number]) => size > 0)
                    .sort((a: [number, number], b: [number, number]) => b[0] - a[0]);
                const asks = book.asks
                    .map((level: any) => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
                    .filter(([price, size]: [number, number]) => size > 0)
                    .sort((a: [number, number], b: [number, number]) => a[0] - b[0]);

                if (bids.length > 0 || asks.length > 0) {
                    return { bids, asks };
                }
            }
        } catch {
            // REST 失败，静默忽略
        }
        return null;
    }

    private buildSportsMarket(match: InternalMatchedMarket, orderbook: SportsOrderBook): SportsMatchedMarket {
        const { predictMarket, polyMarket } = match;

        // 解析队伍名称
        let awayTeam: string;
        let homeTeam: string;

        // 尝试解析 NBA 市场 (使用缩写->球队名映射)
        const nbaParsed = this.parsePredictNbaSlug(match.predictCategorySlug);
        if (nbaParsed) {
            awayTeam = NBA_ABBR_TO_TEAM[nbaParsed.away] || nbaParsed.away.toUpperCase();
            homeTeam = NBA_ABBR_TO_TEAM[nbaParsed.home] || nbaParsed.home.toUpperCase();
        } else {
            // 非 NBA 市场，使用 outcomes
            const outcomes = predictMarket.outcomes || [];
            awayTeam = outcomes[0]?.name || 'Away';
            homeTeam = outcomes[1]?.name || 'Home';
        }

        // 解析 token IDs
        const clobTokenIds = JSON.parse(polyMarket.clobTokenIds || '[]') as string[];
        const awayTokenId = clobTokenIds[0] || '';
        const homeTokenId = clobTokenIds[1] || '';

        // 市场配置
        const feeRateBps = predictMarket.feeRateBps || 200;
        const tickSize = predictMarket.tickSize || 0.01;
        const negRisk = polyMarket.neg_risk || false;

        // 计算 4 个套利机会
        const awayMT = this.calculateOpportunity('away', 'MAKER', orderbook, feeRateBps);
        const awayTT = this.calculateOpportunity('away', 'TAKER', orderbook, feeRateBps);
        const homeMT = this.calculateOpportunity('home', 'MAKER', orderbook, feeRateBps);
        const homeTT = this.calculateOpportunity('home', 'TAKER', orderbook, feeRateBps);

        // 一致性校验 (互斥性约束)
        const consistency = this.checkConsistency(awayMT, awayTT, homeMT, homeTT);

        // 找出最佳机会
        const allOpps = [awayMT, awayTT, homeMT, homeTT].filter(o => o.isValid);
        const bestOpp = allOpps.length > 0
            ? allOpps.reduce((best, curr) =>
                curr.profitPercent > best.profitPercent ? curr : best
            )
            : undefined;

        // 检测体育类型 (NBA 使用 slug 格式检测)
        const sport = this.detectSport(match.predictCategorySlug, polyMarket.slug, nbaParsed !== null);

        // NBA 双市场 ID 设置
        // - NBA: predictAwayMarketId = 客队市场, predictHomeMarketId = 主队市场
        // - 其他: 两个 ID 相同 (单市场结构)
        const predictAwayMarketId = match.isNbaMultiMarket && match.predictAwayMarket
            ? match.predictAwayMarket.id
            : match.predictId;
        const predictHomeMarketId = match.isNbaMultiMarket && match.predictHomeMarket
            ? match.predictHomeMarket.id
            : match.predictId;

        // 查找 Predict slug
        // 对于体育市场，优先使用 categorySlug (如果是有效的 slug 格式)
        let predictSlug: string | undefined;
        const catSlug = match.predictCategorySlug;

        // 1. 对于非 NBA 市场 (LoL 等)，categorySlug 本身就是有效的 URL slug
        //    例如: "lol-lgd-up-2026-01-15" -> predict.fun/market/lol-lgd-up-2026-01-15
        if (catSlug && catSlug.includes('-') && !catSlug.includes('-at-')) {
            predictSlug = catSlug;
        }

        // 2. 对于 NBA 市场 (categorySlug 是 "X-at-Y" 格式)
        //    尝试从 browser-slugs.json 查找 "City at City" 格式
        if (!predictSlug && catSlug?.includes('-at-')) {
            const cityFormat = this.formatCategorySlugAsTitle(catSlug);
            if (cityFormat) {
                predictSlug = getPredictSlugByTitle(cityFormat);
            }
        }

        // 3. 回退到市场 ID 缓存查找 (排除通用的 "match-winner")
        if (!predictSlug) {
            const cached = getPredictSlug(match.predictId);
            if (cached && cached !== 'match-winner') {
                predictSlug = cached;
            }
        }

        return {
            predictMarketId: match.predictId,  // 主 ID (客队市场 ID)
            predictTitle: match.predictTitle,
            predictCategorySlug: match.predictCategorySlug,
            predictSlug,
            polymarketConditionId: match.polymarketConditionId,
            polymarketQuestion: match.polymarketQuestion,
            polymarketSlug: match.polymarketSlug,

            // NBA 双市场 ID
            predictAwayMarketId,
            predictHomeMarketId,

            sport,
            homeTeam,
            awayTeam,
            gameDate: polyMarket.endDate,
            gameStartTime: polyMarket.gameStartTime,

            polymarketAwayTokenId: awayTokenId,
            polymarketHomeTokenId: homeTokenId,
            negRisk,
            tickSize,
            feeRateBps,

            orderbook,

            awayMT,
            awayTT,
            homeMT,
            homeTT,

            bestOpportunity: bestOpp ? {
                direction: bestOpp.direction,
                mode: bestOpp.mode,
                profitPercent: bestOpp.profitPercent,
            } : undefined,

            consistency,

            polymarketLiquidity: match.polymarketLiquidity,
            polymarketVolume: match.polymarketVolume || 0,
            predictVolume: match.predictVolume || 0,
            lastUpdated: Date.now(),
        };
    }

    private calculateOpportunity(
        direction: 'away' | 'home',
        mode: 'MAKER' | 'TAKER',
        orderbook: SportsOrderBook,
        feeRateBps: number
    ): SportsArbOpportunity {
        const pred = orderbook.predict;
        const poly = orderbook.polymarket;

        let predictPrice: number;
        let polyHedgePrice: number;
        let predictFee = 0;
        let predictDepth: number;
        let polyDepth: number;

        if (direction === 'away') {
            // 买客队 (Predict) + 买主队 (Poly 对冲)
            if (mode === 'MAKER') {
                predictPrice = pred.awayBid;
                polyHedgePrice = poly.homeAsk;
                predictDepth = pred.awayBidDepth;
                polyDepth = poly.homeAskDepth;
            } else {
                predictPrice = pred.awayAsk;
                polyHedgePrice = poly.homeAsk;
                predictFee = calculatePredictFee(predictPrice, feeRateBps);
                predictDepth = pred.awayAskDepth;
                polyDepth = poly.homeAskDepth;
            }
        } else {
            // 买主队 (Predict) + 买客队 (Poly 对冲)
            if (mode === 'MAKER') {
                predictPrice = pred.homeBid;  // = 1 - pred.awayAsk
                polyHedgePrice = poly.awayAsk;
                predictDepth = pred.awayAskDepth;  // 主队 bid 深度 = 客队 ask 深度
                polyDepth = poly.awayAskDepth;
            } else {
                predictPrice = pred.homeAsk;  // = 1 - pred.awayBid
                polyHedgePrice = poly.awayAsk;
                predictFee = calculatePredictFee(predictPrice, feeRateBps);
                predictDepth = pred.awayBidDepth;  // 主队 ask 深度 = 客队 bid 深度
                polyDepth = poly.awayAskDepth;
            }
        }

        // 使用固定精度计算避免浮点误差 (保留4位小数)
        const cost = Number((predictPrice + polyHedgePrice + predictFee).toFixed(4));
        const profit = Number((1 - cost).toFixed(4));
        const profitPercent = profit * 100;
        // M-T 模式 profit >= 0 即有效 (有积分奖励)，T-T 需要 profit > 0
        // 使用 epsilon 比较避免浮点精度问题
        const EPSILON = 0.0001;
        const isValid = mode === 'MAKER' ? profit >= -EPSILON : profit > EPSILON;

        // 最大数量取两边深度的较小值
        const maxQuantity = mode === 'MAKER'
            ? polyDepth  // Maker 模式只看对冲端深度
            : Math.min(predictDepth, polyDepth);  // Taker 模式取两边较小值

        return {
            direction,
            mode,
            cost,
            profit,
            profitPercent,
            predictPrice,
            polyHedgePrice,
            predictFee,
            maxQuantity,
            predictDepth,
            polyDepth,
            isValid,
        };
    }

    private checkConsistency(
        awayMT: SportsArbOpportunity,
        awayTT: SportsArbOpportunity,
        homeMT: SportsArbOpportunity,
        homeTT: SportsArbOpportunity
    ): SportsMatchedMarket['consistency'] {
        // 检查同模式下两个方向的成本之和是否 < 1
        // 体育市场互斥性: Away 赢 + Home 赢 = 100%，所以 cost_away + cost_home 应该 >= 1
        // 只有当 cost_away + cost_home < 1 (严格小于) 时，才是真正的"两边都有利润"异常
        // 允许 cost_away + cost_home = 1 (sum <= 1 是正常的)
        const mtSumCost = awayMT.cost + homeMT.cost;
        const ttSumCost = awayTT.cost + homeTT.cost;

        // 只有当成本之和严格小于 1 - ε 时才视为异常
        const mtBothProfitable = mtSumCost < (1 - CONSISTENCY_EPSILON);
        const ttBothProfitable = ttSumCost < (1 - CONSISTENCY_EPSILON);

        const bothDirectionsProfitable = mtBothProfitable || ttBothProfitable;

        let warning: string | undefined;
        if (bothDirectionsProfitable) {
            warning = `Both directions appear profitable (MT sum: ${mtSumCost.toFixed(4)}, TT sum: ${ttSumCost.toFixed(4)}) - possible data anomaly or mapping error`;
        }

        return {
            isValid: !bothDirectionsProfitable,
            bothDirectionsProfitable,
            warning,
        };
    }

    /**
     * 把 categorySlug "cleveland-at-philadelphia" 转换为 "Cleveland at Philadelphia"
     * 用于匹配 browser-slugs.json 中的 NBA/NHL 标题格式
     */
    private formatCategorySlugAsTitle(slug: string): string | null {
        const atIndex = slug.indexOf('-at-');
        if (atIndex === -1) return null;

        // 提取客队城市和主队城市
        const awayCity = slug.substring(0, atIndex)
            .split('-')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
        const homeCity = slug.substring(atIndex + 4)  // skip '-at-'
            .split('-')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

        return `${awayCity} at ${homeCity}`;
    }

    private detectSport(categorySlug: string, polySlug: string, isNbaBySlug: boolean = false): SportType {
        // 如果通过 slug 格式解析已确认是 NBA，直接返回
        if (isNbaBySlug) return 'nba';

        const slug = (categorySlug + ' ' + polySlug).toLowerCase();

        if (slug.includes('nba') || slug.includes('basketball')) return 'nba';
        if (slug.includes('nfl') || slug.includes('football')) return 'nfl';
        if (slug.includes('nhl') || slug.includes('hockey')) return 'nhl';
        if (slug.includes('mlb') || slug.includes('baseball')) return 'mlb';
        if (slug.includes('epl') || slug.includes('soccer') || slug.includes('premier')) return 'epl';
        if (slug.includes('mma') || slug.includes('ufc')) return 'mma';
        if (slug.includes('lol') || slug.includes('league')) return 'lol';

        return 'nba';  // 默认
    }
}

// ============================================================================
// Singleton Export
// ============================================================================

let sportsServiceInstance: SportsService | null = null;

export function getSportsService(): SportsService {
    if (!sportsServiceInstance) {
        sportsServiceInstance = new SportsService();
    }
    return sportsServiceInstance;
}
