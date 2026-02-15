/**
 * 检查用户在特定市场的现有订单
 */

import * as fs from 'fs';
import * as path from 'path';

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

import { PredictTrader } from '../dashboard/predict-trader.js';

const MARKET_ID = 704;  // Los Angeles Rams

async function main() {
    console.log(`=== 检查用户在市场 ${MARKET_ID} 的订单 ===\n`);

    const trader = new PredictTrader();
    await trader.init();

    // 获取用户所有未成交订单
    const headers = await (trader as any).getAuthHeaders();

    // 1. 查询用户所有订单
    const ordersRes = await fetch(`https://api.predict.fun/v1/orders?status=OPEN`, {
        headers
    });
    const ordersData = await ordersRes.json() as any;

    console.log('用户所有 OPEN 订单:');
    const orders = ordersData.data || [];

    if (orders.length === 0) {
        console.log('  (无)');
    } else {
        for (const order of orders) {
            console.log(`\n  Market: ${order.marketId}`);
            console.log(`  Side: ${order.order?.side === 0 ? 'BUY' : 'SELL'}`);
            console.log(`  Price: ${order.order?.makerAmount && order.order?.takerAmount ?
                (Number(order.order.makerAmount) / Number(order.order.takerAmount)).toFixed(4) : 'N/A'}`);
            console.log(`  Status: ${order.status}`);
            console.log(`  Hash: ${order.order?.hash?.slice(0, 20)}...`);
        }
    }

    // 2. 查询用户在特定市场的持仓
    console.log(`\n=== 用户在市场 ${MARKET_ID} 的持仓 ===`);
    const positionsRes = await fetch(`https://api.predict.fun/v1/positions`, {
        headers
    });
    const positionsData = await positionsRes.json() as any;
    const positions = positionsData.data || [];

    const marketPositions = positions.filter((p: any) => p.marketId === MARKET_ID);
    if (marketPositions.length === 0) {
        console.log('  (无持仓)');
    } else {
        for (const pos of marketPositions) {
            console.log(`  Token: ${pos.tokenId?.slice(0, 20)}...`);
            console.log(`  Quantity: ${pos.quantity}`);
            console.log(`  Side: ${pos.side}`);
        }
    }

    console.log('\n=== 检查完成 ===');
}

main().catch(console.error);
