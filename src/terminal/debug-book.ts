// Debug order book data

async function debug() {
    const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5');
    const markets = await gammaRes.json() as any[];
    const m = markets[0];

    console.log('Market:', m.question?.slice(0, 50));
    console.log('Token IDs:', m.clobTokenIds);

    const ids = JSON.parse(m.clobTokenIds);
    console.log('\nYES Token:', ids[0]?.slice(0, 30) + '...');
    console.log('NO Token:', ids[1]?.slice(0, 30) + '...');

    // Fetch YES order book
    console.log('\n=== YES Token Order Book ===');
    const yesBook = await (await fetch('https://clob.polymarket.com/book?token_id=' + ids[0])).json() as any;
    console.log('Bids (buy YES):', yesBook.bids?.slice(0, 3).map((b: any) => b.price + ' x ' + parseFloat(b.size).toFixed(0)).join(', '));
    console.log('Asks (sell YES):', yesBook.asks?.slice(0, 3).map((a: any) => a.price + ' x ' + parseFloat(a.size).toFixed(0)).join(', '));

    if (ids[1]) {
        console.log('\n=== NO Token Order Book ===');
        const noBook = await (await fetch('https://clob.polymarket.com/book?token_id=' + ids[1])).json() as any;
        console.log('Bids (buy NO):', noBook.bids?.slice(0, 3).map((b: any) => b.price + ' x ' + parseFloat(b.size).toFixed(0)).join(', '));
        console.log('Asks (sell NO):', noBook.asks?.slice(0, 3).map((a: any) => a.price + ' x ' + parseFloat(a.size).toFixed(0)).join(', '));
    }
}

debug().catch(console.error);
