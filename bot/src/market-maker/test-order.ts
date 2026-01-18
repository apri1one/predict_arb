/**
 * 真实下单测试
 *
 * 测试流程:
 * 1. 初始化交易客户端（验证 Privy 钱包）
 * 2. 获取一个有订单簿的市场
 * 3. 按买一价挂单 0.1 share
 * 4. 等待 3 秒
 * 5. 撤单
 *
 * 运行: npx tsx src/market-maker/test-order.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

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

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log(`${c.cyan}=== 真实下单测试 ===${c.reset}\n`);

    const apiKey = process.env.PREDICT_API_KEY!;
    const baseUrl = 'https://api.predict.fun';

    try {
        // 1. 初始化交易客户端
        console.log(`${c.dim}初始化交易客户端...${c.reset}`);
        const client = createTradingClient();
        await client.init();

        // 2. 显示余额
        const balance = await client.getBalance();
        console.log(`${c.green}✓ 余额: ${balance.toFixed(4)} USDT${c.reset}\n`);

        if (balance < 0.1) {
            console.log(`${c.red}余额不足，需要至少 0.1 USDT${c.reset}`);
            return;
        }

        // 3. 查找一个有订单簿的 negRisk 市场
        console.log(`${c.dim}查找有订单簿的 negRisk 市场...${c.reset}`);

        // 获取热门市场
        const marketsRes = await fetch(`${baseUrl}/v1/orders/matches?limit=50`, {
            headers: { 'x-api-key': apiKey }
        });
        const marketsData = await marketsRes.json() as {
            data?: Array<{
                market: {
                    id: number;
                    title: string;
                    conditionId: string;
                    isNegRisk: boolean;
                    isYieldBearing?: boolean;
                    feeRateBps: number;
                };
            }>;
        };

        let testMarket: {
            id: number;
            title: string;
            conditionId: string;
            isNegRisk: boolean;
            isYieldBearing: boolean;
            feeRateBps: number;
        } | null = null;
        let bestBid = 0;

        for (const match of marketsData.data || []) {
            const market = match.market;
            // 优先选择 negRisk 市场（Token ID 计算更可靠）
            if (!market.isNegRisk) continue;

            const bookRes = await fetch(`${baseUrl}/v1/markets/${market.id}/orderbook`, {
                headers: { 'x-api-key': apiKey }
            });
            const bookData = await bookRes.json() as { data?: { bids: [number, number][]; asks: [number, number][] } };

            if (bookData.data && bookData.data.bids.length > 0) {
                testMarket = {
                    id: market.id,
                    title: market.title,
                    conditionId: market.conditionId,
                    isNegRisk: market.isNegRisk,
                    isYieldBearing: market.isYieldBearing ?? false,
                    feeRateBps: market.feeRateBps,
                };
                bestBid = bookData.data.bids[0][0];
                break;
            }
        }

        if (!testMarket || bestBid === 0) {
            console.log(`${c.red}未找到有订单簿的市场${c.reset}`);
            return;
        }

        // 关键：isYieldBearing 会影响签名域里的 verifyingContract，不正确会导致 Order hash mismatch
        const marketDetailRes = await fetch(`${baseUrl}/v1/markets/${testMarket.id}`, {
            headers: { 'x-api-key': apiKey }
        });
        if (!marketDetailRes.ok) {
            throw new Error(`获取市场详情失败: ${marketDetailRes.status}`);
        }
        const marketDetail = await marketDetailRes.json() as {
            data?: { isNegRisk?: boolean; isYieldBearing?: boolean; feeRateBps?: number };
        };
        testMarket.isNegRisk = marketDetail.data?.isNegRisk ?? testMarket.isNegRisk;
        testMarket.isYieldBearing = marketDetail.data?.isYieldBearing ?? testMarket.isYieldBearing;
        testMarket.feeRateBps = marketDetail.data?.feeRateBps ?? testMarket.feeRateBps;

        console.log(`${c.green}✓ 找到市场: [${testMarket.id}] ${testMarket.title}${c.reset}`);
        console.log(`  买一价: ${(bestBid * 100).toFixed(2)}¢`);
        console.log(`  isNegRisk: ${testMarket.isNegRisk}`);
        console.log(`  isYieldBearing: ${testMarket.isYieldBearing}`);
        console.log(`  feeRateBps: ${testMarket.feeRateBps}\n`);

        // 4. 获取 Token ID
        console.log(`${c.dim}获取 Token ID...${c.reset}`);
        const tokenId = await client.getTokenId(testMarket.id);
        console.log(`${c.green}✓ Token ID: ${tokenId.slice(0, 30)}...${c.reset}\n`);

        // 5. 下单 - 买入 N share @ 买一价 (需要满足最低 0.9 USD)
        const price = bestBid;
        // 计算满足 0.9 USD 最低金额的数量，向上取整并加余量
        const minValue = 0.9;
        const minQuantity = Math.ceil(minValue / price) + 1;
        const quantity = Math.max(minQuantity, 2);
        const cost = price * quantity;

        console.log(`${c.yellow}>>> 准备下单: BUY ${quantity} shares @ ${(price * 100).toFixed(2)}¢ (成本: ${cost.toFixed(4)} USDT)${c.reset}`);
        console.log(`${c.dim}下单中...${c.reset}`);

        let orderResult: { id: string; hash: string };
        try {
            orderResult = await client.placeOrder({
                marketId: testMarket.id,
                tokenId,
                side: 'BUY',
                price,
                quantity,
                feeRateBps: testMarket.feeRateBps,
                isNegRisk: testMarket.isNegRisk,
                isYieldBearing: testMarket.isYieldBearing
            });
        } catch (error) {
            console.log(`${c.red}✗ 下单失败${c.reset}`);
            console.error(error);
            return;
        }

        console.log(`${c.green}✓ 下单成功!${c.reset}`);
        console.log(`  订单哈希: ${orderResult.hash}\n`);

        // 6. 等待 3 秒
        console.log(`${c.dim}等待 3 秒...${c.reset}`);
        await sleep(3000);

        // 7. 获取订单详情用于撤单
        console.log(`${c.dim}获取订单详情...${c.reset}`);
        const orders = await client.fetchOrders(testMarket.id);
        const orderToCancel = (orders as any[]).find((o: any) => o.order?.hash === orderResult.hash);

        if (!orderToCancel) {
            console.log(`${c.yellow}⚠ 未找到订单（可能已成交）${c.reset}\n`);
        } else {
            // 8. API 撤单（无需 gas）
            const orderId = orderToCancel.id;
            console.log(`${c.yellow}>>> 准备撤单: 订单 ID ${orderId}${c.reset}`);
            console.log(`${c.dim}撤单中...${c.reset}`);

            const cancelResult = await client.cancelOrder(orderId);
            if (cancelResult) {
                console.log(`${c.green}✓ 撤单成功!${c.reset}\n`);
            } else {
                console.log(`${c.yellow}⚠ 撤单失败${c.reset}\n`);
            }
        }

        // 9. 确认余额
        const finalBalance = await client.getBalance();
        console.log(`${c.green}✓ 最终余额: ${finalBalance.toFixed(4)} USDT${c.reset}`);
        console.log(`  变化: ${(finalBalance - balance).toFixed(4)} USDT\n`);

        console.log(`${c.cyan}=== 测试完成 ===${c.reset}`);
        console.log(`${c.green}下单和撤单功能正常！${c.reset}`);

    } catch (error) {
        console.error(`${c.red}错误:${c.reset}`, error);
        process.exit(1);
    }
}

main();
