import { ethers } from 'ethers';

// Predict Smart Wallet 地址
const SMART_WALLET_ADDRESS = '0xbD58EDACc3358FC2A841a291014380b55F6a6E2f';

// BSC Mainnet 配置
const BSC_RPC = 'https://bsc-dataseed.bnbchain.org/';
const provider = new ethers.JsonRpcProvider(BSC_RPC);

// 稳定币地址
const TOKENS = {
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
};

const ERC20_ABI = [
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function allowance(address owner, address spender) view returns (uint256)'
];

// Predict 交易合约地址
const EXCHANGES = {
    CTF_EXCHANGE: '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
    YIELD_BEARING_CTF_EXCHANGE: '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
    NEG_RISK_CTF_EXCHANGE: '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
    YIELD_BEARING_NEG_RISK_CTF_EXCHANGE: '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
};

async function checkSmartWalletBalance() {
    console.log('============================================================');
    console.log('   Predict Smart Wallet 余额查询');
    console.log('============================================================\n');
    console.log(`智能钱包地址: ${SMART_WALLET_ADDRESS}\n`);

    // 1. BNB 余额
    console.log('--- 1. Native Token ---');
    const bnbBalance = await provider.getBalance(SMART_WALLET_ADDRESS);
    console.log(`BNB: ${ethers.formatEther(bnbBalance)}\n`);

    // 2. 稳定币余额
    console.log('--- 2. Stablecoin Balances ---');
    let totalUSD = 0;

    for (const [symbol, address] of Object.entries(TOKENS)) {
        try {
            const contract = new ethers.Contract(address, ERC20_ABI, provider);
            const balance = await contract.balanceOf(SMART_WALLET_ADDRESS);
            const decimals = await contract.decimals();
            const tokenSymbol = await contract.symbol();

            const balanceFormatted = ethers.formatUnits(balance, decimals);
            const balanceNum = parseFloat(balanceFormatted);

            if (balanceNum > 0) {
                console.log(`✅ ${tokenSymbol}: ${balanceFormatted}`);
                totalUSD += balanceNum;
            } else {
                console.log(`   ${tokenSymbol}: 0.0`);
            }
        } catch (error: any) {
            console.log(`❌ ${symbol}: 查询失败`);
        }
    }

    console.log(`\n总计约: $${totalUSD.toFixed(2)} USD\n`);

    // 3. 授权额度
    console.log('--- 3. Exchange 合约授权额度 ---');
    for (const [name, exchangeAddress] of Object.entries(EXCHANGES)) {
        console.log(`\n${name}:`);

        for (const [symbol, tokenAddress] of Object.entries(TOKENS)) {
            try {
                const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
                const allowance = await contract.allowance(SMART_WALLET_ADDRESS, exchangeAddress);
                const decimals = await contract.decimals();
                const allowanceFormatted = ethers.formatUnits(allowance, decimals);
                const allowanceNum = parseFloat(allowanceFormatted);

                if (allowanceNum > 0) {
                    if (allowanceNum > 1e15) {
                        console.log(`  ✅ ${symbol}: 无限授权`);
                    } else {
                        console.log(`  ✅ ${symbol}: ${allowanceFormatted}`);
                    }
                } else {
                    console.log(`  ❌ ${symbol}: 未授权`);
                }
            } catch (error) {
                console.log(`  ⚠️ ${symbol}: 查询失败`);
            }
        }
    }

    console.log('\n============================================================');
    console.log('   总结');
    console.log('============================================================');
    console.log(`智能钱包地址: ${SMART_WALLET_ADDRESS}`);
    console.log(`BscScan: https://bscscan.com/address/${SMART_WALLET_ADDRESS}`);
    console.log(`\n如果有余额但未授权给 Exchange 合约，需要先授权才能交易`);
}

checkSmartWalletBalance().catch(console.error);
