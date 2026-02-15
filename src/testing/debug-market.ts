/**
 * Debug: Check all balances and find valid tokenIds
 */

import * as fs from 'fs';
import * as path from 'path';
import { Wallet, JsonRpcProvider, Contract } from 'ethers';
import { AddressesByChainId, ChainId } from '@predictdotfun/sdk';

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

const PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY!;
const API_KEY = process.env.PREDICT_API_KEY!;
const BSC_RPC = 'https://bsc-dataseed.bnbchain.org';

const ERC20Abi = [
    {
        "inputs": [{ "name": "account", "type": "address" }],
        "name": "balanceOf",
        "outputs": [{ "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    }
];

async function main() {
    console.log('=== BALANCE CHECK ===\n');

    const provider = new JsonRpcProvider(BSC_RPC);
    const signer = new Wallet(PRIVATE_KEY, provider);
    const addresses = AddressesByChainId[ChainId.BnbMainnet];

    console.log('Signer address:', signer.address);
    console.log('USDT contract:', addresses.USDT);

    // Check USDT balance on chain
    const usdt = new Contract(addresses.USDT, ERC20Abi, provider);
    const balance = await usdt.balanceOf(signer.address);
    console.log('\nOn-chain USDT balance:', Number(balance) / 1e18, 'USDT');

    // Check BNB balance
    const bnbBalance = await provider.getBalance(signer.address);
    console.log('BNB balance:', Number(bnbBalance) / 1e18, 'BNB');

    // Check account info via API
    console.log('\n--- API Account Info ---');

    // Get JWT first
    const msgRes = await fetch('https://api.predict.fun/v1/auth/message', {
        headers: { 'x-api-key': API_KEY }
    });
    const msgData = await msgRes.json() as { data: { message: string } };
    const signature = await signer.signMessage(msgData.data.message);
    const authRes = await fetch('https://api.predict.fun/v1/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ signer: signer.address, signature, message: msgData.data.message }),
    });
    const authData = await authRes.json() as { data: { token: string } };
    const jwt = authData.data.token;

    // Get account
    const accRes = await fetch('https://api.predict.fun/v1/account', {
        headers: { 'x-api-key': API_KEY, 'Authorization': `Bearer ${jwt}` }
    });
    const accData = await accRes.json() as { data: any };
    console.log('Account:', JSON.stringify(accData.data, null, 2));

    // Check if there's a deposit address
    if (accData.data?.depositAddress) {
        console.log('\nDeposit address:', accData.data.depositAddress);
        const depositBalance = await usdt.balanceOf(accData.data.depositAddress);
        console.log('Deposit address USDT:', Number(depositBalance) / 1e18, 'USDT');
    }

    console.log('\n=== DONE ===');
}

main().catch(console.error);
