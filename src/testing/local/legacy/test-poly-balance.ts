import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Polygon RPC
const RPC_URL = 'https://polygon-rpc.com';

// Polymarket CTF (Conditional Token Framework) 合约地址
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// ERC-1155 balanceOf ABI
const CTF_ABI = [
    'function balanceOf(address account, uint256 id) view returns (uint256)'
];

// 从任务日志获取的 token IDs (市场 732)
const MARKET_732_TOKENS = {
    YES: '52607315900507156846622820770453728082833251091510131025984187712529448877245',
    NO: '108988271800978168213949343685406694292284061166193819357568013088568150075789'
};

async function queryBalance() {
    const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS!;

    console.log('=== 查询 Polymarket 链上持仓 ===\n');
    console.log(`Proxy Address: ${proxyAddress}`);
    console.log(`CTF Contract: ${CTF_CONTRACT}\n`);

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, provider);

    // 查询市场 732 的持仓
    console.log('市场 732 (Will there be another US government shutdown by January 31?):\n');

    const yesBalance = await ctf.balanceOf(proxyAddress, MARKET_732_TOKENS.YES);
    const noBalance = await ctf.balanceOf(proxyAddress, MARKET_732_TOKENS.NO);

    // CTF 使用 6 位小数 (与 USDC 一致)
    const yesShares = Number(yesBalance) / 1e6;
    const noShares = Number(noBalance) / 1e6;

    console.log(`  YES Token Balance: ${yesShares.toFixed(6)} shares`);
    console.log(`  NO Token Balance:  ${noShares.toFixed(6)} shares`);
    console.log('');

    // 原始值
    console.log('原始 BigInt 值:');
    console.log(`  YES: ${yesBalance.toString()}`);
    console.log(`  NO:  ${noBalance.toString()}`);
}

queryBalance().catch(console.error);
