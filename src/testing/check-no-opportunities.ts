/**
 * 检查 NO 端套利机会
 */

async function main() {
    try {
        const res = await fetch('http://localhost:3005/api/opportunities');
        const opps = await res.json() as any[];

        // 只显示 NO 端的机会
        const noOpps = opps.filter((o: any) => o.side === 'NO');

        console.log('=== NO 端套利机会 ===\n');

        if (noOpps.length === 0) {
            console.log('暂无 NO 端机会');
            return;
        }

        for (const o of noOpps.slice(0, 5)) {
            console.log(`Market ${o.marketId}: ${o.title?.slice(0, 50)}`);
            console.log(`  策略: ${o.strategy}, 利润: ${o.profitPercent?.toFixed(2)}%`);
            console.log(`  predictNoAsk: ${o.predictAsk}, polyYesAsk: ${o.polymarketPrice}`);
            console.log(`  totalCost: ${o.totalCost}`);
            console.log(`  polymarketYesTokenId: ${o.polymarketYesTokenId?.slice(0, 20)}...`);
            console.log(`  polymarketNoTokenId: ${o.polymarketNoTokenId?.slice(0, 20)}...`);
            console.log('');
        }
    } catch (e: any) {
        console.log('Dashboard 未运行或连接失败:', e.message);
    }
}

main();
