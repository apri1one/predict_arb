// Debug WebSocket messages

import WebSocket from 'ws';

async function debug() {
    console.log('Fetching Spurs market...\n');

    const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false');
    const markets = await gammaRes.json() as any[];

    const spurs = markets.find(m => (m.question || '').toLowerCase().includes('spurs'));
    if (!spurs) {
        console.log('Spurs market not found');
        return;
    }

    console.log('Market:', spurs.question);
    const ids = JSON.parse(spurs.clobTokenIds);
    const tokenId = ids[0];
    console.log('Token ID:', tokenId.slice(0, 40) + '...\n');

    // Connect to WebSocket
    const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    console.log('Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log('\n✓ WebSocket connected!\n');

        // Try different subscription formats
        const subscribeMsg = {
            type: 'market',
            assets_ids: [tokenId],
        };

        console.log('Sending subscription:', JSON.stringify(subscribeMsg, null, 2));
        ws.send(JSON.stringify(subscribeMsg));
    });

    ws.on('message', (data: WebSocket.Data) => {
        const msg = data.toString();
        console.log('\n=== Message received ===');
        console.log('Length:', msg.length);

        try {
            const parsed = JSON.parse(msg);
            console.log('Type:', parsed.type || parsed.event_type);
            console.log('Keys:', Object.keys(parsed));

            if (parsed.data) {
                console.log('Data length:', Array.isArray(parsed.data) ? parsed.data.length : 'not array');
                if (Array.isArray(parsed.data) && parsed.data.length > 0) {
                    console.log('First item keys:', Object.keys(parsed.data[0]));
                }
            }

            // Show full message if small
            if (msg.length < 500) {
                console.log('Full message:', msg);
            }
        } catch {
            console.log('Raw:', msg.slice(0, 200));
        }
    });

    ws.on('error', (err) => {
        console.log('Error:', err.message);
    });

    ws.on('close', () => {
        console.log('Disconnected');
    });

    // Keep alive for 30 seconds
    setTimeout(() => {
        ws.close();
        console.log('\n\nDone!');
        process.exit(0);
    }, 30000);
}

debug().catch(console.error);
