/**
 * 使用 market-maker 模块测试下单
 * 对比 dashboard 模块是否有差异
 */

import * as fs from 'fs';
import * as path from 'path';

// 加载 .env
const envPath = path.join(process.cwd(), '..', '.env');
if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
        const match = line.trim().match(/^([^#=]+)=(.*)$/);
        if (match) process.env[match[1].trim()] = match[2].trim();
    }
}

import { createTradingClient } from '../market-maker/trading-client.js';

const API_KEY = process.env.PREDICT_API_KEY!;
const BASE_URL = 'https://api.predict.fun';
const TEST_MARKET_ID = 2069;

async function main() {
    console.log('=== Market-Maker 模块订单测试 ===\n');

    // 获取市场信息
    const marketRes = await fetch(`${BASE_URL}/v1/markets/${TEST_MARKET_ID}`, {
        headers: { 'x-api-key': API_KEY }
    });
    const marketData = await marketRes.json() as { data: any };
    const m = marketData.data;

    console.log('市场:', m.id, m.title);
    console.log('  isNegRisk:', m.isNegRisk);
    console.log('  isYieldBearing:', m.isYieldBearing);
    console.log('  feeRateBps:', m.feeRateBps);

    // 获取订单簿
    const bookRes = await fetch(`${BASE_URL}/v1/markets/${TEST_MARKET_ID}/orderbook`, {
        headers: { 'x-api-key': API_KEY }
    });
    const bookData = await bookRes.json() as { data: { bids: any[]; asks: any[] } };
    const bids = bookData.data?.bids || [];
    const asks = bookData.data?.asks || [];

    if (bids.length === 0) {
        console.log('无订单簿');
        return;
    }

    const bestBid = parseFloat(bids[0][0]);
    const bestAsk = asks.length > 0 ? parseFloat(asks[0][0]) : 0;
    const makerPrice = Math.max(0.01, bestBid - 0.02);

    console.log('  Best Bid:', bestBid, 'Best Ask:', bestAsk);
    console.log('  MAKER Price:', makerPrice);

    // 获取 token ID
    const yesOutcome = m.outcomes?.find((o: any) => o.name === 'Yes' || o.indexSet === 1);
    if (!yesOutcome) {
        console.log('无法找到 YES outcome');
        return;
    }
    const tokenId = yesOutcome.onChainId;
    console.log('  Token ID:', tokenId.slice(0, 30) + '...');

    // 创建 TradingClient
    console.log('\n初始化 TradingClient...');
    const client = createTradingClient();
    await client.init();

    // 下单
    console.log('\n提交订单...');
    try {
        const result = await client.placeOrder({
            side: 'BUY',
            tokenId: tokenId,
            price: makerPrice,
            quantity: 5,
            marketId: TEST_MARKET_ID,
            feeRateBps: m.feeRateBps || 200,
            isNegRisk: m.isNegRisk || false,
            isYieldBearing: m.isYieldBearing || false,
        });

        console.log('下单成功:', result);

        // 轮询状态
        console.log('\n轮询订单状态...');
        const startTime = Date.now();
        while (Date.now() - startTime < 30000) {
            const status = await client.getOrderStatus(result.id);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[${elapsed}s] status=${status?.status} filled=${status?.filledQty}`);

            if (status?.status === 'CANCELLED' || status?.status === 'FILLED') {
                console.log('\n最终状态:', status.status);
                break;
            }

            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (e: any) {
        console.error('下单失败:', e.message);
    }

    console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
