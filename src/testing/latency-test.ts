/**
 * Latency Testing Suite
 * 
 * Tests:
 * 1. Predict REST API orderbook latency
 * 2. Polymarket WebSocket subscription latency
 * 3. Polymarket REST API latency
 * 4. BSC RPC node latency (for chain monitoring)
 */

import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';

// Load env
function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

interface LatencyResult {
    name: string;
    samples: number[];
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
}

function calculateStats(name: string, samples: number[]): LatencyResult {
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);

    return {
        name,
        samples,
        min: sorted[0] || 0,
        max: sorted[sorted.length - 1] || 0,
        avg: samples.length > 0 ? sum / samples.length : 0,
        p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
        p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
        p99: sorted[Math.floor(sorted.length * 0.99)] || 0,
    };
}

function printResult(result: LatencyResult) {
    console.log(`\n  ${result.name}:`);
    console.log(`    Samples: ${result.samples.length}`);
    console.log(`    Min: ${result.min.toFixed(1)}ms`);
    console.log(`    Max: ${result.max.toFixed(1)}ms`);
    console.log(`    Avg: ${result.avg.toFixed(1)}ms`);
    console.log(`    P50: ${result.p50.toFixed(1)}ms`);
    console.log(`    P95: ${result.p95.toFixed(1)}ms`);
    console.log(`    P99: ${result.p99.toFixed(1)}ms`);
}

// Test 1: Predict REST API
async function testPredictRest(marketId: number, iterations: number = 20): Promise<LatencyResult> {
    const apiKey = process.env.PREDICT_API_KEY!;
    const url = `https://api.predict.fun/v1/markets/${marketId}/orderbook`;
    const samples: number[] = [];

    console.log(`\n  Testing Predict REST API (${iterations} requests)...`);

    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        try {
            const res = await fetch(url, {
                headers: { 'x-api-key': apiKey }
            });
            await res.json();
            const latency = performance.now() - start;
            samples.push(latency);
            process.stdout.write(`\r    Request ${i + 1}/${iterations}: ${latency.toFixed(0)}ms`);
        } catch (e) {
            console.log(`    Request ${i + 1} failed`);
        }
        // Small delay between requests
        await new Promise(r => setTimeout(r, 100));
    }
    console.log('');

    return calculateStats('Predict REST API', samples);
}

// Test 2: Polymarket REST API
async function testPolymarketRest(tokenId: string, iterations: number = 20): Promise<LatencyResult> {
    const url = `https://clob.polymarket.com/book?token_id=${tokenId}`;
    const samples: number[] = [];

    console.log(`\n  Testing Polymarket REST API (${iterations} requests)...`);

    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        try {
            const res = await fetch(url);
            await res.json();
            const latency = performance.now() - start;
            samples.push(latency);
            process.stdout.write(`\r    Request ${i + 1}/${iterations}: ${latency.toFixed(0)}ms`);
        } catch (e) {
            console.log(`    Request ${i + 1} failed`);
        }
        await new Promise(r => setTimeout(r, 100));
    }
    console.log('');

    return calculateStats('Polymarket REST API', samples);
}

// Test 3: Polymarket WebSocket
async function testPolymarketWebSocket(tokenId: string, duration: number = 15000): Promise<LatencyResult> {
    return new Promise((resolve) => {
        const samples: number[] = [];
        const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

        console.log(`\n  Testing Polymarket WebSocket (${duration / 1000}s)...`);

        const ws = new WebSocket(wsUrl);
        let subscribeTime = 0;
        let firstMessageTime = 0;
        let messageCount = 0;
        let lastMessageTime = 0;

        ws.on('open', () => {
            console.log('    Connected');
            subscribeTime = performance.now();

            // Subscribe to orderbook - format from working ws-client.ts  
            const subMsg = JSON.stringify({
                type: 'market',
                assets_ids: [tokenId],
            });
            console.log(`    Sending: ${subMsg.slice(0, 80)}`);
            ws.send(subMsg);
        });

        ws.on('message', (data) => {
            const now = performance.now();
            const msg = data.toString();

            if (msg === 'PONG') return;

            messageCount++;

            if (firstMessageTime === 0) {
                firstMessageTime = now;
                const subscriptionLatency = now - subscribeTime;
                console.log(`    First message: ${subscriptionLatency.toFixed(0)}ms after subscribe`);
                samples.push(subscriptionLatency);
            } else {
                const interval = now - lastMessageTime;
                samples.push(interval);
            }

            lastMessageTime = now;
            process.stdout.write(`\r    Messages received: ${messageCount}`);
        });

        ws.on('error', (err) => {
            console.log(`    Error: ${err.message}`);
        });

        // Ping every 5 seconds
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send('PING');
            }
        }, 5000);

        setTimeout(() => {
            clearInterval(pingInterval);
            ws.close();
            console.log('');
            console.log(`    Total messages: ${messageCount}`);

            if (samples.length > 1) {
                // First sample is subscription latency, rest are message intervals
                const intervalSamples = samples.slice(1);
                const result = calculateStats('Polymarket WebSocket (message interval)', intervalSamples);
                result.samples.unshift(samples[0]); // Add subscription latency back
                resolve(result);
            } else {
                resolve(calculateStats('Polymarket WebSocket', samples));
            }
        }, duration);
    });
}

// Test 4: BSC RPC Nodes
async function testBscRpc(iterations: number = 10): Promise<LatencyResult[]> {
    const rpcEndpoints = [
        { name: 'BSC Official', url: 'https://bsc-dataseed.bnbchain.org/' },
        { name: 'BSC Dataseed 1', url: 'https://bsc-dataseed1.bnbchain.org/' },
        { name: 'BSC Dataseed 2', url: 'https://bsc-dataseed2.bnbchain.org/' },
        { name: 'Ankr', url: 'https://rpc.ankr.com/bsc' },
        { name: 'PublicNode', url: 'https://bsc-rpc.publicnode.com' },
    ];

    const results: LatencyResult[] = [];

    console.log(`\n  Testing BSC RPC Nodes (${iterations} requests each)...`);

    for (const endpoint of rpcEndpoints) {
        const samples: number[] = [];
        console.log(`\n    ${endpoint.name}:`);

        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            try {
                const res = await fetch(endpoint.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'eth_blockNumber',
                        params: [],
                        id: 1
                    })
                });
                await res.json();
                const latency = performance.now() - start;
                samples.push(latency);
                process.stdout.write(`\r      Request ${i + 1}/${iterations}: ${latency.toFixed(0)}ms`);
            } catch (e) {
                console.log(`      Request ${i + 1} failed`);
            }
            await new Promise(r => setTimeout(r, 50));
        }
        console.log('');

        results.push(calculateStats(`BSC RPC: ${endpoint.name}`, samples));
    }

    return results;
}

async function main() {
    console.log('='.repeat(70));
    console.log('              LATENCY TESTING SUITE');
    console.log('              ' + new Date().toLocaleString());
    console.log('='.repeat(70));

    // Get a Predict market with Polymarket link for testing
    const apiKey = process.env.PREDICT_API_KEY!;

    console.log('\n[0] Finding test market...');
    const matchRes = await fetch('https://api.predict.fun/v1/orders/matches?first=50', {
        headers: { 'x-api-key': apiKey }
    });
    const matchData = await matchRes.json() as { data?: any[] };

    let predictMarketId = 539; // Jake Paul default
    let polyTokenId = '17186228930277269925710685008112720110989575576784224613930645093956299392660';

    for (const m of matchData.data || []) {
        if (m.market?.polymarketConditionIds?.length > 0) {
            predictMarketId = m.market.id;
            // Get Polymarket token
            const conditionId = m.market.polymarketConditionIds[0];
            try {
                const evRes = await fetch(`https://gamma-api.polymarket.com/events?slug=boxing-jake-paul-vs-anthony-joshua-third-option-included`);
                const events = await evRes.json() as any[];
                if (events[0]?.markets) {
                    for (const pm of events[0].markets) {
                        if (pm.conditionId === conditionId && pm.clobTokenIds) {
                            polyTokenId = JSON.parse(pm.clobTokenIds)[0];
                            break;
                        }
                    }
                }
            } catch { }
            break;
        }
    }

    console.log(`    Predict Market ID: ${predictMarketId}`);
    console.log(`    Polymarket Token: ${polyTokenId.slice(0, 20)}...`);

    const allResults: LatencyResult[] = [];

    // Test 1: Predict REST
    console.log('\n' + '='.repeat(70));
    console.log('[1] PREDICT REST API LATENCY');
    console.log('='.repeat(70));
    const predictResult = await testPredictRest(predictMarketId, 20);
    printResult(predictResult);
    allResults.push(predictResult);

    // Test 2: Polymarket REST
    console.log('\n' + '='.repeat(70));
    console.log('[2] POLYMARKET REST API LATENCY');
    console.log('='.repeat(70));
    const polyRestResult = await testPolymarketRest(polyTokenId, 20);
    printResult(polyRestResult);
    allResults.push(polyRestResult);

    // Test 3: Polymarket WebSocket
    console.log('\n' + '='.repeat(70));
    console.log('[3] POLYMARKET WEBSOCKET LATENCY');
    console.log('='.repeat(70));
    const polyWsResult = await testPolymarketWebSocket(polyTokenId, 15000);
    printResult(polyWsResult);
    allResults.push(polyWsResult);

    // Test 4: BSC RPC
    console.log('\n' + '='.repeat(70));
    console.log('[4] BSC RPC NODE LATENCY');
    console.log('='.repeat(70));
    const rpcResults = await testBscRpc(10);
    for (const r of rpcResults) {
        printResult(r);
        allResults.push(r);
    }

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('                        SUMMARY');
    console.log('='.repeat(70));
    console.log('\n  | Test                          | Avg (ms) | P95 (ms) |');
    console.log('  |-------------------------------|----------|----------|');
    for (const r of allResults) {
        const name = r.name.padEnd(29);
        const avg = r.avg.toFixed(0).padStart(6);
        const p95 = r.p95.toFixed(0).padStart(6);
        console.log(`  | ${name} | ${avg}   | ${p95}   |`);
    }

    console.log('\n' + '='.repeat(70));
    console.log('                    TEST COMPLETE');
    console.log('='.repeat(70));
}

main().catch(console.error);
