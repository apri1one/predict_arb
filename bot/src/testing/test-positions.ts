/**
 * 测试 Predict Positions API (使用智能钱包签名)
 */
import { Wallet, JsonRpcProvider } from 'ethers';
import { OrderBuilder, ChainId } from '@predictdotfun/sdk';
import * as fs from 'fs';
import * as path from 'path';

// 加载 .env
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

const PREDICT_API_KEY = process.env.PREDICT_API_KEY!;
const PREDICT_SIGNER_PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY!;
const PREDICT_SMART_WALLET_ADDRESS = process.env.PREDICT_SMART_WALLET_ADDRESS!;
const PREDICT_BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';

async function main() {
    console.log('============================================================');
    console.log('   测试 Predict Positions API (智能钱包签名)');
    console.log('============================================================\n');

    console.log(`Smart Wallet 地址: ${PREDICT_SMART_WALLET_ADDRESS}`);
    console.log(`API Key: ${PREDICT_API_KEY?.substring(0, 10)}...`);
    console.log(`Base URL: ${PREDICT_BASE_URL}\n`);

    // 1. 创建 OrderBuilder
    console.log('--- 1. 初始化 OrderBuilder ---');
    const provider = new JsonRpcProvider('https://bsc-dataseed.bnbchain.org/');
    const signer = new Wallet(PREDICT_SIGNER_PRIVATE_KEY, provider);
    const orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer, {
        predictAccount: PREDICT_SMART_WALLET_ADDRESS
    });
    console.log('✅ OrderBuilder 创建成功\n');

    // 2. 获取认证消息
    console.log('--- 2. 获取认证消息 ---');
    const msgRes = await fetch(`${PREDICT_BASE_URL}/v1/auth/message`, {
        headers: { 'x-api-key': PREDICT_API_KEY }
    });
    if (!msgRes.ok) {
        console.log('❌ 获取认证消息失败:', await msgRes.text());
        return;
    }
    const msgData = await msgRes.json() as { data: { message: string } };
    const message = msgData.data.message;
    console.log(`消息: ${message.substring(0, 50)}...\n`);

    // 3. 使用智能钱包签名
    console.log('--- 3. 智能钱包签名 ---');
    const signature = await orderBuilder.signPredictAccountMessage(message);
    console.log(`签名: ${signature.substring(0, 50)}...\n`);

    // 4. 获取 JWT Token
    console.log('--- 4. 获取 JWT Token ---');
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

    if (!authRes.ok) {
        console.log('❌ JWT 获取失败:', authRes.status, await authRes.text());
        return;
    }

    const authData = await authRes.json() as { data: { token: string } };
    const jwt = authData.data.token;
    console.log('✅ JWT 获取成功\n');

    // 5. 获取持仓
    console.log('--- 5. 获取持仓 ---');
    const posRes = await fetch(`${PREDICT_BASE_URL}/v1/positions`, {
        headers: {
            'x-api-key': PREDICT_API_KEY,
            'Authorization': `Bearer ${jwt}`
        }
    });

    if (!posRes.ok) {
        console.log('❌ 持仓获取失败:', posRes.status, await posRes.text());
        return;
    }

    const posData = await posRes.json() as any;
    console.log('✅ 持仓获取成功');
    console.log(`Success: ${posData.success}`);
    console.log(`Cursor: ${posData.cursor}`);
    console.log(`持仓数量: ${posData.data?.length || 0}\n`);

    if (posData.data && posData.data.length > 0) {
        console.log('============================================================');
        console.log('   持仓列表');
        console.log('============================================================');
        for (const pos of posData.data) {
            const shares = Number(BigInt(pos.amount || '0')) / 1e18;
            console.log(`\n📈 Market #${pos.market?.id}: ${pos.market?.title?.substring(0, 50)}`);
            console.log(`   结果: ${pos.outcome?.name}`);
            console.log(`   数量: ${shares.toFixed(4)} shares`);
            console.log(`   价值: $${pos.valueUsd}`);
        }
    } else {
        console.log('⚠️ 没有找到持仓');
    }
}

main().catch(console.error);
