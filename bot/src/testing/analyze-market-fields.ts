/**
 * 分析所有 REGISTERED 市场的字段，找出可能的前端过滤条件
 */

import * as fs from 'fs';
import * as path from 'path';

// 加载 .env
function loadEnv() {
    const envPath = path.join(process.cwd(), '..', '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

const PREDICT_API_KEY = process.env.PREDICT_API_KEY!;
const PREDICT_BASE_URL = 'https://api.predict.fun';

async function analyzeMarketFields() {
    console.log('============================================================');
    console.log('   分析 REGISTERED 市场字段特征');
    console.log('============================================================\n');

    // 获取所有市场
    const allMarkets: any[] = [];
    let cursor: string | null = null;
    let page = 0;

    do {
        const url = cursor
            ? `${PREDICT_BASE_URL}/v1/markets?first=50&after=${cursor}`
            : `${PREDICT_BASE_URL}/v1/markets?first=50`;

        const res = await fetch(url, {
            headers: { 'x-api-key': PREDICT_API_KEY }
        });

        const data = await res.json() as any;

        if (data.data && Array.isArray(data.data)) {
            allMarkets.push(...data.data);
            page++;
        }

        cursor = data.cursor || null;
        if (page >= 10) break;
    } while (cursor);

    const registeredMarkets = allMarkets.filter(m => m.status === 'REGISTERED');

    console.log(`REGISTERED 市场总数: ${registeredMarkets.length}\n`);

    // 分析字段
    console.log('--- 字段分析 ---\n');

    const fieldStats = {
        hasEndDate: 0,
        hasPolymarket: 0,
        hasVolume: 0,
        hasNonZeroVolume: 0,
        hasLiquidity: 0,
        hasNonZeroLiquidity: 0,
        endDateInFuture: 0,
        hasQuestion: 0,
        hasTitle: 0,
        titleEqualQuestion: 0
    };

    const now = Date.now();
    const categories = new Map<string, number>();

    for (const market of registeredMarkets) {
        // endDate
        if (market.endDate) {
            fieldStats.hasEndDate++;
            const endTime = new Date(market.endDate).getTime();
            if (endTime > now) {
                fieldStats.endDateInFuture++;
            }
        }

        // Polymarket 关联
        if (market.polymarketConditionIds?.length > 0) {
            fieldStats.hasPolymarket++;
        }

        // volume
        if (market.volume !== undefined && market.volume !== null) {
            fieldStats.hasVolume++;
            if (parseFloat(market.volume) > 0) {
                fieldStats.hasNonZeroVolume++;
            }
        }

        // liquidity
        if (market.liquidity !== undefined && market.liquidity !== null) {
            fieldStats.hasLiquidity++;
            if (parseFloat(market.liquidity) > 0) {
                fieldStats.hasNonZeroLiquidity++;
            }
        }

        // question/title
        if (market.question) fieldStats.hasQuestion++;
        if (market.title) fieldStats.hasTitle++;
        if (market.question && market.title && market.question === market.title) {
            fieldStats.titleEqualQuestion++;
        }

        // category
        const cat = market.category || 'unknown';
        categories.set(cat, (categories.get(cat) || 0) + 1);
    }

    console.log('字段统计:');
    console.log(`  有 endDate: ${fieldStats.hasEndDate} (${(fieldStats.hasEndDate / registeredMarkets.length * 100).toFixed(1)}%)`);
    console.log(`  endDate 在未来: ${fieldStats.endDateInFuture} (${(fieldStats.endDateInFuture / registeredMarkets.length * 100).toFixed(1)}%)`);
    console.log(`  有 Polymarket 关联: ${fieldStats.hasPolymarket} (${(fieldStats.hasPolymarket / registeredMarkets.length * 100).toFixed(1)}%)`);
    console.log(`  有 volume 字段: ${fieldStats.hasVolume} (${(fieldStats.hasVolume / registeredMarkets.length * 100).toFixed(1)}%)`);
    console.log(`  有非零 volume: ${fieldStats.hasNonZeroVolume} (${(fieldStats.hasNonZeroVolume / registeredMarkets.length * 100).toFixed(1)}%)`);
    console.log(`  有 liquidity 字段: ${fieldStats.hasLiquidity} (${(fieldStats.hasLiquidity / registeredMarkets.length * 100).toFixed(1)}%)`);
    console.log(`  有非零 liquidity: ${fieldStats.hasNonZeroLiquidity} (${(fieldStats.hasNonZeroLiquidity / registeredMarkets.length * 100).toFixed(1)}%)`);
    console.log(`  有 question: ${fieldStats.hasQuestion} (${(fieldStats.hasQuestion / registeredMarkets.length * 100).toFixed(1)}%)`);
    console.log(`  有 title: ${fieldStats.hasTitle} (${(fieldStats.hasTitle / registeredMarkets.length * 100).toFixed(1)}%)`);
    console.log();

    console.log('分类统计:');
    for (const [cat, count] of categories) {
        console.log(`  ${cat}: ${count} 个`);
    }
    console.log();

    // 如果前端显示 25 个，尝试找出可能的过滤条件
    console.log('--- 可能的前端过滤条件（目标：25 个市场）---\n');

    const filters = [
        {
            name: '有 Polymarket 关联',
            count: fieldStats.hasPolymarket,
            markets: registeredMarkets.filter(m => m.polymarketConditionIds?.length > 0)
        },
        {
            name: '有非零 volume',
            count: fieldStats.hasNonZeroVolume,
            markets: registeredMarkets.filter(m => m.volume && parseFloat(m.volume) > 0)
        },
        {
            name: '有非零 liquidity',
            count: fieldStats.hasNonZeroLiquidity,
            markets: registeredMarkets.filter(m => m.liquidity && parseFloat(m.liquidity) > 0)
        },
        {
            name: 'endDate 在未来',
            count: fieldStats.endDateInFuture,
            markets: registeredMarkets.filter(m => {
                if (!m.endDate) return false;
                return new Date(m.endDate).getTime() > now;
            })
        }
    ];

    filters.forEach(filter => {
        const diff = Math.abs(filter.count - 25);
        console.log(`${filter.name}: ${filter.count} 个 (差异: ${diff > 25 ? '+' : ''}${filter.count - 25})`);
    });

    console.log();

    // 组合过滤条件
    console.log('--- 组合过滤条件 ---\n');

    const combo1 = registeredMarkets.filter(m =>
        m.polymarketConditionIds?.length > 0 &&
        m.volume && parseFloat(m.volume) > 0
    );

    const combo2 = registeredMarkets.filter(m =>
        m.endDate && new Date(m.endDate).getTime() > now &&
        m.volume && parseFloat(m.volume) > 0
    );

    const combo3 = registeredMarkets.filter(m =>
        m.polymarketConditionIds?.length > 0 ||
        (m.volume && parseFloat(m.volume) > 10)
    );

    console.log(`有 Polymarket + 有非零 volume: ${combo1.length} 个`);
    console.log(`endDate 在未来 + 有非零 volume: ${combo2.length} 个`);
    console.log(`有 Polymarket 或 volume > 10: ${combo3.length} 个`);
    console.log();

    // 输出示例字段
    console.log('--- 示例市场字段（前3个）---\n');

    registeredMarkets.slice(0, 3).forEach((m, i) => {
        console.log(`${i + 1}. ${m.title || m.question}`);
        console.log(`   ID: ${m.id}`);
        console.log(`   status: ${m.status}`);
        console.log(`   question: ${m.question || 'null'}`);
        console.log(`   title: ${m.title || 'null'}`);
        console.log(`   endDate: ${m.endDate || 'null'}`);
        console.log(`   volume: ${m.volume || 'null'}`);
        console.log(`   liquidity: ${m.liquidity || 'null'}`);
        console.log(`   category: ${m.category || 'null'}`);
        console.log(`   polymarketConditionIds: ${m.polymarketConditionIds?.length || 0} 个`);
        console.log();
    });

    // 保存完整字段到文件
    const outputPath = path.join(process.cwd(), 'market-fields-analysis.json');
    const output = {
        timestamp: new Date().toISOString(),
        total: registeredMarkets.length,
        stats: fieldStats,
        categories: Object.fromEntries(categories),
        sampleMarkets: registeredMarkets.slice(0, 5).map(m => ({
            id: m.id,
            title: m.title,
            question: m.question,
            status: m.status,
            endDate: m.endDate,
            volume: m.volume,
            liquidity: m.liquidity,
            category: m.category,
            polymarketConditionIds: m.polymarketConditionIds,
            allFields: Object.keys(m)
        }))
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`详细分析已保存到: ${outputPath}`);
}

analyzeMarketFields().catch(console.error);
