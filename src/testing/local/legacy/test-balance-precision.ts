import { OrderBuilder, ChainId } from '@predictdotfun/sdk';
import { Wallet, JsonRpcProvider } from 'ethers';
import { config } from 'dotenv';

config();

const privateKey = process.env.PREDICT_SIGNER_PRIVATE_KEY;
const walletAddr = process.env.PREDICT_SMART_WALLET_ADDRESS;

if (!privateKey || !walletAddr) {
    console.log('Missing env vars');
    process.exit(1);
}

const provider = new JsonRpcProvider('https://bsc-dataseed1.binance.org');
const signer = new Wallet(privateKey, provider);

console.log('Creating OrderBuilder...');
const builder = await OrderBuilder.make(ChainId.BnbMainnet, signer, { predictAccount: walletAddr });

console.log('Querying balance...');
const balanceWei = await builder.balanceOf('USDT', walletAddr);

console.log('=== Results ===');
console.log('Raw balanceWei:', balanceWei.toString());
console.log('Type:', typeof balanceWei);
console.log('Divided by 1e6:', Number(balanceWei) / 1e6);
console.log('Divided by 1e18:', Number(balanceWei) / 1e18);

// If the balance is huge after 1e6, it means SDK returns 1e18 precision
if (Number(balanceWei) / 1e6 > 1e9) {
    console.log('\n>>> SDK returns 1e18 precision, should use /1e18');
} else {
    console.log('\n>>> SDK returns 1e6 precision, /1e6 is correct');
}
