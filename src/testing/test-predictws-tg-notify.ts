/**
 * Predict WS TG 通知联调测试
 *
 * - 启动 TG 订单通知（BSC WSS + Predict walletEvents WS）
 * - 下一个小额 Predict 订单（尽量贴近卖一，快速成交）
 * - 观察 TG 是否收到来自 PredictWS 的 [TEST] 标记消息
 *
 * ⚠️ 警告：此脚本会真实下单。
 *
 * 用法：
 *   npx tsx src/testing/test-predictws-tg-notify.ts [marketId]
 */

import { config } from 'dotenv';
config();

import { startBscOrderNotifierFromEnv, stopBscOrderNotifier } from '../notification/bsc-order-notifier.js';
import { getTokenMarketCache, stopTokenMarketCache } from '../services/token-market-cache.js';
import { PredictRestClient } from '../predict/rest-client.js';
import { getPredictTrader } from '../dashboard/predict-trader.js';
import { stopPredictWsClient } from '../services/predict-ws-client.js';
import { stopBscOrderWatcher } from '../services/bsc-order-watcher.js';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

type MarketPick = {
    id: number;
    title: string;
    askPrice: number;
    askSize: number;
};

async function pickMarket(marketIdArg?: number): Promise<MarketPick> {
    const apiKey = process.env.PREDICT_API_KEY || '';
    if (!apiKey) throw new Error('Missing PREDICT_API_KEY');

    const client = new PredictRestClient({ apiKey });

    if (marketIdArg) {
        const ob = await client.getOrderBook(marketIdArg);
        const market = await client.getMarket(marketIdArg);
        if (!ob.asks?.length) throw new Error(`Market ${marketIdArg} has no asks`);
        return {
            id: marketIdArg,
            title: market.title || market.question || `Market #${marketIdArg}`,
            askPrice: ob.asks[0][0],
            askSize: ob.asks[0][1],
        };
    }

    // 选取最近有撮合的市场，尽量保证卖一深度足够
    const matches = await client.getOrderMatches({ limit: 30 });
    const marketIds = [...new Set(matches.map(m => m.market?.id).filter(Boolean))] as number[];

    for (const id of marketIds.slice(0, 15)) {
        try {
            const ob = await client.getOrderBook(id);
            if (!ob.asks?.length) continue;
            const askPrice = ob.asks[0][0];
            const askSize = ob.asks[0][1];
            if (askPrice <= 0 || askPrice >= 0.99) continue;

            const market = await client.getMarket(id);
            return {
                id,
                title: market.title || market.question || `Market #${id}`,
                askPrice,
                askSize,
            };
        } catch {
            // ignore
        }
    }

    throw new Error('Failed to pick a market (no liquid asks found)');
}

async function main(): Promise<void> {
    const marketIdArg = process.argv[2] ? Number(process.argv[2]) : undefined;

    console.log('\n============================================================');
    console.log('Predict WS TG 通知联调测试');
    console.log('============================================================\n');

    // 1) 启动 TokenMarketCache（用于把 tokenId 映射为市场标题/YES|NO）
    const tokenCache = getTokenMarketCache(process.env.PREDICT_API_KEY);
    try {
        await tokenCache.start();
        console.log('[Test] TokenMarketCache ready');
    } catch (e: any) {
        console.warn('[Test] TokenMarketCache start failed (messages may show unknown market):', e?.message || e);
    }

    // 2) 启动 TG 通知（会自动连接 BSC WSS + Predict WS）
    await startBscOrderNotifierFromEnv();

    // 3) 选择市场并下单
    const pick = await pickMarket(marketIdArg);
    console.log(`[Test] Market: ${pick.id} - ${pick.title.slice(0, 60)}`);
    console.log(`[Test] Best Ask: ${(pick.askPrice * 100).toFixed(1)}¢, Ask Size: ${pick.askSize.toFixed(0)} shares`);

    const minQty = Math.ceil(1.1 / pick.askPrice);
    const qty = Math.max(minQty, 10);
    const price = Math.min(pick.askPrice + 0.01, 0.99);
    const priceNote = price > pick.askPrice ? ' (aggressive)' : '';
    console.log(`[Test] Place BUY YES: qty=${qty}, price=${(price * 100).toFixed(1)}¢${priceNote}, estCost=$${(qty * price).toFixed(2)}`);

    const trader = getPredictTrader();
    const place = await trader.placeOrder({
        marketId: pick.id,
        side: 'BUY',
        price,
        quantity: qty,
        outcome: 'YES',
    });

    if (!place.success || !place.hash) {
        throw new Error(`placeOrder failed: ${place.error || 'unknown'}`);
    }

    console.log(`[Test] Order placed: ${place.hash}`);

    // 4) 等待一段时间让 walletEvents/BSC 事件触发、TG 推送发出
    console.log('[Test] Waiting 30s for PredictWS/BSC notifications...');
    await sleep(30000);

    // 5) 输出订单状态（不一定需要）
    try {
        const status = await trader.getOrderStatus(place.hash);
        console.log(`[Test] Order status: ${status?.status || 'unknown'} filled=${status?.filledQty || 0} remaining=${status?.remainingQty || 0}`);
    } catch (e: any) {
        console.warn('[Test] getOrderStatus failed:', e?.message || e);
    }

    console.log('\n[Test] Done. Please check Telegram: expect a PredictWS message with [TEST] marker.');
}

main()
    .catch((e) => {
        console.error('\n[Test] Failed:', e?.message || e);
        process.exitCode = 1;
    })
    .finally(() => {
        try { stopBscOrderNotifier(); } catch { /* ignore */ }
        try { stopBscOrderWatcher(); } catch { /* ignore */ }
        try { stopTokenMarketCache(); } catch { /* ignore */ }
        try { stopPredictWsClient(); } catch { /* ignore */ }
    });
