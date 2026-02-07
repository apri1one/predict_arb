/**
 * 测试 Polymarket negRisk 市场下单
 * Market 705: Seattle Seahawks Super Bowl
 */

import * as fs from 'fs';
import * as path from 'path';
import { getPolymarketTrader } from '../dashboard/polymarket-trader.js';

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

const NO_TOKEN_ID = '47021554520147489198499363137978179318351470490672224768430579421357197997727';

async function main() {
    console.log('=== Polymarket negRisk 下单测试 ===\n');

    // 获取 trader（构造函数已初始化）
    const trader = getPolymarketTrader();

    // 1. 获取订单簿
    console.log('[1] 获取 NO token 订单簿...');
    const book = await trader.getOrderbook(NO_TOKEN_ID);

    if (!book || !book.asks || book.asks.length === 0) {
        console.error('无法获取订单簿或无卖单');
        return;
    }

    const bestAsk = book.asks[0];
    console.log(`    Best Ask: ${bestAsk.price} @ ${bestAsk.size} shares`);

    // 2. 检查这是否是 negRisk 市场
    console.log('\n[2] 检查市场类型...');
    try {
        const marketRes = await fetch(`https://clob.polymarket.com/markets/${NO_TOKEN_ID}`);
        const marketData = await marketRes.json() as any;
        console.log(`    negRisk: ${marketData.neg_risk}`);
        console.log(`    condition_id: ${marketData.condition_id}`);
    } catch (e) {
        console.log('    无法获取市场信息');
    }

    // 3. 尝试下单
    console.log('\n[3] 尝试下单 BUY NO 10 shares...');
    console.log(`    价格: ${bestAsk.price}`);
    console.log(`    数量: 10`);
    console.log(`    negRisk: true`);

    try {
        const result = await trader.placeOrder({
            tokenId: NO_TOKEN_ID,
            side: 'BUY',
            price: bestAsk.price,
            quantity: 10,
            orderType: 'IOC',
            outcome: 'NO',
            negRisk: true,  // 关键：negRisk 市场
        });

        console.log('\n[结果]');
        console.log(`    success: ${result.success}`);
        console.log(`    orderId: ${result.orderId || 'N/A'}`);
        console.log(`    error: ${result.error || 'N/A'}`);
    } catch (error: any) {
        console.error('\n[错误]', error.message);
    }
}

main().catch(console.error);
