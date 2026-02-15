/**
 * 测试 API 是否能获取账户资产
 */

import * as fs from 'fs';
import * as path from 'path';
import { Wallet } from 'ethers';

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

const PREDICT_BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';
const PREDICT_API_KEY = process.env.PREDICT_API_KEY;
const PREDICT_SIGNER_ADDRESS = process.env.PREDICT_SIGNER_ADDRESS;
const PREDICT_SIGNER_PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY;

async function testPredictAPI() {
    console.log('='.repeat(60));
    console.log('   Predict API 账户资产测试');
    console.log('='.repeat(60));

    if (!PREDICT_API_KEY) {
        console.error('❌ 缺少 PREDICT_API_KEY');
        return;
    }

    console.log(`\nAPI Key: ${PREDICT_API_KEY.slice(0, 10)}...`);
    console.log(`Signer Address: ${PREDICT_SIGNER_ADDRESS || '(未配置)'}`);

    // 1. 测试基础 API 连接 (无需认证)
    console.log('\n--- 1. 测试基础 API 连接 ---');
    try {
        const res = await fetch(`${PREDICT_BASE_URL}/v1/categories`, {
            headers: { 'x-api-key': PREDICT_API_KEY }
        });
        if (res.ok) {
            const data = await res.json() as any;
            console.log(`✅ 基础 API 连接成功，获取到 ${data.data?.length || 0} 个分类`);
        } else {
            console.error(`❌ 基础 API 连接失败: ${res.status} ${res.statusText}`);
            const text = await res.text();
            console.error('响应:', text);
        }
    } catch (error) {
        console.error('❌ 基础 API 连接失败:', error);
    }

    // 2. 获取 JWT Token (需要签名)
    if (!PREDICT_SIGNER_PRIVATE_KEY) {
        console.log('\n⚠️ 缺少 PREDICT_SIGNER_PRIVATE_KEY，跳过 JWT 认证测试');
        return;
    }

    console.log('\n--- 2. 获取 JWT Token ---');
    let jwtToken: string | null = null;

    try {
        const wallet = new Wallet(PREDICT_SIGNER_PRIVATE_KEY);
        const address = wallet.address;
        console.log(`钱包地址: ${address}`);

        // 获取认证消息 (不需要 address 参数)
        const msgRes = await fetch(`${PREDICT_BASE_URL}/v1/auth/message`, {
            headers: { 'x-api-key': PREDICT_API_KEY! }
        });

        if (!msgRes.ok) {
            console.error(`❌ 获取认证消息失败: ${msgRes.status}`);
            const text = await msgRes.text();
            console.error('响应:', text);
            return;
        }

        const msgData = await msgRes.json() as { data: { message: string } };
        console.log(`认证消息: ${msgData.data.message.slice(0, 50)}...`);

        // 签名消息
        const signature = await wallet.signMessage(msgData.data.message);
        console.log(`签名: ${signature.slice(0, 30)}...`);

        // 获取 JWT (使用正确的参数名)
        const authRes = await fetch(`${PREDICT_BASE_URL}/v1/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': PREDICT_API_KEY
            },
            body: JSON.stringify({
                signer: address,           // 正确: signer 不是 address
                signature: signature,
                message: msgData.data.message  // 需要传原始消息
            })
        });

        if (!authRes.ok) {
            console.error(`❌ JWT 获取失败: ${authRes.status}`);
            const text = await authRes.text();
            console.error('响应:', text);
            return;
        }

        const authData = await authRes.json() as { data: { token: string; expiresAt: string } };
        jwtToken = authData.data.token;
        console.log(`✅ JWT Token 获取成功，过期时间: ${authData.data.expiresAt}`);
    } catch (error) {
        console.error('❌ JWT 获取失败:', error);
        return;
    }

    // 3. 获取账户信息
    console.log('\n--- 3. 获取账户信息 ---');
    try {
        const res = await fetch(`${PREDICT_BASE_URL}/v1/account`, {
            headers: {
                'x-api-key': PREDICT_API_KEY,
                'Authorization': `Bearer ${jwtToken}`
            }
        });

        if (res.ok) {
            const data = await res.json() as any;
            console.log('✅ 账户信息获取成功:');
            console.log(JSON.stringify(data.data, null, 2));
        } else {
            console.error(`❌ 账户信息获取失败: ${res.status}`);
            const text = await res.text();
            console.error('响应:', text);
        }
    } catch (error) {
        console.error('❌ 账户信息获取失败:', error);
    }

    // 4. 获取用户持仓
    console.log('\n--- 4. 获取用户持仓 ---');
    try {
        const res = await fetch(`${PREDICT_BASE_URL}/v1/positions`, {
            headers: {
                'x-api-key': PREDICT_API_KEY,
                'Authorization': `Bearer ${jwtToken}`
            }
        });

        if (res.ok) {
            const data = await res.json() as any;
            const positions = data.data || [];
            console.log(`✅ 持仓获取成功，共 ${positions.length} 个持仓:`);

            if (positions.length === 0) {
                console.log('   (暂无持仓)');
            } else {
                for (const pos of positions) {
                    console.log(`   - ${pos.market?.title || pos.marketId}: ${pos.shares} 股 @ ${pos.outcome}`);
                }
            }
        } else {
            console.error(`❌ 持仓获取失败: ${res.status}`);
            const text = await res.text();
            console.error('响应:', text);
        }
    } catch (error) {
        console.error('❌ 持仓获取失败:', error);
    }

    // 5. 获取用户订单
    console.log('\n--- 5. 获取用户订单 ---');
    try {
        const res = await fetch(`${PREDICT_BASE_URL}/v1/orders`, {
            headers: {
                'x-api-key': PREDICT_API_KEY,
                'Authorization': `Bearer ${jwtToken}`
            }
        });

        if (res.ok) {
            const data = await res.json() as any;
            const orders = data.data || [];
            console.log(`✅ 订单获取成功，共 ${orders.length} 个订单:`);

            if (orders.length === 0) {
                console.log('   (暂无订单)');
            } else {
                for (const order of orders.slice(0, 5)) {
                    console.log(`   - ${order.market?.title || order.marketId}: ${order.side} ${order.shares} @ ${order.price} (${order.status})`);
                }
                if (orders.length > 5) {
                    console.log(`   ... 还有 ${orders.length - 5} 个订单`);
                }
            }
        } else {
            console.error(`❌ 订单获取失败: ${res.status}`);
            const text = await res.text();
            console.error('响应:', text);
        }
    } catch (error) {
        console.error('❌ 订单获取失败:', error);
    }

    // 6. 检查链上余额 (USDC)
    console.log('\n--- 6. 检查链上余额 ---');
    try {
        // 使用 BSC RPC 查询 USDC 余额
        const USDC_CONTRACT = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'; // BSC USDC
        const address = PREDICT_SIGNER_ADDRESS;

        // 调用 balanceOf(address)
        const data = `0x70a08231000000000000000000000000${address?.slice(2)}`;

        const res = await fetch('https://bsc-dataseed.binance.org/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_call',
                params: [{ to: USDC_CONTRACT, data }, 'latest']
            })
        });

        const result = await res.json() as any;
        if (result.result) {
            const balance = parseInt(result.result, 16) / 1e18;
            console.log(`✅ USDC 余额 (BSC): ${balance.toFixed(2)} USDC`);

            if (balance === 0) {
                console.log('   ⚠️ 余额为 0，无法进行交易');
            }
        }

        // BNB 余额
        const bnbRes = await fetch('https://bsc-dataseed.binance.org/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getBalance',
                params: [address, 'latest']
            })
        });

        const bnbResult = await bnbRes.json() as any;
        if (bnbResult.result) {
            const bnbBalance = parseInt(bnbResult.result, 16) / 1e18;
            console.log(`✅ BNB 余额 (Gas): ${bnbBalance.toFixed(6)} BNB`);

            if (bnbBalance === 0) {
                console.log('   ⚠️ BNB 余额为 0，无法支付 Gas');
            }
        }
    } catch (error) {
        console.error('❌ 链上余额查询失败:', error);
    }

    console.log('\n' + '='.repeat(60));
    console.log('   测试完成');
    console.log('='.repeat(60));
}

testPredictAPI();
