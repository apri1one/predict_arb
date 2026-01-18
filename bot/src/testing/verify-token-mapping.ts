/**
 * 验证 Polymarket Token ID 映射是否正确
 *
 * 问题：任务 732 买入价格 0.81 而不是预期的 0.20
 * 这说明 token ID 映射可能是错的
 */

import 'dotenv/config';

const CONDITION_ID = '0x43ec78527bd98a0588dd9455685b2cc82f5743140cb3a154603dc03c02b57de5';
const TASK_NO_TOKEN = '108988271800978168213949343685406694292284061166193819357568013088568150075789';
const TASK_YES_TOKEN = '52607315900507156846622820770453728082833251091510131025984187712529448877245';

async function main() {
    console.log('=== 验证 Token ID 映射 ===\n');

    // 1. 获取 Polymarket 市场信息
    console.log('1. 从 Polymarket API 获取市场信息...\n');
    const marketRes = await fetch(`https://clob.polymarket.com/markets/${CONDITION_ID}`);
    const marketData = await marketRes.json() as any;

    console.log('市场数据:');
    console.log(`  condition_id: ${marketData.condition_id || CONDITION_ID}`);
    console.log(`  tokens: ${JSON.stringify(marketData.tokens, null, 2)}`);

    // 找出 API 返回的 YES/NO token
    const apiYesToken = marketData.tokens?.find((t: any) => t.outcome?.toLowerCase() === 'yes');
    const apiNoToken = marketData.tokens?.find((t: any) => t.outcome?.toLowerCase() === 'no');

    console.log('\n2. API 返回的 token 映射:');
    console.log(`  YES token: ${apiYesToken?.token_id || 'NOT FOUND'}`);
    console.log(`  NO token:  ${apiNoToken?.token_id || 'NOT FOUND'}`);

    // 3. 与任务中的 token ID 对比
    console.log('\n3. 任务中存储的 token ID:');
    console.log(`  polymarketYesTokenId: ${TASK_YES_TOKEN}`);
    console.log(`  polymarketNoTokenId:  ${TASK_NO_TOKEN}`);

    // 4. 检查是否匹配
    console.log('\n4. 匹配检查:');
    const yesMatch = apiYesToken?.token_id === TASK_YES_TOKEN;
    const noMatch = apiNoToken?.token_id === TASK_NO_TOKEN;

    console.log(`  YES token 匹配: ${yesMatch ? '✓' : '✗'}`);
    console.log(`  NO token 匹配:  ${noMatch ? '✓' : '✗'}`);

    if (!yesMatch || !noMatch) {
        console.log('\n❌ Token ID 映射错误!');
        if (apiYesToken?.token_id === TASK_NO_TOKEN) {
            console.log('   问题: 任务中的 polymarketNoTokenId 实际上是 YES token!');
        }
        if (apiNoToken?.token_id === TASK_YES_TOKEN) {
            console.log('   问题: 任务中的 polymarketYesTokenId 实际上是 NO token!');
        }
    }

    // 5. 获取两个 token 的订单簿验证价格
    console.log('\n5. 获取订单簿验证价格...\n');

    for (const token of [TASK_NO_TOKEN, TASK_YES_TOKEN]) {
        const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${token}`);
        const book = await bookRes.json() as any;

        const bestBid = book.bids?.[0]?.price || 'N/A';
        const bestAsk = book.asks?.[0]?.price || 'N/A';

        const isNoToken = token === TASK_NO_TOKEN;
        const label = isNoToken ? 'polymarketNoTokenId' : 'polymarketYesTokenId';

        console.log(`${label}:`);
        console.log(`  Token: ${token.slice(0, 20)}...`);
        console.log(`  Best Bid: ${bestBid}`);
        console.log(`  Best Ask: ${bestAsk}`);

        // 判断这个价格是 YES 还是 NO
        const askNum = parseFloat(bestAsk);
        if (!isNaN(askNum)) {
            if (askNum > 0.5) {
                console.log(`  => 价格 > 0.5, 这看起来是 YES token`);
            } else {
                console.log(`  => 价格 < 0.5, 这看起来是 NO token`);
            }
        }
        console.log('');
    }

    // 6. 结论
    console.log('=== 结论 ===');
}

main().catch(console.error);
