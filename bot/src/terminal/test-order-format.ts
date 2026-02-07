/**
 * 测试脚本：查看订单 API 返回的原始数据格式
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
    console.log('初始化成功');

    // 直接调用原始 API（不经过 normalizeOrderResponse）
    const jwt = await client.getJwt();
    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': process.env.PREDICT_API_KEY!,
        'Authorization': `Bearer ${jwt}`
    };

    // 获取订单
    console.log(`\n获取市场 ${MARKET_ID} 的 OPEN 订单...`);
    const res = await fetch(
        `https://api.predict.fun/v1/orders?marketId=${MARKET_ID}&status=OPEN`,
        { headers }
    );

    const data = await res.json() as { data?: any[] };

    console.log('\n=== API 原始响应 ===');
    console.log(JSON.stringify(data, null, 2));

    if (data.data && data.data.length > 0) {
        console.log('\n=== 第一个订单的字段 ===');
        const first = data.data[0];
        console.log('顶层字段:', Object.keys(first));
        if (first.order) {
            console.log('order 子字段:', Object.keys(first.order));
        }
    }
}

main().catch(console.error);
