/**
 * Polymarket Client Test Script
 * 
 * Tests REST API and WebSocket connectivity
 * Usage: npm run test:polymarket
 */

import { PolymarketClient, type NormalizedOrderBook, type PolymarketMarket, type PricesResponse } from './index.js';

async function main() {
    console.log('='.repeat(60));
    console.log('Polymarket Client Test');
    console.log('='.repeat(60));

    const client = new PolymarketClient();

    // ============================================================================
    // Test 1: REST API - Get Markets (with volume filtering)
    // ============================================================================
    console.log('\n[Test 1] Fetching active markets...');

    let activeMarkets: PolymarketMarket[] = [];

    try {
        // Get markets and filter for ones with order books enabled
        const markets = await client.rest.getMarkets({ active: true, closed: false, limit: 100 });

        // Filter markets with valid token IDs and some volume
        activeMarkets = markets.filter(m => {
            const hasTokenIds = m.clobTokenIds && m.clobTokenIds !== '[]' && m.clobTokenIds !== 'null';
            const hasVolume = (m.volumeNum ?? 0) > 1000; // At least $1000 volume
            return hasTokenIds && hasVolume;
        }).sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0));

        console.log(`  ✓ Found ${markets.length} total markets`);
        console.log(`  ✓ ${activeMarkets.length} have active order books with volume > $1000`);

        if (activeMarkets.length > 0) {
            const market = activeMarkets[0];
            console.log(`\n  Top market by volume:`);
            console.log(`    Question: ${market.question?.slice(0, 60)}...`);
            console.log(`    Volume: $${((market.volumeNum ?? 0) / 1_000_000).toFixed(2)}M`);
            console.log(`    Best Bid: ${market.bestBid}`);
            console.log(`    Best Ask: ${market.bestAsk}`);

            const tokenIds = client.rest.parseTokenIds(market);
            if (tokenIds) {
                console.log(`    YES Token: ${tokenIds.yes.slice(0, 40)}...`);
            }
        }
    } catch (error) {
        console.error(`  ✗ Failed: ${error}`);
    }

    // ============================================================================
    // Test 2: REST API - Get Order Book for top market
    // ============================================================================
    console.log('\n[Test 2] Fetching order book via REST...');

    if (activeMarkets.length > 0) {
        const tokenIds = client.rest.parseTokenIds(activeMarkets[0]);
        if (tokenIds) {
            try {
                const startTime = Date.now();
                const book = await client.rest.getNormalizedOrderBook(tokenIds.yes);
                const latency = Date.now() - startTime;

                console.log(`  ✓ Got order book in ${latency}ms`);
                console.log(`  Bids: ${book.bids.length} levels`);
                console.log(`  Asks: ${book.asks.length} levels`);

                if (book.bids.length > 0) {
                    console.log(`  Best Bid: ${book.bids[0][0]} (size: ${book.bids[0][1].toFixed(2)})`);
                }
                if (book.asks.length > 0) {
                    console.log(`  Best Ask: ${book.asks[0][0]} (size: ${book.asks[0][1].toFixed(2)})`);
                }

                // Calculate spread
                if (book.bids.length > 0 && book.asks.length > 0) {
                    const spread = book.asks[0][0] - book.bids[0][0];
                    console.log(`  Spread: ${(spread * 100).toFixed(2)}%`);
                }
            } catch (error) {
                console.error(`  ✗ Failed: ${error}`);
            }
        }
    } else {
        console.log('  ⚠ No active markets found, skipping...');
    }

    // ============================================================================
    // Test 3: REST API - Batch Price Request
    // ============================================================================
    console.log('\n[Test 3] Batch price request...');

    if (activeMarkets.length >= 3) {
        try {
            const priceRequests: Array<{ token_id: string; side: 'BUY' | 'SELL' }> = [];

            for (let i = 0; i < 3; i++) {
                const tokenIds = client.rest.parseTokenIds(activeMarkets[i]);
                if (tokenIds) {
                    priceRequests.push({ token_id: tokenIds.yes, side: 'BUY' });
                    priceRequests.push({ token_id: tokenIds.yes, side: 'SELL' });
                }
            }

            const startTime = Date.now();
            const prices = await client.rest.getPrices(priceRequests);
            const latency = Date.now() - startTime;

            console.log(`  ✓ Got ${Object.keys(prices).length * 2} prices in ${latency}ms`);

            // Show first few prices
            let count = 0;
            for (const [tokenId, sides] of Object.entries(prices)) {
                if (count >= 2) break;
                console.log(`  Token ${tokenId.slice(0, 20)}... BUY: ${(sides as { BUY?: string; SELL?: string }).BUY}, SELL: ${(sides as { BUY?: string; SELL?: string }).SELL}`);
                count++;
            }
        } catch (error) {
            console.error(`  ✗ Failed: ${error}`);
        }
    } else {
        console.log('  ⚠ Not enough active markets, skipping...');
    }

    // ============================================================================
    // Test 4: WebSocket - Connect and Subscribe to high-volume markets
    // ============================================================================
    console.log('\n[Test 4] Testing WebSocket connection...');

    if (activeMarkets.length > 0) {
        try {
            let updateCount = 0;
            const updateTimes: number[] = [];
            const firstUpdates: { [key: string]: number } = {};

            client.setHandlers({
                onConnect: () => {
                    console.log('  ✓ WebSocket connected');
                },
                onOrderBookUpdate: (book: NormalizedOrderBook) => {
                    const now = Date.now();
                    updateCount++;
                    updateTimes.push(now);

                    // Track first update for each asset
                    if (!firstUpdates[book.assetId]) {
                        firstUpdates[book.assetId] = now;
                    }

                    if (updateCount <= 5) {
                        const bestBid = book.bids.length > 0 ? book.bids[0][0] : 'N/A';
                        const bestAsk = book.asks.length > 0 ? book.asks[0][0] : 'N/A';
                        console.log(`  📊 Update #${updateCount}: Bid=${bestBid}, Ask=${bestAsk}`);
                    } else if (updateCount === 6) {
                        console.log('  ... (suppressing further updates)');
                    }
                },
                onError: (error: Error) => {
                    console.error(`  ✗ WebSocket error: ${error.message}`);
                },
            });

            await client.connect();

            // Subscribe to top 5 markets by volume
            const topMarkets = activeMarkets.slice(0, 5);
            const allTokenIds: string[] = [];

            for (const market of topMarkets) {
                const tokenIds = client.rest.parseTokenIds(market);
                if (tokenIds) {
                    allTokenIds.push(tokenIds.yes, tokenIds.no);
                }
            }

            if (allTokenIds.length > 0) {
                console.log(`  Subscribing to ${allTokenIds.length} tokens from ${topMarkets.length} top markets...`);
                client.subscribeToTokens(allTokenIds);
            }

            // Wait for updates
            console.log('  Waiting 15 seconds for real-time updates...');
            await new Promise(resolve => setTimeout(resolve, 15000));

            console.log(`\n  📈 Results:`);
            console.log(`     Total updates received: ${updateCount}`);
            console.log(`     Unique assets updated: ${Object.keys(firstUpdates).length}`);

            if (updateTimes.length >= 2) {
                const intervals: number[] = [];
                for (let i = 1; i < Math.min(updateTimes.length, 100); i++) {
                    intervals.push(updateTimes[i] - updateTimes[i - 1]);
                }
                const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
                const minInterval = Math.min(...intervals);
                const maxInterval = Math.max(...intervals);
                console.log(`     Update interval: avg=${avgInterval.toFixed(0)}ms, min=${minInterval}ms, max=${maxInterval}ms`);
            }

            // Check cached order books
            const cachedBooks = client.getCachedOrderBooks();
            console.log(`     Cached order books: ${cachedBooks.size}`);

            client.disconnect();
            console.log('  ✓ WebSocket disconnected');

        } catch (error) {
            console.error(`  ✗ Failed: ${error}`);
        }
    } else {
        console.log('  ⚠ No active markets found, skipping WebSocket test...');
    }

    // ============================================================================
    // Summary
    // ============================================================================
    console.log('\n' + '='.repeat(60));
    console.log('Test Complete');
    console.log('='.repeat(60));
}

main().catch(console.error);
