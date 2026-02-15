// Find markets with balanced prices (not 0.1% or 99.9%)

async function test() {
    console.log('Finding markets with balanced order books...\n');

    // Get more markets
    const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50');
    const markets = await gammaRes.json() as { question?: string; clobTokenIds?: string }[];

    let found = 0;

    for (const m of markets) {
        if (!m.clobTokenIds || m.clobTokenIds === '[]') continue;

        try {
            const ids = JSON.parse(m.clobTokenIds);
            if (!ids.length) continue;

            const tokenId = ids[0];
            const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
            const book = await bookRes.json() as { bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] };

            // Check if there are bids AND asks with reasonable prices (not 0.1% or 99.9%)
            const hasBids = book.bids?.some((b: { price: string }) => {
                const p = parseFloat(b.price);
                return p > 0.05 && p < 0.95;
            });
            const hasAsks = book.asks?.some((a: { price: string }) => {
                const p = parseFloat(a.price);
                return p > 0.05 && p < 0.95;
            });

            if (hasBids || hasAsks) {
                found++;
                console.log(`[${found}] ${m.question?.slice(0, 55)}`);
                console.log(`    Token: ${tokenId.slice(0, 30)}...`);

                // Find reasonable bids
                const goodBids = (book.bids || []).filter((b: { price: string }) => {
                    const p = parseFloat(b.price);
                    return p > 0.05 && p < 0.95;
                }).slice(0, 3);

                const goodAsks = (book.asks || []).filter((a: { price: string }) => {
                    const p = parseFloat(a.price);
                    return p > 0.05 && p < 0.95;
                }).slice(0, 3);

                if (goodBids.length > 0) {
                    console.log('    Bids:');
                    goodBids.forEach((b: { price: string; size: string }) => {
                        console.log(`      ${(parseFloat(b.price) * 100).toFixed(1)}¢ x ${parseFloat(b.size).toFixed(0)}`);
                    });
                }
                if (goodAsks.length > 0) {
                    console.log('    Asks:');
                    goodAsks.forEach((a: { price: string; size: string }) => {
                        console.log(`      ${(parseFloat(a.price) * 100).toFixed(1)}¢ x ${parseFloat(a.size).toFixed(0)}`);
                    });
                }
                console.log();

                if (found >= 5) break;
            }
        } catch (e) {
            // Skip
        }
    }

    if (found === 0) {
        console.log('No markets with balanced prices found in first 50.');
    } else {
        console.log(`Found ${found} markets with balanced prices.`);
    }
}

test().catch(console.error);
