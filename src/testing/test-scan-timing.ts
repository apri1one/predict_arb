/**
 * 测试完整扫描流程的时间分布
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
    const envPath = join(process.cwd(), '.env');
    if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) {
                if (!process.env[match[1].trim()]) {
                    process.env[match[1].trim()] = match[2].trim();
                }
            }
        }
    }
}

loadEnv();

// 有效的市场 ID
const PREDICT_MARKET_IDS = [889, 890, 892, 895, 874, 521, 696, 697, 705, 706, 785, 878, 891, 897, 905, 906, 925, 933, 957, 975, 985, 987, 988, 990, 993, 1017, 1163, 1169, 1170, 1185, 1187, 1242, 1273, 1274, 1275, 1276, 1277, 1278, 1279, 1280, 1281, 1282, 1283, 1284, 1285];

const POLY_TOKEN_IDS = [
    '21742633143463906290569050155826241533067272736897614950488156847949938836455',
    '48331043336612883890938759509493159234755048973500640148014422747788308965732',
    '69236923620077691027083946871148646972011131466059644796654161903044970987404'
];

interface OrderBookLevel {
    price: number;
    size: number;
}

async function fetchPredictOrderbook(marketId: number, apiKey: string): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
    try {
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey }
        });
        if (!res.ok) return null;
        const data = await res.json() as { data: { bids: [number, number][]; asks: [number, number][] } };
        const orderbook = data.data;
        if (!orderbook) return null;
        const bids = (orderbook.bids || []).map(([price, size]: [number, number]) => ({ price, size }));
        const asks = (orderbook.asks || []).map(([price, size]: [number, number]) => ({ price, size }));
        return { bids, asks };
    } catch {
        return null;
    }
}

async function fetchPolymarketOrderbook(tokenId: string): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
    try {
        const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        if (!res.ok) return null;
        const book = await res.json() as { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };
        const bids = (book.bids || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
        const asks = (book.asks || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
        return { bids, asks };
    } catch {
        return null;
    }
}

async function main() {
    console.log('═'.repeat(60));
    console.log('  完整扫描流程时间测试');
    console.log('═'.repeat(60));

    const apiKeys = [
        process.env['PREDICT_API_KEY_SCAN'],
        process.env['PREDICT_API_KEY_SCAN_2'],
        process.env['PREDICT_API_KEY_SCAN_3']
    ].filter(Boolean) as string[];

    if (apiKeys.length === 0) {
        console.error('❌ 未找到 API key');
        process.exit(1);
    }

    console.log(`\n使用 ${apiKeys.length} 个 API key`);

    const marketCount = 45;
    const markets = PREDICT_MARKET_IDS.slice(0, marketCount);
    const BATCH_SIZE = 60;

    console.log(`\n模拟扫描 ${marketCount} 个市场...`);

    // 阶段 1: 订单簿获取
    const phase1Start = Date.now();
    const predictBooks = new Map<number, { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null>();
    const polyBooks = new Map<string, { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null>();

    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
        const batch = markets.slice(i, i + BATCH_SIZE);
        const batchStart = Date.now();

        await Promise.all(batch.map(async (marketId, idx) => {
            const apiKey = apiKeys[idx % apiKeys.length];
            const tokenId = POLY_TOKEN_IDS[idx % POLY_TOKEN_IDS.length];

            const [predictBook, polyBook] = await Promise.all([
                fetchPredictOrderbook(marketId, apiKey),
                fetchPolymarketOrderbook(tokenId)
            ]);

            predictBooks.set(marketId, predictBook);
            polyBooks.set(tokenId, polyBook);
        }));

        console.log(`  批次 ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} 市场, 耗时 ${Date.now() - batchStart}ms`);
    }
    const phase1End = Date.now();
    console.log(`\n阶段1 (订单簿获取): ${phase1End - phase1Start}ms`);

    // 阶段 2: 模拟套利计算
    const phase2Start = Date.now();
    let arbCount = 0;
    for (const marketId of markets) {
        const predictBook = predictBooks.get(marketId);
        const tokenId = POLY_TOKEN_IDS[markets.indexOf(marketId) % POLY_TOKEN_IDS.length];
        const polyBook = polyBooks.get(tokenId);

        if (predictBook && polyBook && predictBook.bids.length > 0 && polyBook.asks.length > 0) {
            // 模拟套利计算
            const predictBid = predictBook.bids[0]?.price || 0;
            const polyAsk = polyBook.asks[0]?.price || 0;
            if (predictBid + polyAsk < 1) {
                arbCount++;
            }
        }
    }
    const phase2End = Date.now();
    console.log(`阶段2 (套利计算): ${phase2End - phase2Start}ms, 发现 ${arbCount} 个机会`);

    // 总结
    console.log('\n' + '─'.repeat(60));
    console.log(`总耗时: ${phase2End - phase1Start}ms`);
    console.log('═'.repeat(60));
}

main().catch(console.error);
