import { ethers } from 'ethers';
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
const PREDICT_BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';
const PREDICT_SIGNER_PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY!;

async function testBalanceEndpoints() {
    console.log('============================================================');
    console.log('   Predict 账户余额查询测试');
    console.log('============================================================\n');

    const wallet = new ethers.Wallet(PREDICT_SIGNER_PRIVATE_KEY);
    const address = wallet.address;

    // 1. 获取 JWT Token
    console.log('--- 1. 获取 JWT Token ---');
    const msgRes = await fetch(`${PREDICT_BASE_URL}/v1/auth/message`, {
        headers: { 'x-api-key': PREDICT_API_KEY }
    });
    const msgData = await msgRes.json() as any;

    const message = msgData.data.message;
    const signature = await wallet.signMessage(message);

    const authRes = await fetch(`${PREDICT_BASE_URL}/v1/auth`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': PREDICT_API_KEY
        },
        body: JSON.stringify({
            signer: address,
            signature: signature,
            message: message
        })
    });
    const authData = await authRes.json() as any;
    const jwtToken = authData.data.token;
    console.log('✅ JWT Token 获取成功\n');

    // 2. 测试 /v1/account，查看完整返回
    console.log('--- 2. 测试 /v1/account (完整返回) ---');
    const accountRes = await fetch(`${PREDICT_BASE_URL}/v1/account`, {
        headers: {
            'x-api-key': PREDICT_API_KEY,
            'Authorization': `Bearer ${jwtToken}`
        }
    });
    const accountData = await accountRes.json();
    console.log('完整返回:\n', JSON.stringify(accountData, null, 2));
    console.log();

    // 3. 尝试可能的余额端点
    const possibleEndpoints = [
        '/v1/balance',
        '/v1/account/balance',
        '/v1/account/assets',
        '/v1/wallet/balance',
        '/v1/funds',
        '/v1/account/funds'
    ];

    console.log('--- 3. 尝试可能的余额端点 ---');
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
                console.log(`❌ ${endpoint} - 404 Not Found`);
            } else {
                console.log(`⚠️ ${endpoint} - 状态码: ${res.status}`);
                const text = await res.text();
                console.log(`   响应: ${text.substring(0, 200)}`);
            }
        } catch (error: any) {
            console.log(`❌ ${endpoint} - 错误: ${error.message}`);
        }
    }
    console.log();

    // 4. 查看 positions 的 valueUsd 字段
    console.log('--- 4. 检查持仓价值 (可能包含余额信息) ---');
    const posRes = await fetch(`${PREDICT_BASE_URL}/v1/positions`, {
        headers: {
            'x-api-key': PREDICT_API_KEY,
            'Authorization': `Bearer ${jwtToken}`
        }
    });
    const posData = await posRes.json() as any;

    if (posData.data && posData.data.length > 0) {
        let totalValue = 0;
        posData.data.forEach((pos: any) => {
            console.log(`持仓: ${pos.market.title}`);
            console.log(`  价值: ${pos.valueUsd} USD`);
            totalValue += parseFloat(pos.valueUsd);
        });
        console.log(`\n总持仓价值: ${totalValue} USD`);
    } else {
        console.log('当前无持仓');
    }

    console.log('\n============================================================');
    console.log('   测试完成');
    console.log('============================================================');
}

testBalanceEndpoints().catch(console.error);
