/**
 * 获取活跃的 Polymarket token ID
 */

async function getActiveToken() {
    try {
        // 获取活跃市场
        const res = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=10');
        const markets = await res.json() as any[];

        console.log(`找到 ${markets.length} 个活跃市场\n`);

        for (const market of markets) {
            if (market.clobTokenIds) {
                try {
                    const tokenIds = JSON.parse(market.clobTokenIds);
                    if (tokenIds.length >= 2) {
                        console.log(`市场: ${market.question?.slice(0, 60)}...`);
                        console.log(`  YES Token: ${tokenIds[0]}`);
                        console.log(`  NO Token: ${tokenIds[1]}`);
                        console.log(`  Condition ID: ${market.conditionId}\n`);

                        // 返回第一个有效的 YES token
                        return tokenIds[0];
                    }
                } catch { }
            }
        }
    } catch (error) {
        console.error('获取失败:', error);
    }
    return null;
}

getActiveToken().then(tokenId => {
    if (tokenId) {
        console.log(`\n使用此 token ID 进行测试: ${tokenId}`);
    }
});
