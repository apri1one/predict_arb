import { config } from 'dotenv';
config({ path: '../.env' });

async function main() {
    const apiKey = process.env.PREDICT_API_KEY || '';

    // 直接调用 API 查询 sports 分类
    console.log('查询 category=sports...');
    const url = 'https://api.predict.fun/v1/markets?category=sports&limit=100';
    const res = await fetch(url, {
        headers: { 'X-API-Key': apiKey }
    });
    const data = await res.json();

    const markets = data.data || [];
    console.log(`Sports 市场数量: ${markets.length}`);

    if (markets.length === 0) {
        console.log('\n尝试其他查询方式...');

        // 尝试获取所有市场并筛选
        const allUrl = 'https://api.predict.fun/v1/markets?limit=1000';
        const allRes = await fetch(allUrl, { headers: { 'X-API-Key': apiKey } });
        const allData = await allRes.json();
        const allMarkets = allData.data || [];

        console.log(`总市场数: ${allMarkets.length}`);

        // 检查有 polymarket 映射的
        const withPoly = allMarkets.filter((m: any) => m.polymarketConditionIds?.length > 0);
        console.log(`有 Polymarket 映射: ${withPoly.length}`);

        // 打印所有有映射的市场
        console.log('\n=== 有 Polymarket 映射的市场 ===');
        for (const m of withPoly) {
            console.log(`ID ${m.id}: ${(m.title || '').slice(0, 70)}`);
            console.log(`  polymarketIds: ${JSON.stringify(m.polymarketConditionIds)}`);
        }

        // 按 categorySlug 统计
        const slugs = new Map<string, number>();
        for (const m of allMarkets) {
            const slug = m.categorySlug || 'unknown';
            slugs.set(slug, (slugs.get(slug) || 0) + 1);
        }
        console.log('\n=== categorySlug 统计 ===');
        for (const [slug, count] of Array.from(slugs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
            console.log(`  ${slug}: ${count}`);
        }
    } else {
        console.log('\n=== Sports 市场 ===');
        for (const m of markets.slice(0, 20)) {
            const hasMapping = m.polymarketConditionIds?.length > 0 ? '✓' : '✗';
            console.log(`ID ${m.id} [Poly:${hasMapping}]: ${(m.title || '').slice(0, 60)}`);
        }

        const withMapping = markets.filter((m: any) => m.polymarketConditionIds?.length > 0);
        console.log(`\n体育市场有 Polymarket 映射: ${withMapping.length}/${markets.length}`);
    }
}

main().catch(console.error);
