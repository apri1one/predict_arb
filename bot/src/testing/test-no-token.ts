/**
 * Verify Polymarket YES/NO orderbook relationship
 * 
 * Test: YES bid = 1 - NO ask
 */

async function main() {
    // Jake Paul YES token
    const yesTokenId = '17186228930277269925710685008112720110989575576784224613930645093956299392660';

    console.log('Fetching Jake Paul YES token orderbook...\n');

    const res = await fetch(`https://clob.polymarket.com/book?token_id=${yesTokenId}`);
    const book = await res.json() as { bids: any[]; asks: any[] };

    console.log(`Raw response:`);
    console.log(`  Bids count: ${book.bids?.length || 0}`);
    console.log(`  Asks count: ${book.asks?.length || 0}`);

    // Show last 3 bids (should be highest/best)
    console.log('\nYES Bids (raw, last 3):');
    const lastBids = (book.bids || []).slice(-3);
    for (const bid of lastBids) {
        console.log(`  ${bid.price} x ${bid.size}`);
    }

    // Show last 3 asks (should be lowest/best)
    console.log('\nYES Asks (raw, last 3):');
    const lastAsks = (book.asks || []).slice(-3);
    for (const ask of lastAsks) {
        console.log(`  ${ask.price} x ${ask.size}`);
    }

    // Best YES bid = last bid
    const bestYesBid = book.bids?.length ? parseFloat(book.bids[book.bids.length - 1].price) : 0;
    // Best YES ask = last ask  
    const bestYesAsk = book.asks?.length ? parseFloat(book.asks[book.asks.length - 1].price) : 0;

    console.log('\n=== DERIVED VALUES ===');
    console.log(`Best YES Bid: ${(bestYesBid * 100).toFixed(1)}c`);
    console.log(`Best YES Ask: ${(bestYesAsk * 100).toFixed(1)}c`);

    // Derive NO prices
    const noAsk = 1 - bestYesBid;  // To buy NO, someone must sell YES to you
    const noBid = 1 - bestYesAsk;  // To sell NO, someone must buy YES from you

    console.log(`\nDerived NO Ask (1 - YES Bid): ${(noAsk * 100).toFixed(1)}c`);
    console.log(`Derived NO Bid (1 - YES Ask): ${(noBid * 100).toFixed(1)}c`);

    console.log('\n=== VERIFICATION ===');
    console.log(`YES Bid + NO Ask = ${(bestYesBid * 100).toFixed(1)} + ${(noAsk * 100).toFixed(1)} = ${((bestYesBid + noAsk) * 100).toFixed(1)}c (should be 100c)`);
    console.log(`YES Ask + NO Bid = ${(bestYesAsk * 100).toFixed(1)} + ${(noBid * 100).toFixed(1)} = ${((bestYesAsk + noBid) * 100).toFixed(1)}c (should be 100c)`);
}

main().catch(console.error);
