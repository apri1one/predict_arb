/**
 * 分析 Predict 市场在 Polymarket 上的分组情况
 * 检查是否多个 Predict 市场对应同一个 Polymarket 事件的不同选项
 */

import * as fs from 'fs';
import * as path from 'path';

// 加载 .env
function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
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

async function analyzePolymarketGrouping() {
    console.log('============================================================');
    console.log('   分析 Predict-Polymarket 事件分组关系');
    console.log('============================================================\n');

    // 1. 获取所有 Predict 市场
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

    // 2. 筛选 REGISTERED 且有 Polymarket 关联的市场
    const linkedMarkets = allMarkets.filter(m =>
        m.status === 'REGISTERED' &&
        m.polymarketConditionIds?.length > 0
    );

    console.log(`找到 ${linkedMarkets.length} 个有 Polymarket 关联的 REGISTERED 市场\n`);

    // 3. 获取 Polymarket 事件数据
    console.log('--- 获取 Polymarket 事件数据 ---\n');

    const eventsRes = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=200');
    const polyEvents = await eventsRes.json() as any[];

    console.log(`获取到 ${polyEvents.length} 个 Polymarket 事件\n`);

    // 4. 构建 conditionId 到 Polymarket 事件的映射
    const conditionToEvent = new Map<string, any>();
    const conditionToMarket = new Map<string, any>();

    for (const event of polyEvents) {
        if (event.markets) {
            for (const market of event.markets) {
                if (market.conditionId) {
                    const condId = market.conditionId.toLowerCase();
                    conditionToEvent.set(condId, event);
                    conditionToMarket.set(condId, market);
                }
            }
        }
    }

    // 5. 按 Polymarket 事件分组 Predict 市场
    const polyEventGroups = new Map<string, any[]>();

    for (const predictMarket of linkedMarkets) {
        const conditionId = predictMarket.polymarketConditionIds[0].toLowerCase();
        const polyEvent = conditionToEvent.get(conditionId);

        if (polyEvent) {
            const eventId = polyEvent.id;
            if (!polyEventGroups.has(eventId)) {
                polyEventGroups.set(eventId, []);
            }
            polyEventGroups.get(eventId)!.push({
                predictMarket,
                polyMarket: conditionToMarket.get(conditionId),
                polyEvent
            });
        }
    }

    console.log('--- Polymarket 事件分组 ---\n');
    console.log(`在 Polymarket 上对应 ${polyEventGroups.size} 个事件\n`);

    // 6. 输出分组详情
    console.log('=== 多选事件（Polymarket 事件包含多个选项）===\n');

    const multiChoiceEvents = Array.from(polyEventGroups.entries()).filter(([_, items]) => {
        const polyMarketCount = items[0].polyEvent.markets?.length || 0;
        return polyMarketCount > 1;
    });

    if (multiChoiceEvents.length === 0) {
        console.log('无多选事件匹配\n');
    } else {
        multiChoiceEvents.forEach(([eventId, items], index) => {
            const polyEvent = items[0].polyEvent;
            const polyMarketCount = polyEvent.markets?.length || 0;

            console.log(`${index + 1}. Polymarket 事件: ${polyEvent.title}`);
            console.log(`   Event ID: ${eventId}`);
            console.log(`   Polymarket 市场数: ${polyMarketCount} 个`);
            console.log(`   匹配到的 Predict 市场数: ${items.length} 个`);

            if (items.length < polyMarketCount) {
                console.log(`   ⚠️ 未完全匹配 (Polymarket 有 ${polyMarketCount} 个选项，但只匹配到 ${items.length} 个)`);
            } else if (items.length === polyMarketCount) {
                console.log(`   ✅ 完全匹配`);
            }

            console.log(`\n   Predict 市场列表:`);
            items.forEach((item, i) => {
                console.log(`     ${i + 1}. ${item.predictMarket.title}`);
                console.log(`        Predict ID: ${item.predictMarket.id}`);
                console.log(`        Polymarket: ${item.polyMarket.question}`);
            });

            // 显示未匹配的 Polymarket 选项
            if (items.length < polyMarketCount) {
                console.log(`\n   未匹配的 Polymarket 选项:`);
                const matchedConditions = new Set(items.map(item =>
                    item.predictMarket.polymarketConditionIds[0].toLowerCase()
                ));

                polyEvent.markets.forEach((pm: any) => {
                    if (pm.conditionId && !matchedConditions.has(pm.conditionId.toLowerCase())) {
                        console.log(`     - ${pm.question}`);
                    }
                });
            }

            console.log();
        });
    }

    console.log('=== 二元事件（一对一匹配）===\n');

    const binaryEvents = Array.from(polyEventGroups.entries()).filter(([_, items]) => {
        const polyMarketCount = items[0].polyEvent.markets?.length || 0;
        return polyMarketCount === 1;
    });

    if (binaryEvents.length === 0) {
        console.log('无二元事件匹配\n');
    } else {
        binaryEvents.forEach(([eventId, items], index) => {
            const polyEvent = items[0].polyEvent;
            const item = items[0];

            console.log(`${index + 1}. ${polyEvent.title}`);
            console.log(`   Predict: ${item.predictMarket.title} (ID: ${item.predictMarket.id})`);
            console.log(`   Polymarket: ${item.polyMarket.question}`);
            console.log();
        });
    }

    // 7. 统计
    console.log('============================================================');
    console.log('   统计');
    console.log('============================================================');

    const fullyMatched = Array.from(polyEventGroups.values()).filter(items => {
        const polyMarketCount = items[0].polyEvent.markets?.length || 0;
        return items.length === polyMarketCount;
    });

    const partiallyMatched = Array.from(polyEventGroups.values()).filter(items => {
        const polyMarketCount = items[0].polyEvent.markets?.length || 0;
        return items.length < polyMarketCount;
    });

    console.log(`Polymarket 事件总数: ${polyEventGroups.size}`);
    console.log(`  - 完全匹配: ${fullyMatched.length} 个`);
    console.log(`  - 部分匹配: ${partiallyMatched.length} 个`);
    console.log(`\nPredict 有 Polymarket 关联的市场: ${linkedMarkets.length} 个`);
}

analyzePolymarketGrouping().catch(console.error);
