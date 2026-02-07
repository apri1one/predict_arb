/**
 * Predict WebSocket 订单流测试
 *
 * 测试 Predict WebSocket 订单确认流程：
 * 1. 初始化 PredictOrderWatcher
 * 2. 找一个活跃市场并下小额订单
 * 3. 监控 walletEvents 中的订单状态变化
 * 4. 验证订单确认延迟
 *
 * 用法:
 *   npx tsx src/testing/test-predict-ws-order-flow.ts [marketId]
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import { getPredictTrader } from '../dashboard/predict-trader.js';
import { getOrderWatcher, isUsingPredictWs, type OrderFilledEvent, type IOrderWatcher } from '../services/order-watcher-factory.js';
import { PredictRestClient } from '../predict/rest-client.js';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.PREDICT_API_KEY || '';
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS || '';
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// 最大测试金额（安全限制）
const MAX_ORDER_VALUE = 2.0; // $2

// ============================================================================
// Telegram 通知
// ============================================================================

async function sendTelegram(message: string): Promise<void> {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log('[TG] 未配置 Telegram，跳过发送');
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID,
                text: message,
                parse_mode: 'HTML',
            }),
        });

        if (!res.ok) {
            console.error('[TG] 发送失败:', await res.text());
        }
    } catch (e: any) {
        console.error('[TG] 发送异常:', e.message);
    }
}

// ============================================================================
// 工具函数
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp(): string {
    return new Date().toISOString().slice(11, 23);
}

// ============================================================================
// 主测试
// ============================================================================

async function main(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Predict WebSocket 订单流测试');
    console.log('='.repeat(60));

    if (!API_KEY || !SMART_WALLET) {
        console.error('错误: 缺少环境变量 PREDICT_API_KEY 或 PREDICT_SMART_WALLET_ADDRESS');
        process.exit(1);
    }

    console.log(`\nSmart Wallet: ${SMART_WALLET}`);
    console.log(`Telegram: ${TG_BOT_TOKEN ? '已配置' : '未配置'}`);

    // 发送测试开始通知
    await sendTelegram(`🧪 <b>[测试开始]</b>\nPredict WebSocket 订单流测试`);

    // 记录时间
    const results = {
        placeTime: 0,
        placeLatency: 0,
        wsEventTime: 0,
        wsEventType: '',
        wsLatency: 0,
        orderHash: '',
        filled: false,
    };

    // 1. 初始化 Order Watcher (通过工厂获取)
    console.log('\n[1] 初始化 Order Watcher...');
    let watcher: IOrderWatcher;
    try {
        watcher = await getOrderWatcher();
        if (!watcher.isConnected()) {
            await watcher.start();
        }
        const source = isUsingPredictWs() ? 'Predict WS' : 'BSC WSS';
        console.log(`[${timestamp()}] ✅ Order Watcher 已连接 (${source})`);
    } catch (e: any) {
        console.error(`[${timestamp()}] ❌ Order Watcher 连接失败:`, e.message);
        await sendTelegram(`❌ Order Watcher 连接失败: ${e.message}`);
        process.exit(1);
    }

    // 注册全局订单成交监听
    watcher.on('orderFilled', (event: OrderFilledEvent) => {
        const latency = Date.now() - results.placeTime;
        console.log(`\n[${timestamp()}] 🟠 Predict WS orderFilled 事件!`);
        console.log(`   订单: ${event.orderHash.slice(0, 20)}...`);
        console.log(`   延迟: ${latency}ms`);

        if (results.placeTime > 0 && results.wsEventTime === 0) {
            results.wsEventTime = Date.now();
            results.wsLatency = latency;
            results.wsEventType = event.rawEvent?.type || 'orderFilled';
        }
    });

    // 2. 初始化 trader
    console.log('\n[2] 初始化 PredictTrader...');
    const trader = getPredictTrader();
    await trader.init();
    console.log(`[${timestamp()}] ✅ PredictTrader 已初始化`);

    // 3. 查找市场并下单
    console.log('\n[3] 查找市场...');
    const client = new PredictRestClient({ apiKey: API_KEY });

    const args = process.argv.slice(2);
    const marketIdArg = parseInt(args[0], 10) || undefined;

    let marketId: number | undefined;
    let askPrice: number | undefined;
    let orderQty: number | undefined;

    if (marketIdArg) {
        marketId = marketIdArg;
        const ob = await client.getOrderBook(marketId);
        if (ob.asks?.length > 0) {
            askPrice = ob.asks[0][0];
            orderQty = Math.max(Math.ceil(1.1 / askPrice), 2);
        }
    } else {
        // 查找活跃市场
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
    }

    if (!marketId || !askPrice || !orderQty) {
        console.error('❌ 未找到合适的市场');
        await sendTelegram(`❌ 测试失败: 未找到合适的市场`);
        watcher.stop();
        process.exit(1);
    }

    const orderValue = askPrice * orderQty;
    console.log(`市场: ${marketId}, 价格: ${askPrice}, 数量: ${orderQty}, 价值: $${orderValue.toFixed(2)}`);

    if (orderValue > MAX_ORDER_VALUE) {
        console.log(`⚠️ 订单金额 $${orderValue.toFixed(2)} 超过安全限制 $${MAX_ORDER_VALUE}，跳过`);
        await sendTelegram(`⚠️ 测试跳过: 订单金额超过安全限制`);
        watcher.stop();
        process.exit(0);
    }

    // 4. 注册订单监听
    console.log('\n[4] 准备下单...');

    // 先准备好 watchOrder
    let watchCancel: (() => void) | null = null;
    const watchPromise = new Promise<void>((resolve) => {
        // 预先占位，下单后会更新
        setTimeout(() => {
            if (results.orderHash) {
                watchCancel = watcher.watchOrder(
                    results.orderHash,
                    (event) => {
                        console.log(`\n[${timestamp()}] 🎯 watchOrder 回调触发!`);
                        console.log(`   订单: ${event.orderHash.slice(0, 20)}...`);
                        results.filled = true;
                        resolve();
                    },
                    60000
                );
            }
        }, 100);
    });

    // 5. 下单
    console.log('\n[5] 提交 Taker 订单 (吃单)...');
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
        await sendTelegram(`❌ 下单失败: ${result.error}`);
        watcher.stop();
        process.exit(1);
    }

    console.log(`[${timestamp()}] ✅ 下单成功!`);
    console.log(`   Hash: ${result.hash}`);
    console.log(`   下单延迟: ${results.placeLatency}ms`);

    await sendTelegram(
        `📝 <b>[下单成功]</b>\n\n` +
        `<b>市场:</b> ${marketId}\n` +
        `<b>操作:</b> BUY ${orderQty} YES @ ${askPrice}\n` +
        `<b>价值:</b> $${orderValue.toFixed(2)}\n` +
        `<b>Hash:</b> <code>${result.hash?.slice(0, 20)}...</code>\n` +
        `<b>下单延迟:</b> ${results.placeLatency}ms\n\n` +
        `<i>等待 Predict WS 事件...</i>`
    );

    // 6. 等待 WS 事件
    console.log('\n[6] 等待 Predict WebSocket 事件 (30秒)...');

    // 注册 watchOrder
    if (results.orderHash) {
        watchCancel = watcher.watchOrder(
            results.orderHash,
            (event) => {
                console.log(`\n[${timestamp()}] 🎯 watchOrder 回调触发!`);
                console.log(`   事件类型: ${event.rawEvent?.type}`);
                results.filled = true;
            },
            60000
        );
    }

    await sleep(30000);

    // 7. 汇总结果
    console.log('\n' + '='.repeat(60));
    console.log('测试结果');
    console.log('='.repeat(60));

    console.log(`📝 下单延迟: ${results.placeLatency}ms`);

    if (results.wsEventTime > 0) {
        console.log(`🟠 Predict WS 事件: ${results.wsEventType}`);
        console.log(`   延迟: ${results.wsLatency}ms`);
    } else {
        console.log(`🟠 Predict WS: 未收到事件`);
    }

    console.log(`🎯 订单成交: ${results.filled ? '是' : '否'}`);

    // 发送汇总通知
    await sendTelegram(
        `📊 <b>[测试结果]</b>\n\n` +
        `<b>下单延迟:</b> ${results.placeLatency}ms\n` +
        `<b>Predict WS:</b> ${results.wsEventTime > 0 ? `${results.wsLatency}ms (${results.wsEventType})` : '未收到'}\n` +
        `<b>订单成交:</b> ${results.filled ? '✅ 是' : '❌ 否'}\n\n` +
        `<b>订单Hash:</b> <code>${results.orderHash.slice(0, 20)}...</code>`
    );

    // 清理
    if (watchCancel) watchCancel();
    watcher.stop();

    console.log('\n测试完成!');
    process.exit(0);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
