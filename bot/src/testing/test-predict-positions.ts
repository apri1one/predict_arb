/**
 * 测试 Predict.fun 持仓和余额 API 返回结构
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// 加载根目录 .env
config({ path: resolve(process.cwd(), '../.env') });
config({ path: resolve(process.cwd(), '.env') });
import { Wallet, JsonRpcProvider, Network, FetchRequest } from 'ethers';
import { OrderBuilder, ChainId } from '@predictdotfun/sdk';

const PREDICT_BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';
const PREDICT_API_KEY = process.env.PREDICT_API_KEY;
const PREDICT_SIGNER_PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY;
const PREDICT_SMART_WALLET_ADDRESS = process.env.PREDICT_SMART_WALLET_ADDRESS;

const BSC_NETWORK = new Network('bnb', 56);

function createSilentProvider(rpcUrl: string): JsonRpcProvider {
    const fetchReq = new FetchRequest(rpcUrl);
    fetchReq.timeout = 5000;
    return new JsonRpcProvider(fetchReq, BSC_NETWORK, { staticNetwork: true });
}

async function main() {
    console.log('=== Predict.fun 持仓/余额 API 测试 ===\n');

    if (!PREDICT_API_KEY || !PREDICT_SIGNER_PRIVATE_KEY || !PREDICT_SMART_WALLET_ADDRESS) {
        console.error('缺少必要的环境变量');
        return;
    }

    // 1. 初始化 OrderBuilder
    console.log('1. 初始化 OrderBuilder...');
    const provider = createSilentProvider('https://bsc-dataseed.bnbchain.org');
    const signer = new Wallet(PREDICT_SIGNER_PRIVATE_KEY, provider);

    // @ts-ignore
    const builder = await OrderBuilder.make(ChainId.BnbMainnet, signer, {
        predictAccount: PREDICT_SMART_WALLET_ADDRESS
    });
    console.log('   ✅ OrderBuilder 初始化成功\n');

    // 2. 获取 JWT Token
    console.log('2. 获取 JWT Token...');
    const msgRes = await fetch(`${PREDICT_BASE_URL}/v1/auth/message`, {
        headers: { 'x-api-key': PREDICT_API_KEY }
    });
    const msgData = await msgRes.json() as any;
    const message = msgData.data.message;
    const signature = await builder.signPredictAccountMessage(message);

    const authRes = await fetch(`${PREDICT_BASE_URL}/v1/auth`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': PREDICT_API_KEY
        },
        body: JSON.stringify({
            signer: PREDICT_SMART_WALLET_ADDRESS,
            signature,
            message
        })
    });
    const authData = await authRes.json() as any;
    const jwtToken = authData.data.token;
    console.log('   ✅ JWT Token 获取成功\n');

    const headers = {
        'x-api-key': PREDICT_API_KEY,
        'Authorization': `Bearer ${jwtToken}`
    };

    // 3. 测试 /v1/positions 端点
    console.log('3. 测试 /v1/positions 端点...');
    const positionsRes = await fetch(`${PREDICT_BASE_URL}/v1/positions`, { headers });
    const positionsData = await positionsRes.json();
    console.log('   原始响应:');
    console.log(JSON.stringify(positionsData, null, 2));
    console.log();

    // 4. 测试 /v1/account 或 /v1/balance 端点 (如果存在)
    console.log('4. 测试 /v1/account 端点...');
    try {
        const accountRes = await fetch(`${PREDICT_BASE_URL}/v1/account`, { headers });
        if (accountRes.ok) {
            const accountData = await accountRes.json();
            console.log('   原始响应:');
            console.log(JSON.stringify(accountData, null, 2));
        } else {
            console.log(`   状态码: ${accountRes.status}`);
            const text = await accountRes.text();
            console.log(`   响应: ${text.slice(0, 500)}`);
        }
    } catch (e: any) {
        console.log(`   错误: ${e.message}`);
    }
    console.log();

    // 5. 测试 /v1/funds 端点 (如果存在)
    console.log('5. 测试 /v1/funds 端点...');
    try {
        const fundsRes = await fetch(`${PREDICT_BASE_URL}/v1/funds`, { headers });
        if (fundsRes.ok) {
            const fundsData = await fundsRes.json();
            console.log('   原始响应:');
            console.log(JSON.stringify(fundsData, null, 2));
        } else {
            console.log(`   状态码: ${fundsRes.status}`);
            const text = await fundsRes.text();
            console.log(`   响应: ${text.slice(0, 500)}`);
        }
    } catch (e: any) {
        console.log(`   错误: ${e.message}`);
    }
    console.log();

    // 6. 测试 /v1/balance 端点 (如果存在)
    console.log('6. 测试 /v1/balance 端点...');
    try {
        const balanceRes = await fetch(`${PREDICT_BASE_URL}/v1/balance`, { headers });
        if (balanceRes.ok) {
            const balanceData = await balanceRes.json();
            console.log('   原始响应:');
            console.log(JSON.stringify(balanceData, null, 2));
        } else {
            console.log(`   状态码: ${balanceRes.status}`);
            const text = await balanceRes.text();
            console.log(`   响应: ${text.slice(0, 500)}`);
        }
    } catch (e: any) {
        console.log(`   错误: ${e.message}`);
    }
    console.log();

    // 7. 链上余额对比
    console.log('7. 查询链上 USDT 余额...');
    try {
        const balanceWei = await builder.balanceOf('USDT', PREDICT_SMART_WALLET_ADDRESS);
        const balance = Number(balanceWei) / 1e18;
        console.log(`   链上 USDT: ${balance.toFixed(4)}`);
    } catch (e: any) {
        console.log(`   错误: ${e.message}`);
    }
    console.log();

    // 8. 测试订单查询 (检查 locked 资金)
    console.log('8. 测试 /v1/orders?status=OPEN 端点...');
    try {
        const ordersRes = await fetch(`${PREDICT_BASE_URL}/v1/orders?status=OPEN`, { headers });
        if (ordersRes.ok) {
            const ordersData = await ordersRes.json();
            console.log('   原始响应 (前2条):');
            const orders = (ordersData as any).data || [];
            console.log(JSON.stringify(orders.slice(0, 2), null, 2));
            console.log(`   共 ${orders.length} 条未成交订单`);
        } else {
            console.log(`   状态码: ${ordersRes.status}`);
        }
    } catch (e: any) {
        console.log(`   错误: ${e.message}`);
    }

    console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
