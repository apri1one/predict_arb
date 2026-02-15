/**
 * 测试如何通过 Predict API 获取持仓
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

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

const PREDICT_API_KEY = process.env.PREDICT_API_KEY!;
const PREDICT_BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';
const PREDICT_SIGNER_PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY!;

async function testPositionsAPI() {
    console.log('============================================================');
    console.log('   测试 Predict 持仓 API');
    console.log('============================================================\n');

    const wallet = new ethers.Wallet(PREDICT_SIGNER_PRIVATE_KEY);
    const address = wallet.address;

    // 1. 获取 JWT Token
    console.log('--- 1. 获取 JWT Token ---');
    const msgRes = await fetch(`${PREDICT_BASE_URL}/v1/auth/message`, {
        headers: { 'x-api-key': PREDICT_API_KEY }
    });
    const msgData = await msgRes.json() as any;
    const signature = await wallet.signMessage(msgData.data.message);

    const authRes = await fetch(`${PREDICT_BASE_URL}/v1/auth`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': PREDICT_API_KEY
        },
        body: JSON.stringify({
            signer: address,
            signature: signature,
            message: msgData.data.message
        })
    });
    const authData = await authRes.json() as any;
    const jwtToken = authData.data.token;
    console.log('✅ JWT Token 获取成功\n');

    // 2. 测试 /v1/account (完整返回)
    console.log('--- 2. /v1/account 完整返回 ---');
    const accountRes = await fetch(`${PREDICT_BASE_URL}/v1/account`, {
        headers: {
            'x-api-key': PREDICT_API_KEY,
            'Authorization': `Bearer ${jwtToken}`
        }
    });
    const accountData = await accountRes.json();
    console.log(JSON.stringify(accountData, null, 2));
    console.log();

    // 3. 测试 /v1/positions
    console.log('--- 3. /v1/positions 完整返回 ---');
    const positionsRes = await fetch(`${PREDICT_BASE_URL}/v1/positions`, {
        headers: {
            'x-api-key': PREDICT_API_KEY,
            'Authorization': `Bearer ${jwtToken}`
        }
    });
    const positionsData = await positionsRes.json();
    console.log(JSON.stringify(positionsData, null, 2));
    console.log();

    // 4. 尝试其他可能的端点
    const possibleEndpoints = [
        '/v1/user/positions',
        '/v1/account/positions',
        '/v1/portfolio',
        '/v1/holdings',
        '/v1/assets'
    ];

    console.log('--- 4. 尝试其他可能的持仓端点 ---');
    for (const endpoint of possibleEndpoints) {
        try {
            const res = await fetch(`${PREDICT_BASE_URL}${endpoint}`, {
                headers: {
                    'x-api-key': PREDICT_API_KEY,
                    'Authorization': `Bearer ${jwtToken}`
                }
            });

            if (res.status === 200) {
                const data = await res.json();
                console.log(`✅ ${endpoint} 找到!`);
                console.log(JSON.stringify(data, null, 2));
            } else if (res.status === 404) {
                console.log(`❌ ${endpoint} - 404`);
            } else {
                console.log(`⚠️ ${endpoint} - ${res.status}`);
            }
        } catch (error: any) {
            console.log(`❌ ${endpoint} - ${error.message}`);
        }
    }

    console.log('\n============================================================');
    console.log('   测试完成');
    console.log('============================================================');
}

testPositionsAPI().catch(console.error);
