/**
 * Debug: Find matching markets between Predict and Polymarket
 */

import * as fs from 'fs';
import * as path from 'path';

// Load env
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

async function main() {
    const apiKey = process.env.PREDICT_API_KEY!;

    console.log('=== DEBUG: Matching Markets ===\n');

    // 1. Get linked markets from Predict
    console.log('[1] Fetching Predict markets with Polymarket links...');
    const matchRes = await fetch('https://api.predict.fun/v1/orders/matches?first=100', {
        headers: { 'x-api-key': apiKey }
    });
    const matchData = await matchRes.json() as { data?: any[] };

    const linkedMarkets: any[] = [];
    const seen = new Set<number>();
    for (const m of matchData.data || []) {
        if (m.market && m.market.polymarketConditionIds?.length > 0 && !seen.has(m.market.id)) {
            seen.add(m.market.id);
            linkedMarkets.push(m.market);
        }
    }

    console.log(`    Found ${linkedMarkets.length} linked markets\n`);

    // 2. Get Polymarket markets
    console.log('[2] Fetching Polymarket markets...');
    const polyRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500');
    const polyMarkets = await polyRes.json() as any[];
    console.log(`    Found ${polyMarkets.length} Polymarket markets\n`);

    // Search for similar markets by keyword
    console.log('[3] Searching for matching markets by keyword...\n');

    for (const pm of linkedMarkets) {
        const title = pm.title.toLowerCase();
        const keywords = title.split(/\s+/).filter((w: string) => w.length > 3);

        console.log(`Predict: "${pm.title}"`);
        console.log(`  Condition: ${pm.polymarketConditionIds[0]}`);

        // Search Polymarket
        const matches = polyMarkets.filter(poly => {
            const q = (poly.question || '').toLowerCase();
            return keywords.some((k: string) => q.includes(k));
        });

        if (matches.length > 0) {
            console.log(`  Found ${matches.length} possible Polymarket match(es):`);
            for (const m of matches.slice(0, 3)) {
                console.log(`    - "${m.question?.slice(0, 50)}..."`);
                console.log(`      conditionId: ${m.conditionId}`);
                console.log(`      Match: ${m.conditionId === pm.polymarketConditionIds[0] ? 'EXACT' : 'KEYWORD ONLY'}`);
            }
        } else {
            console.log(`  No Polymarket matches found`);
        }
        console.log('');
    }
}

main().catch(console.error);
