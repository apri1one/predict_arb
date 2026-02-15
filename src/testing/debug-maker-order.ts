/**
 * 调试 MAKER 订单取消问题
 *
 * 使用 PredictTrader 类（与 dashboard 相同的代码路径）
 */

import * as fs from 'fs';
import * as path from 'path';

// 手动加载 .env（在任何 import 之前）
function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    console.log('Loading env from:', envPath);
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                process.env[key] = value;
            }
        }
        console.log('Env loaded. PREDICT_API_KEY:', process.env.PREDICT_API_KEY ? 'SET' : 'NOT SET');
        console.log('PREDICT_SIGNER_PRIVATE_KEY:', process.env.PREDICT_SIGNER_PRIVATE_KEY ? 'SET' : 'NOT SET');
        console.log('PREDICT_SMART_WALLET_ADDRESS:', process.env.PREDICT_SMART_WALLET_ADDRESS || 'NOT SET');
    } else {
        console.error('Env file not found:', envPath);
        process.exit(1);
    }
}

loadEnv();

// 现在才能导入依赖 process.env 的模块
import { PredictTrader } from '../dashboard/predict-trader.js';

const API_KEY = process.env.PREDICT_API_KEY!;
const BASE_URL = 'https://api.predict.fun';

// 测试参数
const TEST_MARKET_ID = 2069;  // LoL Weibo Gaming (yieldBearing)
const TEST_QUANTITY = 5;  // 小量测试
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_TIME_MS = 60000;

interface MarketInfo {
    id: number;
    title: string;
    active: boolean;
    closed: boolean;
    isNegRisk: boolean;
    isYieldBearing: boolean;
    feeRateBps: number;
    conditionId: string;
    outcomes: Array<{ name: string; onChainId: string }>;
}

async function findActiveMarket(): Promise<MarketInfo | null> {
    console.log('\n=== 寻找活跃市场 ===\n');

    const res = await fetch(`${BASE_URL}/v1/markets?active=true&limit=50`, {
        headers: { 'x-api-key': API_KEY }
    });

    if (!res.ok) {
        console.error('获取市场列表失败:', res.status);
        return null;
    }

    const data = await res.json() as { data: any[] };
    const markets = data.data || [];

    // 找一个有订单簿的活跃市场
    for (const m of markets) {
        if (!m.active || m.closed) continue;

        // 获取订单簿
        const bookRes = await fetch(`${BASE_URL}/v1/markets/${m.id}/orderbook`, {
            headers: { 'x-api-key': API_KEY }
        });

        if (!bookRes.ok) continue;

        const bookData = await bookRes.json() as { data: { bids: any[]; asks: any[] } };
        const bids = bookData.data?.bids || [];
        const asks = bookData.data?.asks || [];

        // 需要有买单和卖单
        if (bids.length > 0 && asks.length > 0) {
            console.log(`找到市场: [${m.id}] ${m.title}`);
            console.log(`  isNegRisk: ${m.isNegRisk}`);
            console.log(`  isYieldBearing: ${m.isYieldBearing}`);
            console.log(`  Best Bid: ${bids[0][0]}, Best Ask: ${asks[0][0]}`);

            return {
                id: m.id,
                title: m.title,
                active: m.active,
                closed: m.closed,
                isNegRisk: m.isNegRisk || false,
                isYieldBearing: m.isYieldBearing || false,
                feeRateBps: m.feeRateBps || 200,
                conditionId: m.conditionId,
                outcomes: m.outcomes || []
            };
        }
    }

    return null;
}

async function getOrderBook(marketId: number): Promise<{ bestBid: number; bestAsk: number } | null> {
    const res = await fetch(`${BASE_URL}/v1/markets/${marketId}/orderbook`, {
        headers: { 'x-api-key': API_KEY }
    });

    if (!res.ok) return null;

    const data = await res.json() as { data: { bids: any[]; asks: any[] } };
    const bids = data.data?.bids || [];
    const asks = data.data?.asks || [];

    if (bids.length === 0 || asks.length === 0) return null;

    return {
        bestBid: parseFloat(bids[0][0]),
        bestAsk: parseFloat(asks[0][0])
    };
}

async function main() {
    console.log('=== MAKER 订单调试测试 ===\n');

    // 直接获取指定市场
    console.log(`获取市场 ${TEST_MARKET_ID} 信息...`);
    const marketRes = await fetch(`${BASE_URL}/v1/markets/${TEST_MARKET_ID}`, {
        headers: { 'x-api-key': API_KEY }
    });

    if (!marketRes.ok) {
        console.error('获取市场信息失败:', marketRes.status);
        return;
    }

    const marketData = await marketRes.json() as { data: any };
    const m = marketData.data;

    console.log('市场详情:', JSON.stringify({
        id: m.id,
        title: m.title,
        active: m.active,
        closed: m.closed,
        isNegRisk: m.isNegRisk,
        isYieldBearing: m.isYieldBearing,
        feeRateBps: m.feeRateBps,
        status: m.status
    }, null, 2));

    const market: MarketInfo = {
        id: m.id,
        title: m.title,
        active: m.active !== false,  // 默认为 true
        closed: m.closed === true,   // 默认为 false
        isNegRisk: m.isNegRisk || false,
        isYieldBearing: m.isYieldBearing || false,
        feeRateBps: m.feeRateBps || 200,
        conditionId: m.conditionId,
        outcomes: m.outcomes || []
    };

    if (market.closed) {
        console.error('市场已关闭');
        return;
    }

    // 获取订单簿
    const book = await getOrderBook(market.id);
    if (!book) {
        console.error('无法获取订单簿');
        return;
    }

    // 计算 MAKER 价格（低于 best bid，确保不会立即成交）
    const makerPrice = Math.max(0.01, book.bestBid - 0.02);

    console.log(`\n=== 测试参数 ===`);
    console.log(`市场: [${market.id}] ${market.title}`);
    console.log(`isNegRisk: ${market.isNegRisk}`);
    console.log(`isYieldBearing: ${market.isYieldBearing}`);
    console.log(`feeRateBps: ${market.feeRateBps}`);
    console.log(`Best Bid: ${book.bestBid}, Best Ask: ${book.bestAsk}`);
    console.log(`测试价格: ${makerPrice} (低于 best bid，作为 MAKER)`);
    console.log(`测试数量: ${TEST_QUANTITY}`);

    // 初始化 PredictTrader
    console.log('\n=== 初始化 PredictTrader ===\n');
    const trader = new PredictTrader();
    await trader.init();

    // 下单
    console.log('\n=== 提交 MAKER 订单 ===\n');
    const result = await trader.placeBuyOrder({
        marketId: market.id,
        price: makerPrice,
        quantity: TEST_QUANTITY,
        outcome: 'YES',
    });

    console.log('下单结果:', JSON.stringify(result, null, 2));

    if (!result.success || !result.hash) {
        console.error('下单失败:', result.error);
        return;
    }

    console.log(`\n订单已提交, hash: ${result.hash}`);

    // 轮询状态
    console.log('\n=== 轮询订单状态 ===\n');

    const startTime = Date.now();
    let lastStatus = '';
    let orderCancelled = false;

    while (Date.now() - startTime < MAX_POLL_TIME_MS) {
        const status = await trader.getOrderStatus(result.hash);

        if (status) {
            const statusStr = `${status.status} (filled: ${status.filledQty})`;

            if (statusStr !== lastStatus) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`\n[${elapsed}s] 状态变化: ${status.status}`);
                console.log(`  filledQty: ${status.filledQty}`);
                console.log(`  remainingQty: ${status.remainingQty}`);
                console.log(`  avgPrice: ${status.avgPrice}`);
                console.log(`  cancelReason: ${status.cancelReason || '(无)'}`);

                if (status.rawResponse) {
                    console.log('\n  === 原始 API 响应 ===');
                    console.log(JSON.stringify(status.rawResponse, null, 2));
                    console.log('  ====================\n');
                }

                lastStatus = statusStr;
            }

            if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
                console.log('\n订单被取消/过期!');
                orderCancelled = true;
                break;
            }

            if (status.status === 'FILLED') {
                console.log('\n订单已完全成交!');
                break;
            }
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    // 如果订单还在挂单，取消它
    if (!orderCancelled && lastStatus.includes('OPEN')) {
        console.log('\n=== 取消测试订单 ===\n');
        const cancelled = await trader.cancelOrder(result.hash);
        console.log('取消结果:', cancelled);
    }

    console.log('\n=== 测试完成 ===');
}

main().catch(e => {
    console.error('测试失败:', e);
    process.exit(1);
});
