/**
 * 订单簿变化检测延迟对比测试
 *
 * 测试方法:
 * 1. 同时监控多个活跃市场
 * 2. WS 订阅 + REST 高频轮询同时进行
 * 3. 检测任何订单簿变化（价格、数量、深度）
 * 4. 比较 WS 和 REST 谁先检测到变化
 *
 * 用法:
 *   npx tsx src/testing/test-orderbook-change-latency.ts [marketIds]
 *   npx tsx src/testing/test-orderbook-change-latency.ts 874,1186,521
 *   npx tsx src/testing/test-orderbook-change-latency.ts         # 自动选择活跃市场
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import { PredictWsClient, OrderbookUpdateData } from '../services/predict-ws-client.js';
import { PredictRestClient } from '../predict/rest-client.js';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.PREDICT_API_KEY || '';
const TEST_DURATION_MS = 120000; // 测试 2 分钟
const REST_POLL_INTERVAL_MS = 100; // REST 高频轮询 100ms
const MAX_MARKETS = 5; // 同时监控的市场数

// ============================================================================
// 类型定义
// ============================================================================

interface OrderbookState {
    hash: string; // 订单簿状态哈希（用于快速比较）
    bestBid: number | null;
    bestBsk: number | null;
    bidQty: number | null; // 最优买价数量
    askQty: number | null; // 最优卖价数量
    bidDepth: number;
    askDepth: number;
    timestamp: number;
}

interface ChangeEvent {
    marketId: number;
    changeType: string; // 'bid_price', 'ask_price', 'bid_qty', 'ask_qty', 'depth'
    oldValue: string;
    newValue: string;
    wsDetectTime: number | null;
    restDetectTime: number | null;
}

// ============================================================================
// 工具函数
// ============================================================================

function computeHash(data: { bids: [number, number][]; asks: [number, number][] }): string {
    // 只用前 5 档计算哈希，足够检测变化
    const bidPart = data.bids.slice(0, 5).map(b => `${b[0]}:${b[1]}`).join(',');
    const askPart = data.asks.slice(0, 5).map(a => `${a[0]}:${a[1]}`).join(',');
    return `${bidPart}|${askPart}`;
}

function getState(data: { bids: [number, number][]; asks: [number, number][] }): OrderbookState {
    return {
        hash: computeHash(data),
        bestBid: data.bids[0]?.[0] ?? null,
        bestBsk: data.asks[0]?.[0] ?? null,
        bidQty: data.bids[0]?.[1] ?? null,
        askQty: data.asks[0]?.[1] ?? null,
        bidDepth: data.bids.length,
        askDepth: data.asks.length,
        timestamp: Date.now(),
    };
}

function formatPrice(p: number | null): string {
    return p === null ? 'N/A' : p.toFixed(4);
}

// ============================================================================
// 主测试
// ============================================================================

async function main(): Promise<void> {
    console.log('='.repeat(70));
    console.log('订单簿变化检测延迟对比 (WS vs REST) - 多市场版');
    console.log('='.repeat(70));

    if (!API_KEY) {
        console.error('错误: 缺少 PREDICT_API_KEY');
        process.exit(1);
    }

    const restClient = new PredictRestClient({ apiKey: API_KEY });

    // 确定测试市场
    let marketIds: number[] = [];
    const arg = process.argv[2];

    if (arg) {
        marketIds = arg.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    }

    if (marketIds.length === 0) {
        console.log('\n正在查找活跃市场...');
        try {
            const matches = await restClient.getOrderMatches({ limit: 200 });

            // 统计每个市场的交易次数
            const marketCounts = new Map<number, number>();
            for (const match of matches) {
                if (match.market?.id) {
                    marketCounts.set(match.market.id, (marketCounts.get(match.market.id) || 0) + 1);
                }
            }

            // 按交易次数排序，选择最活跃的
            const sorted = Array.from(marketCounts.entries()).sort((a, b) => b[1] - a[1]);
            marketIds = sorted.slice(0, MAX_MARKETS).map(([id]) => id);

            console.log('活跃市场:');
            for (const [id, count] of sorted.slice(0, MAX_MARKETS)) {
                console.log(`  市场 ${id}: ${count} 笔交易`);
            }
        } catch (e: any) {
            console.error('获取活跃市场失败:', e?.message);
            process.exit(1);
        }
    }

    if (marketIds.length === 0) {
        console.error('未找到活跃市场');
        process.exit(1);
    }

    console.log(`\n测试市场: ${marketIds.join(', ')}`);
    console.log(`测试时长: ${TEST_DURATION_MS / 1000} 秒`);
    console.log(`REST 轮询间隔: ${REST_POLL_INTERVAL_MS} ms`);

    // 每个市场的状态追踪
    const wsStates = new Map<number, OrderbookState | null>();
    const restStates = new Map<number, OrderbookState | null>();
    const allChanges: ChangeEvent[] = [];

    // 统计
    let wsUpdateCount = 0;
    let restCallCount = 0;

    // 待匹配的变化
    // key: marketId:hash, value: { wsTime, restTime }
    const pendingChanges = new Map<string, { wsTime: number | null; restTime: number | null; changeType: string }>();

    // 处理变化检测
    function detectChange(marketId: number, newState: OrderbookState, oldState: OrderbookState | null, source: 'ws' | 'rest'): void {
        if (!oldState) return;
        if (newState.hash === oldState.hash) return;

        const now = Date.now();
        const changeKey = `${marketId}:${newState.hash}`;

        // 确定变化类型
        let changeType = 'orderbook';
        if (newState.bestBid !== oldState.bestBid) changeType = 'bid_price';
        else if (newState.bestBsk !== oldState.bestBsk) changeType = 'ask_price';
        else if (newState.bidQty !== oldState.bidQty) changeType = 'bid_qty';
        else if (newState.askQty !== oldState.askQty) changeType = 'ask_qty';
        else changeType = 'depth';

        const pending = pendingChanges.get(changeKey);

        if (!pending) {
            // 首次检测到这个变化
            pendingChanges.set(changeKey, {
                wsTime: source === 'ws' ? now : null,
                restTime: source === 'rest' ? now : null,
                changeType,
            });
        } else {
            // 另一方也检测到了
            if (source === 'ws' && pending.wsTime === null) {
                pending.wsTime = now;
            } else if (source === 'rest' && pending.restTime === null) {
                pending.restTime = now;
            }

            // 如果双方都检测到了，记录结果
            if (pending.wsTime !== null && pending.restTime !== null) {
                allChanges.push({
                    marketId,
                    changeType: pending.changeType,
                    oldValue: oldState.hash.slice(0, 30),
                    newValue: newState.hash.slice(0, 30),
                    wsDetectTime: pending.wsTime,
                    restDetectTime: pending.restTime,
                });
                pendingChanges.delete(changeKey);
            }
        }
    }

    // 创建 WebSocket 客户端
    const wsClient = new PredictWsClient({ apiKey: API_KEY, autoReconnect: true });

    console.log('\n正在连接 WebSocket...');
    await wsClient.connect();
    console.log('WebSocket 连接成功');

    // 订阅所有市场
    console.log(`正在订阅 ${marketIds.length} 个市场...`);
    for (const marketId of marketIds) {
        wsStates.set(marketId, null);
        restStates.set(marketId, null);

        const success = await wsClient.subscribeOrderbook(marketId, (data: OrderbookUpdateData) => {
            wsUpdateCount++;
            const newState = getState(data);
            const oldState = wsStates.get(marketId) ?? null;
            detectChange(marketId, newState, oldState, 'ws');
            wsStates.set(marketId, newState);
        });

        if (success) {
            console.log(`  ✓ 市场 ${marketId} 订阅成功`);
        } else {
            console.log(`  ✗ 市场 ${marketId} 订阅失败`);
        }
    }

    // 获取初始 REST 状态
    for (const marketId of marketIds) {
        try {
            const book = await restClient.getOrderBook(marketId);
            restStates.set(marketId, getState(book));
        } catch (e) {
            // ignore
        }
    }

    // REST 高频轮询
    console.log('\n开始测试...');
    console.log('(等待订单簿变化，按 Ctrl+C 提前结束)\n');

    const startTime = Date.now();
    let lastProgressTime = startTime;
    let marketIndex = 0;

    const restPollTimer = setInterval(async () => {
        // 轮询方式：轮流请求每个市场（避免同时请求造成延迟）
        const marketId = marketIds[marketIndex % marketIds.length];
        marketIndex++;

        restCallCount++;
        try {
            const book = await restClient.getOrderBook(marketId);
            const newState = getState(book);
            const oldState = restStates.get(marketId) ?? null;
            detectChange(marketId, newState, oldState, 'rest');
            restStates.set(marketId, newState);
        } catch (e) {
            // ignore
        }

        // 每 5 秒打印进度
        const now = Date.now();
        if (now - lastProgressTime >= 5000) {
            lastProgressTime = now;
            const elapsed = Math.floor((now - startTime) / 1000);
            const wsFirst = allChanges.filter(c => c.wsDetectTime! < c.restDetectTime!).length;
            const restFirst = allChanges.filter(c => c.restDetectTime! < c.wsDetectTime!).length;
            const same = allChanges.filter(c => c.wsDetectTime === c.restDetectTime).length;
            console.log(`[${elapsed}s] WS更新=${wsUpdateCount}, REST调用=${restCallCount}, 变化: ${allChanges.length} (WS先=${wsFirst}, REST先=${restFirst}, 同时=${same}), 待匹配=${pendingChanges.size}`);
        }
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

    console.log(`\n测试市场: ${marketIds.join(', ')}`);
    console.log(`测试时长: ${TEST_DURATION_MS / 1000} 秒`);

    console.log(`\n数据统计:`);
    console.log(`  WS 总更新次数: ${wsUpdateCount}`);
    console.log(`  REST 总调用次数: ${restCallCount}`);
    console.log(`  WS 平均更新频率: ${(wsUpdateCount / (TEST_DURATION_MS / 1000)).toFixed(2)} 次/秒`);

    console.log(`\n变化检测:`);
    console.log(`  双方都检测到的变化: ${allChanges.length} 次`);
    console.log(`  仅 WS 检测到（REST 未确认）: ${Array.from(pendingChanges.values()).filter(p => p.wsTime !== null && p.restTime === null).length} 次`);
    console.log(`  仅 REST 检测到（WS 未确认）: ${Array.from(pendingChanges.values()).filter(p => p.restTime !== null && p.wsTime === null).length} 次`);

    if (allChanges.length === 0) {
        console.log('\n⚠️  测试期间未检测到可比较的变化');
        console.log('   可能原因:');
        console.log('   1. 市场在测试期间不够活跃');
        console.log('   2. WS 和 REST 检测到的变化不同步');
        console.log('   建议: 在交易高峰期重新测试');

        // 打印待匹配的变化
        if (pendingChanges.size > 0) {
            console.log(`\n待匹配的变化 (${pendingChanges.size} 个):`);
            let count = 0;
            for (const [key, value] of pendingChanges) {
                if (count++ >= 10) {
                    console.log(`  ... 还有 ${pendingChanges.size - 10} 个`);
                    break;
                }
                const source = value.wsTime !== null ? 'WS' : 'REST';
                console.log(`  ${key.slice(0, 20)}... 由 ${source} 检测到 (${value.changeType})`);
            }
        }

        process.exit(0);
    }

    // 分析结果
    const wsFirstChanges = allChanges.filter(c => c.wsDetectTime! < c.restDetectTime!);
    const restFirstChanges = allChanges.filter(c => c.restDetectTime! < c.wsDetectTime!);
    const sameTimeChanges = allChanges.filter(c => c.wsDetectTime === c.restDetectTime);

    console.log(`\n先检测到变化的统计:`);
    console.log(`  WS 先检测到: ${wsFirstChanges.length} 次 (${(wsFirstChanges.length / allChanges.length * 100).toFixed(1)}%)`);
    console.log(`  REST 先检测到: ${restFirstChanges.length} 次 (${(restFirstChanges.length / allChanges.length * 100).toFixed(1)}%)`);
    console.log(`  同时检测到: ${sameTimeChanges.length} 次 (${(sameTimeChanges.length / allChanges.length * 100).toFixed(1)}%)`);

    // 延迟分析
    if (wsFirstChanges.length > 0) {
        const advantages = wsFirstChanges.map(c => c.restDetectTime! - c.wsDetectTime!);
        const sorted = [...advantages].sort((a, b) => a - b);
        const avg = advantages.reduce((a, b) => a + b, 0) / advantages.length;
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const p50 = sorted[Math.floor(sorted.length * 0.5)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];

        console.log(`\nWS 领先 REST 的延迟统计:`);
        console.log(`  最小: ${min} ms`);
        console.log(`  平均: ${avg.toFixed(1)} ms`);
        console.log(`  中位数 (P50): ${p50} ms`);
        console.log(`  P95: ${p95} ms`);
        console.log(`  最大: ${max} ms`);
    }

    if (restFirstChanges.length > 0) {
        const advantages = restFirstChanges.map(c => c.wsDetectTime! - c.restDetectTime!);
        const sorted = [...advantages].sort((a, b) => a - b);
        const avg = advantages.reduce((a, b) => a + b, 0) / advantages.length;
        const min = sorted[0];
        const max = sorted[sorted.length - 1];

        console.log(`\nREST 领先 WS 的延迟统计:`);
        console.log(`  最小: ${min} ms`);
        console.log(`  平均: ${avg.toFixed(1)} ms`);
        console.log(`  最大: ${max} ms`);
    }

    // 按变化类型统计
    const changeTypes = new Map<string, { wsFirst: number; restFirst: number }>();
    for (const change of allChanges) {
        const type = change.changeType;
        if (!changeTypes.has(type)) {
            changeTypes.set(type, { wsFirst: 0, restFirst: 0 });
        }
        const stat = changeTypes.get(type)!;
        if (change.wsDetectTime! < change.restDetectTime!) {
            stat.wsFirst++;
        } else if (change.restDetectTime! < change.wsDetectTime!) {
            stat.restFirst++;
        }
    }

    console.log(`\n按变化类型统计:`);
    for (const [type, stat] of changeTypes) {
        const total = stat.wsFirst + stat.restFirst;
        if (total > 0) {
            console.log(`  ${type}: WS先=${stat.wsFirst} (${(stat.wsFirst / total * 100).toFixed(0)}%), REST先=${stat.restFirst} (${(stat.restFirst / total * 100).toFixed(0)}%)`);
        }
    }

    // 总结
    console.log('\n');
    console.log('='.repeat(70));
    console.log('结论');
    console.log('='.repeat(70));

    const totalComparable = wsFirstChanges.length + restFirstChanges.length;
    if (totalComparable > 0) {
        const wsWinRate = (wsFirstChanges.length / totalComparable * 100).toFixed(0);
        const restWinRate = (restFirstChanges.length / totalComparable * 100).toFixed(0);

        if (wsFirstChanges.length > restFirstChanges.length) {
            const avgLead = wsFirstChanges.length > 0
                ? (wsFirstChanges.map(c => c.restDetectTime! - c.wsDetectTime!).reduce((a, b) => a + b, 0) / wsFirstChanges.length).toFixed(0)
                : '0';
            console.log(`\n✅ WebSocket 在 ${wsWinRate}% 的变化中先检测到`);
            console.log(`   平均领先 REST ${avgLead} ms`);
        } else if (restFirstChanges.length > wsFirstChanges.length) {
            const avgLead = restFirstChanges.length > 0
                ? (restFirstChanges.map(c => c.wsDetectTime! - c.restDetectTime!).reduce((a, b) => a + b, 0) / restFirstChanges.length).toFixed(0)
                : '0';
            console.log(`\n⚠️  REST 在 ${restWinRate}% 的变化中先检测到`);
            console.log(`   平均领先 WS ${avgLead} ms`);
            console.log(`   可能原因: Predict WS 采用周期性快照推送，而非实时增量推送`);
        } else {
            console.log(`\n两者表现相当 (WS: ${wsWinRate}%, REST: ${restWinRate}%)`);
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
