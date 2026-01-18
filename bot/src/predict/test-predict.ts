/**
 * Predict.fun Client Test Script
 * 
 * Tests REST API connectivity and polling mechanism
 * 
 * Usage: npm run test:predict
 * 
 * NOTE: Some tests require PREDICT_API_KEY environment variable
 * Get your API key from: https://predict.fun/settings/api
 */

import * as fs from 'fs';
import * as path from 'path';
import { PredictClient, PredictRestClient, MissingApiKeyError, type NormalizedOrderBook } from './index.js';

// Load .env file from parent directory
function loadEnv() {
    const envPath = path.join(process.cwd(), '..', '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const match = trimmed.match(/^([^=]+)=(.*)$/);
                if (match) {
                    process.env[match[1].trim()] = match[2].trim();
                }
            }
        }
    }
}

loadEnv();

async function main() {
    console.log('='.repeat(60));
    console.log('Predict.fun Client Test');
    console.log('='.repeat(60));

    const client = new PredictClient();

    // Check API Key status
    const hasApiKey = client.rest.hasApiKey();
    console.log(`\nAPI Key Status: ${hasApiKey ? '✓ Configured' : '✗ Not configured'}`);

    if (!hasApiKey) {
        console.log('\n⚠️  API Key not found!');
        console.log('   To get full functionality, set PREDICT_API_KEY environment variable');
        console.log('   Get your API key from: https://predict.fun/settings/api');
        console.log('\n   Running in limited mode (simulated data only)...\n');
    }

    // ============================================================================
    // Test 1: Markets API (may work without API key for public endpoints)
    // ============================================================================
    console.log('\n[Test 1] Fetching markets...');

    try {
        // Use getActiveMarkets to find markets with recent trades
        const markets = await client.rest.getActiveMarkets();
        console.log(`  ✓ Found ${markets.length} active markets`);

        if (markets.length > 0) {
            const market = markets[0];
            console.log(`\n  First market:`);
            console.log(`    ID: ${market.id}`);
            console.log(`    Title: ${market.title?.slice(0, 50)}...`);
            console.log(`    Status: ${market.status}`);
            console.log(`    Category: ${market.categorySlug || 'N/A'}`);

            if (market.outcomes && market.outcomes.length > 0) {
                console.log(`    Outcomes:`);
                for (const outcome of market.outcomes.slice(0, 2)) {
                    console.log(`      - ${outcome.name}: ${outcome.status ?? 'N/A'}`);
                }
            }
        }
    } catch (error) {
        if (error instanceof MissingApiKeyError) {
            console.log('  ⚠️  Skipped: API Key required');
        } else {
            console.error(`  ✗ Failed: ${error}`);
        }
    }

    // ============================================================================
    // Test 2: Order Book API
    // ============================================================================
    console.log('\n[Test 2] Fetching order book...');

    try {
        // Use getActiveMarkets to find markets with orderbooks
        const markets = await client.rest.getActiveMarkets();

        if (markets.length > 0) {
            const marketId = markets[0].id;
            const startTime = Date.now();
            const book = await client.rest.getOrderBook(marketId);
            const latency = Date.now() - startTime;

            console.log(`  ✓ Got order book for market ${marketId} in ${latency}ms`);
            console.log(`    Update Time: ${new Date(book.updateTimestampMs).toISOString()}`);
            console.log(`    Bids: ${book.bids.length} levels`);
            console.log(`    Asks: ${book.asks.length} levels`);

            if (book.bids.length > 0) {
                console.log(`    Best Bid (YES): ${book.bids[0][0]} @ ${book.bids[0][1]}`);
                console.log(`    Best Bid (NO):  ${PredictRestClient.calculateNoPrice(book.bids[0][0]).toFixed(3)}`);
            }
            if (book.asks.length > 0) {
                console.log(`    Best Ask (YES): ${book.asks[0][0]} @ ${book.asks[0][1]}`);
                console.log(`    Best Ask (NO):  ${PredictRestClient.calculateNoPrice(book.asks[0][0]).toFixed(3)}`);
            }

            // Calculate spread
            const { bestBid, bestAsk, spread } = PredictRestClient.getBestPrices(book);
            if (spread !== null) {
                console.log(`    Spread: ${(spread * 100).toFixed(2)}%`);
            }
        } else {
            console.log('  ⚠️  No active markets found');
        }
    } catch (error) {
        if (error instanceof MissingApiKeyError) {
            console.log('  ⚠️  Skipped: API Key required');
        } else {
            console.error(`  ✗ Failed: ${error}`);
        }
    }

    // ============================================================================
    // Test 3: Order Matches (trades)
    // ============================================================================
    console.log('\n[Test 3] Fetching recent trades...');

    try {
        const matches = await client.rest.getOrderMatches({ limit: 5 });
        console.log(`  ✓ Found ${matches.length} recent trades`);

        if (matches.length > 0) {
            console.log(`\n  Recent trades:`);
            for (const match of matches.slice(0, 3)) {
                const time = new Date(match.executedAt).toLocaleTimeString();
                console.log(`    [${time}] Market ${match.market?.id}: ${match.taker.quoteType} ${match.amountFilled} @ ${match.priceExecuted}`);
            }
        }
    } catch (error) {
        if (error instanceof MissingApiKeyError) {
            console.log('  ⚠️  Skipped: API Key required');
        } else {
            console.error(`  ✗ Failed: ${error}`);
        }
    }

    // ============================================================================
    // Test 4: Polling Mechanism (simulated if no API key)
    // ============================================================================
    console.log('\n[Test 4] Testing polling mechanism...');

    try {
        const markets = await client.rest.getActiveMarkets();

        if (markets.length > 0) {
            const marketIds = markets.map(m => m.id);
            let updateCount = 0;
            const updateTimes: number[] = [];

            // Set up handlers
            client.onOrderBook((book: NormalizedOrderBook) => {
                updateCount++;
                updateTimes.push(Date.now());

                if (updateCount <= 5) {
                    const bestBid = book.bids.length > 0 ? book.bids[0][0] : 'N/A';
                    const bestAsk = book.asks.length > 0 ? book.asks[0][0] : 'N/A';
                    console.log(`  📊 Update #${updateCount}: Market ${book.marketId}, Bid=${bestBid}, Ask=${bestAsk}`);
                } else if (updateCount === 6) {
                    console.log('  ... (suppressing further updates)');
                }
            });

            client.onPollingError((error) => {
                console.error(`  ✗ Polling error: ${error.message}`);
            });

            // Subscribe to markets
            console.log(`  Subscribing to ${marketIds.length} markets...`);
            client.subscribe(marketIds);

            // Wait for updates
            console.log('  Polling for 10 seconds...');
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Stop polling
            client.stopPolling();

            // Show stats
            const stats = client.getStats();
            console.log(`\n  📈 Polling Results:`);
            console.log(`     Total polls: ${stats.pollCount}`);
            console.log(`     Total updates: ${updateCount}`);
            console.log(`     Average latency: ${stats.avgLatency.toFixed(1)}ms`);
            console.log(`     Cached order books: ${stats.cachedCount}`);

            if (updateTimes.length >= 2) {
                const intervals: number[] = [];
                for (let i = 1; i < Math.min(updateTimes.length, 50); i++) {
                    intervals.push(updateTimes[i] - updateTimes[i - 1]);
                }
                const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
                console.log(`     Update interval: avg=${avgInterval.toFixed(0)}ms`);
            }
        } else {
            console.log('  ⚠️  No active markets found for polling test');
        }
    } catch (error) {
        if (error instanceof MissingApiKeyError) {
            console.log('  ⚠️  Skipped: API Key required');
            console.log('\n  Simulating polling behavior...');
            console.log('  (With API key, polling would fetch order books every 100ms)');
        } else {
            console.error(`  ✗ Failed: ${error}`);
        }
    }

    // ============================================================================
    // Test 5: Authenticated Endpoints (only with API key)
    // ============================================================================
    if (hasApiKey) {
        console.log('\n[Test 5] Testing authenticated endpoints...');
        console.log('  ⚠️  Authentication test requires wallet signature (skipped in this test)');
        console.log('  Use SDK for full order creation and signing workflow');
    }

    // ============================================================================
    // Summary
    // ============================================================================
    console.log('\n' + '='.repeat(60));
    console.log('Test Complete');
    console.log('='.repeat(60));

    if (!hasApiKey) {
        console.log('\n📝 To enable full functionality:');
        console.log('   1. Go to https://predict.fun/settings/api');
        console.log('   2. Create an API key');
        console.log('   3. Set environment variable: PREDICT_API_KEY=your_key_here');
        console.log('   4. Re-run this test');
    }
}

main().catch(console.error);
