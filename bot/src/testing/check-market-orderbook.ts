/**
 * 检查市场订单簿状态
 */

import * as fs from 'fs';
import * as path from 'path';

function loadEnv() {
    const envPath = path.join(process.cwd(), '..', '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

const API_KEY = process.env.PREDICT_API_KEY!;
const BASE_URL = 'https://api.predict.fun';

// 检查的市场 ID
const MARKET_ID = 704;  // Los Angeles Rams

async function main() {
    console.log(`=== 市场 ${MARKET_ID} 订单簿检查 ===\n`);

    // 1. 获取市场信息
    const marketRes = await fetch(`${BASE_URL}/v1/markets/${MARKET_ID}`, {
        headers: { 'x-api-key': API_KEY }
    });
    const marketData = await marketRes.json() as any;
    const market = marketData.data;

    console.log('市场:', market?.title);
    console.log('active:', market?.active);
    console.log('closed:', market?.closed);
    console.log('isNegRisk:', market?.isNegRisk);
    console.log('isYieldBearing:', market?.isYieldBearing);
    console.log('feeRateBps:', market?.feeRateBps);

    // 2. 获取订单簿
    const bookRes = await fetch(`${BASE_URL}/v1/markets/${MARKET_ID}/orderbook`, {
        headers: { 'x-api-key': API_KEY }
    });
    const bookData = await bookRes.json() as any;

    console.log('\n=== 订单簿 ===');
    console.log('Bids (买单):');
    const bids = bookData.data?.bids || [];
    bids.slice(0, 5).forEach((bid: any, i: number) => {
        console.log(`  ${i + 1}. 价格: $${bid[0]}, 数量: ${bid[1]}`);
    });

    console.log('\nAsks (卖单):');
    const asks = bookData.data?.asks || [];
    asks.slice(0, 5).forEach((ask: any, i: number) => {
        console.log(`  ${i + 1}. 价格: $${ask[0]}, 数量: ${ask[1]}`);
    });

    // 3. 分析用户订单
    const userPrice = 0.79;
    const bestAsk = asks[0]?.[0];
    const bestBid = bids[0]?.[0];

    console.log('\n=== 分析 ===');
    console.log(`用户买入价格: $${userPrice}`);
    console.log(`Best Ask: $${bestAsk}`);
    console.log(`Best Bid: $${bestBid}`);

    if (bestAsk && userPrice >= bestAsk) {
        console.log(`\n⚠️ 用户价格 ($${userPrice}) >= Best Ask ($${bestAsk})`);
        console.log('   订单应该会立即成交（作为 taker）');
    } else if (bestAsk && userPrice < bestAsk) {
        console.log(`\n✅ 用户价格 ($${userPrice}) < Best Ask ($${bestAsk})`);
        console.log('   订单会挂在订单簿上等待成交（作为 maker）');
    }

    // 4. 检查用户的现有订单
    console.log('\n=== 检查是否有冲突的订单 ===');
    // 这需要 JWT 认证，暂时跳过
    console.log('(需要 JWT 认证才能查询用户订单)');
}

main().catch(console.error);
