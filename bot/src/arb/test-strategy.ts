/**
 * Predict Strategy Test Script
 * 
 * Demonstrates:
 * 1. Binary arbitrage detection (YES + NO < 1)
 * 2. Price gap detection using Polymarket as reference
 * 3. Market making opportunities
 * 
 * Usage: npx tsx src/arb/test-strategy.ts
 */

import {
    PredictStrategy,
    createPredictStrategy,
    type PredictOrderBook,
    type PolymarketReference,
} from './index.js';

// ============================================================================
// Helper: Create mock order book
// ============================================================================

function createMockOrderBook(
    marketId: number,
    yesBestBid: number,
    yesBestAsk: number,
    yesQty: number = 1000
): PredictOrderBook {
    // NO prices are inverse of YES
    const noBestBid = 1 - yesBestAsk;
    const noBestAsk = 1 - yesBestBid;

    return {
        marketId,
        yesBids: [
            { price: yesBestBid, quantity: yesQty, platform: 'predict' },
            { price: yesBestBid - 0.01, quantity: yesQty * 2, platform: 'predict' },
        ],
        yesAsks: [
            { price: yesBestAsk, quantity: yesQty, platform: 'predict' },
            { price: yesBestAsk + 0.01, quantity: yesQty * 2, platform: 'predict' },
        ],
        noBids: [
            { price: noBestBid, quantity: yesQty, platform: 'predict' },
            { price: noBestBid - 0.01, quantity: yesQty * 2, platform: 'predict' },
        ],
        noAsks: [
            { price: noBestAsk, quantity: yesQty, platform: 'predict' },
            { price: noBestAsk + 0.01, quantity: yesQty * 2, platform: 'predict' },
        ],
        lastUpdate: Date.now(),
    };
}

// ============================================================================
// Main Test
// ============================================================================

async function main() {
    console.log('='.repeat(60));
    console.log('Predict Strategy Test');
    console.log('='.repeat(60));

    const strategy = createPredictStrategy({
        minBinaryArbProfit: 0.003,      // 0.3% min profit
        minPriceGap: 0.02,              // 2% min gap
        maxPositionSize: 500,
        minPositionSize: 10,
    });

    // ============================================================================
    // Test 1: Normal market (no arb)
    // ============================================================================
    console.log('\n[Test 1] Normal market - No arbitrage');

    // YES@0.60/0.62, NO@0.38/0.40 -> Total = 0.62 + 0.40 = 1.02 (no arb)
    const normalBook = createMockOrderBook(1, 0.60, 0.62);

    const normalResult = strategy.analyze(normalBook);
    console.log(`  Analysis:`);
    console.log(`    YES mid: ${normalResult.marketAnalysis.predictYesMid.toFixed(3)}`);
    console.log(`    YES spread: ${(normalResult.marketAnalysis.predictYesSpread * 100).toFixed(2)}%`);
    console.log(`    Binary arb profit: ${normalResult.marketAnalysis.binaryArbProfit.toFixed(4)}`);
    console.log(`    Has binary arb: ${normalResult.marketAnalysis.hasBinaryArb}`);
    console.log(`  Opportunities: ${normalResult.opportunities.length}`);
    console.log(`  Signals: ${normalResult.signals.length}`);

    // ============================================================================
    // Test 2: Binary arbitrage opportunity
    // ============================================================================
    console.log('\n[Test 2] Binary arbitrage - YES + NO < 1');

    // YES@0.48, NO@0.48 -> Total = 0.96 (4% profit!)
    const arbBook: PredictOrderBook = {
        marketId: 2,
        yesBids: [{ price: 0.47, quantity: 500, platform: 'predict' }],
        yesAsks: [{ price: 0.48, quantity: 500, platform: 'predict' }],
        noBids: [{ price: 0.51, quantity: 500, platform: 'predict' }],  // 1 - 0.49
        noAsks: [{ price: 0.48, quantity: 500, platform: 'predict' }],  // Deliberately mispriced!
        lastUpdate: Date.now(),
    };

    const arbResult = strategy.analyze(arbBook);
    console.log(`  Analysis:`);
    console.log(`    YES ask: 0.48`);
    console.log(`    NO ask: 0.48`);
    console.log(`    Total cost: 0.96`);
    console.log(`    Binary arb profit: ${arbResult.marketAnalysis.binaryArbProfit.toFixed(4)}`);
    console.log(`    Has binary arb: ${arbResult.marketAnalysis.hasBinaryArb}`);

    if (arbResult.opportunities.length > 0) {
        const opp = arbResult.opportunities[0];
        console.log(`\n  🎯 Opportunity Found!`);
        console.log(`    Type: ${opp.type}`);
        console.log(`    Expected profit: $${opp.expectedProfit.toFixed(2)}`);
        console.log(`    Profit %: ${(opp.expectedProfitPercent * 100).toFixed(2)}%`);
        console.log(`    Recommended qty: ${opp.recommendedQuantity.toFixed(2)}`);
        console.log(`    Confidence: ${opp.confidence}%`);
        console.log(`    Reason: ${opp.reason}`);
    }

    if (arbResult.signals.length > 0) {
        console.log(`\n  📊 Trade Signals:`);
        for (const signal of arbResult.signals) {
            console.log(`    ${signal.type} ${signal.side} @ ${signal.targetPrice.toFixed(3)} (${signal.urgency})`);
        }
    }

    // ============================================================================
    // Test 3: Price gap vs Polymarket
    // ============================================================================
    console.log('\n[Test 3] Price gap - Predict underpriced vs Polymarket');

    // Predict: YES@0.55/0.57
    const gapBook = createMockOrderBook(3, 0.55, 0.57);

    // Polymarket: YES@0.65 (Predict is 12% cheaper!)
    const polyReference: PolymarketReference = {
        yesPrice: 0.65,
        noPrice: 0.35,
        spread: 0.01,
        volume24h: 100000,
        lastUpdate: Date.now(),
    };

    const gapResult = strategy.analyze(gapBook, polyReference);
    console.log(`  Analysis:`);
    console.log(`    Predict YES mid: ${gapResult.marketAnalysis.predictYesMid.toFixed(3)}`);
    console.log(`    Polymarket YES: ${gapResult.marketAnalysis.polymarketYesMid?.toFixed(3)}`);
    console.log(`    Price gap: ${gapResult.marketAnalysis.priceGap?.toFixed(3)}`);
    console.log(`    Gap %: ${((gapResult.marketAnalysis.priceGapPercent ?? 0) * 100).toFixed(2)}%`);

    if (gapResult.opportunities.length > 0) {
        const priceGapOpp = gapResult.opportunities.find(o => o.type === 'price_gap');
        if (priceGapOpp) {
            console.log(`\n  🎯 Price Gap Opportunity!`);
            console.log(`    Action: ${priceGapOpp.action} ${priceGapOpp.side}`);
            console.log(`    Current price: ${priceGapOpp.currentPrice.toFixed(3)}`);
            console.log(`    Target (fair value): ${priceGapOpp.fairValue.toFixed(3)}`);
            console.log(`    Expected profit %: ${(priceGapOpp.expectedProfitPercent * 100).toFixed(2)}%`);
            console.log(`    Confidence: ${priceGapOpp.confidence}%`);
            console.log(`    Reason: ${priceGapOpp.reason}`);
        }
    }

    if (gapResult.signals.length > 0) {
        console.log(`\n  📊 Trade Signals:`);
        for (const signal of gapResult.signals) {
            console.log(`    ${signal.type} ${signal.side}: qty=${signal.quantity.toFixed(2)}, confidence=${signal.confidence}% (${signal.urgency})`);
        }
    }

    // ============================================================================
    // Test 4: Wide spread - Market making opportunity
    // ============================================================================
    console.log('\n[Test 4] Wide spread - Market making opportunity');

    // YES@0.45/0.55 (10% spread!)
    const wideBook = createMockOrderBook(4, 0.45, 0.55);

    const wideResult = strategy.analyze(wideBook);
    console.log(`  Analysis:`);
    console.log(`    YES mid: ${wideResult.marketAnalysis.predictYesMid.toFixed(3)}`);
    console.log(`    YES spread: ${(wideResult.marketAnalysis.predictYesSpread * 100).toFixed(2)}%`);

    const mmOpps = wideResult.opportunities.filter(o => o.type === 'market_making');
    if (mmOpps.length > 0) {
        console.log(`\n  💰 Market Making Opportunities: ${mmOpps.length}`);
        for (const opp of mmOpps) {
            console.log(`    - ${opp.action}: Quote @ ${opp.targetPrice.toFixed(3)} (fair: ${opp.fairValue.toFixed(3)})`);
            console.log(`      Expected profit: $${opp.expectedProfit.toFixed(2)}`);
        }
    }

    // ============================================================================
    // Summary
    // ============================================================================
    console.log('\n' + '='.repeat(60));
    console.log('Strategy Summary');
    console.log('='.repeat(60));
    console.log('\n📈 Detected Opportunity Types:');
    console.log('   1. Binary Arbitrage: Buy YES + NO when sum < 1 (guaranteed profit)');
    console.log('   2. Price Gap: Trade when Predict price differs from Polymarket');
    console.log('   3. Market Making: Provide liquidity when spreads are wide');
    console.log('\n🔑 Key Insight: Use Polymarket as price reference, trade on Predict!');
}

main().catch(console.error);
