/**
 * 测试 PolymarketTrader 的 WS 集成
 *
 * 验证:
 * 1. User WS 自动连接
 * 2. pollOrderStatus 使用 WS 替代 API 轮询
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPolymarketTrader } from '../dashboard/polymarket-trader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

async function main(): Promise<void> {
    console.log('╔════════════════════════════════════════════════════════════════════╗');
    console.log('║       PolymarketTrader WS 集成测试                                  ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');

    // 获取 trader 实例
    const trader = getPolymarketTrader();

    // 监听 WS 事件
    trader.on('ws:order', (event) => {
        console.log(`📥 WS Order Event: type=${event.type}, id=${event.id?.slice(0, 16)}...`);
    });

    trader.on('ws:trade', (event) => {
        console.log(`📥 WS Trade Event: status=${event.status}`);
    });

    // 初始化 (会自动连接 WS)
    console.log('📡 初始化 PolymarketTrader...');
    await trader.init();
    console.log('');

    // 获取一个活跃市场
    console.log('🔍 获取测试市场...');
    const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30');
    const gammaMarkets = await gammaRes.json() as any[];

    let testMarket: { tokenId: string; negRisk: boolean } | null = null;
    for (const m of gammaMarkets) {
        if (m.acceptingOrders && m.enableOrderBook && m.clobTokenIds) {
            let tokens: string[];
            try {
                tokens = JSON.parse(m.clobTokenIds);
            } catch {
                continue;
            }
            if (tokens.length === 0) continue;

            console.log(`   找到市场: ${m.question?.slice(0, 50)}...`);
            testMarket = {
                tokenId: tokens[0],
                negRisk: m.negRisk || false,
            };
            break;
        }
    }

    if (!testMarket) {
        console.error('❌ 无法找到测试市场');
        return;
    }

    // 下一个 GTC 限价单
    console.log('\n📝 下单测试 (GTC, 低价)...');
    const startTime = Date.now();

    const result = await trader.placeOrder({
        tokenId: testMarket.tokenId,
        side: 'BUY',
        price: 0.02,
        quantity: 500,
        orderType: 'GTC',
        negRisk: testMarket.negRisk,
    });

    const placeLatency = Date.now() - startTime;
    console.log(`   下单延迟: ${placeLatency}ms`);

    if (!result.success || !result.orderId) {
        console.error(`❌ 下单失败: ${result.error}`);
        return;
    }

    console.log(`   ✅ 订单已提交: ${result.orderId.slice(0, 20)}...`);

    // 等待一下让 WS 事件有时间到达
    await new Promise(r => setTimeout(r, 1000));

    // 轮询订单状态 (应该使用 WS)
    console.log('\n📊 轮询订单状态 (via WS)...');
    const pollStart = Date.now();
    const status = await trader.pollOrderStatus(result.orderId, 5, 200);
    const pollLatency = Date.now() - pollStart;

    console.log(`   轮询延迟: ${pollLatency}ms`);
    console.log(`   状态: ${status?.status || 'unknown'}, filledQty: ${status?.filledQty || 0}`);

    // 取消订单
    console.log('\n🗑️ 取消订单...');
    const cancelStart = Date.now();
    const cancelled = await trader.cancelOrder(result.orderId, { skipTelegram: true });
    const cancelLatency = Date.now() - cancelStart;

    console.log(`   取消延迟: ${cancelLatency}ms`);
    console.log(`   结果: ${cancelled ? '✅ 成功' : '❌ 失败'}`);

    // 等待 WS 取消事件
    await new Promise(r => setTimeout(r, 1000));

    console.log('\n' + '='.repeat(70));
    console.log('📋 测试完成');
    console.log('='.repeat(70));

    // 退出
    process.exit(0);
}

main().catch((e) => {
    console.error('测试失败:', e);
    process.exit(1);
});
