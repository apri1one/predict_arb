/**
 * Predict WS 订阅返回测试（钱包事件）
 *
 * - 获取 JWT
 * - 连接 Predict WS
 * - 订阅 predictWalletEvents/{jwt}
 * - 打印订阅返回消息
 *
 * ⚠️ 不下单，仅验证订阅响应。
 */

import { config } from 'dotenv';
config();

import { WebSocket } from 'ws';
import { Wallet, JsonRpcProvider } from 'ethers';
import { OrderBuilder } from '@predictdotfun/sdk';
import { getBscRpcUrl } from '../config/bsc-rpc.js';

const API_BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';
const API_KEY = process.env.PREDICT_WS_API_KEY || process.env.PREDICT_API_KEY_TRADE || process.env.PREDICT_API_KEY || '';
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS || '';
const PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY || '';
const WS_URL = 'wss://ws.predict.fun/ws';

async function fetchJwt(): Promise<string> {
    const provider = new JsonRpcProvider(getBscRpcUrl());
    const signer = new Wallet(PRIVATE_KEY, provider);
    const orderBuilder = await OrderBuilder.make(56, signer as any, { predictAccount: SMART_WALLET }) as OrderBuilder;

    const msgRes = await fetch(`${API_BASE_URL}/v1/auth/message`, {
        headers: { 'x-api-key': API_KEY },
    });
    if (!msgRes.ok) throw new Error(`auth/message failed: ${msgRes.status}`);
    const msgData = await msgRes.json() as { data: { message: string } };
    const message = msgData.data.message;
    const signature = await orderBuilder.signPredictAccountMessage(message);

    const authRes = await fetch(`${API_BASE_URL}/v1/auth`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
        },
        body: JSON.stringify({
            signer: SMART_WALLET,
            signature,
            message,
        }),
    });
    if (!authRes.ok) {
        const text = await authRes.text();
        throw new Error(`auth failed: ${authRes.status} - ${text.slice(0, 200)}`);
    }
    const authData = await authRes.json() as { data: { token: string } };
    return authData.data.token;
}

async function main(): Promise<void> {
    if (!API_KEY || !SMART_WALLET || !PRIVATE_KEY) {
        throw new Error('Missing env: PREDICT_API_KEY/PREDICT_WS_API_KEY, PREDICT_SMART_WALLET_ADDRESS, PREDICT_SIGNER_PRIVATE_KEY');
    }

    console.log('\n=== Predict WS walletEvents 订阅返回测试 ===\n');
    console.log(`API Key: ${API_KEY.slice(0, 8)}...`);
    console.log(`Smart Wallet: ${SMART_WALLET.slice(0, 10)}...`);

    const jwt = await fetchJwt();
    console.log(`JWT: ${jwt.slice(0, 12)}...`);

    const ws = new WebSocket(`${WS_URL}?apiKey=${encodeURIComponent(API_KEY)}`);

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS connection timeout')), 15000);

        ws.on('open', () => {
            clearTimeout(timeout);
            console.log('[WS] Connected');
            const subscribeMsg = {
                method: 'subscribe',
                requestId: 1,
                params: [`predictWalletEvents/${jwt}`],
            };
            console.log('[WS] Subscribe ->', JSON.stringify(subscribeMsg));
            ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on('message', (data) => {
            const text = data.toString();
            try {
                const msg = JSON.parse(text);
                if (msg.type === 'R' && msg.requestId === 1) {
                    console.log('[WS] Subscribe response ->', JSON.stringify(msg));
                    resolve();
                } else if (msg.type === 'M' && msg.topic?.startsWith('predictWalletEvents/')) {
                    console.log('[WS] Wallet event ->', JSON.stringify(msg).slice(0, 500));
                } else if (msg.topic === 'heartbeat') {
                    ws.send(JSON.stringify({ method: 'heartbeat', data: msg.data }));
                }
            } catch {
                console.log('[WS] Raw ->', text.slice(0, 200));
            }
        });

        ws.on('error', (err) => reject(err));
    });

    await new Promise(r => setTimeout(r, 5000));
    ws.close();
    console.log('[WS] Closed');
}

main().catch((e) => {
    console.error('[Test] Failed:', e?.message || e);
    process.exitCode = 1;
});

