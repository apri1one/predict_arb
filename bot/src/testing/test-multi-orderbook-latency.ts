/**
 * Predict WebSocket 多订单簿订阅与 REST API 延迟对比测试
 *
 * 功能:
 * - 同时订阅多个市场的订单簿 (WebSocket)
 * - 定期使用 REST API 获取相同订单簿
 * - 比较两者的延迟、数据一致性、变化检测速度
 *
 * 用法:
 *   npx tsx src/testing/test-multi-orderbook-latency.ts [marketId1,marketId2,...]
 *   npx tsx src/testing/test-multi-orderbook-latency.ts 1,2,3,4,5
 *   npx tsx src/testing/test-multi-orderbook-latency.ts           # 自动获取活跃市场
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import { PredictWsClient, OrderbookUpdateData } from '../services/predict-ws-client.js';
import { PredictRestClient } from '../predict/rest-client.js';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.PREDICT_API_KEY || '';
const TEST_DURATION_MS = 60000; // 测试持续时间 60 秒
const REST_POLL_INTERVAL_MS = 1000; // REST 轮询间隔 1 秒（加快以更好检测变化）
const MAX_MARKETS = 10; // 最多订阅市场数

// ============================================================================
// 类型定义
// ============================================================================

interface PriceChange {
    marketId: number;
    wsDetectTime: number; // WS 检测到变化的时间
    restDetectTime: number | null; // REST 检测到同一变化的时间
    oldBestBid: number | null;
    newBestBid: number | null;
    oldBestAsk: number | null;
    newBestAsk: number | null;
}

interface MarketStats {
    marketId: number;
    wsUpdates: number;
    restCalls: number;
    wsMessageIntervals: number[]; // WS 消息到达间隔
    restLatencies: number[]; // REST 请求耗时
    lastWsData: OrderbookUpdateData | null;
    lastWsReceiveTime: number;
    lastRestData: { bids: [number, number][]; asks: [number, number][] } | null;
    dataMatches: number; // 数据一致次数
    dataMismatches: number; // 数据不一致次数
    priceChanges: PriceChange[]; // 价格变化事件
    lastBestBid: number | null;
    lastBestAsk: number | null;
}

// ============================================================================
// 工具函数
// ============================================================================

function formatLatency(latencies: number[]): string {
    if (latencies.length === 0) return 'N/A';
    const sorted = [...latencies].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    return `min=${min}ms, avg=${avg.toFixed(1)}ms, p50=${p50}ms, p95=${p95}ms, max=${max}ms`;
}

function compareBidAsk(
    ws: [number, number][] | undefined,
    rest: [number, number][] | undefined
): boolean {
    if (!ws || !rest) return false;
    if (ws.length === 0 && rest.length === 0) return true;
    if (ws.length === 0 || rest.length === 0) return false;

    // 比较最优价格
    const wsBest = ws[0];
    const restBest = rest[0];
    return Math.abs(wsBest[0] - restBest[0]) < 0.0001;
}

// ============================================================================
// 主测试函数
// ============================================================================

async function main(): Promise<void> {
    console.log('='.repeat(70));
    console.log('Predict WebSocket 多订单簿订阅 vs REST API 延迟对比测试');
    console.log('='.repeat(70));

    if (!API_KEY) {
        console.error('错误: 缺少 PREDICT_API_KEY');
        process.exit(1);
    }

    // 解析市场 ID
    let marketIds: number[] = [];
    const arg = process.argv[2];

    if (arg) {
        marketIds = arg.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    }

    // 如果未指定市场，自动获取活跃市场
    const restClient = new PredictRestClient({ apiKey: API_KEY });

    if (marketIds.length === 0) {
        console.log('\n正在获取活跃市场...');
        try {
            const activeMarkets = await restClient.getActiveMarkets(MAX_MARKETS * 2);
            marketIds = activeMarkets.slice(0, MAX_MARKETS).map((m) => m.id);
            console.log(`找到 ${activeMarkets.length} 个活跃市场，选取前 ${marketIds.length} 个`);
        } catch (e: any) {
            console.error('获取活跃市场失败:', e?.message);
            // 使用默认市场
            marketIds = [1, 2, 3, 4, 5];
            console.log('使用默认市场 ID:', marketIds.join(', '));
        }
    }

    console.log(`\n测试市场: ${marketIds.join(', ')}`);
    console.log(`测试时长: ${TEST_DURATION_MS / 1000} 秒`);
    console.log(`REST 轮询间隔: ${REST_POLL_INTERVAL_MS} ms`);

    // 初始化统计
    const stats = new Map<number, MarketStats>();
    for (const id of marketIds) {
        stats.set(id, {
            marketId: id,
            wsUpdates: 0,
            restCalls: 0,
            wsMessageIntervals: [],
            restLatencies: [],
            lastWsData: null,
            lastWsReceiveTime: 0,
            lastRestData: null,
            dataMatches: 0,
            dataMismatches: 0,
            priceChanges: [],
            lastBestBid: null,
            lastBestAsk: null,
        });
    }

    // 创建 WebSocket 客户端
    const wsClient = new PredictWsClient({ apiKey: API_KEY, autoReconnect: true });

    console.log('\n正在连接 WebSocket...');
    const connectStart = Date.now();
    await wsClient.connect();
    console.log(`WebSocket 连接成功 (${Date.now() - connectStart}ms)`);

    // 订阅所有市场
    console.log(`\n正在订阅 ${marketIds.length} 个市场的订单簿...`);
    const subscribeStart = Date.now();
    let successCount = 0;

    for (const marketId of marketIds) {
        const success = await wsClient.subscribeOrderbook(marketId, (data: OrderbookUpdateData) => {
            const receiveTime = Date.now();
            const stat = stats.get(marketId);
            if (!stat) return;

            // 计算消息到达间隔
            if (stat.lastWsReceiveTime > 0) {
                const interval = receiveTime - stat.lastWsReceiveTime;
                stat.wsMessageIntervals.push(interval);
            }

            stat.wsUpdates++;
            stat.lastWsData = data;
            stat.lastWsReceiveTime = receiveTime;

            // 检测价格变化
            const newBestBid = data.bids[0]?.[0] ?? null;
            const newBestAsk = data.asks[0]?.[0] ?? null;

            const bidChanged = stat.lastBestBid !== null && newBestBid !== stat.lastBestBid;
            const askChanged = stat.lastBestAsk !== null && newBestAsk !== stat.lastBestAsk;

            if (bidChanged || askChanged) {
                stat.priceChanges.push({
                    marketId,
                    wsDetectTime: receiveTime,
                    restDetectTime: null,
                    oldBestBid: stat.lastBestBid,
                    newBestBid,
                    oldBestAsk: stat.lastBestAsk,
                    newBestAsk,
                });
            }

            stat.lastBestBid = newBestBid;
            stat.lastBestAsk = newBestAsk;
        });

        if (success) {
            successCount++;
            console.log(`  ✓ 市场 ${marketId} 订阅成功`);
        } else {
            console.log(`  ✗ 市场 ${marketId} 订阅失败`);
        }
    }

    console.log(`\n订阅完成: ${successCount}/${marketIds.length} 成功 (${Date.now() - subscribeStart}ms)`);

    // REST API 轮询
    let restPollCount = 0;
    const restPollTimer = setInterval(async () => {
        restPollCount++;
        const batchStart = Date.now();

        // 并行请求所有市场
        const promises = marketIds.map(async (marketId) => {
            const stat = stats.get(marketId);
            if (!stat) return;

            const start = Date.now();
            try {
                const orderbook = await restClient.getOrderBook(marketId);
                const elapsed = Date.now() - start;

                stat.restCalls++;
                stat.restLatencies.push(elapsed);
                stat.lastRestData = { bids: orderbook.bids, asks: orderbook.asks };

                // 比较 WS 和 REST 数据
                if (stat.lastWsData) {
                    const bidsMatch = compareBidAsk(stat.lastWsData.bids, orderbook.bids);
                    const asksMatch = compareBidAsk(stat.lastWsData.asks, orderbook.asks);
                    if (bidsMatch && asksMatch) {
                        stat.dataMatches++;
                    } else {
                        stat.dataMismatches++;
                    }
                }
            } catch (e: any) {
                // 忽略单次失败
            }
        });

        await Promise.all(promises);

        // 打印进度
        const elapsed = Date.now() - batchStart;
        const totalWsUpdates = Array.from(stats.values()).reduce((sum, s) => sum + s.wsUpdates, 0);
        process.stdout.write(
            `\r[${restPollCount}] REST batch: ${elapsed}ms | WS 总更新: ${totalWsUpdates}    `
        );
    }, REST_POLL_INTERVAL_MS);

    // 等待测试结束
    await new Promise((resolve) => setTimeout(resolve, TEST_DURATION_MS));

    // 清理
    clearInterval(restPollTimer);
    wsClient.disconnect();

    // ============================================================================
    // 输出结果
    // ============================================================================

    console.log('\n\n');
    console.log('='.repeat(70));
    console.log('测试结果');
    console.log('='.repeat(70));

    // 汇总统计
    let totalWsUpdates = 0;
    let totalRestCalls = 0;
    let totalWsIntervals: number[] = [];
    let totalRestLatencies: number[] = [];
    let totalMatches = 0;
    let totalMismatches = 0;
    let totalPriceChanges = 0;

    console.log('\n各市场详情:');
    console.log('-'.repeat(70));

    for (const [marketId, stat] of stats) {
        totalWsUpdates += stat.wsUpdates;
        totalRestCalls += stat.restCalls;
        totalWsIntervals.push(...stat.wsMessageIntervals);
        totalRestLatencies.push(...stat.restLatencies);
        totalMatches += stat.dataMatches;
        totalMismatches += stat.dataMismatches;
        totalPriceChanges += stat.priceChanges.length;

        console.log(`\n市场 ${marketId}:`);
        console.log(`  WS 更新次数: ${stat.wsUpdates}`);
        console.log(`  REST 调用次数: ${stat.restCalls}`);
        console.log(`  WS 消息间隔: ${formatLatency(stat.wsMessageIntervals)}`);
        console.log(`  REST 请求耗时: ${formatLatency(stat.restLatencies)}`);
        console.log(`  数据一致: ${stat.dataMatches}, 不一致: ${stat.dataMismatches}`);
        console.log(`  价格变化次数: ${stat.priceChanges.length}`);

        // 显示最新数据
        if (stat.lastWsData) {
            const ws = stat.lastWsData;
            const wsBestBid = ws.bids[0]?.[0]?.toFixed(4) || 'N/A';
            const wsBestAsk = ws.asks[0]?.[0]?.toFixed(4) || 'N/A';
            console.log(`  WS 最优: bid=${wsBestBid}, ask=${wsBestAsk}`);
        }
        if (stat.lastRestData) {
            const rest = stat.lastRestData;
            const restBestBid = rest.bids[0]?.[0]?.toFixed(4) || 'N/A';
            const restBestAsk = rest.asks[0]?.[0]?.toFixed(4) || 'N/A';
            console.log(`  REST 最优: bid=${restBestBid}, ask=${restBestAsk}`);
        }
    }

    // 汇总
    console.log('\n');
    console.log('='.repeat(70));
    console.log('汇总统计');
    console.log('='.repeat(70));

    console.log(`\n订阅市场数: ${marketIds.length}`);
    console.log(`测试时长: ${TEST_DURATION_MS / 1000} 秒`);

    console.log(`\nWebSocket:`);
    console.log(`  总更新次数: ${totalWsUpdates}`);
    console.log(`  平均更新频率: ${(totalWsUpdates / (TEST_DURATION_MS / 1000)).toFixed(2)} 次/秒`);
    console.log(`  每市场平均: ${(totalWsUpdates / marketIds.length / (TEST_DURATION_MS / 1000)).toFixed(2)} 次/秒`);
    console.log(`  消息间隔: ${formatLatency(totalWsIntervals)}`);

    console.log(`\nREST API:`);
    console.log(`  总调用次数: ${totalRestCalls}`);
    console.log(`  请求耗时: ${formatLatency(totalRestLatencies)}`);

    console.log(`\n数据一致性:`);
    console.log(`  一致: ${totalMatches}`);
    console.log(`  不一致: ${totalMismatches}`);
    const consistencyRate = totalMatches + totalMismatches > 0
        ? (totalMatches / (totalMatches + totalMismatches) * 100).toFixed(1)
        : 'N/A';
    console.log(`  一致率: ${consistencyRate}%`);

    console.log(`\n价格变化检测:`);
    console.log(`  WS 检测到的价格变化: ${totalPriceChanges} 次`);

    // WS 优势分析
    console.log(`\n延迟优势分析:`);
    if (totalRestLatencies.length > 0) {
        const restAvg = totalRestLatencies.reduce((a, b) => a + b, 0) / totalRestLatencies.length;
        console.log(`  REST 平均请求耗时: ${restAvg.toFixed(1)} ms`);
        console.log(`  REST 轮询间隔: ${REST_POLL_INTERVAL_MS} ms`);
        console.log(`  REST 平均检测延迟: ${(REST_POLL_INTERVAL_MS / 2 + restAvg).toFixed(1)} ms (轮询间隔/2 + 请求耗时)`);
        console.log(`  WS 优势: 实时推送，无轮询等待`);
        if (totalWsIntervals.length > 0) {
            const wsAvgInterval = totalWsIntervals.reduce((a, b) => a + b, 0) / totalWsIntervals.length;
            console.log(`  WS 平均消息间隔: ${wsAvgInterval.toFixed(1)} ms`);
        }
    }

    console.log('\n测试完成');
}

// ============================================================================
// 入口
// ============================================================================

main().catch((e) => {
    console.error('测试失败:', e);
    process.exit(1);
});
