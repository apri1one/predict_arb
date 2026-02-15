/**
 * Polymarket 下单测试 - 小额限价单测试
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { PolymarketTrader } from '../dashboard/polymarket-trader.js';

async function main() {
    console.log('=== Polymarket 下单测试 ===\n');

    const trader = new PolymarketTrader();
    await trader.init();

    // 1. 获取余额
    const balance = await trader.getBalance();
    console.log(`💰 当前余额: $${balance.toFixed(2)} USDC\n`);

    if (false && balance < 1) { // 跳过余额检查
        console.log('❌ 余额不足，无法测试');
        return;
    }

    // 使用 Metamask FDV $2B 市场的 NO token (已验证活跃)
    // conditionId: 0x77399fdf6c5097661705ee1fcf8ad615721ea5dd695871dcae2c9eb192a3d75b
    const testTokenId = '49837632014352686915859208545885869917694907773894605983598473615572060688156';
    const negRisk = false;  // 从市场 API 获取: neg_risk: false

    // 2. 获取订单簿
    console.log('📖 获取订单簿...');
    const book = await trader.getOrderbook(testTokenId);

    if (!book) {
        console.log('❌ 无法获取订单簿');
        return;
    }

    const bestBid = book.bids[0];
    const bestAsk = book.asks[0];

    console.log(`  Best Bid: ${bestBid ? bestBid.price : 'N/A'} (${bestBid ? bestBid.size : 0} shares)`);
    console.log(`  Best Ask: ${bestAsk ? bestAsk.price : 'N/A'} (${bestAsk ? bestAsk.size : 0} shares)\n`);

    if (!bestAsk) {
        console.log('❌ 没有卖单，无法测试');
        return;
    }

    // 3. 测试下单 - 买入最小量 (1 share) @ best ask
    const testPrice = bestAsk.price;
    const testQty = 5;  // 最小 5 shares

    console.log(`📝 测试下单: BUY ${testQty} @ ${testPrice}`);
    console.log(`   预计成本: $${(testQty * testPrice).toFixed(4)}\n`);

    const result = await trader.placeOrder({
        tokenId: testTokenId,
        side: 'BUY',
        price: testPrice,
        quantity: testQty,
        orderType: 'GTC',  // 使用 GTC 以便能取消
        negRisk,
    });

    if (result.success) {
        console.log(`✅ 下单成功! OrderID: ${result.orderId}`);

        // 4. 立即取消订单
        console.log('\n⏳ 等待 500ms 后取消订单...');
        await new Promise(r => setTimeout(r, 500));

        const cancelled = await trader.cancelOrder(result.orderId!);
        console.log(cancelled ? '✅ 订单已取消' : '⚠️ 取消失败 (可能已成交)');

        // 5. 查询订单状态
        const status = await trader.getOrderStatus(result.orderId!);
        console.log(`\n📊 订单状态: ${status ? status.status : 'UNKNOWN'}`);
        console.log(`   已成交: ${status ? status.filledQty : 0} shares`);
    } else {
        console.log(`❌ 下单失败: ${result.error}`);
    }
}

main().catch(console.error);
