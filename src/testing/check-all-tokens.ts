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

const PREDICT_SIGNER_ADDRESS = process.env.PREDICT_SIGNER_ADDRESS!;

// BSC Mainnet 配置
const BSC_RPC = 'https://bsc-dataseed.bnbchain.org/';
const provider = new ethers.JsonRpcProvider(BSC_RPC);

// 常见代币地址 (BSC Mainnet)
const TOKENS = {
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
};

const ERC20_ABI = [
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
];

async function checkAllTokens() {
    console.log('============================================================');
    console.log('   检查所有稳定币余额');
    console.log('============================================================\n');
    console.log(`查询地址: ${PREDICT_SIGNER_ADDRESS}\n`);

    // 1. BNB 余额
    console.log('--- Native Token ---');
    const bnbBalance = await provider.getBalance(PREDICT_SIGNER_ADDRESS);
    console.log(`BNB: ${ethers.formatEther(bnbBalance)}`);
    console.log();

    // 2. 所有稳定币
    console.log('--- Stablecoins ---');
    for (const [symbol, address] of Object.entries(TOKENS)) {
        try {
            const contract = new ethers.Contract(address, ERC20_ABI, provider);
            const balance = await contract.balanceOf(PREDICT_SIGNER_ADDRESS);
            const decimals = await contract.decimals();
            const tokenSymbol = await contract.symbol();

            const balanceFormatted = ethers.formatUnits(balance, decimals);
            if (parseFloat(balanceFormatted) > 0) {
                console.log(`✅ ${tokenSymbol}: ${balanceFormatted}`);
            } else {
                console.log(`   ${tokenSymbol}: 0.0`);
            }
        } catch (error: any) {
            console.log(`❌ ${symbol}: 查询失败 - ${error.message}`);
        }
    }

    console.log('\n============================================================');
    console.log('   交易历史检查');
    console.log('============================================================');
    console.log('如果以上余额都为 0，但您确实充值了，请：');
    console.log('1. 检查充值交易 hash，确认充值到的地址');
    console.log('2. 在 BscScan 查看您的地址交易历史:');
    console.log(`   https://bscscan.com/address/${PREDICT_SIGNER_ADDRESS}`);
    console.log('3. 登录 https://predict.fun/account/funds 查看网页端显示');
    console.log('\n如果您是通过跨链桥充值（如从 Ethereum/Base），请确认：');
    console.log('- 跨链交易是否已完成');
    console.log('- 是否充值到了正确的 BNB Chain 地址');
}

checkAllTokens().catch(console.error);
