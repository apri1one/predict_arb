/**
 * 模拟前端过滤逻辑，找出显示 25 个市场的可能规则
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

async function simulateFrontendFilter() {
    console.log('============================================================');
    console.log('   模拟前端过滤逻辑（目标：25 个市场）');
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

    console.log(`总 REGISTERED 市场: ${registeredMarkets.length}\n`);

    // 按事件分组
    const eventGroups = new Map<string, any[]>();
    for (const market of registeredMarkets) {
        const eventKey = market.question || `market-${market.id}`;
        if (!eventGroups.has(eventKey)) {
            eventGroups.set(eventKey, []);
        }
        eventGroups.get(eventKey)!.push(market);
    }

    console.log(`总事件数: ${eventGroups.size}\n`);

    // 分类
    const withPolymarket: any[] = [];
    const withoutPolymarket: any[] = [];

    for (const [question, markets] of eventGroups) {
        const hasPolymarket = markets.some(m => m.polymarketConditionIds?.length > 0);
        if (hasPolymarket) {
            withPolymarket.push({ question, markets });
        } else {
            withoutPolymarket.push({ question, markets });
        }
    }

    console.log(`有 Polymarket 关联的事件: ${withPolymarket.length} 个`);
    console.log(`无 Polymarket 关联的事件: ${withoutPolymarket.length} 个\n`);

    // 假设：前端显示 = 所有 Polymarket 事件 + 部分精选的无 Polymarket 事件
    const targetCount = 25;
    const needFromNoPoly = targetCount - withPolymarket.length;

    console.log(`需要从无 Polymarket 事件中选择: ${needFromNoPoly} 个\n`);

    // 策略 1: 排除短期/日内市场和系列市场
    console.log('--- 策略 1: 排除特定模式的市场 ---\n');

    const excluded = withoutPolymarket.filter(event => {
        const q = event.question.toLowerCase();

        // 排除条件
        const isShortTerm = q.includes('up or down') || q.includes('dec 2');
        const isBtcSeries = q.includes('bitcoin reach') && q.includes('by december 31');
        const isNbaNfl = q.includes(' vs ') && q.includes('winner');
        const isFedNominee = q.includes('trump nominate') && q.includes('fed chair');

        return isShortTerm || isBtcSeries || isNbaNfl || isFedNominee;
    });

    const included = withoutPolymarket.filter(event => {
        const q = event.question.toLowerCase();

        const isShortTerm = q.includes('up or down') || q.includes('dec 2');
        const isBtcSeries = q.includes('bitcoin reach') && q.includes('by december 31');
        const isNbaNfl = q.includes(' vs ') && q.includes('winner');
        const isFedNominee = q.includes('trump nominate') && q.includes('fed chair');

        return !(isShortTerm || isBtcSeries || isNbaNfl || isFedNominee);
    });

    console.log(`排除的事件 (${excluded.length} 个):`);
    excluded.forEach(e => console.log(`  - ${e.question}`));
    console.log();

    console.log(`保留的事件 (${included.length} 个):`);
    included.forEach(e => console.log(`  - ${e.question}`));
    console.log();

    const strategy1Total = withPolymarket.length + included.length;
    console.log(`策略 1 总数: ${withPolymarket.length} (Polymarket) + ${included.length} (其他) = ${strategy1Total} 个\n`);

    // 策略 2: 按 ID 排序，取前 N 个
    console.log('--- 策略 2: 按 ID 排序取前 N 个 ---\n');

    const sortedByIdAsc = [...withoutPolymarket].sort((a, b) => {
        const idA = Math.min(...a.markets.map((m: any) => m.id));
        const idB = Math.min(...b.markets.map((m: any) => m.id));
        return idA - idB;
    });

    const strategy2Selected = sortedByIdAsc.slice(0, needFromNoPoly);
    const strategy2Total = withPolymarket.length + strategy2Selected.length;

    console.log(`按 ID 升序取前 ${needFromNoPoly} 个:`);
    strategy2Selected.forEach(e => {
        const minId = Math.min(...e.markets.map((m: any) => m.id));
        console.log(`  - ${e.question} (ID: ${minId})`);
    });
    console.log();
    console.log(`策略 2 总数: ${strategy2Total} 个\n`);

    // 策略 3: 按 question 字母排序
    console.log('--- 策略 3: 按 question 字母排序 ---\n');

    const sortedByQuestion = [...withoutPolymarket].sort((a, b) =>
        a.question.localeCompare(b.question)
    );

    const strategy3Selected = sortedByQuestion.slice(0, needFromNoPoly);
    const strategy3Total = withPolymarket.length + strategy3Selected.length;

    console.log(`按字母排序取前 ${needFromNoPoly} 个:`);
    strategy3Selected.forEach(e => console.log(`  - ${e.question}`));
    console.log();
    console.log(`策略 3 总数: ${strategy3Total} 个\n`);

    // 输出最终推荐
    console.log('============================================================');
    console.log('   分析结果');
    console.log('============================================================');
    console.log(`策略 1 (排除模式): ${strategy1Total} 个 ${strategy1Total === 25 ? '✅ 匹配!' : ''}`);
    console.log(`策略 2 (按 ID 排序): ${strategy2Total} 个 ${strategy2Total === 25 ? '✅ 匹配!' : ''}`);
    console.log(`策略 3 (字母排序): ${strategy3Total} 个 ${strategy3Total === 25 ? '✅ 匹配!' : ''}`);
    console.log();

    if (strategy1Total === 25) {
        console.log('✅ 策略 1 可能是前端使用的过滤逻辑！');
        console.log('前端显示的市场 = 所有 Polymarket 关联的事件 + 排除特定模式后的其他事件');
    }
}

simulateFrontendFilter().catch(console.error);
