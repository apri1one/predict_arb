/**
 * 网络延迟测试
 *
 * 测试本地到 Polymarket / Predict / BSC 的 REST + WS 延迟
 * 用法: npx tsx src/testing/test-network-latency.ts
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

// ============================================================================
// 统计工具
// ============================================================================

interface Stats {
    name: string;
    count: number;
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
}

function calcStats(name: string, samples: number[]): Stats {
    if (samples.length === 0) return { name, count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0 };
    const sorted = [...samples].sort((a, b) => a - b);
    return {
        name,
        count: samples.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: samples.reduce((a, b) => a + b, 0) / samples.length,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
    };
}

function printStats(s: Stats) {
    console.log(`  ${s.name}`);
    console.log(`    样本: ${s.count} | Min: ${s.min.toFixed(0)}ms | Avg: ${s.avg.toFixed(0)}ms | P50: ${s.p50.toFixed(0)}ms | P95: ${s.p95.toFixed(0)}ms | Max: ${s.max.toFixed(0)}ms`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ============================================================================
// 测试函数
// ============================================================================

/** REST 延迟测试 (通用) */
async function testRest(name: string, url: string, headers: Record<string, string>, n: number): Promise<Stats> {
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        try {
            const res = await fetch(url, { headers });
            await res.text();
            samples.push(performance.now() - t0);
        } catch (e: any) {
            console.log(`    #${i + 1} 失败: ${e.message}`);
        }
        if (i < n - 1) await sleep(50);
    }
    return calcStats(name, samples);
}

/** Polymarket WS 连接 + 首条消息延迟 */
async function testPolyWs(tokenId: string): Promise<Stats> {
    const samples: number[] = [];
    const ROUNDS = 3;

    for (let r = 0; r < ROUNDS; r++) {
        const t0 = performance.now();
        const connected = await new Promise<number>((resolve) => {
            const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
            const timeout = setTimeout(() => { ws.close(); resolve(-1); }, 10000);

            ws.on('open', () => {
                const connectTime = performance.now() - t0;
                ws.send(JSON.stringify({ type: 'market', assets_ids: [tokenId] }));

                ws.on('message', (data) => {
                    if (data.toString() === 'PONG') return;
                    const total = performance.now() - t0;
                    clearTimeout(timeout);
                    ws.close();
                    resolve(total);
                });
            });

            ws.on('error', () => { clearTimeout(timeout); ws.close(); resolve(-1); });
        });

        if (connected > 0) samples.push(connected);
        if (r < ROUNDS - 1) await sleep(500);
    }
    return calcStats('Polymarket WS (connect+subscribe+first msg)', samples);
}

/** Predict WS 连接延迟 */
async function testPredictWs(): Promise<Stats> {
    const samples: number[] = [];
    const ROUNDS = 3;

    for (let r = 0; r < ROUNDS; r++) {
        const t0 = performance.now();
        const connected = await new Promise<number>((resolve) => {
            const ws = new WebSocket('wss://ws.predict.fun/ws');
            const timeout = setTimeout(() => { ws.close(); resolve(-1); }, 10000);

            ws.on('open', () => {
                clearTimeout(timeout);
                const latency = performance.now() - t0;
                ws.close();
                resolve(latency);
            });

            ws.on('error', () => { clearTimeout(timeout); ws.close(); resolve(-1); });
        });

        if (connected > 0) samples.push(connected);
        if (r < ROUNDS - 1) await sleep(500);
    }
    return calcStats('Predict WS (connect)', samples);
}

/** BSC RPC 延迟 */
async function testBscRpc(n: number): Promise<Stats[]> {
    const endpoints = [
        { name: 'BSC Official', url: 'https://bsc-dataseed.bnbchain.org/' },
        { name: 'BSC Dataseed1', url: 'https://bsc-dataseed1.bnbchain.org/' },
        { name: 'Ankr BSC', url: 'https://rpc.ankr.com/bsc' },
        { name: 'PublicNode BSC', url: 'https://bsc-rpc.publicnode.com' },
    ];

    const results: Stats[] = [];
    for (const ep of endpoints) {
        const samples: number[] = [];
        for (let i = 0; i < n; i++) {
            const t0 = performance.now();
            try {
                const res = await fetch(ep.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
                });
                await res.json();
                samples.push(performance.now() - t0);
            } catch { }
            if (i < n - 1) await sleep(50);
        }
        results.push(calcStats(`BSC RPC: ${ep.name}`, samples));
    }
    return results;
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) {
        console.error('❌ 缺少 PREDICT_API_KEY');
        process.exit(1);
    }

    const N = 20;
    console.log('═'.repeat(65));
    console.log('  网络延迟测试');
    console.log('  ' + new Date().toLocaleString());
    console.log('═'.repeat(65));

    // 找一个活跃市场
    console.log('\n[0] 查找测试市场...');
    let predictMarketId = 0;
    let polyTokenId = '';

    try {
        const res = await fetch('https://api.predict.fun/v1/markets?_limit=20&status=active', {
            headers: { 'x-api-key': apiKey },
        });
        const data = await res.json() as any;
        const markets = data.data || data || [];
        for (const m of markets) {
            if (m.clobTokenIds && m.clobTokenIds.length >= 2) {
                predictMarketId = m.id;
                polyTokenId = m.clobTokenIds[0];
                console.log(`  Predict #${predictMarketId}: ${m.title?.slice(0, 50) || 'N/A'}`);
                break;
            }
        }
    } catch { }

    // fallback: 从 Polymarket 拿一个活跃 token
    if (!polyTokenId) {
        try {
            const res = await fetch('https://gamma-api.polymarket.com/markets?closed=false&limit=1');
            const markets = await res.json() as any[];
            if (markets[0]?.clobTokenIds) {
                polyTokenId = JSON.parse(markets[0].clobTokenIds)[0];
                console.log(`  Polymarket fallback token: ${polyTokenId.slice(0, 20)}...`);
            }
        } catch { }
    }

    const allStats: Stats[] = [];

    // ── 1. Predict REST ──
    console.log('\n' + '─'.repeat(65));
    console.log('[1] Predict REST API');
    console.log('─'.repeat(65));

    if (predictMarketId) {
        const s = await testRest(
            'Predict REST (orderbook)',
            `https://api.predict.fun/v1/markets/${predictMarketId}/orderbook`,
            { 'x-api-key': apiKey },
            N,
        );
        printStats(s);
        allStats.push(s);
    }

    const s1b = await testRest(
        'Predict REST (markets list)',
        'https://api.predict.fun/v1/markets?_limit=1&status=active',
        { 'x-api-key': apiKey },
        N,
    );
    printStats(s1b);
    allStats.push(s1b);

    // ── 2. Polymarket REST ──
    console.log('\n' + '─'.repeat(65));
    console.log('[2] Polymarket REST API');
    console.log('─'.repeat(65));

    if (polyTokenId) {
        const s = await testRest(
            'Polymarket REST (orderbook)',
            `https://clob.polymarket.com/book?token_id=${polyTokenId}`,
            {},
            N,
        );
        printStats(s);
        allStats.push(s);
    }

    const s2b = await testRest(
        'Polymarket REST (Gamma markets)',
        'https://gamma-api.polymarket.com/markets?closed=false&limit=1',
        {},
        N,
    );
    printStats(s2b);
    allStats.push(s2b);

    // ── 3. WebSocket ──
    console.log('\n' + '─'.repeat(65));
    console.log('[3] WebSocket 连接延迟');
    console.log('─'.repeat(65));

    if (polyTokenId) {
        const s = await testPolyWs(polyTokenId);
        printStats(s);
        allStats.push(s);
    }

    const sPws = await testPredictWs();
    printStats(sPws);
    allStats.push(sPws);

    // ── 4. BSC RPC ──
    console.log('\n' + '─'.repeat(65));
    console.log('[4] BSC RPC 节点');
    console.log('─'.repeat(65));

    const bscResults = await testBscRpc(10);
    for (const s of bscResults) {
        printStats(s);
        allStats.push(s);
    }

    // ── 汇总 ──
    console.log('\n' + '═'.repeat(65));
    console.log('  汇总');
    console.log('═'.repeat(65));
    console.log('  | 测试项                                       | Avg    | P50    | P95    |');
    console.log('  |----------------------------------------------|--------|--------|--------|');
    for (const s of allStats) {
        const name = s.name.padEnd(44);
        const avg = (s.avg.toFixed(0) + 'ms').padStart(6);
        const p50 = (s.p50.toFixed(0) + 'ms').padStart(6);
        const p95 = (s.p95.toFixed(0) + 'ms').padStart(6);
        console.log(`  | ${name} | ${avg} | ${p50} | ${p95} |`);
    }
    console.log('═'.repeat(65));
}

main().catch(console.error);
