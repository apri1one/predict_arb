/**
 * Live Maker Strategy Test
 * 
 * Runs the Maker strategy with REAL API data
 * Currently only places mock orders (TODO: integrate real order API)
 * 
 * Usage: npx tsx src/testing/test-maker-live.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { MakerStrategy, type MarketPair } from '../trading/maker-strategy.js';

// Load env
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

// Known market pairs for testing
const JAKE_PAUL_MARKET: MarketPair = {
    name: 'Jake Paul vs Anthony Joshua - Jake Paul',
    predictMarketId: 539,
    predictFeeRateBps: 200,
    polymarketTokenIdYes: '17186228930277269925710685008112720110989575576784224613930645093956299392660',
    polymarketTokenIdNo: '', // Not used - NO prices derived from YES orderbook
};

async function main() {
    console.log('='.repeat(70));
    console.log('           MAKER STRATEGY - LIVE TEST');
    console.log('           ' + new Date().toLocaleString());
    console.log('='.repeat(70));

    // Validate config
    if (!process.env.PREDICT_API_KEY) {
        console.log('\n❌ Missing PREDICT_API_KEY in .env');
        return;
    }

    console.log('\n✓ PREDICT_API_KEY found');
    console.log(`✓ TELEGRAM: ${process.env.TELEGRAM_BOT_TOKEN ? 'enabled' : 'disabled'}`);

    // Create strategy
    const strategy = new MakerStrategy({
        orderbookPollIntervalMs: 2000,  // Poll every 2 seconds for testing
        minProfitPercent: 0,            // Any profit
        maxPositionPerMarket: 100,      // Max 100 shares for testing
    });

    console.log('\n' + '='.repeat(70));
    console.log('           STARTING STRATEGY');
    console.log('='.repeat(70));
    console.log(`\nMarket: ${JAKE_PAUL_MARKET.name}`);
    console.log(`Predict ID: ${JAKE_PAUL_MARKET.predictMarketId}`);
    console.log(`Poll Interval: 2000ms`);
    console.log('\nPress Ctrl+C to stop\n');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n\nReceived SIGINT, stopping...');
        await strategy.stop('User interrupt (Ctrl+C)');

        const state = strategy.getState();
        console.log('\n' + '='.repeat(70));
        console.log('           FINAL STATE');
        console.log('='.repeat(70));
        console.log(`\nTrades Executed: ${state.tradesExecuted}`);
        console.log(`Total Profit: $${state.totalProfit.toFixed(2)}`);

        process.exit(0);
    });

    // Start strategy
    await strategy.start(JAKE_PAUL_MARKET);

    // Keep running indefinitely
    console.log('[MAIN] Strategy running. Watching for arbitrage...\n');
}

main().catch(console.error);
