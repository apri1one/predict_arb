/**
 * 测试使用 OrderBuilder 查询链上余额
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

const PREDICT_SIGNER_PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY!;
const PREDICT_SMART_WALLET_ADDRESS = process.env.PREDICT_SMART_WALLET_ADDRESS!;

async function testOnchainBalance() {
    console.log('============================================================');
    console.log('   测试链上余额查询 (OrderBuilder.balanceOf)');
    console.log('============================================================\n');

    console.log(`Smart Wallet 地址: ${PREDICT_SMART_WALLET_ADDRESS}`);
    console.log(`Signer 地址: ${new Wallet(PREDICT_SIGNER_PRIVATE_KEY).address}\n`);

    try {
        // 1. 创建 OrderBuilder (需要连接 provider)
        console.log('--- 1. 初始化 OrderBuilder ---');
        const provider = new JsonRpcProvider('https://bsc-dataseed.bnbchain.org/');
        const signer = new Wallet(PREDICT_SIGNER_PRIVATE_KEY, provider);
        const orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer, {
            predictAccount: PREDICT_SMART_WALLET_ADDRESS
        });
        console.log('✅ OrderBuilder 创建成功\n');

        // 2. 查询链上 USDT 余额
        console.log('--- 2. 查询 USDT 余额 ---');
        const balanceWei = await orderBuilder.balanceOf('USDT', PREDICT_SMART_WALLET_ADDRESS);
        const balance = Number(balanceWei) / 1e18;
        console.log(`余额 (wei): ${balanceWei}`);
        console.log(`余额 (USDT): ${balance.toFixed(6)}\n`);

        // 3. 查询 Signer 自己的余额 (EOA)
        console.log('--- 3. 查询 Signer EOA 的余额 ---');
        const signerBalanceWei = await orderBuilder.balanceOf('USDT', signer.address);
        const signerBalance = Number(signerBalanceWei) / 1e18;
        console.log(`Signer 余额: ${signerBalance.toFixed(6)} USDT\n`);

        console.log('============================================================');
        console.log('   结论');
        console.log('============================================================');
        console.log(`Smart Wallet USDT 余额: ${balance.toFixed(6)}`);
        console.log(`Signer EOA USDT 余额: ${signerBalance.toFixed(6)}`);

        if (balance === 0 && signerBalance === 0) {
            console.log('\n⚠️ 两个地址的 USDT 余额都为 0');
            console.log('   这是正常的,如果你还没有存入 USDT');
        } else if (balance > 0) {
            console.log('\n✅ Smart Wallet 有余额,可以进行交易!');
        }

    } catch (error) {
        console.error('❌ 测试失败:', error);
    }
}

testOnchainBalance().catch(console.error);
