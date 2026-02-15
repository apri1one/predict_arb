/**
 * 检查 Predict 市场状态字段，对比前端 "open" 状态
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

async function checkMarketStatus() {
    console.log('============================================================');
    console.log('   检查 Predict 市场状态字段');
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

    console.log(`总计获取: ${allMarkets.length} 个市场\n`);

    // 按状态分组统计
    const statusGroups = new Map<string, any[]>();
    for (const market of allMarkets) {
        const status = market.status || 'UNKNOWN';
        if (!statusGroups.has(status)) {
            statusGroups.set(status, []);
        }
        statusGroups.get(status)!.push(market);
    }

    console.log('--- 按状态分组统计 ---\n');
    for (const [status, markets] of statusGroups) {
        console.log(`${status}: ${markets.length} 个市场`);
    }
    console.log();

    // 检查 REGISTERED 市场的其他字段
    console.log('--- REGISTERED 市场的其他可能过滤字段 ---\n');

    const registeredMarkets = statusGroups.get('REGISTERED') || [];
    console.log(`REGISTERED 市场总数: ${registeredMarkets.length}\n`);

    // 检查是否有其他字段可能影响前端显示
    const fieldStats = {
        hasEndDate: 0,
        hasPolymarket: 0,
        hasVolume: 0,
        hasLiquidity: 0,
    };

    const endDateFuture: any[] = [];
    const now = Date.now();

    for (const market of registeredMarkets) {
        // 检查结束日期
        if (market.endDate) {
            fieldStats.hasEndDate++;
            const endTime = new Date(market.endDate).getTime();
            if (endTime > now) {
                endDateFuture.push(market);
            }
        }

        // 检查 Polymarket 关联
        if (market.polymarketConditionIds?.length > 0) {
            fieldStats.hasPolymarket++;
        }

        // 检查交易量
        if (market.volume && parseFloat(market.volume) > 0) {
            fieldStats.hasVolume++;
        }

        // 检查流动性
        if (market.liquidity && parseFloat(market.liquidity) > 0) {
            fieldStats.hasLiquidity++;
        }
    }

    console.log('字段统计:');
    console.log(`  有结束日期: ${fieldStats.hasEndDate} 个`);
    console.log(`  结束日期在未来: ${endDateFuture.length} 个`);
    console.log(`  有 Polymarket 关联: ${fieldStats.hasPolymarket} 个`);
    console.log(`  有交易量 (volume > 0): ${fieldStats.hasVolume} 个`);
    console.log(`  有流动性 (liquidity > 0): ${fieldStats.hasLiquidity} 个\n`);

    // 按事件分组 REGISTERED 市场
    const eventGroups = new Map<string, any[]>();
    for (const market of registeredMarkets) {
        const eventKey = market.question || `market-${market.id}`;
        if (!eventGroups.has(eventKey)) {
            eventGroups.set(eventKey, []);
        }
        eventGroups.get(eventKey)!.push(market);
    }

    console.log(`REGISTERED 市场按事件分组: ${eventGroups.size} 个事件\n`);

    // 检查结束日期在未来的事件
    const futureEventGroups = new Map<string, any[]>();
    for (const market of endDateFuture) {
        const eventKey = market.question || `market-${market.id}`;
        if (!futureEventGroups.has(eventKey)) {
            futureEventGroups.set(eventKey, []);
        }
        futureEventGroups.get(eventKey)!.push(market);
    }

    console.log(`结束日期在未来的事件: ${futureEventGroups.size} 个\n`);

    // 输出示例市场信息
    console.log('--- 示例市场信息 (前 3 个 REGISTERED 市场) ---\n');
    registeredMarkets.slice(0, 3).forEach((m, i) => {
        console.log(`${i + 1}. ${m.title || m.question}`);
        console.log(`   ID: ${m.id}`);
        console.log(`   Status: ${m.status}`);
        console.log(`   Question: ${m.question}`);
        console.log(`   EndDate: ${m.endDate}`);
        console.log(`   Volume: ${m.volume}`);
        console.log(`   Liquidity: ${m.liquidity}`);
        console.log(`   Has Polymarket: ${m.polymarketConditionIds?.length > 0 ? 'Yes' : 'No'}`);
        console.log();
    });

    console.log('============================================================');
    console.log('   总结');
    console.log('============================================================');
    console.log(`总市场数: ${allMarkets.length}`);
    console.log(`REGISTERED 市场: ${registeredMarkets.length} 个市场`);
    console.log(`REGISTERED 事件: ${eventGroups.size} 个事件`);
    console.log(`结束日期在未来的事件: ${futureEventGroups.size} 个事件`);
    console.log(`\n如果前端显示 25 个 "open" 事件，可能的过滤条件:`);
    console.log(`  1. status === 'REGISTERED' ✓`);
    console.log(`  2. endDate > now (结束日期在未来)`);
    console.log(`  3. 或其他未知的前端过滤逻辑`);
}

checkMarketStatus().catch(console.error);
