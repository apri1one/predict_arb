/**
 * Debug script to find active markets
 */

import { PolymarketRestClient } from '../polymarket/index.js';

async function main() {
    console.log('Fetching markets...\n');

    const client = new PolymarketRestClient();
    const markets = await client.getMarkets({ active: true, limit: 30 });

    console.log(`Found ${markets.length} markets\n`);

    let found = 0;

    for (const m of markets) {
        if (!m.clobTokenIds || m.clobTokenIds === '[]') continue;

        const ids = client.parseTokenIds(m);
        if (!ids) continue;

        try {
            const book = await client.getOrderBook(ids.yes);
            const bidCount = book.bids.length;
            const askCount = book.asks.length;

            if (bidCount > 0 || askCount > 0) {
                found++;
                console.log(`[${found}] ${m.question?.slice(0, 60)}`);
                console.log(`    Volume: $${((m.volumeNum ?? 0) / 1000).toFixed(0)}K`);
                console.log(`    Bids: ${bidCount}, Asks: ${askCount}`);
                console.log(`    Token: ${ids.yes.slice(0, 30)}...`);
                console.log();

                if (found >= 5) break;
            }
        } catch (e) {
            // Skip
        }
    }

    if (found === 0) {
        console.log('No markets with order book data found!');
    }
}

main().catch(console.error);
