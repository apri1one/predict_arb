/**
 * 验证 NO 端套利的 Token 映射
 *
 * 问题：NO 端任务的成本计算获取了错误的 poly token（polyAsk=0.792 是 NO 价格，应该获取 YES 价格约 0.21）
 */

import 'dotenv/config';

interface TokenData {
    token_id: string;
    outcome: string;
    price?: string;
    winner?: boolean;
}

interface MarketData {
    tokens: TokenData[];
    condition_id: string;
    question: string;
}

async function verifyTokenMapping(conditionId: string) {
    console.log(`\n=== 验证 Token 映射 (${conditionId.slice(0, 20)}...) ===\n`);

    // 1. 获取 Polymarket 市场信息
    const marketRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
    if (!marketRes.ok) {
        console.log('ERROR: 无法获取市场信息');
        return null;
    }
    const marketData = await marketRes.json() as MarketData;

    // 2. 解析 tokens
    let apiYesToken: string | null = null;
    let apiNoToken: string | null = null;

    for (const token of marketData.tokens || []) {
        if (token.outcome.toLowerCase() === 'yes') {
            apiYesToken = token.token_id;
        } else if (token.outcome.toLowerCase() === 'no') {
            apiNoToken = token.token_id;
        }
    }

    console.log('API 返回的 token 映射:');
    console.log(`  YES token: ${apiYesToken?.slice(0, 30)}...`);
    console.log(`  NO token:  ${apiNoToken?.slice(0, 30)}...`);

    // 3. 获取订单簿验证价格
    console.log('\n订单簿价格验证:');

    for (const [label, tokenId] of [['YES', apiYesToken], ['NO', apiNoToken]]) {
        if (!tokenId) continue;
        const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        const book = await bookRes.json() as any;
        const bestAsk = book.asks?.[0]?.price || 'N/A';
        const bestBid = book.bids?.[0]?.price || 'N/A';
        console.log(`  ${label} token: bid=${bestBid}, ask=${bestAsk}`);
    }

    return { apiYesToken, apiNoToken };
}

async function main() {
    // 从 Dashboard 获取机会列表
    console.log('从 Dashboard 获取 NO 端机会...\n');

    try {
        const res = await fetch('http://localhost:3005/api/opportunities');
        const opps = await res.json() as any[];

        // 找 NO 端机会
        const noOpps = opps.filter((o: any) => o.side === 'NO');

        if (noOpps.length === 0) {
            console.log('暂无 NO 端机会');

            // 尝试使用 YES 端机会验证
            const yesOpp = opps.find((o: any) => o.polymarketConditionId);
            if (yesOpp) {
                console.log('\n使用 YES 端机会进行 token 映射验证:\n');
                console.log(`Market ${yesOpp.marketId}: ${yesOpp.title?.slice(0, 50)}`);
                console.log(`  策略: ${yesOpp.strategy}, 方向: ${yesOpp.side}`);
                console.log(`  Dashboard 中的 token ID:`);
                console.log(`    polymarketYesTokenId: ${yesOpp.polymarketYesTokenId?.slice(0, 30)}...`);
                console.log(`    polymarketNoTokenId: ${yesOpp.polymarketNoTokenId?.slice(0, 30)}...`);

                // 验证实际映射
                const mapping = await verifyTokenMapping(yesOpp.polymarketConditionId);

                if (mapping && yesOpp.polymarketYesTokenId) {
                    const yesMatch = mapping.apiYesToken === yesOpp.polymarketYesTokenId;
                    const noMatch = mapping.apiNoToken === yesOpp.polymarketNoTokenId;

                    console.log('\n映射验证结果:');
                    console.log(`  YES token 匹配: ${yesMatch ? '✓' : '✗'}`);
                    console.log(`  NO token 匹配: ${noMatch ? '✓' : '✗'}`);

                    if (!yesMatch) {
                        console.log('\n⚠️ YES token ID 不匹配!');
                        if (mapping.apiNoToken === yesOpp.polymarketYesTokenId) {
                            console.log('   问题: Dashboard 的 polymarketYesTokenId 实际是 NO token!');
                        }
                    }
                    if (!noMatch) {
                        console.log('\n⚠️ NO token ID 不匹配!');
                        if (mapping.apiYesToken === yesOpp.polymarketNoTokenId) {
                            console.log('   问题: Dashboard 的 polymarketNoTokenId 实际是 YES token!');
                        }
                    }
                }
            }
            return;
        }

        // 验证第一个 NO 端机会
        const opp = noOpps[0];
        console.log(`找到 NO 端机会: Market ${opp.marketId}`);
        console.log(`  标题: ${opp.title?.slice(0, 50)}`);
        console.log(`  策略: ${opp.strategy}, 利润: ${opp.profitPercent?.toFixed(2)}%`);
        console.log(`  predictNoAsk: ${opp.predictAsk}, polyYesAsk: ${opp.polymarketPrice}`);
        console.log(`  totalCost: ${opp.totalCost}`);
        console.log(`\n  Dashboard 中的 token ID:`);
        console.log(`    polymarketYesTokenId: ${opp.polymarketYesTokenId?.slice(0, 30)}...`);
        console.log(`    polymarketNoTokenId: ${opp.polymarketNoTokenId?.slice(0, 30)}...`);

        // 验证实际映射
        const mapping = await verifyTokenMapping(opp.polymarketConditionId);

        if (mapping && opp.polymarketYesTokenId) {
            const yesMatch = mapping.apiYesToken === opp.polymarketYesTokenId;
            const noMatch = mapping.apiNoToken === opp.polymarketNoTokenId;

            console.log('\n映射验证结果:');
            console.log(`  YES token 匹配: ${yesMatch ? '✓' : '✗'}`);
            console.log(`  NO token 匹配: ${noMatch ? '✓' : '✗'}`);

            if (!yesMatch || !noMatch) {
                console.log('\n❌ Token ID 映射错误!');
                console.log('   这是 NO 端任务成本计算错误的根本原因。');
            } else {
                console.log('\n✓ Token 映射正确');
            }
        }

    } catch (e: any) {
        console.log('Dashboard 未运行或连接失败:', e.message);
        console.log('\n请先启动 Dashboard: npm run dashboard');
    }
}

main().catch(console.error);
