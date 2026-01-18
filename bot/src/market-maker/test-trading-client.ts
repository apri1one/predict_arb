/**
 * 测试交易客户端
 *
 * 验证:
 * - JWT 认证
 * - Token ID 计算
 * - 余额查询
 * - 订单簿获取
 *
 * 运行: npx tsx src/market-maker/test-trading-client.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// 加载 .env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { createTradingClient } from './trading-client.js';

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    dim: '\x1b[2m',
};

async function main() {
    console.log(`${c.cyan}=== 交易客户端测试 ===${c.reset}\n`);

    try {
        // 1. 创建并初始化客户端
        console.log(`${c.dim}创建交易客户端...${c.reset}`);
        const client = createTradingClient();

        console.log(`${c.dim}初始化（JWT认证 + 合约连接）...${c.reset}`);
        await client.init();
        console.log(`${c.green}✓ 初始化成功${c.reset}\n`);

        // 2. 获取余额
        console.log(`${c.dim}查询 USDT 余额...${c.reset}`);
        const balance = await client.getBalance();
        console.log(`${c.green}✓ 余额: ${balance.toFixed(4)} USDT${c.reset}\n`);

        // 3. 获取市场信息
        const testMarketId = 539; // Jake Paul market (negRisk)
        console.log(`${c.dim}获取市场 ${testMarketId} 订单簿...${c.reset}`);
        const orderbook = await client.fetchOrderBook(testMarketId);

        if (orderbook) {
            const bestBid = orderbook.bids[0]?.[0] ?? 0;
            const bestAsk = orderbook.asks[0]?.[0] ?? 0;
            console.log(`${c.green}✓ 订单簿: Bid=${(bestBid * 100).toFixed(1)}¢, Ask=${(bestAsk * 100).toFixed(1)}¢${c.reset}\n`);
        } else {
            console.log(`${c.yellow}⚠ 订单簿为空${c.reset}\n`);
        }

        // 4. 计算 Token ID
        console.log(`${c.dim}计算市场 ${testMarketId} Token ID...${c.reset}`);

        // 获取市场详情
        const apiKey = process.env.PREDICT_API_KEY!;
        const res = await fetch(`https://api.predict.fun/v1/markets/${testMarketId}`, {
            headers: { 'x-api-key': apiKey }
        });
        const marketData = await res.json() as { data: { conditionId: string; isNegRisk: boolean } };

        const tokenId = await client.getTokenId(testMarketId);
        console.log(`${c.green}✓ Token ID: ${tokenId.slice(0, 30)}...${c.reset}\n`);

        // 5. 获取持仓
        console.log(`${c.dim}查询市场 ${testMarketId} 持仓...${c.reset}`);
        const position = await client.fetchPosition(testMarketId);
        console.log(`${c.green}✓ 持仓: ${position} shares${c.reset}\n`);

        // 6. 获取活跃订单
        console.log(`${c.dim}查询市场 ${testMarketId} 活跃订单...${c.reset}`);
        const orders = await client.fetchOrders(testMarketId);
        console.log(`${c.green}✓ 活跃订单: ${orders.length} 个${c.reset}\n`);

        console.log(`${c.cyan}=== 测试完成 ===${c.reset}`);
        console.log(`${c.green}所有功能正常！可以运行 npm run market-maker${c.reset}`);

    } catch (error) {
        console.error(`${c.red}错误:${c.reset}`, error);
        process.exit(1);
    }
}

main();
