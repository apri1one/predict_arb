/**
 * Test Predict API - Find active markets with orderbooks
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
    const apiKey = process.env.PREDICT_API_KEY;
    const baseUrl = 'https://api.predict.fun';

    console.log('='.repeat(70));
    console.log('Predict API - Active Markets Test');
    console.log('='.repeat(70));

    // 1. Get recent order matches to find active markets
    console.log('\n[1] Fetching recent order matches...');
    const matchRes = await fetch(`${baseUrl}/v1/orders/matches?first=50`, {
        headers: { 'x-api-key': apiKey! }
    });

    if (!matchRes.ok) {
        console.log('Failed:', matchRes.status, await matchRes.text());
        return;
    }

    const matchData = await matchRes.json() as { data?: any[] };
    console.log('Recent matches found:', matchData.data?.length || 0);

    // Find unique markets with recent trades
    const marketMap = new Map<number, any>();
    for (const match of matchData.data || []) {
        if (match.market && !marketMap.has(match.market.id)) {
            marketMap.set(match.market.id, {
                ...match.market,
                lastTrade: match.executedAt,
                lastPrice: match.priceExecuted
            });
        }
    }

    console.log('Unique markets with recent trades:', marketMap.size);

    // Show recent trades
    console.log('\n[2] Markets with recent trades:');
    console.log('-'.repeat(70));
    for (const [id, market] of Array.from(marketMap.entries()).slice(0, 10)) {
        console.log(`\nID: ${id} | Status: ${market.status}`);
        console.log(`  Title: ${market.title?.slice(0, 55)}`);
        console.log(`  Last Trade: ${market.lastTrade} @ ${market.lastPrice}`);
        if (market.polymarketConditionIds?.length > 0) {
            console.log(`  Polymarket: ${market.polymarketConditionIds[0]}`);
        }
    }

    // 3. Try to get orderbooks for these markets
    console.log('\n[3] Testing orderbooks for markets with recent trades...');
    console.log('-'.repeat(70));

    let successCount = 0;
    for (const [marketId, market] of Array.from(marketMap.entries()).slice(0, 15)) {
        try {
            const obRes = await fetch(`${baseUrl}/v1/markets/${marketId}/orderbook`, {
                headers: { 'x-api-key': apiKey! }
            });

            if (obRes.ok) {
                const ob = await obRes.json() as {
                    data?: {
                        bids?: [number, number][];
                        asks?: [number, number][];
                        updateTimestampMs?: number;
                    }
                };
                const bidsCount = ob.data?.bids?.length || 0;
                const asksCount = ob.data?.asks?.length || 0;

                if (bidsCount > 0 || asksCount > 0) {
                    successCount++;
                    console.log(`\n[OK] Market ${marketId}: ${market.title?.slice(0, 40)}...`);
                    console.log(`     Status: ${market.status}`);
                    console.log(`     Bids: ${bidsCount} | Asks: ${asksCount}`);

                    if (ob.data?.bids && ob.data.bids.length > 0) {
                        const [yesPrice, size] = ob.data.bids[0];
                        console.log(`     Best Bid YES: ${yesPrice} (size: ${size.toFixed(2)})`);
                        console.log(`     Best Bid NO:  ${(1 - yesPrice).toFixed(3)}`);
                    }
                    if (ob.data?.asks && ob.data.asks.length > 0) {
                        const [yesPrice, size] = ob.data.asks[0];
                        console.log(`     Best Ask YES: ${yesPrice} (size: ${size.toFixed(2)})`);
                        console.log(`     Best Ask NO:  ${(1 - yesPrice).toFixed(3)}`);
                    }
                } else {
                    console.log(`[EMPTY] Market ${marketId}: Empty orderbook`);
                }
            } else {
                const errText = await obRes.text();
                console.log(`[FAIL] Market ${marketId}: ${obRes.status} - ${errText.slice(0, 50)}`);
            }
        } catch (e) {
            console.log(`[ERROR] Market ${marketId}: ${e}`);
        }
    }

    console.log('\n' + '='.repeat(70));
    console.log(`Summary: ${successCount} markets have active orderbooks`);
    console.log('='.repeat(70));
}

main().catch(console.error);
