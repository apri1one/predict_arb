/**
 * 市价单测试 + TG 通知
 *
 * 在 Polymarket 和 Predict 分别下小额吃单订单（按卖一价买入），观察 TG 消息
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

import { PolymarketTrader } from '../dashboard/polymarket-trader.js';
import { PredictTrader } from '../dashboard/predict-trader.js';

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

// 测试市场配置
const TEST_MARKETS = {
    // Polymarket: Fed January 2026 "No change" YES token
    polymarket: {
        tokenId: '112838095111461683880944516726938163688341306245473734071798778736646352193304',
        conditionId: '0xe93c89c41d1bb08d3bb40066d8565df301a696563b2542256e6e8bbbb1ec490d',
        negRisk: true,
        marketTitle: 'Fed Jan: No change',
        outcome: 'YES' as const,
    },
    // Predict: Will find active market
    predict: {
        marketId: 0,  // Will be set dynamically
        title: '',
        outcome: 'YES' as const,
    },
};

async function getPolyOrderbook(tokenId: string): Promise<{ bestAsk: number; bestAskSize: number } | null> {
    try {
        const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        if (!res.ok) return null;
        const data = await res.json() as { asks: { price: string; size: string }[] };
        if (!data.asks?.length) return null;
        // asks 是从低到高排序，第一个是 best ask
        const best = data.asks[0];
        return { bestAsk: parseFloat(best.price), bestAskSize: parseFloat(best.size) };
    } catch {
        return null;
    }
}

async function getPredictOrderbook(marketId: number): Promise<{ bestAsk: number; bestAskSize: number } | null> {
    try {
        const apiKey = process.env.PREDICT_API_KEY;
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey || '' },
        });
        if (!res.ok) return null;
        const data = await res.json() as { data: { asks: [number, number][] } };
        if (!data.data?.asks?.length) return null;
        // asks 是 [price, size]，从低到高排序
        const [price, size] = data.data.asks[0];
        return { bestAsk: price, bestAskSize: size };
    } catch {
        return null;
    }
}

async function main() {
    console.log(`\n${c.cyan}=== 市价单 + TG 通知测试 ===${c.reset}\n`);

    // 解析命令行参数
    const args = process.argv.slice(2);
    const testPoly = args.includes('--poly') || args.includes('--all') || args.length === 0;
    const testPredict = args.includes('--predict') || args.includes('--all') || args.length === 0;

    // 初始化 traders
    const polyTrader = new PolymarketTrader();
    const predictTrader = new PredictTrader();

    // ========================================
    // Polymarket 测试
    // ========================================
    if (testPoly) {
        console.log(`${c.yellow}[Polymarket] 获取订单簿...${c.reset}`);
        const polyBook = await getPolyOrderbook(TEST_MARKETS.polymarket.tokenId);

        if (!polyBook) {
            console.log(`${c.red}[Polymarket] 无法获取订单簿${c.reset}`);
        } else {
            console.log(`  Best Ask: ${(polyBook.bestAsk * 100).toFixed(1)}¢`);
            console.log(`  Ask Size: ${polyBook.bestAskSize.toFixed(0)} shares`);

            // 计算最小订单量 (>= $1)
            const minQty = Math.ceil(1 / polyBook.bestAsk);
            const orderQty = Math.max(minQty, 10); // 至少 10 股
            const orderCost = polyBook.bestAsk * orderQty;

            console.log(`\n${c.yellow}[Polymarket] 下单参数:${c.reset}`);
            console.log(`  价格: ${(polyBook.bestAsk * 100).toFixed(1)}¢`);
            console.log(`  数量: ${orderQty} shares`);
            console.log(`  成本: $${orderCost.toFixed(2)}`);

            console.log(`\n${c.dim}等待 2 秒后下单...${c.reset}`);
            await new Promise(r => setTimeout(r, 2000));

            console.log(`${c.dim}提交订单...${c.reset}`);
            const result = await polyTrader.placeOrder({
                tokenId: TEST_MARKETS.polymarket.tokenId,
                side: 'BUY',
                price: polyBook.bestAsk,
                quantity: orderQty,
                orderType: 'IOC',  // 立即成交
                negRisk: TEST_MARKETS.polymarket.negRisk,
                outcome: TEST_MARKETS.polymarket.outcome,
                marketTitle: TEST_MARKETS.polymarket.marketTitle,
                conditionId: TEST_MARKETS.polymarket.conditionId,
            });

            if (result.success) {
                console.log(`${c.green}✓ Polymarket 下单成功!${c.reset}`);
                console.log(`  Order ID: ${result.orderId}`);

                // 等待一下让 TG 通知发出
                await new Promise(r => setTimeout(r, 2000));

                // 查询订单状态
                if (result.orderId) {
                    const status = await polyTrader.getOrderStatus(result.orderId);
                    console.log(`  Status: ${status?.status || 'unknown'}`);
                    console.log(`  Filled: ${status?.filledQty || 0}`);
                }
            } else {
                console.log(`${c.red}✗ Polymarket 下单失败: ${result.error}${c.reset}`);
            }
        }
    }

    // ========================================
    // Predict 测试
    // ========================================
    if (testPredict) {
        console.log(`\n${c.yellow}[Predict] 获取订单簿...${c.reset}`);
        const predictBook = await getPredictOrderbook(TEST_MARKETS.predict.marketId);

        if (!predictBook) {
            console.log(`${c.red}[Predict] 无法获取订单簿${c.reset}`);
        } else {
            console.log(`  Best Ask: ${(predictBook.bestAsk * 100).toFixed(1)}¢`);
            console.log(`  Ask Size: ${predictBook.bestAskSize.toFixed(0)} shares`);

            // Predict 最小订单 ~$1
            const minQty = Math.ceil(1 / predictBook.bestAsk);
            const orderQty = Math.max(minQty, 10);
            const orderCost = predictBook.bestAsk * orderQty;

            console.log(`\n${c.yellow}[Predict] 下单参数:${c.reset}`);
            console.log(`  Market ID: ${TEST_MARKETS.predict.marketId}`);
            console.log(`  价格: ${(predictBook.bestAsk * 100).toFixed(1)}¢`);
            console.log(`  数量: ${orderQty} shares`);
            console.log(`  成本: $${orderCost.toFixed(2)}`);

            console.log(`\n${c.dim}等待 2 秒后下单...${c.reset}`);
            await new Promise(r => setTimeout(r, 2000));

            console.log(`${c.dim}提交订单...${c.reset}`);
            const result = await predictTrader.placeOrder({
                marketId: TEST_MARKETS.predict.marketId,
                side: 'BUY',
                price: predictBook.bestAsk,
                quantity: orderQty,
                outcome: TEST_MARKETS.predict.outcome,
            });

            if (result.success) {
                console.log(`${c.green}✓ Predict 下单成功!${c.reset}`);
                console.log(`  Hash: ${result.hash}`);

                // 等待一下让 TG 通知发出
                await new Promise(r => setTimeout(r, 2000));

                // 查询订单状态
                if (result.hash) {
                    const status = await predictTrader.getOrderStatus(result.hash);
                    console.log(`  Status: ${status?.status || 'unknown'}`);
                    console.log(`  Filled: ${status?.filledQty || 0}`);
                }
            } else {
                console.log(`${c.red}✗ Predict 下单失败: ${result.error}${c.reset}`);
            }
        }
    }

    console.log(`\n${c.green}=== 测试完成 ===${c.reset}`);
    console.log(`${c.dim}请检查 Telegram 收到的消息${c.reset}\n`);

    // 等待 TG 消息发送完成
    await new Promise(r => setTimeout(r, 3000));
    process.exit(0);
}

main().catch(err => {
    console.error(`${c.red}测试失败:${c.reset}`, err);
    process.exit(1);
});
