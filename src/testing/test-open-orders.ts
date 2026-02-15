/**
 * 测试 Open Orders 获取
 *
 * 验证 Predict 和 Polymarket 的未成交订单查询
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import { Wallet } from 'ethers';
import { OrderBuilder, ChainId } from '@predictdotfun/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

// ============================================================================
// Predict Open Orders
// ============================================================================

async function testPredictOpenOrders(): Promise<void> {
    console.log(`\n${c.cyan}=== Predict Open Orders ===${c.reset}\n`);

    const PREDICT_API_KEY = process.env.PREDICT_API_KEY;
    const PREDICT_BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';
    const PREDICT_SIGNER_PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY;
    const PREDICT_SMART_WALLET_ADDRESS = process.env.PREDICT_SMART_WALLET_ADDRESS;

    if (!PREDICT_API_KEY) {
        console.log(`${c.red}✗ 缺少 PREDICT_API_KEY${c.reset}`);
        return;
    }

    // 1. 获取 JWT Token
    console.log(`${c.dim}获取 JWT Token...${c.reset}`);

    try {
        // 初始化 OrderBuilder
        const provider = new (await import('ethers')).JsonRpcProvider('https://bsc-dataseed.bnbchain.org/');
        const signer = new Wallet(PREDICT_SIGNER_PRIVATE_KEY!, provider);

        const orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer as any, {
            predictAccount: PREDICT_SMART_WALLET_ADDRESS!
        });

        // 获取认证消息
        const msgRes = await fetch(`${PREDICT_BASE_URL}/v1/auth/message`, {
            headers: { 'x-api-key': PREDICT_API_KEY }
        });

        if (!msgRes.ok) {
            console.log(`${c.red}✗ 获取认证消息失败: ${msgRes.status}${c.reset}`);
            return;
        }

        const msgData = await msgRes.json() as any;
        const message = msgData.data.message;

        // 签名
        const signature = await orderBuilder.signPredictAccountMessage(message);

        // 获取 JWT
        const authRes = await fetch(`${PREDICT_BASE_URL}/v1/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': PREDICT_API_KEY
            },
            body: JSON.stringify({
                signer: PREDICT_SMART_WALLET_ADDRESS,
                signature: signature,
                message: message
            })
        });

        if (!authRes.ok) {
            console.log(`${c.red}✗ JWT 获取失败: ${authRes.status}${c.reset}`);
            return;
        }

        const authData = await authRes.json() as any;
        const jwtToken = authData.data.token;
        console.log(`${c.green}✓ JWT Token 获取成功${c.reset}\n`);

        // 2. 查询 Open Orders
        console.log(`${c.dim}查询 Open Orders...${c.reset}`);

        const ordersRes = await fetch(`${PREDICT_BASE_URL}/v1/orders?status=OPEN`, {
            headers: {
                'x-api-key': PREDICT_API_KEY,
                'Authorization': `Bearer ${jwtToken}`
            }
        });

        if (!ordersRes.ok) {
            console.log(`${c.red}✗ 订单查询失败: ${ordersRes.status}${c.reset}`);
            const errorText = await ordersRes.text();
            console.log(`${c.dim}响应: ${errorText}${c.reset}`);
            return;
        }

        const ordersData = await ordersRes.json() as any;
        const rawOrders = ordersData.data || [];

        console.log(`${c.green}✓ 查询成功，找到 ${rawOrders.length} 个订单${c.reset}\n`);

        if (rawOrders.length > 0) {
            console.log(`${c.yellow}订单列表 (解析后):${c.reset}`);
            for (const o of rawOrders) {
                const orderData = o.order || {};

                // 解析逻辑 (与 account-service.ts 一致)
                const sideNum = orderData.side ?? o.side;
                const side = sideNum === 0 || sideNum === '0' ? 'BUY' : 'SELL';

                const amountWei = BigInt(o.amount || orderData.takerAmount || '0');
                const qty = Number(amountWei) / 1e18;

                const filledWei = BigInt(o.amountFilled || '0');
                const filled = Number(filledWei) / 1e18;

                const makerAmount = Number(BigInt(orderData.makerAmount || '0')) / 1e18;
                const takerAmount = Number(BigInt(orderData.takerAmount || '0')) / 1e18;
                const price = takerAmount > 0 ? makerAmount / takerAmount : 0;

                console.log(`  - Market #${o.marketId}`);
                console.log(`    Side: ${side}, Outcome: YES`);
                console.log(`    Price: ${(price * 100).toFixed(0)}¢, Qty: ${qty} shares`);
                console.log(`    Filled: ${filled}/${qty}`);
                console.log(`    Hash: ${orderData.hash?.slice(0, 20)}...`);
                console.log('');
            }
        }

        // 打印原始数据结构 (第一个订单)
        if (rawOrders.length > 0) {
            console.log(`${c.dim}原始数据结构 (第一个订单):${c.reset}`);
            console.log(JSON.stringify(rawOrders[0], null, 2));
        }

    } catch (error) {
        console.error(`${c.red}✗ 错误: ${(error as Error).message}${c.reset}`);
    }
}

// ============================================================================
// Polymarket Open Orders
// ============================================================================

function buildPolymarketHeaders(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    address: string,
    method: string,
    path: string
): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method + path;

    const secretBuffer = Buffer.from(apiSecret, 'base64');
    const signature = createHmac('sha256', secretBuffer)
        .update(message, 'utf-8')
        .digest('base64');

    const urlSafeSignature = signature.replace(/\+/g, '-').replace(/\//g, '_');

    return {
        'POLY_API_KEY': apiKey,
        'POLY_SIGNATURE': urlSafeSignature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': passphrase,
        'POLY_ADDRESS': address,
        'Content-Type': 'application/json',
    };
}

async function testPolymarketOpenOrders(): Promise<void> {
    console.log(`\n${c.cyan}=== Polymarket Open Orders ===${c.reset}\n`);

    const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY;
    const POLYMARKET_API_SECRET = process.env.POLYMARKET_API_SECRET;
    const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;
    const POLYMARKET_TRADER_ADDRESS = process.env.POLYMARKET_TRADER_ADDRESS;

    if (!POLYMARKET_API_KEY || !POLYMARKET_API_SECRET || !POLYMARKET_PASSPHRASE || !POLYMARKET_TRADER_ADDRESS) {
        console.log(`${c.red}✗ 缺少 Polymarket API 配置${c.reset}`);
        return;
    }

    try {
        console.log(`${c.dim}查询订单 (Get Active Orders API)...${c.reset}`);

        // 根据文档，/data/orders 默认返回活跃订单 (不需要 state 参数)
        const ordersPath = '/data/orders';
        const headers = buildPolymarketHeaders(
            POLYMARKET_API_KEY,
            POLYMARKET_API_SECRET,
            POLYMARKET_PASSPHRASE,
            POLYMARKET_TRADER_ADDRESS,
            'GET',
            ordersPath
        );

        console.log(`${c.dim}  API: https://clob.polymarket.com${ordersPath}${c.reset}`);
        console.log(`${c.dim}  Address: ${POLYMARKET_TRADER_ADDRESS}${c.reset}`);

        const ordersRes = await fetch(`https://clob.polymarket.com${ordersPath}`, { headers });

        console.log(`${c.dim}  Status: ${ordersRes.status}${c.reset}`);

        if (!ordersRes.ok) {
            console.log(`${c.red}✗ 订单查询失败: ${ordersRes.status}${c.reset}`);
            const errorText = await ordersRes.text();
            console.log(`${c.dim}响应: ${errorText}${c.reset}`);
            return;
        }

        const ordersData = await ordersRes.json() as any;

        // 打印原始响应结构
        console.log(`${c.dim}原始响应类型: ${typeof ordersData}, isArray: ${Array.isArray(ordersData)}${c.reset}`);
        if (!Array.isArray(ordersData)) {
            console.log(`${c.dim}响应 keys: ${Object.keys(ordersData).join(', ')}${c.reset}`);
        }

        // API 返回订单数组
        const allOrders = Array.isArray(ordersData) ? ordersData : (ordersData.orders || ordersData.data || []);
        console.log(`${c.dim}总订单数: ${allOrders.length}${c.reset}`);

        // 过滤 LIVE 状态的订单
        const liveOrders = allOrders.filter((o: any) => {
            const status = (o.status || o.order_status || '').toUpperCase();
            return status === 'LIVE' || status === 'OPEN' || status === 'MATCHED';
        });

        console.log(`${c.green}✓ 查询成功，找到 ${liveOrders.length} 个活跃订单${c.reset}\n`);

        if (liveOrders.length > 0) {
            console.log(`${c.yellow}订单列表:${c.reset}`);
            for (const order of liveOrders) {
                console.log(`  - Market: ${order.market || order.asset_id?.slice(0, 20) + '...'}`);
                console.log(`    Side: ${order.side}, Status: ${order.status}`);
                console.log(`    Price: ${order.price}, Size: ${order.size || order.original_size}`);
                console.log(`    Matched: ${order.size_matched || 0}`);
                console.log(`    OrderID: ${order.id || order.order_id}`);
                console.log('');
            }
        }

        // 打印原始数据结构 (第一个 LIVE 订单)
        if (liveOrders.length > 0) {
            console.log(`${c.dim}原始数据结构 (第一个 LIVE 订单):${c.reset}`);
            console.log(JSON.stringify(liveOrders[0], null, 2));
        }

    } catch (error) {
        console.error(`${c.red}✗ 错误: ${(error as Error).message}${c.reset}`);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log(`\n${c.cyan}====== Open Orders 测试 ======${c.reset}`);

    await testPredictOpenOrders();
    await testPolymarketOpenOrders();

    console.log(`\n${c.green}====== 测试完成 ======${c.reset}\n`);
}

main().catch(err => {
    console.error(`${c.red}测试失败:${c.reset}`, err);
    process.exit(1);
});
