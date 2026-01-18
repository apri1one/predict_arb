/**
 * 列出所有 REGISTERED 事件标题（简洁版）
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

async function listEventTitles() {
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

    // 筛选 REGISTERED 状态的市场
    const registeredMarkets = allMarkets.filter(m => m.status === 'REGISTERED');

    // 按事件分组
    const eventGroups = new Map<string, any[]>();
    for (const market of registeredMarkets) {
        const eventKey = market.question || `market-${market.id}`;
        if (!eventGroups.has(eventKey)) {
            eventGroups.set(eventKey, []);
        }
        eventGroups.get(eventKey)!.push(market);
    }

    console.log(`REGISTERED 事件总数: ${eventGroups.size}\n`);
    console.log('所有事件标题:\n');

    let index = 0;
    for (const [question, markets] of eventGroups) {
        index++;
        const hasPolymarket = markets.some(m => m.polymarketConditionIds?.length > 0);
        const polyMark = hasPolymarket ? ' [P]' : '';
        const multiMark = markets.length > 1 ? ` [多选×${markets.length}]` : '';
        console.log(`${index}. ${question}${polyMark}${multiMark}`);
    }

    console.log(`\n总计: ${eventGroups.size} 个事件`);
    console.log(`[P] = 有 Polymarket 关联`);
    console.log(`[多选×N] = 多选事件（N个选项）`);
}

listEventTitles().catch(console.error);
