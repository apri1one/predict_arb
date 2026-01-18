/**
 * 调试未匹配的 Predict-Polymarket 市场
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

async function debugUnmatchedMarkets() {
    console.log('============================================================');
    console.log('   调试未匹配的 Predict-Polymarket 市场');
    console.log('============================================================\n');

    // 1. 获取 Predict 有 Polymarket 关联的市场
    console.log('--- 1. 获取 Predict 市场（有 polymarketConditionIds）---\n');
    const matchRes = await fetch(`${PREDICT_BASE_URL}/v1/orders/matches?first=100`, {
        headers: { 'x-api-key': PREDICT_API_KEY }
    });
    const matchData = await matchRes.json() as any;

    const linkedMarkets: any[] = [];
    const seen = new Set<number>();
    for (const m of matchData.data || []) {
        if (m.market && !seen.has(m.market.id) && m.market.polymarketConditionIds?.length > 0) {
            seen.add(m.market.id);
            linkedMarkets.push(m.market);
        }
    }

    console.log(`找到 ${linkedMarkets.length} 个有 Polymarket 关联的市场\n`);

    // 2. 获取 Polymarket 所有市场（通过 events API）
    console.log('--- 2. 获取 Polymarket 所有市场（通过 events API）---\n');

    const polyMarkets: any[] = [];

    // 获取活跃事件
    try {
        const eventsRes = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=200');
        const events = await eventsRes.json() as any[];
        console.log(`获取到 ${events.length} 个活跃事件`);

        for (const event of events) {
            if (event.markets) {
                for (const m of event.markets) {
                    if (m.conditionId) {
                        polyMarkets.push(m);
                    }
                }
            }
        }
    } catch (error: any) {
        console.error('获取活跃事件失败:', error.message);
    }

    console.log(`从活跃事件中提取到 ${polyMarkets.length} 个市场\n`);

    // 提取所有 conditionId
    const polyConditionIds = new Set(
        polyMarkets.map(m => m.conditionId?.toLowerCase()).filter(Boolean)
    );
    console.log(`Polymarket 有效 conditionId 数量: ${polyConditionIds.size}\n`);

    // 3. 检查每个 Predict 市场
    console.log('--- 3. 检查匹配状态 ---\n');

    for (const market of linkedMarkets) {
        const conditionId = market.polymarketConditionIds[0];
        const matched = polyConditionIds.has(conditionId.toLowerCase());

        console.log(`[${matched ? '✅ 匹配' : '❌ 未匹配'}] ${market.title}`);
        console.log(`  Predict ID: ${market.id}`);
        console.log(`  Condition ID: ${conditionId}`);

        if (!matched) {
            // 尝试在 Polymarket 中搜索相似标题
            console.log(`  \n  ⚠️ 在 Polymarket 中未找到此 conditionId`);
            console.log(`  尝试搜索相似标题...`);

            const similarMarkets = polyMarkets.filter(pm => {
                const predictTitle = market.title.toLowerCase();
                const polyTitle = pm.question?.toLowerCase() || '';

                // 提取关键词
                const predictKeywords = predictTitle.split(/\s+/).filter(w => w.length > 3);
                const polyKeywords = polyTitle.split(/\s+/).filter(w => w.length > 3);

                // 计算匹配度
                const matches = predictKeywords.filter(kw => polyKeywords.includes(kw));
                return matches.length >= 2;
            });

            if (similarMarkets.length > 0) {
                console.log(`\n  可能的匹配市场 (${similarMarkets.length} 个):`);
                similarMarkets.slice(0, 3).forEach(pm => {
                    console.log(`    - ${pm.question}`);
                    console.log(`      Condition ID: ${pm.conditionId}`);
                });
            } else {
                console.log(`  未找到相似标题的市场`);
            }
        } else {
            // 找到匹配的市场
            const polyMarket = polyMarkets.find(pm =>
                pm.conditionId?.toLowerCase() === conditionId.toLowerCase()
            );
            if (polyMarket) {
                console.log(`  Polymarket: ${polyMarket.question}`);
            }
        }
        console.log();
    }

    // 4. 总结
    const matched = linkedMarkets.filter(m =>
        polyConditionIds.has(m.polymarketConditionIds[0].toLowerCase())
    );
    const unmatched = linkedMarkets.filter(m =>
        !polyConditionIds.has(m.polymarketConditionIds[0].toLowerCase())
    );

    console.log('============================================================');
    console.log('   总结');
    console.log('============================================================');
    console.log(`总市场数: ${linkedMarkets.length}`);
    console.log(`成功匹配: ${matched.length}`);
    console.log(`未匹配: ${unmatched.length}`);
    console.log(`匹配率: ${((matched.length / linkedMarkets.length) * 100).toFixed(1)}%`);
    console.log('\n未匹配的市场:');
    unmatched.forEach(m => {
        console.log(`  - ${m.title} (ID: ${m.id})`);
        console.log(`    Condition ID: ${m.polymarketConditionIds[0]}`);
    });
}

debugUnmatchedMarkets().catch(console.error);
