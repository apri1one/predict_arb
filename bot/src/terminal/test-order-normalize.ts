/**
 * 测试脚本：验证订单数据解析是否正确
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { createTradingClient } from '../market-maker/trading-client.js';

const MARKET_ID = 521;

async function main() {
    console.log('初始化 TradingClient...');
    const client = createTradingClient();
    await client.init();
    console.log('初始化成功\n');

    // 使用 fetchOrders（经过 normalizeOrderResponse 处理）
    console.log(`获取市场 ${MARKET_ID} 的订单（已解析）...`);
    const orders = await client.fetchOrders(MARKET_ID);

    console.log(`\n找到 ${orders.length} 个订单:\n`);

    for (const o of orders) {
        console.log(`ID: ${o.id}`);
        console.log(`  side: ${o.order.side}`);
        console.log(`  status: ${o.order.status}`);
        console.log(`  quantity: ${o.order.quantity}`);
        console.log(`  quantityFilled: ${o.order.quantityFilled}`);
        console.log(`  price: ${o.order.price}`);
        console.log(`  marketId: ${o.order.marketId}`);
        console.log(`  hash: ${o.order.hash.slice(0, 20)}...`);
        console.log('');
    }
}

main().catch(console.error);
