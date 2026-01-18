/**
 * 检查未匹配的 conditionId，看它们是否在 Polymarket 上存在
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

async function checkUnmatchedConditions() {
    console.log('============================================================');
    console.log('   检查未匹配的 Predict conditionId');
    console.log('============================================================\n');

    // 1. 获取所有 Predict 有 Polymarket 关联的市场
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

    const linkedMarkets = allMarkets.filter(m =>
        m.status === 'REGISTERED' &&
        m.polymarketConditionIds?.length > 0
    );

    console.log(`找到 ${linkedMarkets.length} 个有 Polymarket 关联的 REGISTERED 市场\n`);

    // 2. 获取 Polymarket 所有事件（包括关闭的）
    console.log('--- 获取 Polymarket 事件 ---\n');

    const allPolyConditions = new Set<string>();
    const conditionToEvent = new Map<string, any>();

    // 获取活跃事件
    try {
        console.log('获取活跃事件...');
        const activeRes = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=200');
        const activeEvents = await activeRes.json() as any[];
        console.log(`  活跃事件: ${activeEvents.length} 个`);

        for (const event of activeEvents) {
            if (event.markets) {
                for (const market of event.markets) {
                    if (market.conditionId) {
                        const condId = market.conditionId.toLowerCase();
                        allPolyConditions.add(condId);
                        conditionToEvent.set(condId, { event, market });
                    }
                }
            }
        }
    } catch (error: any) {
        console.error('获取活跃事件失败:', error.message);
    }

    // 获取已关闭事件
    try {
        console.log('获取已关闭事件...');
        const closedRes = await fetch('https://gamma-api.polymarket.com/events?active=false&closed=true&limit=200');
        const closedEvents = await closedRes.json() as any[];
        console.log(`  已关闭事件: ${closedEvents.length} 个`);

        for (const event of closedEvents) {
            if (event.markets) {
                for (const market of event.markets) {
                    if (market.conditionId) {
                        const condId = market.conditionId.toLowerCase();
                        allPolyConditions.add(condId);
                        conditionToEvent.set(condId, { event, market });
                    }
                }
            }
        }
    } catch (error: any) {
        console.error('获取已关闭事件失败:', error.message);
    }

    console.log(`\nPolymarket 总 conditionId 数: ${allPolyConditions.size}\n`);

    // 3. 检查每个 Predict 市场
    console.log('--- 匹配检查 ---\n');

    const matched: any[] = [];
    const unmatched: any[] = [];

    for (const market of linkedMarkets) {
        const conditionId = market.polymarketConditionIds[0].toLowerCase();

        if (allPolyConditions.has(conditionId)) {
            matched.push({
                market,
                polyData: conditionToEvent.get(conditionId)
            });
        } else {
            unmatched.push(market);
        }
    }

    console.log(`✅ 匹配成功: ${matched.length} 个`);
    console.log(`❌ 未匹配: ${unmatched.length} 个\n`);

    if (unmatched.length > 0) {
        console.log('未匹配的 Predict 市场:\n');
        unmatched.forEach((m, i) => {
            console.log(`${i + 1}. ${m.title || m.question}`);
            console.log(`   Predict ID: ${m.id}`);
            console.log(`   Condition ID: ${m.polymarketConditionIds[0]}`);
            console.log();
        });
    }

    // 4. 按 Polymarket 事件分组已匹配的市场
    console.log('--- 已匹配市场按 Polymarket 事件分组 ---\n');

    const eventGroups = new Map<string, any[]>();

    for (const { market, polyData } of matched) {
        const eventId = polyData.event.id;
        if (!eventGroups.has(eventId)) {
            eventGroups.set(eventId, []);
        }
        eventGroups.get(eventId)!.push({ market, polyData });
    }

    console.log(`对应 ${eventGroups.size} 个 Polymarket 事件\n`);

    for (const [eventId, items] of eventGroups) {
        const polyEvent = items[0].polyData.event;
        const polyMarketCount = polyEvent.markets?.length || 0;

        console.log(`Polymarket 事件: ${polyEvent.title}`);
        console.log(`  Polymarket 选项数: ${polyMarketCount}`);
        console.log(`  匹配到的 Predict 市场: ${items.length} 个`);
        console.log(`  状态: ${polyEvent.active ? '活跃' : '已关闭'}`);

        items.forEach((item: any, i: number) => {
            console.log(`    ${i + 1}. ${item.market.title}`);
        });

        console.log();
    }
}

checkUnmatchedConditions().catch(console.error);
