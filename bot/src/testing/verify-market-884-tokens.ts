/**
 * 验证 Market 884 的 Token 映射
 */

import 'dotenv/config';

async function main() {
    const MARKET_ID = 884;

    console.log('=== 验证 Market 884 Token 映射 ===\n');

    // 1. 获取 Predict 市场信息
    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) {
        console.log('ERROR: 缺少 PREDICT_API_KEY');
        return;
    }

    const predictRes = await fetch(`https://api.predict.fun/v1/markets/${MARKET_ID}`, {
        headers: { 'X-API-KEY': apiKey }
    });
    const predictMarket = await predictRes.json() as any;

    const conditionIds = predictMarket.data?.polymarketConditionIds || [];
    const conditionId = conditionIds[0];

    console.log('Predict 市场信息:');
    console.log(`  question: ${predictMarket.data?.question?.slice(0, 60)}`);
    console.log(`  conditionId: ${conditionId}`);

    if (!conditionId) {
        console.log('ERROR: 无 polymarketConditionIds');
        return;
    }

    // 2. 获取 Polymarket 市场信息
    const polyRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
    const polyMarket = await polyRes.json() as any;

    console.log('\nPolymarket tokens:');
    for (const t of polyMarket.tokens || []) {
        console.log(`  ${t.outcome}: ${t.token_id}`);
    }

    const apiYesToken = polyMarket.tokens?.find((t: any) => t.outcome?.toLowerCase() === 'yes');
    const apiNoToken = polyMarket.tokens?.find((t: any) => t.outcome?.toLowerCase() === 'no');

    // 3. 获取订单簿价格
    console.log('\n订单簿价格验证:');

    for (const [label, token] of [['YES', apiYesToken?.token_id], ['NO', apiNoToken?.token_id]]) {
        if (!token) continue;
        const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${token}`);
        const book = await bookRes.json() as any;
        const bestAsk = book.asks?.[0]?.price || 'N/A';
        const bestBid = book.bids?.[0]?.price || 'N/A';
        console.log(`  ${label} token: bid=${bestBid}, ask=${bestAsk}`);
    }

    console.log('\n正确映射应该是:');
    console.log(`  polymarketYesTokenId: ${apiYesToken?.token_id}`);
    console.log(`  polymarketNoTokenId: ${apiNoToken?.token_id}`);
}

main().catch(console.error);
