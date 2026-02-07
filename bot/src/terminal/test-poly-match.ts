/**
 * Test: How to correctly get Polymarket orderbook using Predict's polymarketConditionIds
 */

import * as fs from 'fs';
import * as path from 'path';

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

async function main() {
    const apiKey = process.env.PREDICT_API_KEY!;

    console.log('=== Testing Polymarket Orderbook Retrieval ===\n');

    // Get linked markets from Predict
    console.log('[1] Fetching linked markets from Predict...');
    const matchRes = await fetch('https://api.predict.fun/v1/orders/matches?first=100', {
        headers: { 'x-api-key': apiKey }
    });
    const matchData = await matchRes.json() as { data?: any[] };

    const linkedMarkets: any[] = [];
    const seen = new Set<number>();
    for (const m of matchData.data || []) {
        if (m.market?.polymarketConditionIds?.length > 0 && !seen.has(m.market.id)) {
            seen.add(m.market.id);
            linkedMarkets.push(m.market);
        }
    }

    console.log(`    Found ${linkedMarkets.length} linked markets\n`);

    for (const market of linkedMarkets.slice(0, 3)) {
        const conditionId = market.polymarketConditionIds[0];

        console.log('='.repeat(70));
        console.log(`Predict: ${market.title}`);
        console.log(`Condition ID: ${conditionId}`);
        console.log('');

        // Method 1: Search Polymarket by condition_id
        console.log('  [Method 1] GET /markets?condition_id=...');
        try {
            const r1 = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
            const d1 = await r1.json() as any[];
            console.log(`    Result: ${d1.length} market(s) found`);
            if (d1.length > 0) {
                console.log(`    Question: ${d1[0].question?.slice(0, 50)}`);
                console.log(`    clobTokenIds: ${d1[0].clobTokenIds?.slice(0, 60)}`);
            }
        } catch (e) {
            console.log(`    Error: ${e}`);
        }

        // Method 2: Try CLOB book directly with condition ID
        console.log('\n  [Method 2] GET /book?token_id={conditionId}');
        try {
            const r2 = await fetch(`https://clob.polymarket.com/book?token_id=${conditionId}`);
            console.log(`    Status: ${r2.status}`);
            if (r2.ok) {
                const d2 = await r2.json() as { bids?: any[]; asks?: any[] };
                console.log(`    Bids: ${d2.bids?.length || 0}, Asks: ${d2.asks?.length || 0}`);
            }
        } catch (e) {
            console.log(`    Error: ${e}`);
        }

        // Method 3: Search in all active Polymarket markets
        console.log('\n  [Method 3] Search all active markets by conditionId match...');
        try {
            const r3 = await fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500`);
            const d3 = await r3.json() as any[];
            const match = d3.find(m => m.conditionId === conditionId);
            if (match) {
                console.log(`    FOUND: ${match.question?.slice(0, 50)}`);
                console.log(`    clobTokenIds: ${match.clobTokenIds}`);

                // Try to get orderbook
                if (match.clobTokenIds) {
                    const tokenIds = JSON.parse(match.clobTokenIds);
                    if (tokenIds.length > 0) {
                        const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${tokenIds[0]}`);
                        if (bookRes.ok) {
                            const book = await bookRes.json() as { bids?: any[]; asks?: any[] };
                            console.log(`    Orderbook: ${book.bids?.length || 0} bids, ${book.asks?.length || 0} asks`);
                        }
                    }
                }
            } else {
                console.log(`    NOT FOUND in active markets`);
            }
        } catch (e) {
            console.log(`    Error: ${e}`);
        }

        console.log('');
    }
}

main().catch(console.error);
