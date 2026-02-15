/**
 * Check balance and try Jake Paul market (539)
 */

import * as fs from 'fs';
import * as path from 'path';
import { Wallet, JsonRpcProvider, Contract } from 'ethers';
import { OrderBuilder, Side, ChainId, AddressesByChainId } from '@predictdotfun/sdk';

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

const API_KEY = process.env.PREDICT_API_KEY!;
const PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY!;
const BASE_URL = 'https://api.predict.fun';
const BSC_RPC = 'https://bsc-dataseed.bnbchain.org';

// NegRiskAdapter for negRisk markets
const NegRiskAdapterAbi = [
    {
        "inputs": [{ "name": "_questionId", "type": "bytes32" }, { "name": "_outcome", "type": "bool" }],
        "name": "getPositionId",
        "outputs": [{ "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    }
];

async function main() {
    console.log('=== PREDICT ORDER TEST - Jake Paul (539) ===\n');

    const provider = new JsonRpcProvider(BSC_RPC);
    const signer = new Wallet(PRIVATE_KEY, provider);
    console.log('Signer:', signer.address);

    // Auth
    const msgRes = await fetch(`${BASE_URL}/v1/auth/message`, { headers: { 'x-api-key': API_KEY } });
    const msgData = await msgRes.json() as { data: { message: string } };
    const signature = await signer.signMessage(msgData.data.message);
    const authRes = await fetch(`${BASE_URL}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ signer: signer.address, signature, message: msgData.data.message }),
    });
    const authData = await authRes.json() as { data: { token: string } };
    const jwt = authData.data.token;
    console.log('JWT: OK');

    // Check balance using OrderBuilder
    const orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer);
    try {
        const balance = await orderBuilder.balanceOf();
        console.log('USDT Balance:', Number(balance) / 1e18, 'USDT');
    } catch (e) {
        console.log('Balance check failed');
    }

    // Get Jake Paul market (539) - negRisk market
    const marketRes = await fetch(`${BASE_URL}/v1/markets/539`, { headers: { 'x-api-key': API_KEY } });
    const marketData = await marketRes.json() as { data: any };
    const market = marketData.data;
    console.log('\nMarket:', market.title);
    console.log('isNegRisk:', market.isNegRisk);
    console.log('isYieldBearing:', market.isYieldBearing);
    console.log('feeRateBps:', market.feeRateBps);
    console.log('conditionId:', market.conditionId);

    // Get tokenId using NegRiskAdapter for negRisk markets
    const addresses = AddressesByChainId[ChainId.BnbMainnet];
    const negRiskAdapter = new Contract(addresses.NEG_RISK_ADAPTER, NegRiskAdapterAbi, provider);

    const yesTokenId = await negRiskAdapter.getPositionId(market.conditionId, true);
    console.log('YES tokenId:', yesTokenId.toString());

    // Calculate amounts - 1 USDT at 5¢
    const amounts = orderBuilder.getLimitOrderAmounts({
        side: Side.BUY,
        pricePerShareWei: BigInt(Math.floor(0.05 * 1e18)), // 5¢
        quantityWei: BigInt(Math.floor(20 * 1e18)), // 20 shares
    });
    console.log('\nOrder: BUY 20 shares @ 5¢ = 1 USDT');

    // Build order
    const order = orderBuilder.buildOrder('LIMIT', {
        side: Side.BUY,
        tokenId: yesTokenId.toString(),
        makerAmount: amounts.makerAmount,
        takerAmount: amounts.takerAmount,
        feeRateBps: market.feeRateBps || 200,
    });

    const typedData = orderBuilder.buildTypedData(order, {
        isNegRisk: true,  // Jake Paul is negRisk
        isYieldBearing: market.isYieldBearing || false,
    });

    const signedOrder = await orderBuilder.signTypedDataOrder(typedData);
    const hash = orderBuilder.buildTypedDataHash(typedData);
    console.log('Order Hash:', hash);

    // Submit
    const payload = {
        data: {
            order: { ...signedOrder, hash },
            pricePerShare: amounts.pricePerShare.toString(),
            strategy: 'LIMIT',
        },
    };

    console.log('\nSubmitting order...');
    const res = await fetch(`${BASE_URL}/v1/orders`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify(payload),
    });

    const resultText = await res.text();
    console.log('Response:', res.status);
    console.log('Body:', resultText);

    if (res.ok) {
        console.log('\n✅ SUCCESS - Order placed!');

        // Cancel it
        const result = JSON.parse(resultText);
        console.log('\nCancelling order...');
        const cancelRes = await fetch(`${BASE_URL}/v1/orders/${result.data?.hash || hash}`, {
            method: 'DELETE',
            headers: { 'x-api-key': API_KEY, 'Authorization': `Bearer ${jwt}` },
        });
        console.log('Cancel:', cancelRes.ok ? 'OK' : cancelRes.status);
    }

    console.log('\n=== DONE ===');
}

main().catch(console.error);
