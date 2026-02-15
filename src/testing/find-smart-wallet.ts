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

// BSC 配置
const BSC_RPC = 'https://bsc-dataseed.bnbchain.org/';
const provider = new ethers.JsonRpcProvider(BSC_RPC);

const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const ERC20_ABI = [
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)'
];

async function findSmartWallet() {
    console.log('============================================================');
    console.log('   查找 Predict 智能钱包地址');
    console.log('============================================================\n');

    const wallet = new ethers.Wallet(PREDICT_SIGNER_PRIVATE_KEY);
    const signerAddress = wallet.address;
    console.log(`签名钱包地址 (Binance Wallet): ${signerAddress}\n`);

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
            signer: signerAddress,
            signature: signature,
            message: msgData.data.message
        })
    });
    const authData = await authRes.json() as any;
    const jwtToken = authData.data.token;
    console.log('✅ JWT Token 获取成功\n');

    // 2. 检查 /v1/account 是否包含智能钱包地址
    console.log('--- 2. 检查账户信息 ---');
    const accountRes = await fetch(`${PREDICT_BASE_URL}/v1/account`, {
        headers: {
            'x-api-key': PREDICT_API_KEY,
            'Authorization': `Bearer ${jwtToken}`
        }
    });
    const accountData = await accountRes.json() as any;
    console.log('账户信息:');
    console.log(JSON.stringify(accountData, null, 2));

    const returnedAddress = accountData.data?.address;
    console.log(`\nAPI 返回的地址: ${returnedAddress}`);

    if (returnedAddress && returnedAddress.toLowerCase() !== signerAddress.toLowerCase()) {
        console.log('✅ 这可能是智能钱包地址！\n');

        // 查询这个地址的 USDT 余额
        const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
        const balance = await usdtContract.balanceOf(returnedAddress);
        const decimals = await usdtContract.decimals();

        console.log('--- 3. 智能钱包 USDT 余额 ---');
        console.log(`地址: ${returnedAddress}`);
        console.log(`余额: ${ethers.formatUnits(balance, decimals)} USDT`);
    } else {
        console.log('⚠️ API 返回的地址与签名地址相同，不是智能钱包\n');

        // 尝试查询订单中的 maker 地址
        console.log('--- 3. 尝试从订单中查找智能钱包 ---');
        const ordersRes = await fetch(`${PREDICT_BASE_URL}/v1/orders`, {
            headers: {
                'x-api-key': PREDICT_API_KEY,
                'Authorization': `Bearer ${jwtToken}`
            }
        });
        const ordersData = await ordersRes.json() as any;

        if (ordersData.data && ordersData.data.length > 0) {
            const makerAddress = ordersData.data[0].order.maker;
            console.log(`从订单中找到 maker 地址: ${makerAddress}`);

            if (makerAddress.toLowerCase() !== signerAddress.toLowerCase()) {
                console.log('✅ 这可能是智能钱包地址！\n');

                const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
                const balance = await usdtContract.balanceOf(makerAddress);
                const decimals = await usdtContract.decimals();

                console.log(`智能钱包 USDT 余额: ${ethers.formatUnits(balance, decimals)} USDT`);
            }
        } else {
            console.log('⚠️ 没有找到历史订单，无法从订单中获取智能钱包地址\n');
            console.log('建议：');
            console.log('1. 登录 https://predict.fun/account/funds 查看网页端余额');
            console.log('2. 或者先创建一笔小额订单，然后从订单的 maker 字段获取智能钱包地址');
        }
    }

    console.log('\n============================================================');
    console.log('   完成');
    console.log('============================================================');
}

findSmartWallet().catch(console.error);
