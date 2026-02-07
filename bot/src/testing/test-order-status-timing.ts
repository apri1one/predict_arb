/**
 * 订单状态延迟测试 - 含真实下单
 *
 * 测试内容:
 * 1. Predict 真实下单延迟测试 (下不成交的单，立即撤单)
 * 2. Polymarket 真实下单延迟测试 (小额 IOC)
 * 3. 订单簿获取极限测试
 * 4. 最优轮询间隔搜索
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
    const envPath = join(__dirname, '..', '..', '..', '.env');
    if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) {
                if (!process.env[match[1].trim()]) {
                    process.env[match[1].trim()] = match[2].trim();
                }
            }
        }
    }
}

loadEnv();

// ============================================================================
// 类型定义
// ============================================================================

interface TimingResult {
    min: number;
    max: number;
    avg: number;
    p95: number;
    samples: number[];
}

interface TestReport {
    predict: {
        orderToFirstStatus: TimingResult | null;
        cancelToStatusUpdate: TimingResult | null;
        recommendedPollInterval: number;
    };
    polymarket: {
        orderToFirstStatus: TimingResult | null;
        orderToMatched: TimingResult | null;
        recommendedPollInterval: number;
    };
    orderbook: {
        minSafeInterval: number;
        rateLimitThreshold: number;
    };
    summary: {
        POLL_INTERVAL: number;
        ORDERBOOK_RETRY_DELAY: number;
        HEDGE_WAIT: number;
    };
}

// ============================================================================
// 工具函数
// ============================================================================

function calculateTimingResult(samples: number[]): TimingResult {
    if (samples.length === 0) {
        return { min: 0, max: 0, avg: 0, p95: 0, samples: [] };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p95 = sorted[p95Index] || max;
    return { min, max, avg, p95, samples };
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Predict 测试
// ============================================================================

async function testPredictOrderTiming(
    apiKey: string,
    marketId: number,
    iterations: number = 5
): Promise<{ orderToFirstStatus: TimingResult | null; cancelToStatusUpdate: TimingResult | null }> {
    console.log(`\n📊 Predict 订单状态延迟测试 (${iterations} 次)`);

    // 动态导入 PredictTrader
    const { getPredictTrader } = await import('../dashboard/predict-trader.js');
    const trader = getPredictTrader();
    await trader.init();

    const orderToFirstStatusSamples: number[] = [];
    const cancelToStatusUpdateSamples: number[] = [];

    // 获取当前订单簿，找一个不会成交的价格
    const orderbook = await trader.getOrderbook(marketId);
    if (!orderbook || orderbook.bids.length === 0) {
        console.log('  ❌ 无法获取订单簿');
        return { orderToFirstStatus: null, cancelToStatusUpdate: null };
    }

    const bestBid = orderbook.bids[0][0];
    const safePrice = Math.max(0.01, bestBid - 0.1); // 比 best bid 低 0.1，确保不成交
    // 动态计算数量，确保下单金额 > $1.5 (安全边际)
    const minQuantity = Math.ceil(1.5 / safePrice);

    console.log(`  市场 ID: ${marketId}, 安全价格: ${safePrice.toFixed(3)} (best bid: ${bestBid.toFixed(3)}), 数量: ${minQuantity}`);

    for (let i = 0; i < iterations; i++) {
        console.log(`  第 ${i + 1}/${iterations} 次测试...`);

        try {
            // 1. 下单
            const orderStart = Date.now();
            const result = await trader.placeOrder({
                marketId,
                side: 'BUY',
                price: safePrice,
                quantity: minQuantity, // 动态计算确保金额 > $1
                outcome: 'YES',
            });

            if (!result.success || !result.hash) {
                console.log(`    ❌ 下单失败: ${result.error}`);
                await delay(2000);
                continue;
            }

            // 2. 轮询直到首次获取到状态 (最多 20 秒)
            let firstStatusTime = 0;
            const pollStart = Date.now();
            for (let j = 0; j < 100; j++) { // 最多轮询 100 次
                const status = await trader.getOrderStatus(result.hash);
                if (status) {
                    firstStatusTime = Date.now() - orderStart;
                    break;
                }
                await delay(200); // 200ms 间隔轮询
            }

            if (firstStatusTime > 0) {
                orderToFirstStatusSamples.push(firstStatusTime);
                console.log(`    下单到首次获取状态: ${firstStatusTime}ms`);
            }

            // 3. 撤单
            const cancelStart = Date.now();
            await trader.cancelOrder(result.hash);

            // 4. 轮询直到状态变为 CANCELLED (最多 10 秒)
            let cancelStatusTime = 0;
            for (let j = 0; j < 50; j++) {
                const status = await trader.getOrderStatus(result.hash);
                if (status && (status.status === 'CANCELLED' || status.status === 'EXPIRED')) {
                    cancelStatusTime = Date.now() - cancelStart;
                    break;
                }
                await delay(200);
            }

            if (cancelStatusTime > 0) {
                cancelToStatusUpdateSamples.push(cancelStatusTime);
                console.log(`    撤单到状态更新: ${cancelStatusTime}ms`);
            }

            // 等待 2 秒避免限流
            await delay(2000);
        } catch (error: any) {
            console.log(`    ❌ 错误: ${error.message}`);
            await delay(2000);
        }
    }

    return {
        orderToFirstStatus: orderToFirstStatusSamples.length > 0 ? calculateTimingResult(orderToFirstStatusSamples) : null,
        cancelToStatusUpdate: cancelToStatusUpdateSamples.length > 0 ? calculateTimingResult(cancelToStatusUpdateSamples) : null,
    };
}

// ============================================================================
// Polymarket 测试
// ============================================================================

async function testPolymarketOrderTiming(
    tokenId: string,
    iterations: number = 3
): Promise<{ orderToFirstStatus: TimingResult | null; orderToMatched: TimingResult | null }> {
    console.log(`\n📊 Polymarket 订单状态延迟测试 (${iterations} 次)`);

    // 动态导入 PolymarketTrader
    const { getPolymarketTrader } = await import('../dashboard/polymarket-trader.js');
    const trader = getPolymarketTrader();
    await trader.init();

    const orderToFirstStatusSamples: number[] = [];
    const orderToMatchedSamples: number[] = [];

    // 获取订单簿
    const orderbook = await trader.getOrderbook(tokenId);
    if (!orderbook || orderbook.asks.length === 0) {
        console.log('  ❌ 无法获取订单簿');
        return { orderToFirstStatus: null, orderToMatched: null };
    }

    // 使用比 best ask 高一点的价格确保 IOC 成交
    const bestAsk = orderbook.asks[0].price;
    const takerPrice = Math.min(0.99, bestAsk + 0.01);
    // 动态计算数量，确保下单金额 > $1.5 (安全边际)
    const minQuantity = Math.ceil(1.5 / takerPrice);

    console.log(`  Token ID: ${tokenId.slice(0, 20)}..., Taker 价格: ${takerPrice.toFixed(3)} (best ask: ${bestAsk.toFixed(3)}), 数量: ${minQuantity}`);

    for (let i = 0; i < iterations; i++) {
        console.log(`  第 ${i + 1}/${iterations} 次测试...`);

        try {
            // 1. 下 IOC 单
            const orderStart = Date.now();
            const result = await trader.placeOrder({
                tokenId,
                side: 'BUY',
                price: takerPrice,
                quantity: minQuantity, // 动态计算确保金额 > $1
                orderType: 'IOC',
            });

            if (!result.success || !result.orderId) {
                console.log(`    ❌ 下单失败: ${result.error}`);
                await delay(2000);
                continue;
            }

            // 2. 轮询直到首次获取到状态
            let firstStatusTime = 0;
            let matchedTime = 0;
            for (let j = 0; j < 30; j++) { // IOC 应该很快
                const status = await trader.getOrderStatus(result.orderId);
                if (status) {
                    if (firstStatusTime === 0) {
                        firstStatusTime = Date.now() - orderStart;
                    }
                    if (status.status === 'MATCHED') {
                        matchedTime = Date.now() - orderStart;
                        break;
                    }
                    if (status.status === 'CANCELLED') {
                        // IOC 未成交被取消
                        console.log(`    IOC 未成交被取消`);
                        break;
                    }
                }
                await delay(50);
            }

            if (firstStatusTime > 0) {
                orderToFirstStatusSamples.push(firstStatusTime);
                console.log(`    下单到首次获取状态: ${firstStatusTime}ms`);
            }
            if (matchedTime > 0) {
                orderToMatchedSamples.push(matchedTime);
                console.log(`    下单到 MATCHED: ${matchedTime}ms`);
            }

            // 等待 2 秒
            await delay(2000);
        } catch (error: any) {
            console.log(`    ❌ 错误: ${error.message}`);
            await delay(2000);
        }
    }

    return {
        orderToFirstStatus: orderToFirstStatusSamples.length > 0 ? calculateTimingResult(orderToFirstStatusSamples) : null,
        orderToMatched: orderToMatchedSamples.length > 0 ? calculateTimingResult(orderToMatchedSamples) : null,
    };
}

// ============================================================================
// 订单簿获取极限测试
// ============================================================================

async function testOrderbookRateLimit(
    apiKey: string,
    marketId: number
): Promise<{ minSafeInterval: number; rateLimitThreshold: number }> {
    console.log(`\n📊 订单簿获取极限测试`);

    const intervals = [10, 20, 50, 100, 200];
    let minSafeInterval = 200;
    let rateLimitThreshold = 0;

    for (const interval of intervals) {
        console.log(`  测试 ${interval}ms 间隔...`);

        let success = 0;
        let rateLimit = 0;
        const requests = 20;

        for (let i = 0; i < requests; i++) {
            try {
                const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
                    headers: { 'x-api-key': apiKey },
                });
                if (res.ok) {
                    success++;
                } else if (res.status === 429) {
                    rateLimit++;
                }
            } catch {
                // 忽略网络错误
            }
            await delay(interval);
        }

        const successRate = (success / requests) * 100;
        console.log(`    成功率: ${successRate.toFixed(0)}% (${success}/${requests}), 限流: ${rateLimit}`);

        if (rateLimit === 0 && successRate >= 95) {
            minSafeInterval = interval;
        } else if (rateLimit > 0) {
            rateLimitThreshold = interval;
            break;
        }
    }

    return { minSafeInterval, rateLimitThreshold };
}

// ============================================================================
// 主函数
// ============================================================================

async function main() {
    console.log('═'.repeat(60));
    console.log('  订单状态延迟测试 - 含真实下单');
    console.log('═'.repeat(60));

    const apiKey = process.env['PREDICT_API_KEY_TRADE'] || process.env['PREDICT_API_KEY'] || '';
    if (!apiKey) {
        console.error('❌ 未找到 PREDICT_API_KEY');
        process.exit(1);
    }

    // 测试用市场 (可配置或动态获取)
    const predictMarketId = Number(process.env['TEST_MARKET_ID']) || 889;
    let polyTokenId = process.env['TEST_POLY_TOKEN_ID'] || '';

    // 如果没有配置 token ID，动态获取一个有效的
    if (!polyTokenId) {
        console.log('\n🔍 动态获取有效的 Polymarket token ID...');
        try {
            // 从 Gamma API 获取活跃市场
            const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?closed=false&limit=10');
            const gammaMarkets = await gammaRes.json() as any[];

            for (const m of gammaMarkets) {
                if (!m.conditionId) continue;
                // 获取 CLOB 市场详情
                const clobRes = await fetch(`https://clob.polymarket.com/markets/${m.conditionId}`);
                if (!clobRes.ok) continue;
                const clobData = await clobRes.json() as any;

                // 获取 NO token (通常 outcome === 'No' 或 index 1)
                const noToken = clobData.tokens?.find((t: any) => t.outcome === 'No')?.token_id ||
                               clobData.tokens?.[1]?.token_id;
                if (!noToken) continue;

                // 检查订单簿是否有足够深度
                const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${noToken}`);
                if (!bookRes.ok) continue;
                const book = await bookRes.json() as any;

                // 需要有 asks 且价格 > 0.1 (10%) 才适合测试
                if (book.asks?.length > 0 && parseFloat(book.asks[0].price) > 0.1) {
                    polyTokenId = noToken;
                    console.log(`  ✓ 找到有效 token: ${noToken.slice(0, 30)}...`);
                    console.log(`  市场: ${m.question?.slice(0, 50)}...`);
                    console.log(`  Best Ask: ${book.asks[0].price}`);
                    break;
                }
            }
        } catch (e: any) {
            console.log(`  ❌ 动态获取失败: ${e.message}`);
        }
    }

    if (!polyTokenId) {
        console.log('\n⚠️ 未找到有效的 Polymarket token，跳过 Polymarket 测试');
    }

    const report: TestReport = {
        predict: {
            orderToFirstStatus: null,
            cancelToStatusUpdate: null,
            recommendedPollInterval: 500,
        },
        polymarket: {
            orderToFirstStatus: null,
            orderToMatched: null,
            recommendedPollInterval: 200,
        },
        orderbook: {
            minSafeInterval: 100,
            rateLimitThreshold: 0,
        },
        summary: {
            POLL_INTERVAL: 500,
            ORDERBOOK_RETRY_DELAY: 2000,
            HEDGE_WAIT: 500,
        },
    };

    // 1. Predict 测试 (3 次以加快测试速度)
    try {
        const predictResult = await testPredictOrderTiming(apiKey, predictMarketId, 3);
        report.predict.orderToFirstStatus = predictResult.orderToFirstStatus;
        report.predict.cancelToStatusUpdate = predictResult.cancelToStatusUpdate;

        if (predictResult.orderToFirstStatus) {
            // 推荐轮询间隔 = p95 * 1.2
            report.predict.recommendedPollInterval = Math.ceil(predictResult.orderToFirstStatus.p95 * 1.2);
        }
    } catch (error: any) {
        console.log(`\n❌ Predict 测试失败: ${error.message}`);
    }

    // 2. Polymarket 测试 (可选，需要 API 配置和有效 token)
    const hasPolyConfig = process.env['POLYMARKET_TRADER_PRIVATE_KEY'] && process.env['POLYMARKET_API_KEY'];
    if (hasPolyConfig && polyTokenId) {
        try {
            const polyResult = await testPolymarketOrderTiming(polyTokenId, 3);
            report.polymarket.orderToFirstStatus = polyResult.orderToFirstStatus;
            report.polymarket.orderToMatched = polyResult.orderToMatched;

            if (polyResult.orderToFirstStatus) {
                report.polymarket.recommendedPollInterval = Math.ceil(polyResult.orderToFirstStatus.p95 * 1.2);
            }
        } catch (error: any) {
            console.log(`\n❌ Polymarket 测试失败: ${error.message}`);
        }
    } else if (!hasPolyConfig) {
        console.log('\n⚠️ 跳过 Polymarket 测试 (未配置 POLYMARKET_TRADER_PRIVATE_KEY)');
    }

    // 3. 订单簿限流测试
    try {
        const orderbookResult = await testOrderbookRateLimit(apiKey, predictMarketId);
        report.orderbook = orderbookResult;
    } catch (error: any) {
        console.log(`\n❌ 订单簿测试失败: ${error.message}`);
    }

    // 4. 生成报告
    console.log('\n' + '═'.repeat(60));
    console.log('  真实下单延迟测试报告');
    console.log('═'.repeat(60));

    console.log('\nPredict:');
    if (report.predict.orderToFirstStatus) {
        const t = report.predict.orderToFirstStatus;
        console.log(`  下单到首次获取状态: avg ${t.avg}ms, min ${t.min}ms, max ${t.max}ms, p95 ${t.p95}ms`);
    } else {
        console.log('  下单到首次获取状态: 无数据');
    }
    if (report.predict.cancelToStatusUpdate) {
        const t = report.predict.cancelToStatusUpdate;
        console.log(`  撤单到状态更新: avg ${t.avg}ms, min ${t.min}ms, max ${t.max}ms`);
    }
    console.log(`  推荐轮询间隔: ${report.predict.recommendedPollInterval}ms`);

    console.log('\nPolymarket:');
    if (report.polymarket.orderToFirstStatus) {
        const t = report.polymarket.orderToFirstStatus;
        console.log(`  下单到首次获取状态: avg ${t.avg}ms, min ${t.min}ms, max ${t.max}ms`);
    } else {
        console.log('  下单到首次获取状态: 无数据');
    }
    if (report.polymarket.orderToMatched) {
        const t = report.polymarket.orderToMatched;
        console.log(`  下单到 MATCHED: avg ${t.avg}ms, min ${t.min}ms, max ${t.max}ms`);
    }
    console.log(`  推荐轮询间隔: ${report.polymarket.recommendedPollInterval}ms`);

    console.log('\n订单簿获取:');
    console.log(`  最小安全间隔: ${report.orderbook.minSafeInterval}ms`);
    console.log(`  触发 429 阈值: ${report.orderbook.rateLimitThreshold}ms`);

    // 计算推荐值
    report.summary.POLL_INTERVAL = Math.max(
        200, // 最小 200ms
        report.predict.recommendedPollInterval,
        report.polymarket.recommendedPollInterval
    );
    report.summary.ORDERBOOK_RETRY_DELAY = Math.max(
        500, // 最小 500ms
        report.orderbook.minSafeInterval * 5
    );
    report.summary.HEDGE_WAIT = Math.max(
        200,
        report.polymarket.orderToMatched?.avg || 200
    );

    console.log('\n' + '─'.repeat(60));
    console.log('总结建议:');
    console.log(`  TAKER_POLL_INTERVAL_MS=${report.summary.POLL_INTERVAL}`);
    console.log(`  ORDERBOOK_RETRY_DELAY_MS=${report.summary.ORDERBOOK_RETRY_DELAY}`);
    console.log(`  TAKER_HEDGE_WAIT_MS=${report.summary.HEDGE_WAIT}`);
    console.log('═'.repeat(60));
}

main().catch(console.error);
