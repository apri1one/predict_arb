/**
 * 使用 market-maker 模块下单并持续轮询状态
 */

import * as fs from 'fs';
import * as path from 'path';

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
    console.log('=== Market-Maker 模块订单测试 (带轮询) ===\n');

    // 获取市场信息
    const marketRes = await fetch(`${BASE_URL}/v1/markets/${TEST_MARKET_ID}`, {
        headers: { 'x-api-key': API_KEY }
    });
    const marketData = await marketRes.json() as { data: any };
    const m = marketData.data;

    console.log('市场:', m.id, m.title);
    console.log('  isNegRisk:', m.isNegRisk);
    console.log('  isYieldBearing:', m.isYieldBearing);

    // 获取订单簿
    const bookRes = await fetch(`${BASE_URL}/v1/markets/${TEST_MARKET_ID}/orderbook`, {
        headers: { 'x-api-key': API_KEY }
    });
    const bookData = await bookRes.json() as { data: { bids: any[]; asks: any[] } };
    const bids = bookData.data?.bids || [];

    if (bids.length === 0) {
        console.log('无订单簿');
        return;
    }

    const bestBid = parseFloat(bids[0][0]);
    const makerPrice = Math.max(0.01, bestBid - 0.02);

    console.log('  Best Bid:', bestBid);
    console.log('  MAKER Price:', makerPrice);

    // 获取 token ID
    const yesOutcome = m.outcomes?.find((o: any) => o.name === 'Yes' || o.indexSet === 1);
    const tokenId = yesOutcome?.onChainId;
    if (!tokenId) {
        console.log('无法找到 token ID');
        return;
    }

    // 创建 TradingClient
    console.log('\n初始化 TradingClient...');
    const client = createTradingClient();
    await client.init();

    // 下单
    console.log('\n提交订单...');
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

    console.log('下单结果:', result);

    // 使用 API 直接查询订单状态
    console.log('\n轮询订单状态 (30秒)...');
    const jwt = await client.getJwt();
    const startTime = Date.now();

    while (Date.now() - startTime < 30000) {
        const statusRes = await fetch(`${BASE_URL}/v1/orders/${result.hash}`, {
            headers: {
                'x-api-key': API_KEY,
                'Authorization': `Bearer ${jwt}`
            }
        });
        const statusData = await statusRes.json() as { data: any };
        const order = statusData.data;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[${elapsed}s] status=${order?.status} filled=${order?.amountFilled}`);

        if (order?.status === 'CANCELLED' || order?.status === 'FILLED') {
            console.log('\n最终状态:', order.status);
            if (order.status === 'CANCELLED') {
                console.log('订单被取消!');
            }
            break;
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
