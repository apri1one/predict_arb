/**
 * 测试 Polymarket 订单簿排序逻辑
 * 验证当前代码对 bids/asks 排序的理解是否正确
 */

// 模拟 Polymarket API 返回的订单簿数据
interface PolyLevel {
    price: string;
    size: string;
}

interface PolyBook {
    bids: PolyLevel[];
    asks: PolyLevel[];
}

// 场景1: 假设 bids 升序、asks 降序（当前代码的理解）
const mockBook1: PolyBook = {
    bids: [
        { price: '0.50', size: '100' },  // 低价
        { price: '0.51', size: '200' },
        { price: '0.52', size: '150' },  // 高价（最佳买价？）
    ],
    asks: [
        { price: '0.60', size: '150' },  // 高价
        { price: '0.59', size: '200' },
        { price: '0.58', size: '100' },  // 低价（最佳卖价？）
    ],
};

// 场景2: 假设 bids 降序、asks 升序（标准订单簿格式）
const mockBook2: PolyBook = {
    bids: [
        { price: '0.52', size: '150' },  // 高价（最佳买价）
        { price: '0.51', size: '200' },
        { price: '0.50', size: '100' },  // 低价
    ],
    asks: [
        { price: '0.58', size: '100' },  // 低价（最佳卖价）
        { price: '0.59', size: '200' },
        { price: '0.60', size: '150' },  // 高价
    ],
};

function analyzeOrderBook(book: PolyBook, scenario: string) {
    console.log(`\n========== ${scenario} ==========`);

    // 当前代码的逻辑：取最后一个元素
    const currentLogicBestBid = book.bids.length > 0 ? parseFloat(book.bids[book.bids.length - 1].price) : 0;
    const currentLogicBestAsk = book.asks.length > 0 ? parseFloat(book.asks[book.asks.length - 1].price) : 0;

    // 标准逻辑：取第一个元素
    const standardLogicBestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0;
    const standardLogicBestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : 0;

    console.log('\n原始订单簿:');
    console.log('Bids:', book.bids.map(b => `${b.price}x${b.size}`).join(', '));
    console.log('Asks:', book.asks.map(a => `${a.price}x${a.size}`).join(', '));

    console.log('\n当前代码逻辑 (取最后一个):');
    console.log(`  Best Bid: ${currentLogicBestBid}`);
    console.log(`  Best Ask: ${currentLogicBestAsk}`);
    console.log(`  Spread: ${(currentLogicBestAsk - currentLogicBestBid).toFixed(4)}`);
    console.log(`  合理性: ${currentLogicBestAsk > currentLogicBestBid ? '✅ Ask > Bid' : '❌ Ask <= Bid (错误!)'}`);

    console.log('\n标准逻辑 (取第一个):');
    console.log(`  Best Bid: ${standardLogicBestBid}`);
    console.log(`  Best Ask: ${standardLogicBestAsk}`);
    console.log(`  Spread: ${(standardLogicBestAsk - standardLogicBestBid).toFixed(4)}`);
    console.log(`  合理性: ${standardLogicBestAsk > standardLogicBestBid ? '✅ Ask > Bid' : '❌ Ask <= Bid (错误!)'}`);

    // YES -> NO 转换测试
    console.log('\n=== YES -> NO 转换测试 ===');

    // YES Bid -> NO Ask (买 YES = 卖 NO)
    const yesBook = book;
    const noBidsFromYesAsks = yesBook.asks.map(a => ({
        price: 1 - parseFloat(a.price),
        size: parseFloat(a.size)
    })).sort((a, b) => b.price - a.price);  // 降序

    const noAsksFromYesBids = yesBook.bids.map(b => ({
        price: 1 - parseFloat(b.price),
        size: parseFloat(b.size)
    })).sort((a, b) => a.price - b.price);  // 升序

    console.log('NO Bids (从 YES Asks 转换):', noBidsFromYesAsks.map(b => `${b.price.toFixed(2)}x${b.size}`).join(', '));
    console.log('NO Asks (从 YES Bids 转换):', noAsksFromYesBids.map(a => `${a.price.toFixed(2)}x${a.size}`).join(', '));

    // 使用当前逻辑获取 NO 最佳价格
    const noBestBid = noBidsFromYesAsks.length > 0 ? noBidsFromYesAsks[noBidsFromYesAsks.length - 1].price : 0;
    const noBestAsk = noAsksFromYesBids.length > 0 ? noAsksFromYesBids[noAsksFromYesBids.length - 1].price : 0;

    // 使用标准逻辑
    const noBestBidStd = noBidsFromYesAsks.length > 0 ? noBidsFromYesAsks[0].price : 0;
    const noBestAskStd = noAsksFromYesBids.length > 0 ? noAsksFromYesBids[0].price : 0;

    console.log(`\nNO 最佳价格 (当前逻辑): Bid=${noBestBid.toFixed(2)}, Ask=${noBestAsk.toFixed(2)}`);
    console.log(`NO 最佳价格 (标准逻辑): Bid=${noBestBidStd.toFixed(2)}, Ask=${noBestAskStd.toFixed(2)}`);
}

console.log('===============================================');
console.log('   Polymarket 订单簿排序逻辑验证');
console.log('===============================================');

analyzeOrderBook(mockBook1, '场景1: bids升序, asks降序 (当前代码假设)');
analyzeOrderBook(mockBook2, '场景2: bids降序, asks升序 (标准格式)');

console.log('\n\n========== 结论 ==========');
console.log('检查上面哪个场景的 Spread 是正数且合理');
console.log('正确的场景就是 Polymarket API 实际使用的排序方式');
