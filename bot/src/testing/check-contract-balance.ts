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

const PREDICT_SIGNER_ADDRESS = process.env.PREDICT_SIGNER_ADDRESS!;

// BSC Mainnet 配置
const BSC_RPC = 'https://bsc-dataseed.bnbchain.org/';
const provider = new ethers.JsonRpcProvider(BSC_RPC);

// Predict 合约地址 (从 SDK Constants.ts)
const CONTRACTS = {
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    KERNEL: '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D',
    CTF_EXCHANGE: '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
    YIELD_BEARING_CTF_EXCHANGE: '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
    NEG_RISK_CTF_EXCHANGE: '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
    YIELD_BEARING_NEG_RISK_CTF_EXCHANGE: '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
};

// ERC20 ABI (只需要 balanceOf)
const ERC20_ABI = [
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
];

async function checkContractBalances() {
    console.log('============================================================');
    console.log('   Predict 合约余额查询');
    console.log('============================================================\n');
    console.log(`查询地址: ${PREDICT_SIGNER_ADDRESS}\n`);

    const usdtContract = new ethers.Contract(CONTRACTS.USDT, ERC20_ABI, provider);
    const decimals = await usdtContract.decimals();
    const symbol = await usdtContract.symbol();

    console.log(`USDT 合约: ${CONTRACTS.USDT}`);
    console.log(`Decimals: ${decimals}, Symbol: ${symbol}\n`);

    // 1. 外部钱包中的 USDT
    console.log('--- 1. 外部钱包 USDT 余额 ---');
    const walletBalance = await usdtContract.balanceOf(PREDICT_SIGNER_ADDRESS);
    console.log(`余额: ${ethers.formatUnits(walletBalance, decimals)} ${symbol}\n`);

    // 2. 尝试查询 Kernel (智能账户) 相关余额
    console.log('--- 2. 尝试查询智能账户信息 ---');
    console.log('Kernel 合约:', CONTRACTS.KERNEL);

    // 检查 Kernel 合约代码
    const kernelCode = await provider.getCode(CONTRACTS.KERNEL);
    if (kernelCode === '0x') {
        console.log('❌ Kernel 合约未部署或地址错误\n');
    } else {
        console.log('✅ Kernel 合约存在\n');

        // 尝试调用 Kernel 的常见方法
        // 注意: 需要知道具体的 ABI 才能调用
        try {
            // Kernel 可能是工厂合约，需要通过它获取用户的智能钱包地址
            const kernelABI = [
                'function getAddress(address owner, uint256 index) view returns (address)',
                'function predictAddress(address owner, uint256 index) view returns (address)',
            ];
            const kernelContract = new ethers.Contract(CONTRACTS.KERNEL, kernelABI, provider);

            try {
                const smartWalletAddress = await kernelContract.getAddress(PREDICT_SIGNER_ADDRESS, 0);
                console.log(`智能钱包地址: ${smartWalletAddress}`);

                // 查询智能钱包中的 USDT
                const smartWalletBalance = await usdtContract.balanceOf(smartWalletAddress);
                console.log(`智能钱包 USDT 余额: ${ethers.formatUnits(smartWalletBalance, decimals)} ${symbol}\n`);
            } catch (e) {
                console.log('⚠️ 无法通过 getAddress 获取智能钱包地址，尝试其他方法...\n');
            }
        } catch (e) {
            console.log('⚠️ Kernel ABI 不匹配，需要查看实际合约接口\n');
        }
    }

    // 3. 查询各个 Exchange 合约中的授权额度
    console.log('--- 3. 查询 Exchange 合约 USDT 授权额度 ---');
    const allowanceABI = ['function allowance(address owner, address spender) view returns (uint256)'];
    const usdtWithAllowance = new ethers.Contract(CONTRACTS.USDT, allowanceABI, provider);

    const exchanges = [
        { name: 'CTF_EXCHANGE', address: CONTRACTS.CTF_EXCHANGE },
        { name: 'YIELD_BEARING_CTF_EXCHANGE', address: CONTRACTS.YIELD_BEARING_CTF_EXCHANGE },
        { name: 'NEG_RISK_CTF_EXCHANGE', address: CONTRACTS.NEG_RISK_CTF_EXCHANGE },
        { name: 'YIELD_BEARING_NEG_RISK_CTF_EXCHANGE', address: CONTRACTS.YIELD_BEARING_NEG_RISK_CTF_EXCHANGE },
    ];

    for (const exchange of exchanges) {
        const allowance = await usdtWithAllowance.allowance(PREDICT_SIGNER_ADDRESS, exchange.address);
        if (allowance > 0n) {
            console.log(`✅ ${exchange.name}:`);
            console.log(`   授权额度: ${ethers.formatUnits(allowance, decimals)} ${symbol}`);
        } else {
            console.log(`❌ ${exchange.name}: 无授权`);
        }
    }

    console.log('\n============================================================');
    console.log('   提示');
    console.log('============================================================');
    console.log('如果充值的 USDT 在 Predict 托管系统中，可能：');
    console.log('1. 在您的智能钱包地址中（需要通过 Kernel 工厂合约查询）');
    console.log('2. 在 Exchange 合约中（但需要通过 Predict API 查询余额）');
    console.log('3. 网页端显示的余额可能来自 Predict 内部数据库');
    console.log('\n建议：登录 https://predict.fun 查看网页端显示的余额');
}

checkContractBalances().catch(console.error);
