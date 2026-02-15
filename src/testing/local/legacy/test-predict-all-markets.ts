// Test script to fetch ALL Predict markets with pagination
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), '.env') });

const API_KEY = process.env.PREDICT_API_KEY || process.env.PREDICT_API_KEY_SCAN;

async function fetchMarkets(offset: number, limit: number) {
    const url = `https://api.predict.fun/v1/markets?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY!
        }
    });
    return res.json() as Promise<any>;
}

async function main() {
    console.log('=== Fetching ALL Predict Markets with Pagination ===\n');

    let allMarkets: any[] = [];
    let offset = 0;
    const limit = 100;

    // 分页获取所有市场
    while (true) {
        console.log(`Fetching offset=${offset}...`);
        const response = await fetchMarkets(offset, limit);

        if (!response.data || response.data.length === 0) {
            console.log('No more markets.');
            break;
        }

        allMarkets = [...allMarkets, ...response.data];
        console.log(`   Got ${response.data.length} markets, total: ${allMarkets.length}`);

        if (response.data.length < limit) {
            break; // 最后一页
        }

        offset += limit;

        // 防止无限循环
        if (offset > 2000) {
            console.log('Reached max offset limit');
            break;
        }
    }

    console.log(`\nTotal markets fetched: ${allMarkets.length}`);

    // 统计状态
    const statusCounts: Record<string, number> = {};
    for (const m of allMarkets) {
        statusCounts[m.status] = (statusCounts[m.status] || 0) + 1;
    }
    console.log('\nStatus distribution:');
    for (const [status, count] of Object.entries(statusCounts)) {
        console.log(`   ${status}: ${count}`);
    }

    // 筛选体育市场
    const sportsKeywords = ['nba', 'nfl', 'nhl', 'mlb', 'epl', 'soccer', 'at', 'match', 'game', 'vs'];
    const sportsMarkets = allMarkets.filter(m => {
        const cat = (m.categorySlug || '').toLowerCase();
        const title = (m.title || '').toLowerCase();
        const question = (m.question || '').toLowerCase();
        return sportsKeywords.some(k =>
            cat.includes(k) || title.includes(k) || question.includes(k)
        );
    });

    console.log(`\nSports-related markets: ${sportsMarkets.length}`);

    // 显示活跃的体育市场
    const activeSports = sportsMarkets.filter(m => m.status === 'REGISTERED');
    console.log(`Active (REGISTERED) sports markets: ${activeSports.length}`);

    if (activeSports.length > 0) {
        console.log('\n--- Active Sports Markets ---');
        for (const m of activeSports.slice(0, 30)) {
            console.log(`[${m.id}] ${m.title}`);
            console.log(`   Q: ${m.question}`);
            console.log(`   Cat: ${m.categorySlug}`);
            console.log(`   Poly: ${JSON.stringify(m.polymarketConditionIds)}`);
            console.log('');
        }
    }

    // 显示所有体育市场（包括已结算的）
    console.log('\n--- All Sports Markets (including resolved) ---');
    for (const m of sportsMarkets.slice(0, 30)) {
        console.log(`[${m.id}] ${m.title} | ${m.status}`);
        console.log(`   ${m.categorySlug}`);
    }

    // 搜索 "at" 格式的市场（如 Chicago at Houston）
    console.log('\n--- Markets with "at" format ---');
    const atMarkets = allMarkets.filter(m => {
        const title = (m.title || '').toLowerCase();
        const question = (m.question || '').toLowerCase();
        return title.includes(' at ') || question.includes(' at ');
    });
    console.log(`Found ${atMarkets.length} "at" format markets`);
    for (const m of atMarkets.slice(0, 20)) {
        console.log(`[${m.id}] ${m.title} | ${m.status} | ${m.categorySlug}`);
    }
}

main().catch(console.error);
