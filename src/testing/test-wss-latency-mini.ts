/**
 * Mini WSS latency test (LIVE guarded)
 *
 * Compares:
 * - Predict: BSC OrderFilled WSS vs Predict REST API
 * - Polymarket: User WS (TRADE/ORDER) vs Polymarket REST API
 *
 * Safety:
 * - Dry-run by default. To place real orders set `RUN_LIVE_LATENCY_TEST=1`.
 * - Caps: `LATENCY_TEST_PREDICT_MAX_USD`, `LATENCY_TEST_POLY_MAX_USD`.
 *
 * Usage:
 * - Dry-run: `npx tsx src/testing/test-wss-latency-mini.ts`
 * - Live:    `RUN_LIVE_LATENCY_TEST=1 npx tsx src/testing/test-wss-latency-mini.ts`
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPredictTrader } from '../dashboard/predict-trader.js';
import { getBscOrderWatcher } from '../services/bsc-order-watcher.js';
import { getPolymarketTrader } from '../dashboard/polymarket-trader.js';
import { getPolymarketUserWsClient, type TradeEvent, type OrderEvent } from '../polymarket/user-ws-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

const RUN_LIVE = process.env.RUN_LIVE_LATENCY_TEST === '1';

const PREDICT_MIN_ORDER_VALUE_USD = Number(process.env.PREDICT_MIN_ORDER_VALUE_USD || '0.9');
const PREDICT_MAX_USD = Number(process.env.LATENCY_TEST_PREDICT_MAX_USD || '2');
const POLY_MAX_USD = Number(process.env.LATENCY_TEST_POLY_MAX_USD || '10');

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function formatMs(ms: number | null): string {
    if (ms === null) return 'n/a';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function bestAsk(asks: Array<{ price: string; size: string }>): { price: number; size: number } | null {
    let best: { price: number; size: number } | null = null;
    for (const a of asks) {
        const p = Number(a.price);
        const s = Number(a.size);
        if (!Number.isFinite(p) || !Number.isFinite(s) || p <= 0 || s <= 0) continue;
        if (!best || p < best.price) best = { price: p, size: s };
    }
    return best;
}

async function pickPredictMarket(): Promise<{
    marketId: number;
    title: string;
    askPrice: number;
    askQty: number;
    qty: number;
    estCost: number;
} | null> {
    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) throw new Error('Missing PREDICT_API_KEY');

    const res = await fetch('https://api.predict.fun/v1/orders/matches?first=50', {
        headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) throw new Error(`Predict matches fetch failed: HTTP ${res.status}`);
    const data = await res.json() as any;

    const trader = getPredictTrader();
    await trader.init();

    for (const m of (data.data || [])) {
        const marketId = Number(m?.market?.id);
        const title = String(m?.market?.title || '');
        if (!Number.isFinite(marketId) || marketId <= 0) continue;

        const ob = await trader.getOrderbook(marketId);
        if (!ob?.asks?.length) continue;

        const [askPrice, askQty] = ob.asks[0];
        if (!Number.isFinite(askPrice) || !Number.isFinite(askQty) || askPrice <= 0 || askQty <= 0) continue;

        const qty = Math.max(1, Math.ceil(PREDICT_MIN_ORDER_VALUE_USD / askPrice));
        if (askQty < qty) continue;

        const estCost = qty * askPrice;
        return { marketId, title, askPrice, askQty, qty, estCost };
    }

    return null;
}

async function pickPolymarketToken(): Promise<{
    tokenId: string;
    question: string;
    negRisk: boolean;
    minOrderSizeUsd: number;
    askPrice: number;
    askQty: number;
    qty: number;
    estCost: number;
} | null> {
    const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200');
    if (!gammaRes.ok) throw new Error(`Gamma markets fetch failed: HTTP ${gammaRes.status}`);
    const markets = await gammaRes.json() as any[];

    const candidates = markets
        .filter(m => m?.acceptingOrders && m?.enableOrderBook && m?.clobTokenIds)
        .map(m => {
            const bid = Number(m.bestBid);
            const ask = Number(m.bestAsk);
            const mid = (bid + ask) / 2;
            return { m, score: Math.abs(mid - 0.5), mid };
        })
        .filter(x => Number.isFinite(x.mid) && Number.isFinite(x.score))
        .sort((a, b) => a.score - b.score)
        .slice(0, 20);

    for (const { m } of candidates) {
        let tokens: string[];
        try {
            tokens = JSON.parse(m.clobTokenIds);
        } catch {
            continue;
        }
        if (!Array.isArray(tokens) || tokens.length < 1) continue;

        const minOrderSizeUsd = Number(m.orderMinSize || 5);
        const question = String(m.question || '');

        for (const tokenId of tokens.slice(0, 2)) {
            const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
            if (!bookRes.ok) continue;
            const book = await bookRes.json() as any;
            const asks = Array.isArray(book?.asks) ? book.asks : [];
            if (!asks.length) continue;

            const best = bestAsk(asks);
            if (!best) continue;

            const qty = Math.ceil(minOrderSizeUsd / best.price);
            if (!Number.isFinite(qty) || qty <= 0) continue;
            if (best.size < qty) continue;

            const estCost = qty * best.price;
            return {
                tokenId: String(tokenId),
                question,
                negRisk: !!m.negRisk,
                minOrderSizeUsd,
                askPrice: best.price,
                askQty: best.size,
                qty,
                estCost,
            };
        }
    }

    return null;
}

type PredictPick = NonNullable<Awaited<ReturnType<typeof pickPredictMarket>>>;
type PolymarketPick = NonNullable<Awaited<ReturnType<typeof pickPolymarketToken>>>;

async function runPredictLatency(p: PredictPick): Promise<{
    wssFirstFillMs: number | null;
    apiFirstFillMs: number | null;
    apiFinalStatus: string | null;
}> {
    const trader = getPredictTrader();
    await trader.init();

    const watcher = getBscOrderWatcher();
    if (!watcher.isConnected()) await watcher.start();

    console.log(`\n[Predict] BUY YES qty=${p.qty} @ ${p.askPrice} (est $${p.estCost.toFixed(2)}) marketId=${p.marketId}`);
    console.log(`[Predict] title=${p.title.slice(0, 80)}`);

    const t0 = Date.now();
    const result = await trader.placeBuyOrder({
        marketId: p.marketId,
        side: 'BUY',
        price: p.askPrice,
        quantity: p.qty,
        outcome: 'YES',
    });

    if (!result.success || !result.hash) {
        throw new Error(result.error || 'Predict order failed');
    }

    const hash = result.hash;
    console.log(`[Predict] order hash=${hash.slice(0, 18)}...`);

    let tWss: number | null = null;
    const cancelWatch = watcher.watchOrder(hash, () => {
        if (!tWss) tWss = Date.now();
    }, 60_000);

    let tApiFirstFill: number | null = null;
    let apiFinalStatus: string | null = null;

    const pollStart = Date.now();
    while (Date.now() - pollStart < 45_000) {
        const status = await trader.getOrderStatus(hash);
        if (status) {
            apiFinalStatus = status.status;
            if (!tApiFirstFill && status.filledQty > 0) tApiFirstFill = Date.now();
            if (status.status === 'FILLED' || status.status === 'CANCELLED' || status.status === 'EXPIRED') break;
        }
        await sleep(200);
    }

    cancelWatch();

    const wssFirstFillMs = tWss ? (tWss - t0) : null;
    const apiFirstFillMs = tApiFirstFill ? (tApiFirstFill - t0) : null;

    console.log(`[Predict] WSS first fill: ${formatMs(wssFirstFillMs)}`);
    console.log(`[Predict] API first fill: ${formatMs(apiFirstFillMs)} final=${apiFinalStatus || 'n/a'}`);
    if (tWss && tApiFirstFill) {
        console.log(`[Predict] diff (API - WSS): ${formatMs(tApiFirstFill - tWss)}`);
    }

    return { wssFirstFillMs, apiFirstFillMs, apiFinalStatus };
}

async function runPolymarketLatency(p: PolymarketPick): Promise<{
    wsTradeFirstMs: number | null;
    wsOrderFirstMs: number | null;
    apiFirstFillMs: number | null;
    apiFinalMs: number | null;
    apiFinalStatus: string | null;
}> {
    const apiKey = process.env.POLYMARKET_API_KEY;
    const secret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_PASSPHRASE;
    if (!apiKey || !secret || !passphrase) throw new Error('Missing POLYMARKET_API_* env');

    const userWs = getPolymarketUserWsClient({ apiKey, secret, passphrase });
    if (!userWs.connected()) await userWs.connect();

    const tradeFirstByOrderId = new Map<string, number>();
    const orderFirstByOrderId = new Map<string, number>();

    const tradeListenerId = userWs.addTradeEventListener((ev: TradeEvent) => {
        const id = ev.taker_order_id;
        if (!tradeFirstByOrderId.has(id)) tradeFirstByOrderId.set(id, Date.now());
    });
    const orderListenerId = userWs.addOrderEventListener((ev: OrderEvent) => {
        const id = ev.id;
        if (!orderFirstByOrderId.has(id)) orderFirstByOrderId.set(id, Date.now());
    });

    const trader = getPolymarketTrader();
    await trader.init();

    console.log(`\n[Polymarket] BUY IOC qty=${p.qty} @ ${p.askPrice} (minOrder=$${p.minOrderSizeUsd}, est $${p.estCost.toFixed(2)})`);
    console.log(`[Polymarket] question=${p.question.slice(0, 80)}`);

    const t0 = Date.now();
    const orderRes = await trader.placeOrder({
        tokenId: p.tokenId,
        side: 'BUY',
        price: p.askPrice,
        quantity: p.qty,
        orderType: 'IOC',
        negRisk: p.negRisk,
        outcome: 'YES',
    });

    if (!orderRes.success || !orderRes.orderId) {
        userWs.removeTradeEventListener(tradeListenerId);
        userWs.removeOrderEventListener(orderListenerId);
        throw new Error(orderRes.error || 'Polymarket order failed');
    }

    const orderId = orderRes.orderId;
    console.log(`[Polymarket] orderId=${orderId.slice(0, 18)}...`);

    // wait up to 10s for WS messages for this orderId
    let tWsTrade = tradeFirstByOrderId.get(orderId) ?? null;
    let tWsOrder = orderFirstByOrderId.get(orderId) ?? null;
    const wsWaitStart = Date.now();
    while (Date.now() - wsWaitStart < 10_000 && (!tWsTrade || !tWsOrder)) {
        if (!tWsTrade) tWsTrade = tradeFirstByOrderId.get(orderId) ?? null;
        if (!tWsOrder) tWsOrder = orderFirstByOrderId.get(orderId) ?? null;
        if (tWsTrade && tWsOrder) break;
        await sleep(50);
    }

    let tApiFirstFill: number | null = null;
    let tApiFinal: number | null = null;
    let apiFinalStatus: string | null = null;

    const pollStart = Date.now();
    while (Date.now() - pollStart < 20_000) {
        const st = await trader.getOrderStatus(orderId);
        if (st) {
            apiFinalStatus = st.status;
            if (!tApiFirstFill && st.filledQty > 0) tApiFirstFill = Date.now();
            if ((st.status === 'MATCHED' || st.status === 'CANCELLED') && !tApiFinal) {
                tApiFinal = Date.now();
                break;
            }
        }
        await sleep(100);
    }

    userWs.removeTradeEventListener(tradeListenerId);
    userWs.removeOrderEventListener(orderListenerId);

    const wsTradeFirstMs = tWsTrade ? (tWsTrade - t0) : null;
    const wsOrderFirstMs = tWsOrder ? (tWsOrder - t0) : null;
    const apiFirstFillMs = tApiFirstFill ? (tApiFirstFill - t0) : null;
    const apiFinalMs = tApiFinal ? (tApiFinal - t0) : null;

    console.log(`[Polymarket] WS TRADE first: ${formatMs(wsTradeFirstMs)}`);
    console.log(`[Polymarket] WS ORDER first: ${formatMs(wsOrderFirstMs)}`);
    console.log(`[Polymarket] API first fill: ${formatMs(apiFirstFillMs)} final=${apiFinalStatus || 'n/a'} @ ${formatMs(apiFinalMs)}`);
    if (tWsTrade && tApiFinal) {
        console.log(`[Polymarket] diff (API final - WS trade): ${formatMs(tApiFinal - tWsTrade)}`);
    }

    return { wsTradeFirstMs, wsOrderFirstMs, apiFirstFillMs, apiFinalMs, apiFinalStatus };
}

async function main(): Promise<void> {
    console.log(`RUN_LIVE_LATENCY_TEST=${RUN_LIVE ? '1' : '0'}`);

    const predict = await pickPredictMarket();
    if (predict) {
        console.log(`[Pick] Predict marketId=${predict.marketId} ask=${predict.askPrice} qty=${predict.qty} est=$${predict.estCost.toFixed(2)}`);
    } else {
        console.log('[Pick] Predict: no candidate market found');
    }

    const poly = await pickPolymarketToken();
    if (poly) {
        console.log(`[Pick] Polymarket tokenId=${poly.tokenId.slice(0, 16)}... ask=${poly.askPrice} qty=${poly.qty} est=$${poly.estCost.toFixed(2)}`);
    } else {
        console.log('[Pick] Polymarket: no candidate token found');
    }

    if (!RUN_LIVE) {
        console.log('\nDry-run only. Set RUN_LIVE_LATENCY_TEST=1 to place real orders.');
        return;
    }

    if (predict && predict.estCost > PREDICT_MAX_USD) {
        throw new Error(`Predict estCost too high: $${predict.estCost.toFixed(2)} > $${PREDICT_MAX_USD}`);
    }
    if (poly && poly.estCost > POLY_MAX_USD) {
        throw new Error(`Polymarket estCost too high: $${poly.estCost.toFixed(2)} > $${POLY_MAX_USD}`);
    }

    if (predict) await runPredictLatency(predict);
    if (poly) await runPolymarketLatency(poly);
}

main().catch((e) => {
    console.error(e?.message || e);
    process.exitCode = 1;
});
