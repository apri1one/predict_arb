/**
 * Polymarket 下单功能测试
 *
 * 测试 PolymarketTrader 的订单提交功能
 * 使用真实 API，请确保环境变量已配置
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// 加载父目录的 .env 文件
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import { getPolymarketTrader, PolymarketTrader } from '../dashboard/polymarket-trader.js';

// 颜色输出
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

async function main() {
    console.log(`\n${c.cyan}=== Polymarket 下单测试 ===${c.reset}\n`);

    // 1. 初始化
    console.log(`${c.dim}初始化 PolymarketTrader...${c.reset}`);
    const trader = getPolymarketTrader();
    await trader.init();
    console.log(`${c.green}✓ 初始化成功${c.reset}\n`);

    // 2. 获取余额 (使用链上查询，API 余额查询可能有问题)
    console.log(`${c.dim}获取账户余额 (链上查询)...${c.reset}`);
    const { ethers } = await import('ethers');
    const USDC_E_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
    const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
    const usdc = new ethers.Contract(
        USDC_E_ADDRESS,
        ['function balanceOf(address) view returns (uint256)'],
        provider
    );
    const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS!;
    const rawBalance = await usdc.balanceOf(proxyAddress);
    const balance = Number(rawBalance) / 1e6;
    console.log(`${c.green}✓ USDC.e 余额: $${balance.toFixed(2)}${c.reset}\n`);

    if (balance < 1) {
        console.log(`${c.red}✗ 余额不足，无法进行下单测试${c.reset}`);
        return;
    }

    // 3. 选择测试市场 (使用一个活跃市场的 NO token)
    // 使用 Market 889 EdgeX FDV above $2B 的 NO token
    const testTokenId = '113350885464808674951991697099053010367047110695236183898915618148180735012616';
    const conditionId = '0xcad388a016c4ccb9a4bc07549f802d60675d9a5ebb7b0e221cf2efef5f067e16';

    // 4. 获取订单簿
    console.log(`${c.dim}获取订单簿...${c.reset}`);
    const orderbook = await trader.getOrderbook(testTokenId);
    if (!orderbook) {
        console.log(`${c.red}✗ 无法获取订单簿${c.reset}`);
        return;
    }

    console.log(`${c.green}✓ 订单簿获取成功${c.reset}`);
    console.log(`  最佳买价 (bid): ${orderbook.bids[0]?.price || 'N/A'}`);
    console.log(`  最佳卖价 (ask): ${orderbook.asks[0]?.price || 'N/A'}`);
    console.log();

    // 5. 获取市场信息
    console.log(`${c.dim}获取市场信息...${c.reset}`);
    const marketInfo = await trader.getMarketInfo(conditionId);
    if (marketInfo) {
        console.log(`${c.green}✓ 市场信息${c.reset}`);
        console.log(`  Tick Size: ${marketInfo.tickSize}`);
        console.log(`  Neg Risk: ${marketInfo.negRisk}`);
        console.log();
    }

    // 6. 测试下单 (使用最小数量，低于市场价格的买单，避免成交)
    const testPrice = 0.01;  // 极低价格，不会成交
    const testQuantity = 1;  // 最小数量

    console.log(`${c.yellow}📝 测试下单参数:${c.reset}`);
    console.log(`  Token ID: ${testTokenId.slice(0, 20)}...`);
    console.log(`  方向: BUY`);
    console.log(`  价格: $${testPrice}`);
    console.log(`  数量: ${testQuantity}`);
    console.log(`  订单类型: GTC (Good-Till-Cancel, 方便测试后取消)`);
    console.log();

    // 确认
    console.log(`${c.yellow}⚠️  即将提交真实订单到 Polymarket${c.reset}`);
    console.log(`${c.dim}按 Ctrl+C 取消，或等待 3 秒继续...${c.reset}`);
    await new Promise(r => setTimeout(r, 3000));

    // 7. 提交订单
    console.log(`\n${c.dim}提交订单...${c.reset}`);
    const result = await trader.placeOrder({
        tokenId: testTokenId,
        side: 'BUY',
        price: testPrice,
        quantity: testQuantity,
        orderType: 'GTC',  // 使用 GTC 方便观察和取消
        negRisk: false,
    });

    if (!result.success) {
        console.log(`${c.red}✗ 下单失败: ${result.error}${c.reset}`);
        return;
    }

    console.log(`${c.green}✓ 下单成功!${c.reset}`);
    console.log(`  订单 ID: ${result.orderId}`);
    console.log();

    // 8. 查询订单状态
    console.log(`${c.dim}查询订单状态...${c.reset}`);
    await new Promise(r => setTimeout(r, 500));
    const status = await trader.getOrderStatus(result.orderId!);
    if (status) {
        console.log(`${c.green}✓ 订单状态${c.reset}`);
        console.log(`  状态: ${status.status}`);
        console.log(`  已成交: ${status.filledQty}`);
        console.log(`  剩余: ${status.remainingQty}`);
    }
    console.log();

    // 9. 取消订单
    console.log(`${c.dim}取消订单...${c.reset}`);
    const cancelled = await trader.cancelOrder(result.orderId!);
    if (cancelled) {
        console.log(`${c.green}✓ 订单已取消${c.reset}`);
    } else {
        console.log(`${c.yellow}⚠ 订单取消可能失败，请手动检查${c.reset}`);
    }

    console.log(`\n${c.green}=== 测试完成 ===${c.reset}\n`);
}

main().catch(err => {
    console.error(`${c.red}测试失败:${c.reset}`, err);
    process.exit(1);
});
