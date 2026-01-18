/**
 * 查询并取消指定市场的所有 Predict 订单
 *
 * 用法:
 *   npx tsx src/testing/cancel-market-orders.ts                  # 查看所有订单
 *   npx tsx src/testing/cancel-market-orders.ts --cancel 2079    # 取消市场 2079 的所有订单
 *   npx tsx src/testing/cancel-market-orders.ts --cancel-all     # 取消所有市场的订单
 */

import * as fs from 'fs';
import * as path from 'path';

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

import { PredictTrader } from '../dashboard/predict-trader.js';

interface Order {
    id: string;
    status: string;
    marketId?: number;
    order?: {
        side: number;
        makerAmount: string;
        takerAmount: string;
        hash: string;
        marketId?: number;
    };
}

async function main() {
    const args = process.argv.slice(2);
    const cancelMarketId = args.includes('--cancel') ? parseInt(args[args.indexOf('--cancel') + 1]) : null;
    const cancelAll = args.includes('--cancel-all');

    console.log('═'.repeat(60));
    console.log('  Predict 订单管理工具');
    console.log('═'.repeat(60));

    const trader = new PredictTrader();
    await trader.init();

    const headers = await (trader as any).getAuthHeaders();

    // 查询所有 OPEN 订单
    console.log('\n📋 查询所有 OPEN 订单...\n');
    const ordersRes = await fetch(`https://api.predict.fun/v1/orders?status=OPEN`, { headers });
    const ordersData = await ordersRes.json() as { data?: Order[] };
    const orders = ordersData.data || [];

    if (orders.length === 0) {
        console.log('✅ 没有活跃订单\n');
        return;
    }

    // 按市场分组
    const byMarket = new Map<number, Order[]>();
    for (const order of orders) {
        const marketId = order.marketId || order.order?.marketId || 0;
        if (!byMarket.has(marketId)) {
            byMarket.set(marketId, []);
        }
        byMarket.get(marketId)!.push(order);
    }

    // 显示每个市场的订单
    console.log(`共 ${orders.length} 个活跃订单，分布在 ${byMarket.size} 个市场:\n`);

    for (const [marketId, marketOrders] of byMarket) {
        console.log(`─── Market ${marketId} (${marketOrders.length} 订单) ───`);

        let totalCollateral = 0;
        for (const order of marketOrders) {
            const side = order.order?.side === 0 ? 'BUY' : 'SELL';
            const makerAmount = BigInt(order.order?.makerAmount || '0');
            const takerAmount = BigInt(order.order?.takerAmount || '0');

            // BUY 订单: makerAmount 是 USDC 抵押品
            // SELL 订单: takerAmount 是期望获得的 USDC
            const collateral = side === 'BUY'
                ? Number(makerAmount) / 1e18
                : Number(takerAmount) / 1e18;

            if (side === 'BUY') {
                totalCollateral += collateral;
            }

            const price = side === 'BUY'
                ? Number(makerAmount) / Number(takerAmount)
                : Number(takerAmount) / Number(makerAmount);

            console.log(`  ${side} @ ${price.toFixed(4)} | ${collateral.toFixed(2)} USDC | ID: ${order.id}`);
        }

        if (totalCollateral > 0) {
            console.log(`  📊 该市场 BUY 订单占用抵押品: ${totalCollateral.toFixed(2)} USDC`);
        }
        console.log();
    }

    // 取消订单
    if (cancelAll) {
        console.log('🗑️  取消所有订单...\n');
        const orderIds = orders.map(o => o.id);
        await cancelOrders(headers, orderIds);
    } else if (cancelMarketId !== null && !isNaN(cancelMarketId)) {
        const marketOrders = byMarket.get(cancelMarketId);
        if (!marketOrders || marketOrders.length === 0) {
            console.log(`⚠️  市场 ${cancelMarketId} 没有活跃订单\n`);
            return;
        }
        console.log(`🗑️  取消市场 ${cancelMarketId} 的 ${marketOrders.length} 个订单...\n`);
        const orderIds = marketOrders.map(o => o.id);
        await cancelOrders(headers, orderIds);
    } else {
        console.log('💡 提示:');
        console.log('   --cancel <marketId>  取消指定市场的所有订单');
        console.log('   --cancel-all         取消所有市场的订单\n');
    }

    console.log('═'.repeat(60));
}

async function cancelOrders(headers: Record<string, string>, orderIds: string[]): Promise<void> {
    try {
        const res = await fetch('https://api.predict.fun/v1/orders/remove', {
            method: 'POST',
            headers,
            body: JSON.stringify({ data: { ids: orderIds } }),
        });

        const result = await res.json() as { success: boolean; removed?: string[]; noop?: string[] };

        if (res.ok && result.success) {
            console.log(`✅ 已取消: ${result.removed?.length || 0} 个订单`);
            if (result.noop?.length) {
                console.log(`⚠️  已完成/已取消: ${result.noop.length} 个订单`);
            }
        } else {
            console.log(`❌ 取消失败: ${JSON.stringify(result)}`);
        }
    } catch (error: any) {
        console.error(`❌ 取消订单出错: ${error.message}`);
    }
}

main().catch(console.error);
