/**
 * 检查链上余额
 */

async function checkBalance() {
    const address = '0xDfd23628d4F411fa547A8851583e7682656d38Fd';
    const USDC_CONTRACT = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'; // BSC USDC

    console.log(`检查地址: ${address}\n`);

    // 检查 BNB 余额
    try {
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
        const bnbBalance = parseInt(bnbResult.result, 16) / 1e18;
        console.log(`BNB 余额 (Gas): ${bnbBalance.toFixed(6)} BNB`);

        if (bnbBalance === 0) {
            console.log('  ⚠️ BNB 余额为 0，无法支付 Gas 费用');
        }
    } catch (error) {
        console.error('BNB 查询失败:', error);
    }

    // 检查 USDC 余额
    try {
        const data = `0x70a08231000000000000000000000000${address.slice(2)}`;

        const usdcRes = await fetch('https://bsc-dataseed.binance.org/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_call',
                params: [{ to: USDC_CONTRACT, data }, 'latest']
            })
        });

        const usdcResult = await usdcRes.json() as any;
        const usdcBalance = parseInt(usdcResult.result, 16) / 1e18;
        console.log(`USDC 余额: ${usdcBalance.toFixed(2)} USDC`);

        if (usdcBalance === 0) {
            console.log('  ⚠️ USDC 余额为 0');
        }
    } catch (error) {
        console.error('USDC 查询失败:', error);
    }

    console.log('\n=== 结论 ===');
    console.log('如果余额为 0，说明:');
    console.log('1. 这可能不是正确的钱包地址');
    console.log('2. 资金可能在 Predict Smart Wallet 中');
    console.log('3. 需要从 Predict 导出正确的 Privy Wallet 私钥');
}

checkBalance();
