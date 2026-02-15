/**
 * 实时订单簿变化监控
 *
 * 同时使用 WS 和 REST 监控订单簿，实时显示变化和延迟对比
 *
 * 用法:
 *   npx tsx src/testing/monitor-orderbook-realtime.ts <marketId>
 */

import { config } from 'dotenv';
config();

import { PredictWsClient, OrderbookUpdateData } from '../services/predict-ws-client.js';
import { PredictRestClient } from '../predict/rest-client.js';

const API_KEY = process.env.PREDICT_API_KEY || '';
const REST_POLL_MS = 100;

interface Snapshot {
    bestBid: number | null;
    bidQty: number | null;
    bestAsk: number | null;
    askQty: number | null;
    time: number;
}

function snap(data: { bids: [number, number][]; asks: [number, number][] }): Snapshot {
    return {
        bestBid: data.bids[0]?.[0] ?? null,
        bidQty: data.bids[0]?.[1] ?? null,
        bestAsk: data.asks[0]?.[0] ?? null,
        askQty: data.asks[0]?.[1] ?? null,
        time: Date.now(),
    };
}

function fmt(n: number | null, decimals = 4): string {
    return n === null ? '  N/A  ' : n.toFixed(decimals).padStart(7);
}

function changed(a: Snapshot | null, b: Snapshot): string[] {
    if (!a) return [];
    const changes: string[] = [];
    if (a.bestBid !== b.bestBid) changes.push(`bid: ${fmt(a.bestBid)} → ${fmt(b.bestBid)}`);
    if (a.bestAsk !== b.bestAsk) changes.push(`ask: ${fmt(a.bestAsk)} → ${fmt(b.bestAsk)}`);
    if (a.bidQty !== b.bidQty) changes.push(`bidQty: ${a.bidQty?.toFixed(0)} → ${b.bidQty?.toFixed(0)}`);
    if (a.askQty !== b.askQty) changes.push(`askQty: ${a.askQty?.toFixed(0)} → ${b.askQty?.toFixed(0)}`);
    return changes;
}

async function main() {
    const marketId = parseInt(process.argv[2], 10);
    if (isNaN(marketId)) {
        console.error('用法: npx tsx src/testing/monitor-orderbook-realtime.ts <marketId>');
        process.exit(1);
    }

    console.log('='.repeat(70));
    console.log(`实时监控市场 ${marketId} 订单簿变化`);
    console.log('='.repeat(70));
    console.log('WS + REST 同时监控，实时显示变化和延迟');
    console.log('按 Ctrl+C 退出\n');

    const restClient = new PredictRestClient({ apiKey: API_KEY });
    const wsClient = new PredictWsClient({ apiKey: API_KEY });

    let wsSnap: Snapshot | null = null;
    let restSnap: Snapshot | null = null;
    let wsCount = 0;
    let restCount = 0;

    // 统计
    const latencies: { wsFirst: number[]; restFirst: number[] } = { wsFirst: [], restFirst: [] };
    const pendingWs = new Map<string, number>(); // hash -> wsTime
    const pendingRest = new Map<string, number>(); // hash -> restTime

    function snapHash(s: Snapshot): string {
        return `${s.bestBid}:${s.bidQty}:${s.bestAsk}:${s.askQty}`;
    }

    function onWsUpdate(data: OrderbookUpdateData) {
        const newSnap = snap(data);
        const now = Date.now();
        wsCount++;

        const ch = changed(wsSnap, newSnap);
        if (ch.length > 0) {
            const hash = snapHash(newSnap);
            const restTime = pendingRest.get(hash);

            if (restTime) {
                // REST 先检测到
                const diff = now - restTime;
                latencies.restFirst.push(diff);
                console.log(`[WS  ] 变化 (REST 先 ${diff}ms): ${ch.join(', ')}`);
                pendingRest.delete(hash);
            } else {
                // WS 先检测到
                pendingWs.set(hash, now);
                console.log(`[WS  ] 变化: ${ch.join(', ')}`);
            }
        }

        wsSnap = newSnap;
    }

    function onRestUpdate(book: { bids: [number, number][]; asks: [number, number][] }) {
        const newSnap = snap(book);
        const now = Date.now();
        restCount++;

        const ch = changed(restSnap, newSnap);
        if (ch.length > 0) {
            const hash = snapHash(newSnap);
            const wsTime = pendingWs.get(hash);

            if (wsTime) {
                // WS 先检测到
                const diff = now - wsTime;
                latencies.wsFirst.push(diff);
                console.log(`[REST] 变化 (WS 先 ${diff}ms): ${ch.join(', ')}`);
                pendingWs.delete(hash);
            } else {
                // REST 先检测到
                pendingRest.set(hash, now);
                console.log(`[REST] 变化: ${ch.join(', ')}`);
            }
        }

        restSnap = newSnap;
    }

    // 连接 WS
    await wsClient.connect();
    console.log('WS 连接成功');

    await wsClient.subscribeOrderbook(marketId, onWsUpdate);
    console.log('WS 订阅成功');

    // 获取初始状态
    const initBook = await restClient.getOrderBook(marketId);
    restSnap = snap(initBook);
    console.log(`初始状态: bid=${fmt(restSnap.bestBid)}, ask=${fmt(restSnap.bestAsk)}\n`);

    // REST 轮询
    const pollTimer = setInterval(async () => {
        try {
            const book = await restClient.getOrderBook(marketId);
            onRestUpdate(book);
        } catch (e) {
            // ignore
        }
    }, REST_POLL_MS);

    // 定期打印统计
    const statsTimer = setInterval(() => {
        const wsFirst = latencies.wsFirst.length;
        const restFirst = latencies.restFirst.length;
        const total = wsFirst + restFirst;
        if (total > 0) {
            const wsAvg = wsFirst > 0 ? (latencies.wsFirst.reduce((a, b) => a + b, 0) / wsFirst).toFixed(0) : 'N/A';
            console.log(`\n--- 统计: WS先=${wsFirst} (avg ${wsAvg}ms), REST先=${restFirst}, WS更新=${wsCount}, REST调用=${restCount} ---\n`);
        }
    }, 10000);

    // 退出处理
    process.on('SIGINT', () => {
        clearInterval(pollTimer);
        clearInterval(statsTimer);
        wsClient.disconnect();

        console.log('\n\n=== 最终统计 ===');
        const wsFirst = latencies.wsFirst.length;
        const restFirst = latencies.restFirst.length;
        console.log(`WS 先检测到: ${wsFirst} 次`);
        console.log(`REST 先检测到: ${restFirst} 次`);

        if (wsFirst > 0) {
            const sorted = [...latencies.wsFirst].sort((a, b) => a - b);
            const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
            console.log(`WS 领先平均: ${avg.toFixed(0)} ms (min=${sorted[0]}, max=${sorted[sorted.length - 1]})`);
        }

        process.exit(0);
    });
}

main().catch(console.error);
