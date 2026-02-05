/**
 * 双边套利延迟基准测试
 *
 * 分阶段测量双边套利关键路径每个环节的真实延迟:
 *   Test 1: EIP-712 签名延迟 (纯本地)
 *   Test 2: Predict 端全链路 (JWT → 签名 → 提交 → 确认 → 取消)
 *   Test 3: Polymarket 端全链路
 *     3a: GTC 限价单 (不成交，签名 → 提交 → 确认 → 取消)
 *     3b: IOC 订单 (真实成交 ~$2-5，签名 → 提交 → pollStatus 首次 MATCHED)
 *   Test 4: Orderbook 获取延迟 (Polymarket REST)
 *
 * 市场选择: 自动从 polymarket-match-result.json 中选择深度充足的活跃 Binary 市场
 *
 * 运行: cd bot && npx tsx src/testing/test-arb-latency.ts
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import { PredictTrader } from '../dashboard/predict-trader.js';
import { PolymarketTrader } from '../dashboard/polymarket-trader.js';

// ============================================================================
// 常量 & 颜色
// ============================================================================

const CLOB_BASE_URL = 'https://clob.polymarket.com';

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    magenta: '\x1b[35m',
};

// ============================================================================
// 工具函数
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatMs(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function median(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, idx)];
}

function printStats(label: string, times: number[]): void {
    if (times.length === 0) {
        console.log(`  ${label}: ${c.red}无数据${c.reset}`);
        return;
    }
    const min = Math.min(...times);
    const max = Math.max(...times);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const med = median(times);
    const p = p95(times);
    console.log(`  ${label}:`);
    console.log(`    min=${c.green}${formatMs(min)}${c.reset}  avg=${formatMs(avg)}  median=${c.cyan}${formatMs(med)}${c.reset}  P95=${c.yellow}${formatMs(p)}${c.reset}  max=${formatMs(max)}  (n=${times.length})`);
}

async function measureLatency<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
    const start = performance.now();
    const result = await fn();
    return { result, latencyMs: performance.now() - start };
}

// ============================================================================
// 市场选择 — 从 polymarket-match-result.json 选取活跃的 Binary 市场
// ============================================================================

interface MatchEntry {
    predict: {
        id: number;
        title: string;
        question: string;
        conditionId: string;
        feeRateBps: number;
        categorySlug: string;
    };
    polymarket: {
        question: string;
        conditionId: string;
        active: boolean;
        closed: boolean;
        acceptingOrders: boolean;
    };
    inverted?: boolean;
}

interface PolymarketClobMarket {
    tokens: { token_id: string; outcome: string }[];
    closed: boolean;
    accepting_orders: boolean;
    neg_risk: boolean;
    minimum_tick_size: string;
}

// 体育市场关键字 — 用于排除
const SPORTS_KEYWORDS = [
    'vs', 'VS', 'Match Winner', 'BO1', 'BO3', 'BO5',
    'NBA', 'NFL', 'MLB', 'NHL', 'UFC', 'Dota',
    'CS2', 'League of Legends', 'Valorant',
];

function isSportsMarket(entry: MatchEntry): boolean {
    const q = entry.predict.question + ' ' + entry.predict.categorySlug;
    return SPORTS_KEYWORDS.some(kw => q.includes(kw));
}

async function selectTestMarket(): Promise<{
    predictMarketId: number;
    polyConditionId: string;
    polyTokenIdYes: string;  // 选中端的 tokenId (用于下单)
    polyTokenIdNo: string;   // 另一端的 tokenId
    negRisk: boolean;
    tickSize: number;
    title: string;
    selectedSide: 'YES' | 'NO';
} | null> {
    const matchFilePath = resolve(__dirname, '../../polymarket-match-result.json');
    if (!fs.existsSync(matchFilePath)) {
        console.error(`${c.red}找不到 polymarket-match-result.json${c.reset}`);
        return null;
    }

    const matchData = JSON.parse(fs.readFileSync(matchFilePath, 'utf-8')) as {
        matches: MatchEntry[];
    };

    // 过滤: 活跃 + 接受订单 + 非倒转
    // 优先非体育，如找不到则回退到体育市场
    const nonSports = matchData.matches.filter(m =>
        m.polymarket.active &&
        !m.polymarket.closed &&
        m.polymarket.acceptingOrders &&
        !m.inverted &&
        !isSportsMarket(m)
    );
    const sports = matchData.matches.filter(m =>
        m.polymarket.active &&
        !m.polymarket.closed &&
        m.polymarket.acceptingOrders &&
        !m.inverted &&
        isSportsMarket(m)
    );
    const candidates = [...nonSports, ...sports];

    console.log(`${c.dim}候选市场: ${candidates.length} 个 (非体育 ${nonSports.length}, 体育 ${sports.length})${c.reset}`);

    // 逐个检查 Polymarket CLOB 是否有深度 (最多检查 60 个)
    let checked = 0;
    for (const cand of candidates) {
        if (checked >= 60) break;
        checked++;
        try {
            // 获取 Polymarket token IDs
            const res = await fetch(`${CLOB_BASE_URL}/markets/${cand.polymarket.conditionId}`);
            if (!res.ok) {
                console.log(`${c.dim}  [${checked}] ${cand.predict.title.slice(0, 50)}: CLOB HTTP ${res.status}${c.reset}`);
                continue;
            }
            const clobData = await res.json() as PolymarketClobMarket;

            if (!clobData.tokens || clobData.tokens.length < 2) {
                console.log(`${c.dim}  [${checked}] ${cand.predict.title.slice(0, 50)}: 无 tokens${c.reset}`);
                continue;
            }
            if (clobData.closed || !clobData.accepting_orders) {
                console.log(`${c.dim}  [${checked}] ${cand.predict.title.slice(0, 50)}: closed/不接受订单${c.reset}`);
                continue;
            }

            const yesToken = clobData.tokens.find(t => t.outcome === 'Yes');
            const noToken = clobData.tokens.find(t => t.outcome === 'No');
            if (!yesToken || !noToken) continue;

            // 检查两个 token 的 orderbook，选深度更好的一端
            // (YES bestAsk 接近 1 时，NO 端通常更适合测试)
            let selectedTokenId = yesToken.token_id;
            let otherTokenId = noToken.token_id;
            let selectedSide: 'YES' | 'NO' = 'YES';

            const bookYes = await fetch(`${CLOB_BASE_URL}/book?token_id=${yesToken.token_id}`);
            const bookNo = await fetch(`${CLOB_BASE_URL}/book?token_id=${noToken.token_id}`);
            if (!bookYes.ok || !bookNo.ok) continue;

            const yesBook = await bookYes.json() as { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };
            const noBook = await bookNo.json() as { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };

            const yesBestAsk = yesBook.asks?.[0] ? parseFloat(yesBook.asks[0].price) : 0;
            const noBestAsk = noBook.asks?.[0] ? parseFloat(noBook.asks[0].price) : 0;
            const yesAskDepth = (yesBook.asks || []).reduce((s, a) => s + parseFloat(a.size), 0);
            const noAskDepth = (noBook.asks || []).reduce((s, a) => s + parseFloat(a.size), 0);

            // 优先选 bestAsk 不太极端的一端 (0.05 ~ 0.95)
            // 如果两端都极端，退而求其次选 bestAsk < 0.995 且深度充足的
            let bestAsk = 0;
            let totalAskSize = 0;

            const yesIdeal = yesBestAsk > 0.03 && yesBestAsk < 0.97 && yesAskDepth >= 5;
            const noIdeal = noBestAsk > 0.03 && noBestAsk < 0.97 && noAskDepth >= 5;
            const yesFallback = yesBestAsk > 0 && yesBestAsk < 0.999 && yesAskDepth >= 5;
            const noFallback = noBestAsk > 0 && noBestAsk < 0.999 && noAskDepth >= 5;

            // 二次选择: 理想范围 > fallback
            const yesOk = yesIdeal || yesFallback;
            const noOk = noIdeal || noFallback;
            const yesScore = (yesIdeal ? 2 : yesFallback ? 1 : 0);
            const noScore = (noIdeal ? 2 : noFallback ? 1 : 0);

            if (yesOk && (!noOk || yesScore > noScore || (yesScore === noScore && yesAskDepth >= noAskDepth))) {
                selectedTokenId = yesToken.token_id;
                otherTokenId = noToken.token_id;
                selectedSide = 'YES';
                bestAsk = yesBestAsk;
                totalAskSize = yesAskDepth;
            } else if (noOk) {
                selectedTokenId = noToken.token_id;
                otherTokenId = yesToken.token_id;
                selectedSide = 'NO';
                bestAsk = noBestAsk;
                totalAskSize = noAskDepth;
            } else {
                console.log(`${c.dim}  [${checked}] ${cand.predict.title.slice(0, 50)}: 两端深度不足 (Y: ask=${yesBestAsk} depth=${yesAskDepth.toFixed(0)}, N: ask=${noBestAsk} depth=${noAskDepth.toFixed(0)})${c.reset}`);
                continue;
            }

            console.log(`${c.green}✓ 选定市场: ${cand.predict.question}${c.reset}`);
            console.log(`  Predict ID: ${cand.predict.id}`);
            console.log(`  Poly conditionId: ${cand.polymarket.conditionId}`);
            console.log(`  选用 ${selectedSide} 端, tokenId: ${selectedTokenId.slice(0, 20)}...`);
            console.log(`  Best ask: ${bestAsk}, 总 ask 深度: ${totalAskSize.toFixed(2)} shares`);
            console.log(`  negRisk: ${clobData.neg_risk}, tickSize: ${clobData.minimum_tick_size}`);
            console.log();

            return {
                predictMarketId: cand.predict.id,
                polyConditionId: cand.polymarket.conditionId,
                polyTokenIdYes: selectedTokenId,
                polyTokenIdNo: otherTokenId,
                negRisk: clobData.neg_risk || false,
                tickSize: parseFloat(clobData.minimum_tick_size || '0.01'),
                title: cand.predict.question,
                selectedSide,
            };
        } catch (err: any) {
            console.log(`${c.dim}  [${checked}] ${cand.predict.title.slice(0, 50)}: ${err.message?.slice(0, 80)}${c.reset}`);
            continue;
        }
    }

    console.error(`${c.red}未找到满足深度要求的活跃 Binary 市场 (已检查 ${checked} 个)${c.reset}`);
    return null;
}

// ============================================================================
// Test 1: EIP-712 签名延迟
// ============================================================================

async function testSigningLatency(
    predictTrader: PredictTrader,
    polyTrader: PolymarketTrader,
    market: Awaited<ReturnType<typeof selectTestMarket>> & {}
): Promise<void> {
    console.log(`\n${c.bold}${c.cyan}═══ Test 1: EIP-712 签名延迟 (纯本地, 10 次) ═══${c.reset}\n`);

    const predictTimes: number[] = [];
    const polyTimes: number[] = [];

    for (let i = 0; i < 10; i++) {
        // Predict 签名 — 使用极低价 GTC 单（只构建+签名，不提交）
        const { latencyMs: prdMs } = await measureLatency(async () => {
            // placeOrder 内部会做签名+提交，我们只能测整体
            // 但为了隔离签名，用一个不可能成交的低价
            // 这里复用 placeOrder 但立即取消
            // 实际上无法纯隔离签名，所以这里测的是 "构建+签名+提交" 总时间
            // 见 Test 2 分段测量
        });

        // Polymarket 签名 — 构建 EIP-712 typed data + 签名
        const { latencyMs: polyMs } = await measureLatency(async () => {
            // 构建并签名一个不会提交的订单
            // 直接调用 wallet.signTypedData (这是签名的核心)
            const { Wallet } = await import('ethers');
            const wallet = new Wallet(process.env.POLYMARKET_TRADER_PRIVATE_KEY!);
            const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS!;

            const domain = {
                name: 'Polymarket CTF Exchange',
                version: '1',
                chainId: 137,
                verifyingContract: market.negRisk
                    ? '0xC5d563A36AE78145C45a50134d48A1215220f80a'
                    : '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
            };

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

            const order = {
                salt: Math.round(Math.random() * Date.now()),
                maker: proxyAddress,
                signer: wallet.address,
                taker: '0x0000000000000000000000000000000000000000',
                tokenId: BigInt(market.polyTokenIdYes),
                makerAmount: BigInt(1000000),  // $1
                takerAmount: BigInt(2000000),  // 2 shares
                expiration: BigInt(0),
                nonce: 0,
                feeRateBps: 0,
                side: 0,  // BUY
                signatureType: 2,
            };

            await wallet.signTypedData(domain, ORDER_TYPES, order);
        });

        polyTimes.push(polyMs);
    }

    // Predict 签名单独测试 — 通过 OrderBuilder
    // OrderBuilder.signTypedDataOrder 是核心签名步骤
    // 我们无法直接访问内部方法，但可以测试 placeOrder 的签名部分
    // 改为在 Test 2 中分段测量

    console.log(`${c.magenta}Polymarket EIP-712 签名 (wallet.signTypedData):${c.reset}`);
    printStats('signTypedData', polyTimes);
    console.log(`${c.dim}(Predict 签名延迟包含在 Test 2 分段测量中)${c.reset}`);
}

// ============================================================================
// Test 2: Predict 端全链路
// ============================================================================

async function testPredictFullChain(
    predictTrader: PredictTrader,
    market: Awaited<ReturnType<typeof selectTestMarket>> & {}
): Promise<void> {
    console.log(`\n${c.bold}${c.cyan}═══ Test 2: Predict 端全链路 (GTC 低价单) ═══${c.reset}\n`);

    // 使用极低价 BUY 单: price=0.02 → 不可能成交
    const testPrice = 0.02;
    const testQty = 50;  // 50 shares @ 0.02 = $1 (满足最小订单)
    const testOutcome = market.selectedSide;

    // --- Step A: JWT 认证 (init 内完成, 已 cached) ---
    // init 已调用，JWT 已有，测量一次刷新
    const jwtTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
        const { latencyMs } = await measureLatency(async () => {
            // 强制刷新 JWT (模拟过期)
            // @ts-expect-error accessing private for benchmark
            predictTrader.jwt = null;
            // @ts-expect-error accessing private for benchmark
            predictTrader.jwtExpiresAt = null;
            // @ts-expect-error accessing private for benchmark
            await predictTrader.authenticateSmartWallet();
        });
        jwtTimes.push(latencyMs);
    }

    // --- Step B+C+D+E: 下单 → 确认 → 取消 ---
    const placeOrderTimes: number[] = [];
    const getStatusTimes: number[] = [];
    const cancelTimes: number[] = [];
    const totalTimes: number[] = [];

    const ROUNDS = 3;
    for (let i = 0; i < ROUNDS; i++) {
        console.log(`${c.dim}  Round ${i + 1}/${ROUNDS}...${c.reset}`);
        const totalStart = performance.now();

        // B: 构建+签名+提交
        const { result: orderResult, latencyMs: placeMs } = await measureLatency(async () => {
            return predictTrader.placeOrder({
                marketId: market.predictMarketId,
                side: 'BUY',
                price: testPrice,
                quantity: testQty,
                outcome: testOutcome,
            });
        });

        if (!orderResult.success || !orderResult.hash) {
            console.log(`${c.red}  下单失败: ${orderResult.error}${c.reset}`);
            continue;
        }
        placeOrderTimes.push(placeMs);
        console.log(`${c.dim}    placeOrder: ${formatMs(placeMs)}, hash: ${orderResult.hash.slice(0, 16)}...${c.reset}`);

        // C: getOrderStatus 确认
        const { result: status, latencyMs: statusMs } = await measureLatency(async () => {
            return predictTrader.getOrderStatus(orderResult.hash!);
        });
        getStatusTimes.push(statusMs);
        console.log(`${c.dim}    getOrderStatus: ${formatMs(statusMs)}, status: ${status?.status}${c.reset}`);

        // D: cancelOrder
        const { latencyMs: cancelMs } = await measureLatency(async () => {
            return predictTrader.cancelOrder(orderResult.hash!);
        });
        cancelTimes.push(cancelMs);
        console.log(`${c.dim}    cancelOrder: ${formatMs(cancelMs)}${c.reset}`);

        totalTimes.push(performance.now() - totalStart);

        // 间隔避免限频
        if (i < ROUNDS - 1) await sleep(500);
    }

    console.log(`\n${c.magenta}Predict 端分段延迟:${c.reset}`);
    printStats('JWT 认证 (authenticateSmartWallet)', jwtTimes);
    printStats('placeOrder (构建+签名+HTTP提交)', placeOrderTimes);
    printStats('getOrderStatus (确认)', getStatusTimes);
    printStats('cancelOrder (取消)', cancelTimes);
    printStats('全链路 (下单→确认→取消)', totalTimes);
}

// ============================================================================
// Test 3a: Polymarket GTC 限价单 (不成交)
// ============================================================================

async function testPolyGtcChain(
    polyTrader: PolymarketTrader,
    market: Awaited<ReturnType<typeof selectTestMarket>> & {}
): Promise<void> {
    console.log(`\n${c.bold}${c.cyan}═══ Test 3a: Polymarket GTC 限价单 (不成交) ═══${c.reset}\n`);

    // 使用极低价 YES BUY: price=0.01 → 不可能成交
    const testPrice = 0.01;
    const testQty = 100;  // 100 shares @ 0.01 = $1 (满足 Polymarket 最小 $1)

    const placeOrderTimes: number[] = [];
    const getStatusTimes: number[] = [];
    const cancelTimes: number[] = [];
    const totalTimes: number[] = [];

    const ROUNDS = 3;
    for (let i = 0; i < ROUNDS; i++) {
        console.log(`${c.dim}  Round ${i + 1}/${ROUNDS}...${c.reset}`);
        const totalStart = performance.now();

        // 签名 + HTTP 提交
        const { result: orderResult, latencyMs: placeMs } = await measureLatency(async () => {
            return polyTrader.placeOrder({
                tokenId: market.polyTokenIdYes,
                side: 'BUY',
                price: testPrice,
                quantity: testQty,
                orderType: 'GTC',
                negRisk: market.negRisk,
            });
        });

        if (!orderResult.success || !orderResult.orderId) {
            console.log(`${c.red}  下单失败: ${orderResult.error}${c.reset}`);
            continue;
        }
        placeOrderTimes.push(placeMs);
        console.log(`${c.dim}    placeOrder: ${formatMs(placeMs)}, orderId: ${orderResult.orderId.slice(0, 16)}...${c.reset}`);

        // getOrderStatus 确认
        const { result: status, latencyMs: statusMs } = await measureLatency(async () => {
            return polyTrader.getOrderStatus(orderResult.orderId!);
        });
        getStatusTimes.push(statusMs);
        console.log(`${c.dim}    getOrderStatus: ${formatMs(statusMs)}, status: ${status?.status}${c.reset}`);

        // cancelOrder
        const { latencyMs: cancelMs } = await measureLatency(async () => {
            return polyTrader.cancelOrder(orderResult.orderId!, { skipTelegram: true });
        });
        cancelTimes.push(cancelMs);
        console.log(`${c.dim}    cancelOrder: ${formatMs(cancelMs)}${c.reset}`);

        totalTimes.push(performance.now() - totalStart);

        if (i < ROUNDS - 1) await sleep(500);
    }

    console.log(`\n${c.magenta}Polymarket GTC 分段延迟:${c.reset}`);
    printStats('placeOrder (签名+HTTP提交)', placeOrderTimes);
    printStats('getOrderStatus (确认)', getStatusTimes);
    printStats('cancelOrder (取消)', cancelTimes);
    printStats('全链路 (下单→确认→取消)', totalTimes);
}

// ============================================================================
// Test 3b: Polymarket IOC 订单 (真实成交)
// ============================================================================

async function testPolyIocLive(
    polyTrader: PolymarketTrader,
    market: Awaited<ReturnType<typeof selectTestMarket>> & {}
): Promise<void> {
    console.log(`\n${c.bold}${c.cyan}═══ Test 3b: Polymarket IOC 订单 (真实成交, ~$2-5) ═══${c.reset}\n`);

    // 1. 检查余额
    const balance = await polyTrader.getBalance();
    console.log(`  Polymarket CLOB 余额: $${balance.toFixed(2)}`);
    if (balance < 5) {
        console.log(`${c.red}  余额不足 $5，跳过 IOC 测试${c.reset}`);
        return;
    }

    // 2. 获取最新 orderbook，使用 best ask 价格
    const book = await polyTrader.getOrderbook(market.polyTokenIdYes);
    if (!book || book.asks.length === 0) {
        console.log(`${c.red}  无法获取 asks，跳过 IOC 测试${c.reset}`);
        return;
    }

    const bestAsk = book.asks[0].price;
    const bestAskSize = book.asks[0].size;
    console.log(`  Best ask: ${bestAsk} @ ${bestAskSize} shares`);

    // 目标 $2-5 成本
    const targetUsd = Math.min(3, balance * 0.3);
    const targetQty = Math.floor(targetUsd / bestAsk);

    if (targetQty < 1 || targetQty * bestAsk < 1) {
        console.log(`${c.red}  计算数量不足 (qty=${targetQty}, cost=${(targetQty * bestAsk).toFixed(2)})，跳过${c.reset}`);
        return;
    }

    // 确保不超过 best ask 深度
    const safeQty = Math.min(targetQty, Math.floor(bestAskSize * 0.8));
    if (safeQty < 1) {
        console.log(`${c.red}  深度不足 (bestAskSize=${bestAskSize})，跳过${c.reset}`);
        return;
    }

    const estimatedCost = (safeQty * bestAsk).toFixed(2);
    console.log(`  IOC 买单: ${safeQty} shares @ ${bestAsk}, 预计花费: $${estimatedCost}`);
    console.log();

    // 3. 执行 IOC
    const signAndSubmitTimes: number[] = [];
    const pollTimes: number[] = [];
    const totalTimes: number[] = [];

    // IOC 只测 1 次（真实花钱）
    const totalStart = performance.now();

    const { result: orderResult, latencyMs: placeMs } = await measureLatency(async () => {
        return polyTrader.placeOrder({
            tokenId: market.polyTokenIdYes,
            side: 'BUY',
            price: bestAsk,
            quantity: safeQty,
            orderType: 'IOC',
            negRisk: market.negRisk,
        });
    });

    if (!orderResult.success || !orderResult.orderId) {
        console.log(`${c.red}  IOC 下单失败: ${orderResult.error}${c.reset}`);
        return;
    }
    signAndSubmitTimes.push(placeMs);
    console.log(`  ${c.green}placeOrder (IOC): ${formatMs(placeMs)}, orderId: ${orderResult.orderId.slice(0, 16)}...${c.reset}`);

    // 轮询直到 MATCHED 或 CANCELLED
    const { result: finalStatus, latencyMs: pollMs } = await measureLatency(async () => {
        return polyTrader.pollOrderStatus(orderResult.orderId!, 10, 150);
    });
    pollTimes.push(pollMs);

    const totalMs = performance.now() - totalStart;
    totalTimes.push(totalMs);

    if (finalStatus) {
        const filled = finalStatus.filledQty;
        const status = finalStatus.status;
        console.log(`  ${c.green}pollOrderStatus: ${formatMs(pollMs)}, status=${status}, filled=${filled}${c.reset}`);
    } else {
        console.log(`  ${c.yellow}pollOrderStatus: ${formatMs(pollMs)}, 超时未确认${c.reset}`);
    }

    console.log(`\n${c.magenta}Polymarket IOC 延迟:${c.reset}`);
    printStats('placeOrder (签名+HTTP提交)', signAndSubmitTimes);
    printStats('pollOrderStatus (首次终态)', pollTimes);
    printStats('总耗时 (下单→确认成交)', totalTimes);
}

// ============================================================================
// Test 4: Orderbook 获取延迟
// ============================================================================

async function testOrderbookLatency(
    polyTrader: PolymarketTrader,
    predictTrader: PredictTrader,
    market: Awaited<ReturnType<typeof selectTestMarket>> & {}
): Promise<void> {
    console.log(`\n${c.bold}${c.cyan}═══ Test 4: Orderbook 获取延迟 (10 次) ═══${c.reset}\n`);

    const polyRestTimes: number[] = [];
    const predictRestTimes: number[] = [];

    for (let i = 0; i < 10; i++) {
        // Polymarket REST orderbook
        try {
            const { latencyMs: polyMs } = await measureLatency(async () => {
                const res = await fetch(`${CLOB_BASE_URL}/book?token_id=${market.polyTokenIdYes}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = await res.text();
                return JSON.parse(text);
            });
            polyRestTimes.push(polyMs);
        } catch (err: any) {
            console.log(`${c.dim}  Poly orderbook [${i + 1}] 失败: ${err.message?.slice(0, 80)}${c.reset}`);
        }

        // Predict REST orderbook
        try {
            const { latencyMs: predictMs } = await measureLatency(async () => {
                return predictTrader.getOrderbook(market.predictMarketId);
            });
            predictRestTimes.push(predictMs);
        } catch (err: any) {
            console.log(`${c.dim}  Predict orderbook [${i + 1}] 失败: ${err.message?.slice(0, 80)}${c.reset}`);
        }

        if (i < 9) await sleep(300);
    }

    console.log(`${c.magenta}Orderbook REST 延迟:${c.reset}`);
    printStats('Polymarket REST (/book)', polyRestTimes);
    printStats('Predict REST (/orderbook)', predictRestTimes);
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
    console.log(`\n${c.bold}${c.magenta}╔════════════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.bold}${c.magenta}║   双边套利延迟基准测试 (Arb Latency Benchmark) ║${c.reset}`);
    console.log(`${c.bold}${c.magenta}╚════════════════════════════════════════════════╝${c.reset}\n`);

    // 0. 选择测试市场
    console.log(`${c.cyan}[Step 0] 选择测试市场...${c.reset}\n`);
    const market = await selectTestMarket();
    if (!market) {
        process.exit(1);
    }

    // 1. 初始化 Traders
    console.log(`${c.cyan}[Step 1] 初始化 Traders...${c.reset}\n`);

    const predictTrader = new PredictTrader();
    const { latencyMs: predictInitMs } = await measureLatency(() => predictTrader.init());
    console.log(`  PredictTrader.init(): ${c.green}${formatMs(predictInitMs)}${c.reset}`);

    const polyTrader = new PolymarketTrader();
    const { latencyMs: polyInitMs } = await measureLatency(() => polyTrader.init());
    console.log(`  PolymarketTrader.init(): ${c.green}${formatMs(polyInitMs)}${c.reset}`);

    // 2. 执行测试
    try {
        await testSigningLatency(predictTrader, polyTrader, market);
        await testPredictFullChain(predictTrader, market);
        await testPolyGtcChain(polyTrader, market);
        await testPolyIocLive(polyTrader, market);
        await testOrderbookLatency(polyTrader, predictTrader, market);
    } catch (err: any) {
        console.error(`\n${c.red}测试执行出错: ${err.message}${c.reset}`);
        console.error(err.stack);
    }

    console.log(`\n${c.bold}${c.magenta}═══ 测试完成 ═══${c.reset}\n`);
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
