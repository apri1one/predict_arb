/**
 * 调用真实 Polymarket API 验证订单簿排序
 */

async function testRealPolymarketOrderbook() {
    // 使用活跃的 token ID (US recession in 2025 YES token)
    const testTokenId = '104173557214744537570424345347209544585775842950109756851652855913015295701992';

    console.log('===============================================');
    console.log('   真实 Polymarket API 订单簿验证');
    console.log('===============================================\n');

    try {
        const res = await fetch(`https://clob.polymarket.com/book?token_id=${testTokenId}`);

        if (!res.ok) {
            console.error('API 请求失败:', res.status, res.statusText);
            return;
        }

        const data = await res.json() as any;

        console.log('原始 API 响应结构:');
        console.log(`  Bids 数量: ${data.bids?.length || 0}`);
        console.log(`  Asks 数量: ${data.asks?.length || 0}`);

        if (data.bids && data.bids.length > 0) {
            console.log('\nBids 前5个:');
            for (let i = 0; i < Math.min(5, data.bids.length); i++) {
                console.log(`  [${i}] Price: ${data.bids[i].price}, Size: ${data.bids[i].size}`);
            }
            console.log('\nBids 后5个:');
            for (let i = Math.max(0, data.bids.length - 5); i < data.bids.length; i++) {
                console.log(`  [${i}] Price: ${data.bids[i].price}, Size: ${data.bids[i].size}`);
            }
        }

        if (data.asks && data.asks.length > 0) {
            console.log('\nAsks 前5个:');
            for (let i = 0; i < Math.min(5, data.asks.length); i++) {
                console.log(`  [${i}] Price: ${data.asks[i].price}, Size: ${data.asks[i].size}`);
            }
            console.log('\nAsks 后5个:');
            for (let i = Math.max(0, data.asks.length - 5); i < data.asks.length; i++) {
                console.log(`  [${i}] Price: ${data.asks[i].price}, Size: ${data.asks[i].size}`);
            }
        }

        // 分析排序方向
        console.log('\n========== 排序分析 ==========');

        if (data.bids && data.bids.length >= 2) {
            const firstBid = parseFloat(data.bids[0].price);
            const secondBid = parseFloat(data.bids[1].price);
            const lastBid = parseFloat(data.bids[data.bids.length - 1].price);

            console.log(`\nBids 排序:`);
            console.log(`  第1个: ${firstBid}`);
            console.log(`  第2个: ${secondBid}`);
            console.log(`  最后: ${lastBid}`);

            if (firstBid < secondBid) {
                console.log('  ✅ Bids 是升序排列 (低价 -> 高价)');
                console.log('  → 最佳买价 (最高) 在最后: bids[bids.length - 1]');
            } else if (firstBid > secondBid) {
                console.log('  ✅ Bids 是降序排列 (高价 -> 低价)');
                console.log('  → 最佳买价 (最高) 在开头: bids[0]');
            }
        }

        if (data.asks && data.asks.length >= 2) {
            const firstAsk = parseFloat(data.asks[0].price);
            const secondAsk = parseFloat(data.asks[1].price);
            const lastAsk = parseFloat(data.asks[data.asks.length - 1].price);

            console.log(`\nAsks 排序:`);
            console.log(`  第1个: ${firstAsk}`);
            console.log(`  第2个: ${secondAsk}`);
            console.log(`  最后: ${lastAsk}`);

            if (firstAsk < secondAsk) {
                console.log('  ✅ Asks 是升序排列 (低价 -> 高价)');
                console.log('  → 最佳卖价 (最低) 在开头: asks[0]');
            } else if (firstAsk > secondAsk) {
                console.log('  ✅ Asks 是降序排列 (高价 -> 低价)');
                console.log('  → 最佳卖价 (最低) 在最后: asks[asks.length - 1]');
            }
        }

        // 验证当前代码逻辑
        console.log('\n========== 当前代码逻辑验证 ==========');
        const bestBidCurrent = data.bids?.length > 0 ? parseFloat(data.bids[data.bids.length - 1].price) : 0;
        const bestAskCurrent = data.asks?.length > 0 ? parseFloat(data.asks[data.asks.length - 1].price) : 0;
        console.log(`当前逻辑 (取最后): Best Bid=${bestBidCurrent}, Best Ask=${bestAskCurrent}`);
        console.log(`Spread: ${(bestAskCurrent - bestBidCurrent).toFixed(4)}`);
        console.log(`合理性: ${bestAskCurrent > bestBidCurrent ? '✅ Ask > Bid' : '❌ 错误!'}`);

        // 验证标准逻辑
        const bestBidStandard = data.bids?.length > 0 ? parseFloat(data.bids[0].price) : 0;
        const bestAskStandard = data.asks?.length > 0 ? parseFloat(data.asks[0].price) : 0;
        console.log(`\n标准逻辑 (取第一个): Best Bid=${bestBidStandard}, Best Ask=${bestAskStandard}`);
        console.log(`Spread: ${(bestAskStandard - bestBidStandard).toFixed(4)}`);
        console.log(`合理性: ${bestAskStandard > bestBidStandard ? '✅ Ask > Bid' : '❌ 错误!'}`);

        console.log('\n========== 结论 ==========');
        if (bestAskCurrent > bestBidCurrent && (bestAskCurrent - bestBidCurrent) < (bestAskStandard - bestBidStandard)) {
            console.log('✅ 当前代码逻辑正确 (spread 更紧密)');
            console.log('   Polymarket CLOB API: bids升序, asks降序');
        } else if (bestAskStandard > bestBidStandard && (bestAskStandard - bestBidStandard) < (bestAskCurrent - bestBidCurrent)) {
            console.log('❌ 当前代码逻辑错误，应该用标准逻辑');
            console.log('   Polymarket CLOB API: bids降序, asks升序 (标准格式)');
        } else {
            console.log('⚠️ 无法明确判断，需要进一步检查');
        }

    } catch (error) {
        console.error('测试失败:', error);
    }
}

testRealPolymarketOrderbook();
