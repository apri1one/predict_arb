/**
 * 订单簿获取延迟测试
 *
 * 对比 Predict WS 订阅 vs REST API 轮询：
 * - WS 订阅：实时推送订单簿更新
 * - REST 轮询：定期请求订单簿数据
 *
 * 通过下单触发订单簿变化，测量两种方式检测到变化的时间
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import {
    initPredictWsClient,
    getPredictWsClient,
    type OrderbookUpdateData,
} from '../services/predict-ws-client.js';
import { PredictRestClient } from '../predict/rest-client.js';
import { getPredictTrader } from '../dashboard/predict-trader.js';

const API_KEY = process.env.PREDICT_API_KEY || '';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp(): string {
    return new Date().toISOString().slice(11, 23);
}

function formatOrderbook(bids: [number, number][], asks: [number, number][]): string {
    const topBid = bids.length > 0 ? `${bids[0][0]}@${bids[0][1]}` : 'N/A';
    const topAsk = asks.length > 0 ? `${asks[0][0]}@${asks[0][1]}` : 'N/A';
    return `Bid: ${topBid}, Ask: ${topAsk}`;
}

async function main(): Promise<void> {
    console.log('='.repeat(60));
    console.log('订单簿获取延迟测试 (Predict WS vs REST API)');
    console.log('='.repeat(60));

    if (!API_KEY) {
        console.error('错误: 缺少 PREDICT_API_KEY');
        process.exit(1);
    }

    const restClient = new PredictRestClient({ apiKey: API_KEY });

    // 1. 查找活跃市场
    console.log('\n[1] 查找活跃市场...');
    const matches = await restClient.getOrderMatches({ limit: 20 });
    const marketIds = [...new Set(matches.map(m => m.market?.id).filter(Boolean))] as number[];

    let marketId: number | undefined;
    for (const id of marketIds.slice(0, 5)) {
        try {
            const ob = await restClient.getOrderBook(id);
            if (ob.bids?.length > 0 && ob.asks?.length > 0) {
                marketId = id;
                console.log(`    选择市场: ${id}`);
                console.log(`    当前订单簿: ${formatOrderbook(ob.bids, ob.asks)}`);
                break;
            }
        } catch { /* ignore */ }
    }

    if (!marketId) {
        console.error('❌ 未找到活跃市场');
        process.exit(1);
    }

    // 2. 初始化 WS 客户端
    console.log('\n[2] 初始化 Predict WS...');
    const wsClient = initPredictWsClient({ apiKey: API_KEY });
    await wsClient.connect();
    console.log(`[${timestamp()}] ✅ WS 已连接`);

    // 3. 订阅订单簿
    console.log('\n[3] 订阅订单簿...');

    const wsUpdates: { time: number; data: OrderbookUpdateData }[] = [];
    const restUpdates: { time: number; bids: [number, number][]; asks: [number, number][] }[] = [];

    let wsLastUpdate = '';
    let restLastUpdate = '';

    const wsCallback = (data: OrderbookUpdateData) => {
        const now = Date.now();
        const key = `${data.bids[0]?.[0]}-${data.asks[0]?.[0]}`;
        if (key !== wsLastUpdate) {
            wsLastUpdate = key;
            wsUpdates.push({ time: now, data });
            console.log(`[${timestamp()}] 🟠 WS 更新: ${formatOrderbook(data.bids, data.asks)}`);
        }
    };

    const success = await wsClient.subscribeOrderbook(marketId, wsCallback);
    if (!success) {
        console.error('❌ 订阅失败');
        wsClient.disconnect();
        process.exit(1);
    }
    console.log(`[${timestamp()}] ✅ 已订阅市场 ${marketId}`);

    // 4. 初始化 Trader 用于下单触发订单簿变化
    console.log('\n[4] 初始化 Trader...');
    const trader = getPredictTrader();
    await trader.init();
    console.log(`[${timestamp()}] ✅ Trader 已初始化`);

    // 获取当前订单簿找一个合适的挂单价格
    const currentOb = await restClient.getOrderBook(marketId);
    const bidPrice = currentOb.bids.length > 0
        ? Math.max(0.01, currentOb.bids[0][0] - 0.02)  // 比最高 bid 低 2 分
        : 0.05;
    const orderQty = Math.max(15, Math.ceil(1.0 / bidPrice));

    console.log(`    挂单价格: ${bidPrice}, 数量: ${orderQty}`);

    // 5. 下单并测量订单簿更新延迟
    console.log('\n[5] 下单测试订单簿更新延迟...');
    console.log('    WS: 订阅推送');
    console.log('    REST: 每 100ms 轮询一次\n');

    let wsDetectTime = 0;
    let restDetectTime = 0;
    let placeTime = 0;
    const targetBidPrice = bidPrice;

    // 记录下单前的订单簿状态（用于检测变化）
    const initialBidKeys = new Set(currentOb.bids.map(b => `${b[0]}-${b[1]}`));

    // 更新 WS 回调以检测订单簿变化（新增我们的订单）
    const detectCallback = (data: OrderbookUpdateData) => {
        if (wsDetectTime > 0 || placeTime === 0) return;  // 已检测到 或 还没下单

        // 检查是否包含我们的挂单价格（且是新增的）
        for (const bid of data.bids) {
            const bidKey = `${bid[0]}-${bid[1]}`;
            if (Math.abs(bid[0] - targetBidPrice) < 0.001 && !initialBidKeys.has(bidKey)) {
                wsDetectTime = Date.now();
                console.log(`[${timestamp()}] 🟠 WS 检测到挂单! 延迟: ${wsDetectTime - placeTime}ms`);
                console.log(`    ${formatOrderbook(data.bids.slice(0, 5), data.asks.slice(0, 3))}`);
                break;
            }
        }
    };

    // 替换回调
    await wsClient.unsubscribeOrderbook(marketId, wsCallback);
    await wsClient.subscribeOrderbook(marketId, detectCallback);

    // 启动 REST 轮询
    const pollInterval = 100;  // 更频繁的轮询
    let polling = true;

    const pollLoop = async () => {
        while (polling && restDetectTime === 0) {
            if (placeTime === 0) {
                await sleep(pollInterval);
                continue;  // 还没下单，继续等待
            }

            try {
                const pollStart = Date.now();
                const ob = await restClient.getOrderBook(marketId!);
                const pollEnd = Date.now();

                // 检查是否包含我们的挂单价格（且是新增的）
                for (const bid of ob.bids) {
                    const bidKey = `${bid[0]}-${bid[1]}`;
                    if (Math.abs(bid[0] - targetBidPrice) < 0.001 && !initialBidKeys.has(bidKey)) {
                        restDetectTime = pollEnd;
                        console.log(`[${timestamp()}] 🔵 REST 检测到挂单! 延迟: ${restDetectTime - placeTime}ms (请求耗时: ${pollEnd - pollStart}ms)`);
                        console.log(`    ${formatOrderbook(ob.bids.slice(0, 5), ob.asks.slice(0, 3))}`);
                        break;
                    }
                }
            } catch (e: any) {
                // ignore
            }
            await sleep(pollInterval);
        }
    };

    // 开始轮询
    const pollPromise = pollLoop();

    // 下单
    await sleep(500);  // 确保轮询已启动
    console.log(`[${timestamp()}] 📤 下单中...`);
    placeTime = Date.now();

    const result = await trader.placeOrder({
        marketId: marketId!,
        side: 'BUY',
        price: bidPrice,
        quantity: orderQty,
        outcome: 'YES',
    });

    const placeLatency = Date.now() - placeTime;
    console.log(`[${timestamp()}] ✅ 下单完成 (API: ${placeLatency}ms), hash: ${result.hash?.slice(0, 20)}...`);

    // 等待检测（最多 10 秒）
    const waitStart = Date.now();
    while (Date.now() - waitStart < 10000 && (wsDetectTime === 0 || restDetectTime === 0)) {
        await sleep(100);
    }

    polling = false;
    await pollPromise;

    // 取消订单
    if (result.hash) {
        console.log(`\n[${timestamp()}] 取消测试订单...`);
        await trader.cancelOrder(result.hash);
    }

    // 6. 分析结果
    console.log('\n' + '='.repeat(60));
    console.log('测试结果');
    console.log('='.repeat(60));

    console.log('\n┌─────────────────┬───────────┐');
    console.log('│ 方式            │ 检测延迟  │');
    console.log('├─────────────────┼───────────┤');
    console.log(`│ API 下单响应    │ ${String(placeLatency).padStart(7)}ms │`);
    console.log(`│ Predict WS 推送 │ ${wsDetectTime > 0 ? String(wsDetectTime - placeTime).padStart(7) + 'ms' : '   未检测'} │`);
    console.log(`│ REST API 轮询   │ ${restDetectTime > 0 ? String(restDetectTime - placeTime).padStart(7) + 'ms' : '   未检测'} │`);
    console.log('└─────────────────┴───────────┘');

    if (wsDetectTime > 0 && restDetectTime > 0) {
        const diff = restDetectTime - wsDetectTime;
        if (diff > 0) {
            console.log(`\n🏆 Predict WS 比 REST 轮询快 ${diff}ms`);
        } else {
            console.log(`\n🏆 REST 轮询比 Predict WS 快 ${Math.abs(diff)}ms`);
        }
    }

    // 清理
    await wsClient.unsubscribeOrderbook(marketId, detectCallback);
    wsClient.disconnect();

    console.log('\n测试完成!');
    process.exit(0);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
