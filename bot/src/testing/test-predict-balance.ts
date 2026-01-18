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

async function testPredictBalance() {
    console.log('============================================================');
    console.log('   Predict 内部账户余额查询');
    console.log('============================================================\n');

    const wallet = new ethers.Wallet(PREDICT_SIGNER_PRIVATE_KEY);
    const address = wallet.address;

    // 1. 获取 JWT Token
    console.log('--- 1. 获取认证 ---');
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
    console.log('✅ 认证成功\n');

    // 2. 尝试所有可能的端点
    const possibleEndpoints = [
        // 账户相关
        '/v1/account',
        '/v1/account/balance',
        '/v1/account/assets',
        '/v1/account/funds',
        '/v1/account/wallet',

        // 余额相关
        '/v1/balance',
        '/v1/balances',
        '/v1/wallet',
        '/v1/wallet/balance',
        '/v1/funds',

        // 用户相关
        '/v1/user',
        '/v1/user/balance',
        '/v1/user/assets',

        // 资产相关
        '/v1/assets',
        '/v1/portfolio',

        // 可能的内部端点
        '/v1/internal/balance',
        '/v1/me',
        '/v1/me/balance',
    ];

    console.log('--- 2. 测试所有可能的余额端点 ---\n');
    const foundEndpoints: any[] = [];

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
                console.log(`✅ ${endpoint} - 找到!`);
                console.log(JSON.stringify(data, null, 2));
                console.log();
                foundEndpoints.push({ endpoint, data });
            } else if (res.status !== 404) {
                const text = await res.text();
                console.log(`⚠️ ${endpoint} - 状态码 ${res.status}`);
                console.log(`   ${text.substring(0, 200)}\n`);
            }
        } catch (error: any) {
            // 忽略网络错误
        }
    }

    if (foundEndpoints.length === 0) {
        console.log('❌ 未找到余额查询端点\n');
    }

    // 3. 尝试使用 OPTIONS 方法查看允许的端点
    console.log('--- 3. 尝试查看 API 元数据 ---');
    try {
        const optionsRes = await fetch(`${PREDICT_BASE_URL}/v1/`, {
            method: 'OPTIONS',
            headers: {
                'x-api-key': PREDICT_API_KEY,
                'Authorization': `Bearer ${jwtToken}`
            }
        });
        console.log(`OPTIONS 状态码: ${optionsRes.status}`);
        const headers: any = {};
        optionsRes.headers.forEach((value, key) => {
            headers[key] = value;
        });
        console.log('响应头:', headers);
    } catch (e) {
        console.log('OPTIONS 请求失败');
    }
    console.log();

    // 4. 查看持仓的详细信息，可能包含余额
    console.log('--- 4. 检查持仓详细信息 ---');
    const posRes = await fetch(`${PREDICT_BASE_URL}/v1/positions`, {
        headers: {
            'x-api-key': PREDICT_API_KEY,
            'Authorization': `Bearer ${jwtToken}`
        }
    });
    const posData = await posRes.json() as any;
    console.log('持仓数据:');
    console.log(JSON.stringify(posData, null, 2));

    console.log('\n============================================================');
    console.log('   结论');
    console.log('============================================================');
    console.log('如果以上都没有找到余额端点，说明：');
    console.log('1. Predict API 确实不提供余额查询功能');
    console.log('2. 网页端可能使用不同的 API 或 GraphQL');
    console.log('3. 或者使用 WebSocket 获取余额信息');
    console.log('\n建议：');
    console.log('- 打开浏览器开发者工具访问 https://predict.fun/account/funds');
    console.log('- 查看 Network 标签，找到获取余额的实际 API 请求');
}

testPredictBalance().catch(console.error);
