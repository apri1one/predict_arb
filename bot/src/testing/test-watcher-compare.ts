/**
 * Predict WS vs BSC WSS 延迟对比测试
 *
 * 预先启动两个 watcher，同时监听同一订单，对比事件到达时间
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import { getPredictTrader } from '../dashboard/predict-trader.js';
import { getPredictOrderWatcher } from '../services/predict-order-watcher.js';
import { getBscOrderWatcher } from '../services/bsc-order-watcher.js';
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
    console.log('Predict WS vs BSC WSS 延迟对比测试');
    console.log('='.repeat(60));

    if (!API_KEY || !SMART_WALLET) {
        console.error('错误: 缺少环境变量');
        process.exit(1);
    }

    const results = {
        placeTime: 0,
        placeLatency: 0,
        orderHash: '',
        predictWs: { eventTime: 0, latency: 0, eventType: '' },
        bscWss: { eventTime: 0, latency: 0, eventType: '' },
    };

    // 1. 预先启动两个 watcher
    console.log('\n[1] 预先启动两个 Watcher...');

    // 启动 Predict WS
    console.log('    启动 Predict WS...');
    const predictWatcher = getPredictOrderWatcher(SMART_WALLET);
    const predictStartTime = Date.now();
    await predictWatcher.start();
    console.log(`    ✅ Predict WS 已连接 (${Date.now() - predictStartTime}ms)`);

    // 启动 BSC WSS
    console.log('    启动 BSC WSS...');
    const bscWatcher = getBscOrderWatcher(SMART_WALLET);
    const bscStartTime = Date.now();
    await bscWatcher.start();
    console.log(`    ✅ BSC WSS 已连接 (${Date.now() - bscStartTime}ms)`);

    // 等待订阅稳定
    await sleep(1000);
    console.log('    两个 Watcher 都已就绪\n');

    // 2. 注册全局事件监听
    predictWatcher.on('orderFilled', (event: any) => {
        if (results.predictWs.eventTime === 0 && results.placeTime > 0) {
            results.predictWs.eventTime = Date.now();
            results.predictWs.latency = results.predictWs.eventTime - results.placeTime;
            results.predictWs.eventType = event.rawEvent?.type || event.type || 'orderFilled';
            console.log(`[${timestamp()}] 🟠 Predict WS 事件! 延迟: ${results.predictWs.latency}ms`);
        }
    });

    bscWatcher.on('orderFilled', (event: any) => {
        if (results.bscWss.eventTime === 0 && results.placeTime > 0) {
            results.bscWss.eventTime = Date.now();
            results.bscWss.latency = results.bscWss.eventTime - results.placeTime;
            results.bscWss.eventType = 'OrderFilled (链上)';
            console.log(`[${timestamp()}] 🔵 BSC WSS 事件! 延迟: ${results.bscWss.latency}ms`);
        }
    });

    // 3. 初始化 trader
    console.log('[2] 初始化 PredictTrader...');
    const trader = getPredictTrader();
    await trader.init();
    console.log(`[${timestamp()}] ✅ PredictTrader 已初始化\n`);

    // 4. 查找市场
    console.log('[3] 查找市场...');
    const client = new PredictRestClient({ apiKey: API_KEY });

    let marketId: number | undefined;
    let askPrice: number | undefined;
    let orderQty: number | undefined;

    const matches = await client.getOrderMatches({ limit: 20 });
    const marketIds = [...new Set(matches.map(m => m.market?.id).filter(Boolean))] as number[];

    for (const id of marketIds.slice(0, 10)) {
        try {
            const ob = await client.getOrderBook(id);
            if (ob.asks?.length > 0 && ob.asks[0][0] >= 0.01 && ob.asks[0][0] <= 0.95) {
                marketId = id;
                askPrice = ob.asks[0][0];
                orderQty = Math.max(Math.ceil(1.1 / askPrice), 2);
                break;
            }
        } catch { /* ignore */ }
    }

    if (!marketId || !askPrice || !orderQty) {
        console.error('❌ 未找到合适的市场');
        predictWatcher.stop();
        bscWatcher.stop();
        process.exit(1);
    }

    const orderValue = askPrice * orderQty;
    console.log(`    市场: ${marketId}, 价格: ${askPrice}, 数量: ${orderQty}, 价值: $${orderValue.toFixed(2)}\n`);

    if (orderValue > 2.0) {
        console.log('⚠️ 订单金额超过安全限制，跳过');
        predictWatcher.stop();
        bscWatcher.stop();
        process.exit(0);
    }

    // 5. 注册 watchOrder
    let predictCancel: (() => void) | null = null;
    let bscCancel: (() => void) | null = null;

    // 6. 下单
    console.log('[4] 提交订单...');
    results.placeTime = Date.now();

    const result = await trader.placeOrder({
        marketId,
        side: 'BUY',
        price: askPrice,
        quantity: orderQty,
        outcome: 'YES',
    });

    results.placeLatency = Date.now() - results.placeTime;
    results.orderHash = result.hash || '';

    if (!result.success) {
        console.error(`❌ 下单失败: ${result.error}`);
        predictWatcher.stop();
        bscWatcher.stop();
        process.exit(1);
    }

    console.log(`[${timestamp()}] ✅ 下单成功!`);
    console.log(`    Hash: ${result.hash}`);
    console.log(`    OrderId: ${result.orderId}`);
    console.log(`    下单延迟: ${results.placeLatency}ms\n`);

    // 注册 watchOrder (带 orderId)
    if (results.orderHash) {
        predictCancel = predictWatcher.watchOrder(
            results.orderHash,
            () => {},
            60000,
            result.orderId
        );
        bscCancel = bscWatcher.watchOrder(
            results.orderHash,
            () => {},
            60000
        );
    }

    // 7. 等待事件
    console.log('[5] 等待事件 (30秒)...\n');

    const waitStart = Date.now();
    while (Date.now() - waitStart < 30000) {
        if (results.predictWs.eventTime > 0 && results.bscWss.eventTime > 0) {
            break;
        }
        await sleep(100);
    }

    // 8. 汇总结果
    console.log('\n' + '='.repeat(60));
    console.log('测试结果');
    console.log('='.repeat(60));

    console.log(`\n📝 下单延迟: ${results.placeLatency}ms\n`);

    console.log('事件延迟对比:');
    console.log('┌─────────────┬──────────┬─────────────────────┐');
    console.log('│ 来源        │ 延迟     │ 事件类型            │');
    console.log('├─────────────┼──────────┼─────────────────────┤');

    if (results.predictWs.eventTime > 0) {
        console.log(`│ Predict WS  │ ${String(results.predictWs.latency).padStart(6)}ms │ ${results.predictWs.eventType.padEnd(19)} │`);
    } else {
        console.log('│ Predict WS  │   未收到 │ -                   │');
    }

    if (results.bscWss.eventTime > 0) {
        console.log(`│ BSC WSS     │ ${String(results.bscWss.latency).padStart(6)}ms │ ${results.bscWss.eventType.padEnd(19)} │`);
    } else {
        console.log('│ BSC WSS     │   未收到 │ -                   │');
    }

    console.log('└─────────────┴──────────┴─────────────────────┘');

    if (results.predictWs.eventTime > 0 && results.bscWss.eventTime > 0) {
        const diff = results.predictWs.latency - results.bscWss.latency;
        const faster = diff > 0 ? 'BSC WSS' : 'Predict WS';
        console.log(`\n🏆 ${faster} 更快 ${Math.abs(diff)}ms`);
    }

    // 清理
    if (predictCancel) predictCancel();
    if (bscCancel) bscCancel();
    predictWatcher.stop();
    bscWatcher.stop();

    console.log('\n测试完成!');
    process.exit(0);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
