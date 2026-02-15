// Test script to fetch active Predict markets via order matches
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PredictRestClient } from './src/predict/rest-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), '.env') });

async function main() {
    const client = new PredictRestClient();

    console.log('=== Fetching Active Predict Markets ===\n');

    // 方法 1: 通过最近交易获取活跃市场
    console.log('1. Getting active markets via order matches...');
    const activeMarkets = await client.getActiveMarkets(200);
    console.log(`   Found ${activeMarkets.length} markets with recent trades\n`);

    // 统计状态
    const statusCounts: Record<string, number> = {};
    for (const m of activeMarkets) {
        statusCounts[m.status] = (statusCounts[m.status] || 0) + 1;
    }
    console.log('Status distribution:');
    for (const [status, count] of Object.entries(statusCounts)) {
        console.log(`   ${status}: ${count}`);
    }

    // 筛选体育市场
    const sportsKeywords = ['nba', 'nfl', 'nhl', 'mlb', 'epl', 'soccer', ' at ', 'match', 'game', 'vs', 'lol', 'dota'];
    const sportsMarkets = activeMarkets.filter(m => {
        const cat = (m.categorySlug || '').toLowerCase();
        const title = (m.title || '').toLowerCase();
        const question = (m.question || '').toLowerCase();
        return sportsKeywords.some(k =>
            cat.includes(k) || title.includes(k) || question.includes(k)
        );
    });

    console.log(`\nSports-related markets: ${sportsMarkets.length}`);

    // 显示所有活跃市场
    console.log('\n--- All Active Markets ---');
    for (const m of activeMarkets) {
        const polyLink = m.polymarketConditionIds?.length > 0 ? '✓Poly' : '';
        console.log(`[${m.id}] ${m.title} | ${m.status} ${polyLink}`);
        console.log(`   Cat: ${m.categorySlug}`);
    }

    // 显示有 Polymarket 链接的市场
    const linkedMarkets = activeMarkets.filter(m => m.polymarketConditionIds && m.polymarketConditionIds.length > 0);
    console.log(`\n--- Markets with Polymarket Link: ${linkedMarkets.length} ---`);
    for (const m of linkedMarkets) {
        console.log(`[${m.id}] ${m.title}`);
        console.log(`   Cat: ${m.categorySlug}`);
        console.log(`   PolyIds: ${m.polymarketConditionIds?.join(', ')?.slice(0, 80)}`);
        console.log('');
    }

    // 方法 2: 直接调用 order matches API 查看最近交易
    console.log('\n2. Recent order matches (trades):');
    const matches = await client.getOrderMatches({ limit: 20 });
    console.log(`   Found ${matches.length} recent trades`);

    for (const match of matches.slice(0, 10)) {
        console.log(`   Trade: ${match.market?.title} @ ${match.priceExecuted} (${match.amountFilled})`);
    }
}

main().catch(console.error);
