/**
 * 测试脚本：验证 SCALP 策略的买单逻辑
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { createTradingClient } from '../market-maker/trading-client.js';

const MARKET_ID = 521;
const MAX_SHARES = 200;

async function main() {
    console.log('初始化 TradingClient...');
    const client = createTradingClient();
    await client.init();

    const deps = client.createDependencies();

    // 获取配置
    const noTokenId = await client.getTokenId(MARKET_ID, 'NO');

    // 获取市场属性
    const marketRes = await fetch(`https://api.predict.fun/v1/markets/${MARKET_ID}`, {
        headers: { 'x-api-key': process.env.PREDICT_API_KEY! }
    });
    const marketData = await marketRes.json() as { data: { isNegRisk: boolean; isYieldBearing: boolean } };
    const isNegRisk = marketData.data.isNegRisk;
    const isYieldBearing = marketData.data.isYieldBearing;

    // 获取持仓
    const position = await deps.fetchPosition(MARKET_ID, noTokenId, { isNegRisk, isYieldBearing });
    console.log(`\n持仓: ${position}`);
    console.log(`maxShares: ${MAX_SHARES}`);

    // 精度处理（与 getEffectivePosition 一致）
    const decimals = 2;
    const factor = Math.pow(10, decimals);
    const effectivePosition = Math.floor(position * factor) / factor;
    console.log(`effectivePosition (精度处理后): ${effectivePosition}`);

    // 获取活跃订单
    const orders = await deps.fetchOrders(MARKET_ID);
    console.log(`\n活跃订单数: ${orders.length}`);

    // 计算已挂买单量
    const buyOrders = orders.filter(o => o.order?.side === 'BUY');
    const openBuyRemaining = buyOrders.reduce((sum, o) => sum + (o.order.quantity - o.order.quantityFilled), 0);
    console.log(`已挂买单剩余量: ${openBuyRemaining}`);

    // 计算目标买单量（与 calculateBuyDelta 一致）
    const desiredBuy = MAX_SHARES - effectivePosition - openBuyRemaining;
    console.log(`\n目标买单量 (desiredBuy): ${desiredBuy}`);
    console.log(`  = maxShares(${MAX_SHARES}) - effectivePosition(${effectivePosition}) - openBuyRemaining(${openBuyRemaining})`);

    if (desiredBuy > 0) {
        console.log(`\n⚠️  会触发买单！数量: ${desiredBuy}`);
    } else {
        console.log(`\n✓  不会触发买单 (desiredBuy <= 0)`);
    }

    // 计算已挂卖单量
    const sellOrders = orders.filter(o => o.order?.side === 'SELL');
    const openSellRemaining = sellOrders.reduce((sum, o) => sum + (o.order.quantity - o.order.quantityFilled), 0);
    console.log(`\n已挂卖单剩余量: ${openSellRemaining}`);
}

main().catch(console.error);
