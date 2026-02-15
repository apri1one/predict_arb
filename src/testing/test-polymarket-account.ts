/**
 * 测试 Polymarket 账户余额和订单查询
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';

// 加载 .env
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

const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY!;
const POLYMARKET_API_SECRET = process.env.POLYMARKET_API_SECRET!;
const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE!;
const POLYMARKET_TRADER_ADDRESS = process.env.POLYMARKET_TRADER_ADDRESS!;
const POLYMARKET_PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS || '';

/**
 * 构建 Polymarket HMAC 签名 Headers
 */
function buildPolymarketHeaders(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    address: string,
    method: string,
    path: string,
    body: string = ''
): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method + path + body;

    const secretBuffer = Buffer.from(apiSecret, 'base64');
    const signature = crypto
        .createHmac('sha256', secretBuffer)
        .update(message, 'utf-8')
        .digest('base64');

    // URL-safe base64
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

async function testPolymarketAccount() {
    console.log('============================================================');
    console.log('   测试 Polymarket 账户查询');
    console.log('============================================================\n');

    console.log(`Trader Address: ${POLYMARKET_TRADER_ADDRESS}\n`);

    // 1. 查询余额
    console.log('--- 1. 查询余额 (/balance-allowance) ---');
    try {
        const balancePath = '/balance-allowance';
        const headers = buildPolymarketHeaders(
            POLYMARKET_API_KEY,
            POLYMARKET_API_SECRET,
            POLYMARKET_PASSPHRASE,
            POLYMARKET_TRADER_ADDRESS,
            'GET',
            balancePath
        );

        const res = await fetch(
            `https://clob.polymarket.com${balancePath}?asset_type=COLLATERAL`,
            { headers }
        );

        if (res.ok) {
            const data = await res.json();
            console.log('完整响应:');
            console.log(JSON.stringify(data, null, 2));

            const balance = data.balance ? parseFloat(data.balance) / 1e6 : 0;
            const allowance = data.allowance ? parseFloat(data.allowance) / 1e6 : 0;

            console.log(`\n余额: $${balance.toFixed(2)} USDC`);
            console.log(`授权额度: $${allowance.toFixed(2)}\n`);
        } else {
            const errorText = await res.text();
            console.error(`❌ 查询失败 (${res.status}): ${errorText}\n`);
        }
    } catch (error: any) {
        console.error(`❌ 查询异常: ${error.message}\n`);
    }

    // 2. 查询订单
    console.log('--- 2. 查询订单 (/data/orders) ---');
    try {
        const ordersPath = '/data/orders';
        const headers = buildPolymarketHeaders(
            POLYMARKET_API_KEY,
            POLYMARKET_API_SECRET,
            POLYMARKET_PASSPHRASE,
            POLYMARKET_TRADER_ADDRESS,
            'GET',
            ordersPath
        );

        const res = await fetch(
            `https://clob.polymarket.com${ordersPath}`,
            { headers }
        );

        if (res.ok) {
            const data = await res.json();
            const orderList = Array.isArray(data) ? data : (data.orders || []);

            console.log(`找到 ${orderList.length} 个订单\n`);

            if (orderList.length > 0) {
                console.log('前 5 个订单:');
                for (const order of orderList.slice(0, 5)) {
                    const side = order.side || '?';
                    const size = order.size || order.original_size || '?';
                    const price = order.price || '?';
                    const status = order.status || 'unknown';
                    console.log(`  - ${side} ${size} @ $${price} (${status})`);
                }

                // 计算锁定金额
                let locked = 0;
                for (const order of orderList) {
                    if (order.status === 'LIVE' || order.status === 'live') {
                        if (order.side === 'BUY') {
                            locked += parseFloat(order.size || 0) * parseFloat(order.price || 0);
                        }
                    }
                }
                console.log(`\n锁定金额 (BUY订单): $${locked.toFixed(2)}\n`);
            } else {
                console.log('没有订单\n');
            }
        } else {
            const errorText = await res.text();
            console.error(`❌ 查询失败 (${res.status}): ${errorText}\n`);
        }
    } catch (error: any) {
        console.error(`❌ 查询异常: ${error.message}\n`);
    }

    // 3. 查询交易记录
    console.log('--- 3. 查询交易记录 (/data/trades) ---');
    try {
        const tradesPath = '/data/trades';
        const headers = buildPolymarketHeaders(
            POLYMARKET_API_KEY,
            POLYMARKET_API_SECRET,
            POLYMARKET_PASSPHRASE,
            POLYMARKET_TRADER_ADDRESS,
            'GET',
            tradesPath
        );

        const res = await fetch(
            `https://clob.polymarket.com${tradesPath}`,
            { headers }
        );

        if (res.ok) {
            const data = await res.json();
            const tradeList = Array.isArray(data) ? data : (data.trades || []);

            console.log(`找到 ${tradeList.length} 笔交易\n`);

            if (tradeList.length > 0) {
                console.log('前 5 笔交易:');
                for (const trade of tradeList.slice(0, 5)) {
                    const side = trade.side || '?';
                    const size = trade.size || '?';
                    const price = trade.price || '?';
                    console.log(`  - ${side} ${size} @ $${price}`);
                }
                console.log();
            } else {
                console.log('没有交易记录\n');
            }
        } else {
            const errorText = await res.text();
            console.error(`❌ 查询失败 (${res.status}): ${errorText}\n`);
        }
    } catch (error: any) {
        console.error(`❌ 查询异常: ${error.message}\n`);
    }

    // 4. 查询链上余额 (Polygon)
    console.log('--- 4. 查询链上余额 (Polygon) ---');
    try {
        const polygonRpc = new ethers.JsonRpcProvider('https://polygon-rpc.com/');
        const usdceAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e on Polygon
        const erc20ABI = [
            'function balanceOf(address account) view returns (uint256)',
            'function decimals() view returns (uint8)',
        ];

        const contract = new ethers.Contract(usdceAddress, erc20ABI, polygonRpc);
        const decimals = await contract.decimals();

        // 查询 EOA 余额
        console.log(`\n[EOA 地址: ${POLYMARKET_TRADER_ADDRESS}]`);
        const eoaBalance = await contract.balanceOf(POLYMARKET_TRADER_ADDRESS);
        const eoaBalanceFormatted = ethers.formatUnits(eoaBalance, decimals);
        const eoaMaticBalance = await polygonRpc.getBalance(POLYMARKET_TRADER_ADDRESS);
        const eoaMaticFormatted = ethers.formatEther(eoaMaticBalance);

        console.log(`  USDC.e: $${parseFloat(eoaBalanceFormatted).toFixed(2)}`);
        console.log(`  MATIC:  ${parseFloat(eoaMaticFormatted).toFixed(4)}`);

        // 查询代理钱包余额
        if (POLYMARKET_PROXY_ADDRESS) {
            console.log(`\n[代理钱包: ${POLYMARKET_PROXY_ADDRESS}]`);
            const proxyBalance = await contract.balanceOf(POLYMARKET_PROXY_ADDRESS);
            const proxyBalanceFormatted = ethers.formatUnits(proxyBalance, decimals);
            const proxyMaticBalance = await polygonRpc.getBalance(POLYMARKET_PROXY_ADDRESS);
            const proxyMaticFormatted = ethers.formatEther(proxyMaticBalance);

            console.log(`  USDC.e: $${parseFloat(proxyBalanceFormatted).toFixed(2)}`);
            console.log(`  MATIC:  ${parseFloat(proxyMaticFormatted).toFixed(4)}`);

            const proxyCode = await polygonRpc.getCode(POLYMARKET_PROXY_ADDRESS);
            if (proxyCode === '0x') {
                console.log(`  ⚠️  合约未部署 - 请检查地址是否正确`);
            } else {
                console.log(`  ✅ 合约已部署`);
            }

            const totalBalance = parseFloat(eoaBalanceFormatted) + parseFloat(proxyBalanceFormatted);
            console.log(`\n💰 总计 USDC.e: $${totalBalance.toFixed(2)}\n`);
        } else {
            console.log(`\n⚠️ 未配置 POLYMARKET_PROXY_ADDRESS`);
            console.log(`   在 Polymarket.com 钱包页面可以找到您的代理钱包地址\n`);
        }

    } catch (error: any) {
        console.error(`❌ 链上查询失败: ${error.message}\n`);
    }

    console.log('============================================================');
    console.log('   测试完成');
    console.log('============================================================');
}

testPolymarketAccount().catch(console.error);
