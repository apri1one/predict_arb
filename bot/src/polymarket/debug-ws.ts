/**
 * Polymarket WebSocket Debug Test
 * 
 * Detailed debugging of WebSocket connection and messages
 * Uses high-volume markets for better activity
 */

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const GAMMA_URL = 'https://gamma-api.polymarket.com';

interface Market {
    question?: string;
    clobTokenIds?: string;
    volumeNum?: number;
    active?: boolean;
}

async function debugWebSocket() {
    console.log('='.repeat(60));
    console.log('Polymarket WebSocket Debug Test');
    console.log('='.repeat(60));

    // First, get high-volume active markets
    console.log('\n[Step 1] Fetching high-volume markets...');

    const response = await fetch(`${GAMMA_URL}/markets?active=true&closed=false&limit=100`);
    const markets = (await response.json()) as Market[];

    // Sort by volume and filter for valid token IDs
    const activeMarkets = markets
        .filter(m => m.clobTokenIds && m.clobTokenIds !== '[]' && (m.volumeNum ?? 0) > 100000)
        .sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0))
        .slice(0, 5);

    const tokenIds: string[] = [];

    for (const market of activeMarkets) {
        try {
            const ids = JSON.parse(market.clobTokenIds!);
            if (Array.isArray(ids) && ids.length > 0) {
                tokenIds.push(ids[0]); // YES token
                const volume = ((market.volumeNum ?? 0) / 1_000_000).toFixed(2);
                console.log(`  Market: ${market.question?.slice(0, 50)}...`);
                console.log(`    Volume: $${volume}M`);
                console.log(`    Token: ${ids[0].slice(0, 30)}...`);
            }
        } catch { }
    }

    if (tokenIds.length === 0) {
        console.error('  ✗ No valid token IDs found!');
        return;
    }

    console.log(`\n  Total tokens to subscribe: ${tokenIds.length}`);

    console.log(`\n[Step 2] Connecting to WebSocket...`);
    console.log(`  URL: ${WS_URL}`);

    return new Promise<void>((resolve) => {
        const ws = new WebSocket(WS_URL);
        let messageCount = 0;
        let lastPing = Date.now();

        ws.onopen = () => {
            console.log('  ✓ Connected!');

            // Send subscription
            const subscribeMsg = JSON.stringify({
                type: 'market',
                assets_ids: tokenIds
            });

            console.log(`\n[Step 3] Sending subscription...`);
            console.log(`  Payload length: ${subscribeMsg.length} chars`);
            ws.send(subscribeMsg);

            // Start ping
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send('PING');
                    lastPing = Date.now();
                }
            }, 10000);

            // Cleanup on close
            ws.addEventListener('close', () => clearInterval(pingInterval));
        };

        ws.onmessage = (event) => {
            const data = event.data as string;
            const timestamp = new Date().toISOString().slice(11, 23);

            if (data === 'PONG') {
                const latency = Date.now() - lastPing;
                console.log(`  [${timestamp}] PONG (latency: ${latency}ms)`);
                return;
            }

            messageCount++;

            try {
                const parsed = JSON.parse(data);
                const eventType = parsed.event_type || parsed.type || 'unknown';

                console.log(`\n  [${timestamp}] Message #${messageCount}:`);
                console.log(`    Event Type: ${eventType}`);

                if (parsed.asset_id) {
                    console.log(`    Asset ID: ${parsed.asset_id.slice(0, 30)}...`);
                }

                if (eventType === 'book') {
                    console.log(`    Bids: ${parsed.bids?.length || 0} levels`);
                    console.log(`    Asks: ${parsed.asks?.length || 0} levels`);
                    if (parsed.bids?.length > 0) {
                        const bestBid = parsed.bids[0];
                        console.log(`    Best Bid: ${bestBid.price} @ ${bestBid.size}`);
                    }
                    if (parsed.asks?.length > 0) {
                        const bestAsk = parsed.asks[0];
                        console.log(`    Best Ask: ${bestAsk.price} @ ${bestAsk.size}`);
                    }
                } else if (eventType === 'price_change' || eventType === 'last_trade_price') {
                    console.log(`    Price: ${parsed.price}`);
                    if (parsed.side) console.log(`    Side: ${parsed.side}`);
                    if (parsed.size) console.log(`    Size: ${parsed.size}`);
                } else {
                    console.log(`    Keys: ${Object.keys(parsed).join(', ')}`);
                }
            } catch {
                console.log(`  [${timestamp}] Raw message: ${data.slice(0, 100)}...`);
            }
        };

        ws.onerror = (event) => {
            console.error('\n  ✗ WebSocket error:', event);
        };

        ws.onclose = (event) => {
            console.log(`\n[Closed] Code: ${event.code}, Reason: ${event.reason || 'none'}`);
            console.log(`  Total messages received: ${messageCount}`);
            resolve();
        };

        // Run for 30 seconds then close
        console.log('\n[Step 4] Listening for 30 seconds...');
        console.log('  (Waiting for order book updates from high-volume markets)\n');

        setTimeout(() => {
            console.log(`\n[Summary]`);
            console.log(`  Messages received: ${messageCount}`);
            console.log(`  Connection state: ${ws.readyState}`);

            ws.close(1000, 'Debug complete');
        }, 30000);
    });
}

debugWebSocket()
    .then(() => {
        console.log('\n' + '='.repeat(60));
        console.log('Debug Complete');
        console.log('='.repeat(60));
    })
    .catch(console.error);
