/**
 * 测试 IOC 订单的 WS 监听
 *
 * IOC 订单会立即尝试成交，未成交部分会被取消
 * 这是 Taker 模式的实际场景
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPolymarketTrader } from '../dashboard/polymarket-trader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

async function main(): Promise<void> {
    console.log('╔════════════════════════════════════════════════════════════════════╗');
    console.log('║       IOC 订单 WS 监听测试                                          ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');

    const trader = getPolymarketTrader();

    // 监听所有 WS 事件
    trader.on('ws:order', (event) => {
        console.log(`   📥 WS: type=${event.type}, size_matched=${event.size_matched || '0'}`);
    });

    console.log('📡 初始化 PolymarketTrader...');
    await trader.init();

    // 获取测试市场
    console.log('\n🔍 获取测试市场...');
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

    // 下一个 IOC 低价订单 (不会成交，会立即被取消)
    console.log('\n📝 下单测试 (IOC, 低价 - 不会成交)...');
    const startTime = Date.now();

    const result = await trader.placeOrder({
        tokenId: testMarket.tokenId,
        side: 'BUY',
        price: 0.01,  // 极低价格，不会成交
        quantity: 500,
        orderType: 'IOC',  // 立即成交或取消
        negRisk: testMarket.negRisk,
    });

    const placeLatency = Date.now() - startTime;
    console.log(`   下单延迟: ${placeLatency}ms`);

    if (!result.success || !result.orderId) {
        console.error(`❌ 下单失败: ${result.error}`);
        process.exit(1);
    }

    console.log(`   ✅ 订单已提交: ${result.orderId.slice(0, 20)}...`);

    // 轮询订单状态
    console.log('\n📊 轮询订单状态...');
    const pollStart = Date.now();
    const status = await trader.pollOrderStatus(result.orderId, 10, 200);
    const pollLatency = Date.now() - pollStart;

    console.log(`   轮询延迟: ${pollLatency}ms`);
    console.log(`   状态: ${status?.status || 'unknown'}`);
    console.log(`   已成交: ${status?.filledQty || 0}`);

    // IOC 订单应该被取消 (因为低价不会成交)
    if (status?.status === 'CANCELLED') {
        console.log('\n✅ IOC 订单正确取消 (预期行为)');
    } else {
        console.log(`\n⚠️ 意外状态: ${status?.status}`);
    }

    console.log('\n' + '='.repeat(70));
    console.log('📋 测试完成');
    console.log('='.repeat(70));

    process.exit(0);
}

main().catch((e) => {
    console.error('测试失败:', e);
    process.exit(1);
});
