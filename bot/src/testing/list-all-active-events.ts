/**
 * 列出所有活跃（REGISTERED）事件供用户核对
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

async function listAllActiveEvents() {
    console.log('============================================================');
    console.log('   列出所有 REGISTERED 状态的事件');
    console.log('============================================================\n');

    // 1. 获取所有市场
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

    console.log(`总计获取: ${allMarkets.length} 个市场\n`);

    // 2. 筛选 REGISTERED 状态的市场
    const registeredMarkets = allMarkets.filter(m => m.status === 'REGISTERED');
    console.log(`REGISTERED 市场: ${registeredMarkets.length} 个\n`);

    // 3. 按事件分组
    const eventGroups = new Map<string, any[]>();
    for (const market of registeredMarkets) {
        const eventKey = market.question || `market-${market.id}`;
        if (!eventGroups.has(eventKey)) {
            eventGroups.set(eventKey, []);
        }
        eventGroups.get(eventKey)!.push(market);
    }

    console.log(`REGISTERED 事件总数: ${eventGroups.size} 个\n`);
    console.log('============================================================\n');

    // 4. 列出所有事件
    let eventIndex = 0;
    for (const [question, markets] of eventGroups) {
        eventIndex++;
        const hasPolymarket = markets.some(m => m.polymarketConditionIds?.length > 0);
        const polymarketMark = hasPolymarket ? ' [有 Polymarket 关联]' : '';

        console.log(`${eventIndex}. ${question}${polymarketMark}`);

        if (markets.length > 1) {
            console.log(`   类型: 多选事件 (${markets.length} 个选项)`);
            console.log(`   选项:`);
            markets.forEach(m => {
                console.log(`     - ${m.title} (ID: ${m.id})`);
            });
        } else {
            console.log(`   类型: 二元事件 (YES/NO)`);
            console.log(`   市场 ID: ${markets[0].id}`);
        }

        const firstMarket = markets[0];
        if (firstMarket.endDate) {
            const endDate = new Date(firstMarket.endDate);
            const now = new Date();
            const isExpired = endDate < now;
            console.log(`   结束日期: ${firstMarket.endDate}${isExpired ? ' [已过期]' : ' [未来]'}`);
        }

        if (firstMarket.volume) {
            console.log(`   交易量: ${firstMarket.volume}`);
        }

        if (hasPolymarket) {
            const conditionId = markets.find(m => m.polymarketConditionIds?.length > 0)?.polymarketConditionIds[0];
            console.log(`   Polymarket Condition ID: ${conditionId}`);
        }

        console.log();
    }

    console.log('============================================================');
    console.log('   统计');
    console.log('============================================================');

    const binaryEvents = Array.from(eventGroups.values()).filter(g => g.length === 1);
    const multiChoiceEvents = Array.from(eventGroups.values()).filter(g => g.length > 1);
    const polymarketLinked = Array.from(eventGroups.values()).filter(g =>
        g.some(m => m.polymarketConditionIds?.length > 0)
    );

    // 检查结束日期
    const now = new Date();
    const futureEvents = Array.from(eventGroups.entries()).filter(([_, markets]) => {
        const endDate = markets[0].endDate ? new Date(markets[0].endDate) : null;
        return endDate && endDate > now;
    });

    console.log(`总事件数（REGISTERED）: ${eventGroups.size}`);
    console.log(`  - 二元事件: ${binaryEvents.length}`);
    console.log(`  - 多选事件: ${multiChoiceEvents.length}`);
    console.log(`  - 有 Polymarket 关联: ${polymarketLinked.length}`);
    console.log(`  - 结束日期在未来: ${futureEvents.length}`);
}

listAllActiveEvents().catch(console.error);
