/**
 * Polymarket 官方 SDK 下单测试
 *
 * 使用 @polymarket/clob-client 官方 SDK
 * 参考文档: https://docs.polymarket.com/quickstart/first-order
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
// 使用 ethers v5 (clob-client 内部依赖)
import { Wallet } from 'ethers5';

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
const CHAIN_ID = 137;  // Polygon mainnet

// Signature types
const SIGNATURE_TYPE = {
    EOA: 0,
    POLY_PROXY: 1,
    POLY_GNOSIS_SAFE: 2,
};

async function main() {
    console.log(`\n${c.cyan}=== Polymarket 官方 SDK 下单测试 ===${c.reset}\n`);

    // 1. 检查环境变量
    const privateKey = process.env.POLYMARKET_TRADER_PRIVATE_KEY;
    const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;
    const apiKey = process.env.POLYMARKET_API_KEY;
    const apiSecret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_PASSPHRASE;

    if (!privateKey || !proxyAddress) {
        console.error(`${c.red}缺少环境变量: POLYMARKET_TRADER_PRIVATE_KEY 或 POLYMARKET_PROXY_ADDRESS${c.reset}`);
        process.exit(1);
    }

    // 2. 初始化 signer
    console.log(`${c.dim}初始化钱包...${c.reset}`);
    const signer = new Wallet(privateKey);
    console.log(`  Signer 地址: ${signer.address}`);
    console.log(`  Proxy 地址: ${proxyAddress}`);
    console.log();

    // 3. 初始化 ClobClient (Step 1)
    console.log(`${c.dim}Step 1: 初始化 ClobClient...${c.reset}`);
    let client = new ClobClient(HOST, CHAIN_ID, signer);
    console.log(`${c.green}✓ ClobClient 已创建${c.reset}\n`);

    // 4. 获取或派生 API 凭证 (Step 2)
    // 始终使用 SDK 派生以确保与 signer 匹配
    console.log(`${c.dim}Step 2: 派生 API 凭证...${c.reset}`);
    let userApiCreds;

    try {
        userApiCreds = await client.createOrDeriveApiKey();
        console.log(`  API Key: ${userApiCreds.apiKey}`);
        console.log(`  Secret: ${userApiCreds.secret.slice(0, 10)}...`);
        console.log(`  Passphrase: ${userApiCreds.passphrase.slice(0, 10)}...`);

        // 检查是否与 .env 中配置一致
        if (apiKey && userApiCreds.apiKey !== apiKey) {
            console.log(`${c.yellow}  ⚠ 派生的 API Key 与 .env 配置不同${c.reset}`);
            console.log(`    .env API Key: ${apiKey}`);
            console.log(`    派生 API Key: ${userApiCreds.apiKey}`);
        }
    } catch (err: any) {
        console.error(`${c.red}  派生 API 凭证失败: ${err.message}${c.reset}`);
        // 回退到 .env 配置
        if (apiKey && apiSecret && passphrase) {
            console.log(`  使用 .env 配置的 API 凭证`);
            userApiCreds = {
                apiKey: apiKey,
                secret: apiSecret,
                passphrase: passphrase,
            };
        } else {
            throw new Error('无法获取 API 凭证');
        }
    }
    console.log(`${c.green}✓ API 凭证已获取${c.reset}\n`);

    // 5. 配置签名类型和 Funder (Step 3)
    // 由于用户使用的是 Gnosis Safe proxy，使用 POLY_GNOSIS_SAFE
    console.log(`${c.dim}Step 3: 配置签名类型...${c.reset}`);
    const signatureType = SIGNATURE_TYPE.POLY_GNOSIS_SAFE;
    const funderAddress = proxyAddress;
    console.log(`  Signature Type: ${signatureType} (POLY_GNOSIS_SAFE)`);
    console.log(`  Funder Address: ${funderAddress}`);
    console.log(`${c.green}✓ 签名类型已配置${c.reset}\n`);

    // 6. 重新初始化 ClobClient (Step 4)
    console.log(`${c.dim}Step 4: 重新初始化完整认证...${c.reset}`);
    client = new ClobClient(
        HOST,
        CHAIN_ID,
        signer,
        userApiCreds,
        signatureType,
        funderAddress
    );
    console.log(`${c.green}✓ ClobClient 已重新初始化${c.reset}\n`);

    // 7. 验证连接
    console.log(`${c.dim}验证 API 连接...${c.reset}`);
    try {
        const apiKeys = await client.getApiKeys();
        console.log(`${c.green}✓ API 连接成功，当前有 ${apiKeys.length} 个 API Key${c.reset}\n`);
    } catch (err: any) {
        console.error(`${c.red}✗ API 连接失败: ${err.message}${c.reset}`);
        process.exit(1);
    }

    // 8. 获取链上余额
    console.log(`${c.dim}获取链上余额...${c.reset}`);
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

    if (balance < 1) {
        console.log(`${c.red}✗ 余额不足，无法进行下单测试${c.reset}`);
        return;
    }

    // 9. 选择测试市场
    // 使用 Market 889 EdgeX FDV above $2B 的 NO token
    const testTokenId = '113350885464808674951991697099053010367047110695236183898915618148180735012616';

    // 10. 获取市场信息 (Step 5)
    console.log(`${c.dim}Step 5: 获取市场信息...${c.reset}`);
    let market;
    try {
        market = await client.getMarket(testTokenId);
        console.log(`${c.green}✓ 市场信息获取成功${c.reset}`);
        console.log(`  Tick Size: ${market.minimum_tick_size}`);
        console.log(`  Neg Risk: ${market.neg_risk}`);
        console.log();
    } catch (err: any) {
        console.error(`${c.red}获取市场信息失败: ${err.message}${c.reset}`);
        // 使用默认值继续
        market = { minimum_tick_size: '0.01', neg_risk: false };
    }

    // 11. 获取订单簿
    console.log(`${c.dim}获取订单簿...${c.reset}`);
    try {
        const orderbook = await client.getOrderBook(testTokenId);
        console.log(`${c.green}✓ 订单簿获取成功${c.reset}`);
        const bestBid = orderbook.bids?.[0];
        const bestAsk = orderbook.asks?.[0];
        console.log(`  最佳买价 (bid): ${bestBid ? bestBid.price : 'N/A'}`);
        console.log(`  最佳卖价 (ask): ${bestAsk ? bestAsk.price : 'N/A'}`);
        console.log();
    } catch (err: any) {
        console.error(`${c.red}获取订单簿失败: ${err.message}${c.reset}`);
    }

    // 12. 下单参数
    const testPrice = 0.01;  // 极低价格，不会成交
    const testSize = 10;     // 最小数量 (size = shares, not dollars)

    console.log(`${c.yellow}📝 测试下单参数:${c.reset}`);
    console.log(`  Token ID: ${testTokenId.slice(0, 20)}...`);
    console.log(`  方向: BUY`);
    console.log(`  价格: $${testPrice}`);
    console.log(`  数量: ${testSize} shares`);
    console.log(`  订单类型: GTC`);
    console.log();

    // 确认
    console.log(`${c.yellow}⚠️  即将提交真实订单到 Polymarket${c.reset}`);
    console.log(`${c.dim}按 Ctrl+C 取消，或等待 3 秒继续...${c.reset}`);
    await new Promise(r => setTimeout(r, 3000));

    // 13. 下单 (Step 5)
    console.log(`\n${c.dim}提交订单...${c.reset}`);
    try {
        const response = await client.createAndPostOrder(
            {
                tokenID: testTokenId,
                price: testPrice,
                size: testSize,
                side: Side.BUY,
            },
            {
                tickSize: market.minimum_tick_size || '0.01',
                negRisk: market.neg_risk || false,
            },
            OrderType.GTC
        );

        console.log(`${c.green}✓ 下单成功!${c.reset}`);
        console.log(`  订单 ID: ${response.orderID}`);
        console.log(`  状态: ${response.status}`);
        console.log();

        // 14. 查询订单状态
        if (response.orderID) {
            console.log(`${c.dim}查询订单状态...${c.reset}`);
            await new Promise(r => setTimeout(r, 1000));
            try {
                const order = await client.getOrder(response.orderID);
                console.log(`${c.green}✓ 订单状态${c.reset}`);
                console.log(`  状态: ${order.status}`);
                console.log(`  已成交: ${order.size_matched}`);
                console.log(`  剩余: ${Number(order.original_size) - Number(order.size_matched)}`);
                console.log();
            } catch (err: any) {
                console.log(`${c.yellow}⚠ 获取订单状态失败: ${err.message}${c.reset}`);
            }

            // 15. 取消订单
            console.log(`${c.dim}取消订单...${c.reset}`);
            try {
                const cancelResult = await client.cancelOrder({ orderID: response.orderID });
                console.log(`${c.green}✓ 订单已取消${c.reset}`);
                console.log(`  取消结果:`, cancelResult);
            } catch (err: any) {
                console.log(`${c.yellow}⚠ 订单取消失败: ${err.message}${c.reset}`);
            }
        }

    } catch (err: any) {
        console.error(`${c.red}✗ 下单失败: ${err.message}${c.reset}`);
        if (err.response?.data) {
            console.error(`  响应详情:`, err.response.data);
        }
    }

    console.log(`\n${c.green}=== 测试完成 ===${c.reset}\n`);
}

main().catch(err => {
    console.error(`${c.red}测试失败:${c.reset}`, err);
    process.exit(1);
});
