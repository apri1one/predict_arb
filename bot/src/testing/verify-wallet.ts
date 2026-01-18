/**
 * 验证钱包配置
 */

import * as fs from 'fs';
import * as path from 'path';
import { Wallet } from 'ethers';

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

async function verifyWallet() {
    console.log('='.repeat(60));
    console.log('   Privy Wallet 配置验证');
    console.log('='.repeat(60));

    const privateKey = process.env.PREDICT_SIGNER_PRIVATE_KEY;
    const configuredAddress = process.env.PREDICT_SIGNER_ADDRESS;

    if (!privateKey) {
        console.error('❌ 缺少 PREDICT_SIGNER_PRIVATE_KEY');
        return;
    }

    console.log(`\n配置的地址: ${configuredAddress}`);
    console.log(`私钥长度: ${privateKey.length} 字符`);
    console.log(`私钥前缀: ${privateKey.slice(0, 10)}...`);

    // 验证私钥格式
    let formattedKey = privateKey;
    if (!privateKey.startsWith('0x')) {
        formattedKey = '0x' + privateKey;
        console.log('\n⚠️ 私钥没有 0x 前缀，已自动添加');
    }

    // 从私钥派生地址
    try {
        const wallet = new Wallet(formattedKey);
        const derivedAddress = wallet.address;

        console.log(`\n从私钥派生的地址: ${derivedAddress}`);

        if (configuredAddress) {
            if (derivedAddress.toLowerCase() === configuredAddress.toLowerCase()) {
                console.log('✅ 地址匹配！私钥配置正确');
            } else {
                console.log('❌ 地址不匹配！');
                console.log('   配置的地址和私钥对应的地址不同');
                console.log('   请检查私钥是否正确');
            }
        }

        // 测试签名
        console.log('\n--- 测试签名功能 ---');
        const testMessage = 'Test message for Predict';
        const signature = await wallet.signMessage(testMessage);
        console.log(`✅ 签名成功: ${signature.slice(0, 30)}...`);

        // 再次尝试 Predict 认证，看看具体错误
        console.log('\n--- 重新测试 Predict 认证 ---');
        const PREDICT_BASE_URL = 'https://api.predict.fun';
        const PREDICT_API_KEY = process.env.PREDICT_API_KEY;

        // 获取认证消息
        const msgRes = await fetch(`${PREDICT_BASE_URL}/v1/auth/message?address=${derivedAddress}`, {
            headers: { 'x-api-key': PREDICT_API_KEY! }
        });

        if (!msgRes.ok) {
            const text = await msgRes.text();
            console.error(`❌ 获取认证消息失败: ${msgRes.status}`);
            console.error('响应:', text);
            return;
        }

        const msgData = await msgRes.json() as { data: { message: string } };
        console.log(`认证消息: ${msgData.data.message.slice(0, 80)}...`);

        // 签名
        const authSignature = await wallet.signMessage(msgData.data.message);

        // 获取 JWT
        const authRes = await fetch(`${PREDICT_BASE_URL}/v1/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': PREDICT_API_KEY!
            },
            body: JSON.stringify({
                address: derivedAddress,
                signature: authSignature
            })
        });

        const authText = await authRes.text();
        console.log(`\n认证响应 (${authRes.status}):`);

        try {
            const authJson = JSON.parse(authText);
            console.log(JSON.stringify(authJson, null, 2));

            if (authJson.success === false) {
                console.log('\n❌ 认证失败');
                console.log('\n可能的原因:');
                console.log('1. 这个钱包地址没有在 Predict 平台注册');
                console.log('2. 需要先在 Predict 网站登录并关联此钱包');
                console.log('3. 账户可能使用了不同的登录方式 (Email/Google/Twitter)');
            }
        } catch {
            console.log(authText);
        }

    } catch (error) {
        console.error('❌ 私钥格式无效:', error);
    }
}

verifyWallet();
