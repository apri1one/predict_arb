/**
 * Polymarket 下单测试 + Telegram 通知
 *
 * 使用官方 SDK 下单并发送 TG 通知
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from 'ethers5';
import { createTelegramNotifier, TelegramNotifier } from '../notification/telegram.js';

// 颜色输出
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

async function main() {
    console.log(`\n${c.cyan}=== Polymarket 下单 + TG 通知测试 ===${c.reset}\n`);

    // 1. 初始化 TG 通知
    console.log(`${c.dim}初始化 Telegram 通知...${c.reset}`);
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChatId = process.env.TELEGRAM_CHAT_ID;

    let telegram: TelegramNotifier | null = null;
    if (tgToken && tgChatId) {
        telegram = createTelegramNotifier({
            botToken: tgToken,
            chatId: tgChatId,
            enabled: true,
        });
        console.log(`${c.green}✓ TG 通知已初始化${c.reset}\n`);
    } else {
        console.log(`${c.yellow}⚠ TG 配置缺失，跳过通知${c.reset}\n`);
    }

    // 2. 初始化钱包和客户端
    const privateKey = process.env.POLYMARKET_TRADER_PRIVATE_KEY!;
    const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS!;

    console.log(`${c.dim}初始化钱包...${c.reset}`);
    const signer = new Wallet(privateKey);
    console.log(`  Signer: ${signer.address}`);
    console.log(`  Proxy: ${proxyAddress}\n`);

    // 3. 初始化 ClobClient
    console.log(`${c.dim}初始化 ClobClient...${c.reset}`);
    let client = new ClobClient(HOST, CHAIN_ID, signer);

    // 4. 派生 API 凭证
    console.log(`${c.dim}派生 API 凭证...${c.reset}`);
    const userApiCreds = await client.createOrDeriveApiKey();
    console.log(`${c.green}✓ API 凭证已获取${c.reset}\n`);

    // 5. 重新初始化 (GNOSIS_SAFE)
    client = new ClobClient(HOST, CHAIN_ID, signer, userApiCreds, 2, proxyAddress);

    // 6. 获取余额
    const { ethers } = await import('ethers');
    const USDC_E_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
    const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
    const usdc = new ethers.Contract(
        USDC_E_ADDRESS,
        ['function balanceOf(address) view returns (uint256)'],
        provider
    );
    const rawBalance = await usdc.balanceOf(proxyAddress);
    const balance = Number(rawBalance) / 1e6;
    console.log(`${c.green}✓ USDC.e 余额: $${balance.toFixed(2)}${c.reset}\n`);

    // 7. 测试市场
    const testTokenId = '113350885464808674951991697099053010367047110695236183898915618148180735012616';
    const testPrice = 0.01;
    const testSize = 10;

    console.log(`${c.yellow}📝 下单参数:${c.reset}`);
    console.log(`  Token: ${testTokenId.slice(0, 20)}...`);
    console.log(`  价格: $${testPrice}`);
    console.log(`  数量: ${testSize} shares`);
    console.log(`  类型: GTC\n`);

    console.log(`${c.yellow}⚠️  即将下单并发送 TG 通知${c.reset}`);
    console.log(`${c.dim}等待 3 秒...${c.reset}`);
    await new Promise(r => setTimeout(r, 3000));

    // 8. 下单
    console.log(`\n${c.dim}提交订单...${c.reset}`);
    try {
        const response = await client.createAndPostOrder(
            {
                tokenID: testTokenId,
                price: testPrice,
                size: testSize,
                side: Side.BUY,
            },
            { tickSize: '0.01', negRisk: false },
            OrderType.GTC
        );

        console.log(`${c.green}✓ 下单成功!${c.reset}`);
        console.log(`  订单 ID: ${response.orderID}`);
        console.log(`  状态: ${response.status}\n`);

        // 发送 TG 通知: 下单成功
        if (telegram) {
            console.log(`${c.dim}发送 TG 通知: 下单成功...${c.reset}`);
            await telegram.alertOrder({
                type: 'PLACED',
                platform: 'POLYMARKET',
                marketName: `EdgeX FDV Test`,
                action: 'BUY',
                side: 'NO',
                price: testPrice,
                quantity: testSize,
                orderId: response.orderID,
            });
            console.log(`${c.green}✓ TG 通知已发送${c.reset}\n`);
        }

        // 9. 等待并取消
        console.log(`${c.dim}等待 2 秒后取消订单...${c.reset}`);
        await new Promise(r => setTimeout(r, 2000));

        console.log(`${c.dim}取消订单...${c.reset}`);
        const cancelResult = await client.cancelOrder({ orderID: response.orderID });
        console.log(`${c.green}✓ 订单已取消${c.reset}`);
        console.log(`  结果:`, cancelResult);

        // 发送 TG 通知: 订单取消
        if (telegram) {
            console.log(`\n${c.dim}发送 TG 通知: 订单取消...${c.reset}`);
            await telegram.alertOrder({
                type: 'CANCELLED',
                platform: 'POLYMARKET',
                marketName: `EdgeX FDV Test`,
                action: 'BUY',
                side: 'NO',
                price: testPrice,
                quantity: testSize,
                orderId: response.orderID,
            });
            console.log(`${c.green}✓ TG 通知已发送${c.reset}`);
        }

    } catch (error: any) {
        console.error(`${c.red}✗ 下单失败: ${error.message}${c.reset}`);

        // 发送 TG 通知: 错误
        if (telegram) {
            await telegram.alertError({
                operation: '下单',
                platform: 'POLYMARKET',
                marketName: 'EdgeX FDV Test',
                error: error.message,
                requiresManualIntervention: false,
            });
        }
    }

    console.log(`\n${c.green}=== 测试完成 ===${c.reset}\n`);
}

main().catch(err => {
    console.error(`${c.red}测试失败:${c.reset}`, err);
    process.exit(1);
});
