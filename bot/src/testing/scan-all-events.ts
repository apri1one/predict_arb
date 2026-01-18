/**
 * 按事件分组扫描 Predict 市场
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

async function scanAllEvents() {
    console.log('============================================================');
    console.log('   按事件分组扫描 Predict 市场');
    console.log('============================================================\n');

    // 1. 获取所有市场
    console.log('--- 1. 获取所有 Predict 市场 ---\n');

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

    console.log(`总计获取: ${allMarkets.length} 个 outcomes (结果选项)\n`);

    // 2. 按 question 或 questionIndex 分组（同一事件的不同选项）
    const eventGroups = new Map<string, any[]>();

    for (const market of allMarkets) {
        // 使用 question 或 questionIndex 作为事件标识
        const eventKey = market.question || `market-${market.id}`;

        if (!eventGroups.has(eventKey)) {
            eventGroups.set(eventKey, []);
        }
        eventGroups.get(eventKey)!.push(market);
    }

    console.log(`--- 2. 事件分组统计 ---\n`);
    console.log(`总事件数（含已结束）: ${eventGroups.size} 个\n`);

    // 只统计活跃事件（REGISTERED 状态）
    const activeEventGroups = Array.from(eventGroups.entries()).filter(([_, markets]) =>
        markets[0].status === 'REGISTERED'
    );
    console.log(`活跃事件数（仅 REGISTERED）: ${activeEventGroups.length} 个\n`);

    // 统计活跃事件类型
    const activeBinaryEvents = activeEventGroups.filter(([_, g]) => g.length === 1);
    const activeMultiOutcomeEvents = activeEventGroups.filter(([_, g]) => g.length > 1);

    console.log(`活跃二元事件 (YES/NO): ${activeBinaryEvents.length} 个`);
    console.log(`活跃多选事件: ${activeMultiOutcomeEvents.length} 个\n`);

    // 3. 找出有 Polymarket 关联的事件
    console.log('--- 3. 有 Polymarket 关联的事件 ---\n');

    const linkedEvents: any[] = [];

    for (const [question, markets] of eventGroups) {
        const hasPolymarket = markets.some(m =>
            m.polymarketConditionIds && m.polymarketConditionIds.length > 0
        );

        if (hasPolymarket) {
            linkedEvents.push({
                question,
                markets,
                outcomeCount: markets.length,
                status: markets[0].status,
                polymarketConditionId: markets.find(m => m.polymarketConditionIds)?.polymarketConditionIds[0]
            });
        }
    }

    console.log(`找到 ${linkedEvents.length} 个有 Polymarket 关联的事件\n`);

    // 按状态分类
    const activeLinked = linkedEvents.filter(e => e.status === 'REGISTERED');
    const resolvedLinked = linkedEvents.filter(e => e.status === 'RESOLVED');

    console.log(`活跃事件: ${activeLinked.length} 个`);
    console.log(`已结束事件: ${resolvedLinked.length} 个\n`);

    console.log('--- 4. 活跃事件详情 ---\n');

    activeLinked.forEach((event, i) => {
        console.log(`${i + 1}. ${event.question}`);
        console.log(`   选项数: ${event.outcomeCount}`);
        console.log(`   市场 IDs: ${event.markets.map((m: any) => m.id).join(', ')}`);
        console.log(`   Condition ID: ${event.polymarketConditionId}`);

        if (event.outcomeCount > 1) {
            console.log(`   选项:`);
            event.markets.forEach((m: any) => {
                console.log(`     - ${m.title} (ID: ${m.id})`);
            });
        }
        console.log();
    });

    console.log('============================================================');
    console.log('   总结');
    console.log('============================================================');
    console.log(`Predict 总市场数 (outcomes): ${allMarkets.length}`);
    console.log(`实际事件数（含已结束）: ${eventGroups.size}`);
    console.log(`活跃事件数（仅 REGISTERED）: ${activeEventGroups.length}`);
    console.log(`有 Polymarket 关联的事件: ${linkedEvents.length}`);
    console.log(`  - 活跃: ${activeLinked.length}`);
    console.log(`  - 已结束: ${resolvedLinked.length}`);
}

scanAllEvents().catch(console.error);
