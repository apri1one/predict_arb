/**
 * 非链上事件延迟测试
 *
 * 测试 Predict WS 对非链上事件的响应延迟：
 * - ORDER_ACCEPTED (挂单接受)
 * - ORDER_CANCELLED (订单取消)
 *
 * 对比 REST API 轮询
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import { getPredictTrader } from '../dashboard/predict-trader.js';
import { getPredictOrderWatcher } from '../services/predict-order-watcher.js';
import { getPredictWsClient, type WalletEventData } from '../services/predict-ws-client.js';
import { PredictRestClient } from '../predict/rest-client.js';

const API_KEY = process.env.PREDICT_API_KEY || '';
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS || '';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp(): string {
    return new Date().toISOString().slice(11, 23);
}

async function main(): Promise<void> {
    console.log('='.repeat(60));
    console.log('非链上事件延迟测试 (Predict WS vs REST)');
    console.log('='.repeat(60));

    if (!API_KEY || !SMART_WALLET) {
        console.error('错误: 缺少环境变量');
        process.exit(1);
    }

    // 1. 启动 Predict WS
    console.log('\n[1] 启动 Predict WS...');
    const watcher = getPredictOrderWatcher(SMART_WALLET);
    const wsStartTime = Date.now();
    await watcher.start();
    console.log(`    ✅ Predict WS 已连接 (${Date.now() - wsStartTime}ms)\n`);

    // 2. 初始化 trader 和 REST client
    console.log('[2] 初始化 Trader 和 REST Client...');
    const trader = getPredictTrader();
    await trader.init();
    const restClient = new PredictRestClient({ apiKey: API_KEY });
    const traderJwt = (trader as any).jwt as string | undefined;
    const traderJwtExpiresAt = (trader as any).jwtExpiresAt as Date | undefined;
    if (traderJwt && traderJwtExpiresAt) {
        restClient.setJwtToken(traderJwt, traderJwtExpiresAt);
    } else {
        console.log('[WARN] Missing trader JWT; REST auth calls may fail.');
    }
    console.log(`[${timestamp()}] ✅ 初始化完成\n`);

    // 3. 查找市场（选择一个不太可能立即成交的价格）
    console.log('[3] 查找市场...');
    const matches = await restClient.getOrderMatches({ limit: 20 });
    const marketIds = [...new Set(matches.map(m => m.market?.id).filter(Boolean))] as number[];

    let marketId: number | undefined;
    let bidPrice: number | undefined;

    for (const id of marketIds.slice(0, 10)) {
        try {
            const ob = await restClient.getOrderBook(id);
            // 找一个有 bid 的市场，我们用低于 bid 的价格挂单（不会成交）
            if (ob.bids?.length > 0 && ob.bids[0][0] >= 0.05) {
                marketId = id;
                // 用比最高 bid 低很多的价格，确保不会成交
                bidPrice = Math.max(0.01, ob.bids[0][0] - 0.05);
                break;
            }
        } catch { /* ignore */ }
    }

    if (!marketId || !bidPrice) {
        console.error('❌ 未找到合适的市场');
        watcher.stop();
        process.exit(1);
    }

    console.log(`    市场: ${marketId}, 挂单价格: ${bidPrice} (确保不成交)\n`);

    // ========================================
    // 测试 1: ORDER_ACCEPTED 延迟
    // ========================================
    console.log('='.repeat(60));
    console.log('测试 1: ORDER_ACCEPTED (挂单接受) 延迟');
    console.log('='.repeat(60));

    let orderHash = '';
    let orderId = '';
    let placeTime = 0;
    let wsAcceptedTime = 0;
    let restAcceptedTime = 0;

    // 监听 WS 事件 - 使用底层 ws client 监听所有 walletEvent
    const wsClient = getPredictWsClient();
    if (!wsClient) {
        console.error('❌ 无法获取 WS Client');
        watcher.stop();
        process.exit(1);
    }

    const acceptHandler = (event: WalletEventData) => {
        console.log(`[${timestamp()}] 📥 WS 事件: type=${event.type}, orderId=${event.orderId}, hash=${event.orderHash?.slice(0, 16) || 'N/A'}`);

        // 匹配 orderHash 或 orderId
        const matchByHash = event.orderHash && orderHash && event.orderHash.toLowerCase() === orderHash.toLowerCase();
        const matchById = event.orderId && orderId && event.orderId === orderId;

        if (matchByHash || matchById) {
            if (event.type === 'ORDER_ACCEPTED') {
                if (wsAcceptedTime === 0) {
                    wsAcceptedTime = Date.now();
                    console.log(`[${timestamp()}] 🟠 WS ORDER_ACCEPTED 匹配! 延迟: ${wsAcceptedTime - placeTime}ms`);
                }
            }
        }
    };
    wsClient.on('walletEvent', acceptHandler);

    // 下挂单
    console.log('\n下挂单...');
    placeTime = Date.now();
    const placeResult = await trader.placeOrder({
        marketId,
        side: 'BUY',
        price: bidPrice,
        quantity: Math.max(15, Math.ceil(1.0 / bidPrice)),  // 确保 > $0.9 最小订单
        outcome: 'YES',
    });

    const placeLatency = Date.now() - placeTime;
    orderHash = placeResult.hash || '';
    orderId = placeResult.orderId ? String(placeResult.orderId).replace(/n$/, '') : '';

    if (!placeResult.success) {
        console.error(`❌ 下单失败: ${placeResult.error}`);
        watcher.stop();
        process.exit(1);
    }

    console.log(`[${timestamp()}] ✅ 下单成功 (${placeLatency}ms)`);
    console.log(`    Hash: ${orderHash}`);
    console.log(`    OrderId: ${orderId}\n`);

    // REST 轮询检测订单状态
    // REST polling for order status
    console.log('REST polling for order status...');
    const restPollStart = Date.now();
    for (let i = 0; i < 20; i++) {
        try {
            const order = await restClient.getOrder(orderHash);
            if (order) {
                const orderIdFromRest = (order as any).id ?? (order as any).orderId ?? '';
                if (!orderId && orderIdFromRest) {
                    orderId = String(orderIdFromRest).replace(/n$/, '');
                    console.log(`[${timestamp()}] REST orderId: ${orderId}`);
                }
                restAcceptedTime = Date.now();
                console.log(`[${timestamp()}] REST status: ${order.status} (${restAcceptedTime - placeTime}ms)`);
                break;
            }
        } catch { /* ignore */ }
        await sleep(200);
    }

    // Wait for WS event (max 10s)
    const wsWaitStart = Date.now();
    while (wsAcceptedTime === 0 && Date.now() - wsWaitStart < 10000) {
        await sleep(100);
    }

    wsClient.removeListener('walletEvent', acceptHandler);

    console.log('\nORDER_ACCEPTED latency:');
    console.log(`    Place latency (API): ${placeLatency}ms`);
    if (wsAcceptedTime > 0) {
        console.log(`    Predict WS: ${wsAcceptedTime - placeTime}ms`);
    } else {
        console.log('    Predict WS: not received (10s)');
    }
    if (restAcceptedTime > 0) {
        console.log(`    REST: ${restAcceptedTime - placeTime}ms`);
    } else {
        console.log('    REST: not detected');
    }

    // ========================================
    // Test 2: ORDER_CANCELLED latency
    // ========================================
    console.log('\n' + '='.repeat(60));
    console.log('Test 2: ORDER_CANCELLED latency');
    console.log('='.repeat(60));

    let cancelTime = 0;
    let wsCancelledTime = 0;
    let restCancelledTime = 0;

    const cancelHandler = (event: WalletEventData) => {
        console.log(`[${timestamp()}] WS event: type=${event.type}, orderId=${event.orderId}, hash=${event.orderHash?.slice(0, 16) || 'N/A'}`);
        const matchByHash = event.orderHash && orderHash && event.orderHash.toLowerCase() === orderHash.toLowerCase();
        const matchById = event.orderId && orderId && event.orderId === orderId;
        if (matchByHash || matchById) {
            if (event.type === 'ORDER_CANCELLED') {
                if (wsCancelledTime === 0) {
                    wsCancelledTime = Date.now();
                    console.log(`[${timestamp()}] WS ORDER_CANCELLED matched: ${wsCancelledTime - cancelTime}ms`);
                }
            }
        }
    };
    wsClient.on('walletEvent', cancelHandler);

    console.log('\nCancelling order...');
    cancelTime = Date.now();
    const cancelResult = await trader.cancelOrder(orderHash);
    const cancelLatency = Date.now() - cancelTime;
    if (!cancelResult.success) {
        console.error(`Cancel failed: ${cancelResult.error}`);
    } else {
        console.log(`[${timestamp()}] Cancel OK (API: ${cancelLatency}ms)`);
    }

    console.log('REST polling for cancel status...');
    for (let i = 0; i < 20; i++) {
        try {
            const order = await restClient.getOrder(orderHash);
            if (order) {
                const orderIdFromRest = (order as any).id ?? (order as any).orderId ?? '';
                if (!orderId && orderIdFromRest) {
                    orderId = String(orderIdFromRest).replace(/n$/, '');
                    console.log(`[${timestamp()}] REST orderId: ${orderId}`);
                }
            }
            if (order && (order.status === 'CANCELLED' || order.status === 'DEAD')) {
                restCancelledTime = Date.now();
                console.log(`[${timestamp()}] REST status: ${order.status} (${restCancelledTime - cancelTime}ms)`);
                break;
            }
        } catch { /* ignore */ }
        await sleep(200);
    }

    const wsCancelWaitStart = Date.now();
    while (wsCancelledTime === 0 && Date.now() - wsCancelWaitStart < 10000) {
        await sleep(100);
    }

    wsClient.removeListener('walletEvent', cancelHandler);

    console.log('\nORDER_CANCELLED latency:');
    console.log(`    Cancel latency (API): ${cancelLatency}ms`);
    if (wsCancelledTime > 0) {
        console.log(`    Predict WS: ${wsCancelledTime - cancelTime}ms`);
    } else {
        console.log('    Predict WS: not received (10s)');
    }
    if (restCancelledTime > 0) {
        console.log(`    REST: ${restCancelledTime - cancelTime}ms`);
    } else {
        console.log('    REST: not detected');
    }
    console.log('\n' + '='.repeat(60));
    console.log('汇总');
    console.log('='.repeat(60));

    console.log('\n┌────────────────────┬───────────┬───────────┬───────────┐');
    console.log('│ 事件               │ API 响应  │ WS 事件   │ REST 轮询 │');
    console.log('├────────────────────┼───────────┼───────────┼───────────┤');
    console.log(`│ ORDER_ACCEPTED     │ ${String(placeLatency).padStart(7)}ms │ ${wsAcceptedTime > 0 ? String(wsAcceptedTime - placeTime).padStart(7) + 'ms' : '   未收到'} │ ${restAcceptedTime > 0 ? String(restAcceptedTime - placeTime).padStart(7) + 'ms' : '   未收到'} │`);
    console.log(`│ ORDER_CANCELLED    │ ${String(cancelLatency).padStart(7)}ms │ ${wsCancelledTime > 0 ? String(wsCancelledTime - cancelTime).padStart(7) + 'ms' : '   未收到'} │ ${restCancelledTime > 0 ? String(restCancelledTime - cancelTime).padStart(7) + 'ms' : '   未收到'} │`);
    console.log('└────────────────────┴───────────┴───────────┴───────────┘');

    // 清理
    watcher.stop();

    console.log('\n测试完成!');
    process.exit(0);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
