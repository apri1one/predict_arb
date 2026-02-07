/**
 * 测试 MAKER 订单取消原因
 *
 * 下一个 MAKER 订单，轮询状态，观察是否被取消及原因
 */

import * as fs from 'fs';
import * as path from 'path';
import { Wallet, JsonRpcProvider, Contract } from 'ethers';
import { OrderBuilder, Side, ChainId, AddressesByChainId } from '@predictdotfun/sdk';

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

const API_KEY = process.env.PREDICT_API_KEY!;
const PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY!;
const BASE_URL = 'https://api.predict.fun';
const BSC_RPC = 'https://bsc-dataseed.bnbchain.org';

// 测试参数
const TEST_MARKET_ID = 2069;  // LoL: Weibo Gaming vs Invictus Gaming
const TEST_PRICE = 0.54;      // 用户尝试的价格
const TEST_QUANTITY = 10;     // 小量测试
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_TIME_MS = 30000;

const NegRiskAdapterAbi = [
    {
        "inputs": [{ "name": "_questionId", "type": "bytes32" }, { "name": "_outcome", "type": "bool" }],
        "name": "getPositionId",
        "outputs": [{ "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    }
];

async function getJwt(signer: Wallet): Promise<string> {
    const msgRes = await fetch(`${BASE_URL}/v1/auth/message`, { headers: { 'x-api-key': API_KEY } });
    const msgData = await msgRes.json() as { data: { message: string } };
    const signature = await signer.signMessage(msgData.data.message);
    const authRes = await fetch(`${BASE_URL}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ signer: signer.address, signature, message: msgData.data.message }),
    });
    const authData = await authRes.json() as { data: { token: string } };
    return authData.data.token;
}

async function getOrderStatus(hash: string, jwt: string): Promise<any> {
    const res = await fetch(`${BASE_URL}/v1/orders/${hash}`, {
        headers: {
            'x-api-key': API_KEY,
            'Authorization': `Bearer ${jwt}`,
        },
    });

    if (!res.ok) {
        console.log(`[Status] HTTP ${res.status}`);
        return null;
    }

    const data = await res.json();
    return data;
}

async function main() {
    console.log('=== MAKER 订单取消原因测试 ===\n');
    console.log(`市场 ID: ${TEST_MARKET_ID}`);
    console.log(`价格: ${TEST_PRICE}`);
    console.log(`数量: ${TEST_QUANTITY}\n`);

    const provider = new JsonRpcProvider(BSC_RPC);
    const signer = new Wallet(PRIVATE_KEY, provider);
    console.log('Signer:', signer.address);

    // 获取 JWT
    const jwt = await getJwt(signer);
    console.log('JWT: OK\n');

    // 获取市场信息
    const marketRes = await fetch(`${BASE_URL}/v1/markets/${TEST_MARKET_ID}`, { headers: { 'x-api-key': API_KEY } });
    const marketData = await marketRes.json() as { data: any };
    const market = marketData.data;

    if (!market) {
        console.error('❌ 市场不存在');
        return;
    }

    console.log('市场:', market.title);
    console.log('isNegRisk:', market.isNegRisk);
    console.log('isYieldBearing:', market.isYieldBearing);
    console.log('feeRateBps:', market.feeRateBps);
    console.log('active:', market.active);
    console.log('closed:', market.closed);
    console.log('conditionId:', market.conditionId);

    // 检查市场状态
    if (!market.active || market.closed) {
        console.log('\n⚠️ 市场已关闭或不活跃，这可能是订单被取消的原因');
    }

    // 获取订单簿
    const bookRes = await fetch(`${BASE_URL}/v1/markets/${TEST_MARKET_ID}/orderbook`, { headers: { 'x-api-key': API_KEY } });
    const bookData = await bookRes.json() as { data: any };
    console.log('\n当前订单簿:');
    console.log('Best Bid:', bookData.data?.bids?.[0] || 'N/A');
    console.log('Best Ask:', bookData.data?.asks?.[0] || 'N/A');

    // 初始化 OrderBuilder
    const orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer);

    // 获取 tokenId
    let tokenId: string;
    if (market.isNegRisk) {
        const addresses = AddressesByChainId[ChainId.BnbMainnet];
        const negRiskAdapter = new Contract(addresses.NEG_RISK_ADAPTER, NegRiskAdapterAbi, provider);
        const yesTokenId = await negRiskAdapter.getPositionId(market.conditionId, true);
        tokenId = yesTokenId.toString();
    } else {
        tokenId = market.yesTokenId || market.outcomes?.[0]?.tokenId;
    }
    console.log('\nYES tokenId:', tokenId);

    // 计算订单金额
    const amounts = orderBuilder.getLimitOrderAmounts({
        side: Side.BUY,
        pricePerShareWei: BigInt(Math.floor(TEST_PRICE * 1e18)),
        quantityWei: BigInt(Math.floor(TEST_QUANTITY * 1e18)),
    });

    console.log(`\n订单: BUY ${TEST_QUANTITY} shares @ $${TEST_PRICE}`);
    console.log('makerAmount:', amounts.makerAmount.toString());
    console.log('takerAmount:', amounts.takerAmount.toString());

    // 构建订单
    const order = orderBuilder.buildOrder('LIMIT', {
        side: Side.BUY,
        tokenId: tokenId,
        makerAmount: amounts.makerAmount,
        takerAmount: amounts.takerAmount,
        feeRateBps: market.feeRateBps || 200,
    });

    const typedData = orderBuilder.buildTypedData(order, {
        isNegRisk: market.isNegRisk || false,
        isYieldBearing: market.isYieldBearing || false,
    });

    const signedOrder = await orderBuilder.signTypedDataOrder(typedData);
    const hash = orderBuilder.buildTypedDataHash(typedData);
    console.log('\nOrder Hash:', hash);

    // 提交订单
    const payload = {
        data: {
            order: { ...signedOrder, hash },
            pricePerShare: amounts.pricePerShare.toString(),
            strategy: 'LIMIT',
        },
    };

    console.log('\n📤 提交订单...');
    const submitRes = await fetch(`${BASE_URL}/v1/orders`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify(payload),
    });

    const submitText = await submitRes.text();
    console.log('Response:', submitRes.status);
    console.log('Body:', submitText);

    if (!submitRes.ok) {
        console.log('\n❌ 订单提交失败');
        return;
    }

    console.log('\n✅ 订单已提交，开始轮询状态...\n');

    // 轮询订单状态
    const startTime = Date.now();
    let lastStatus = '';
    let cancelled = false;

    while (Date.now() - startTime < MAX_POLL_TIME_MS) {
        const statusData = await getOrderStatus(hash, jwt);

        if (statusData) {
            const order = statusData.data ?? statusData.order ?? statusData;
            const status = order?.status?.toUpperCase() || 'UNKNOWN';

            if (status !== lastStatus) {
                console.log(`[${new Date().toISOString()}] Status: ${status}`);
                console.log('完整响应:', JSON.stringify(statusData, null, 2));
                lastStatus = status;
            }

            if (status === 'CANCELLED' || status === 'CANCELED') {
                console.log('\n🛑 订单被取消!');
                console.log('\n========== 完整 API 响应 ==========');
                console.log(JSON.stringify(statusData, null, 2));
                console.log('===================================\n');

                // 提取可能的取消原因字段
                console.log('可能的取消原因字段:');
                console.log('  - reason:', order?.reason);
                console.log('  - cancelReason:', order?.cancelReason);
                console.log('  - cancel_reason:', order?.cancel_reason);
                console.log('  - message:', order?.message);
                console.log('  - error:', order?.error);
                console.log('  - cancelledReason:', order?.cancelledReason);

                cancelled = true;
                break;
            }

            if (status === 'FILLED') {
                console.log('\n✅ 订单已成交!');
                break;
            }

            if (status === 'EXPIRED') {
                console.log('\n⏰ 订单已过期!');
                console.log('完整响应:', JSON.stringify(statusData, null, 2));
                break;
            }
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!cancelled && lastStatus !== 'FILLED' && lastStatus !== 'EXPIRED') {
        console.log(`\n⏱️ 轮询超时 (${MAX_POLL_TIME_MS / 1000}s)，订单仍在挂单中`);

        // 取消订单
        console.log('\n取消测试订单...');
        const cancelRes = await fetch(`${BASE_URL}/v1/orders/remove`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'Authorization': `Bearer ${jwt}`,
            },
            body: JSON.stringify({ data: { ids: [hash] } }),
        });
        console.log('取消结果:', cancelRes.ok ? 'OK' : cancelRes.status);
    }

    console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
