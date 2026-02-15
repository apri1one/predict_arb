/**
 * 测试脚本：检查订单的 marketId
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { createTradingClient } from '../market-maker/trading-client.js';

const MARKET_ID = 521;

async function main() {
    console.log('初始化 TradingClient...');
    const client = createTradingClient();
    await client.init();

    // 获取订单
    console.log(`\n获取市场 ${MARKET_ID} 的订单...`);
    const orders = await client.fetchOrders(MARKET_ID);

    console.log(`\n返回 ${orders.length} 个订单:`);
    for (const o of orders) {
        console.log(`  ID: ${o.id}, marketId: ${o.order.marketId}, side: ${o.order.side}, qty: ${o.order.quantity}`);
    }

    // 过滤实际属于 MARKET_ID 的订单
    const filtered = orders.filter(o => o.order.marketId === MARKET_ID);
    console.log(`\n实际属于市场 ${MARKET_ID} 的订单: ${filtered.length} 个`);
}

main().catch(console.error);
