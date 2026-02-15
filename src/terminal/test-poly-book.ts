/**
 * Quick test: Get Polymarket orderbook using token IDs from event
 */

async function main() {
    // Jake Paul market clobTokenIds from Polymarket event API
    const jakeTokenIds = [
        '17186228930277269925710685008112720110989575576784224613930645093956299392660',
        '18968531329469578817820958932684369618971586158082514800693071870821003163196'
    ];

    console.log('=== Testing Polymarket CLOB with known token IDs ===\n');

    for (let i = 0; i < jakeTokenIds.length; i++) {
        const tokenId = jakeTokenIds[i];
        console.log(`[Token ${i + 1}] ${tokenId.slice(0, 20)}...`);

        const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        console.log(`  Status: ${res.status}`);

        if (res.ok) {
            const book = await res.json() as { bids?: any[]; asks?: any[] };
            console.log(`  Bids: ${book.bids?.length || 0}, Asks: ${book.asks?.length || 0}`);

            if (book.bids && book.bids.length > 0) {
                console.log(`  Best Bid: ${book.bids[0].price} x ${book.bids[0].size}`);
            }
            if (book.asks && book.asks.length > 0) {
                console.log(`  Best Ask: ${book.asks[0].price} x ${book.asks[0].size}`);
            }
        }
        console.log('');
    }
}

main().catch(console.error);
