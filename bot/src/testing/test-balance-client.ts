/**
 * 测试 PredictRestClient 的余额查询功能
 */

import { PredictRestClient } from '../predict/rest-client.js';
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

async function testBalanceQuery() {
    console.log('============================================================');
    console.log('   测试 PredictRestClient 余额查询功能');
    console.log('============================================================\n');

    const client = new PredictRestClient();

    // 1. 测试余额查询
    console.log('--- 1. 查询智能钱包余额 ---');
    try {
        const balanceResult = await client.getSmartWalletBalance();
        console.log('✅ 余额查询成功\n');
        console.log(`智能钱包地址: ${balanceResult.address}`);
        console.log('\n余额:');
        console.log(`  USDT: ${balanceResult.balances.USDT}`);
        console.log(`  USDC: ${balanceResult.balances.USDC}`);
        console.log(`  BUSD: ${balanceResult.balances.BUSD}`);
        console.log(`  BNB:  ${balanceResult.balances.BNB}`);
        console.log(`\n总计约: $${balanceResult.totalUSD.toFixed(2)} USD\n`);
    } catch (error: any) {
        console.error('❌ 余额查询失败:', error.message);
    }

    // 2. 测试授权状态查询
    console.log('--- 2. 查询 Exchange 合约授权状态 ---');
    try {
        const authResult = await client.getExchangeAuthorizations();
        console.log('✅ 授权查询成功\n');

        for (const [exchangeName, tokens] of Object.entries(authResult)) {
            console.log(`${exchangeName}:`);
            for (const [symbol, authorized] of Object.entries(tokens)) {
                const status = authorized ? '✅ 已授权' : '❌ 未授权';
                console.log(`  ${symbol}: ${status}`);
            }
            console.log();
        }
    } catch (error: any) {
        console.error('❌ 授权查询失败:', error.message);
    }

    console.log('============================================================');
    console.log('   测试完成');
    console.log('============================================================');
}

testBalanceQuery().catch(console.error);
