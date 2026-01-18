/**
 * 使用 PredictTrader 测试订单取消原因
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

// 使用接近市场价的价格测试
const TEST_MARKET_ID = 704;  // Los Angeles Rams (Best Ask: $0.22, Best Bid: $0.17)
const TEST_PRICE = 0.16;     // 低于 best bid，作为 maker 挂单
const TEST_QUANTITY = 10;

async function main() {
    console.log('=== 订单取消原因调试 ===\n');

    const trader = new PredictTrader();
    await trader.init();

    // 1. 获取市场信息
    console.log('1. 获取市场信息...');
    const marketInfo = await (trader as any).getMarketInfo(TEST_MARKET_ID);
    console.log('市场信息:', JSON.stringify(marketInfo, null, 2));

    if (!marketInfo) {
        console.error('❌ 无法获取市场信息');
        return;
    }

    // 2. 下单
    console.log('\n2. 提交订单...');
    console.log(`   市场: ${TEST_MARKET_ID}`);
    console.log(`   方向: BUY YES`);
    console.log(`   价格: $${TEST_PRICE}`);
    console.log(`   数量: ${TEST_QUANTITY}`);

    const result = await trader.placeBuyOrder({
        marketId: TEST_MARKET_ID,
        price: TEST_PRICE,
        quantity: TEST_QUANTITY,
        outcome: 'YES',
    });

    console.log('\n订单结果:', JSON.stringify(result, null, 2));

    if (!result.success || !result.hash) {
        console.error('❌ 订单提交失败:', result.error);
        return;
    }

    console.log('\n✅ 订单已提交, hash:', result.hash);

    // 3. 轮询状态
    console.log('\n3. 开始轮询订单状态 (30秒)...\n');

    const startTime = Date.now();
    const maxTime = 30000;
    let lastStatus = '';

    while (Date.now() - startTime < maxTime) {
        const status = await trader.getOrderStatus(result.hash);

        if (status) {
            const statusStr = `${status.status} (filled: ${status.filledQty})`;
            if (statusStr !== lastStatus) {
                console.log(`[${new Date().toISOString()}] Status: ${status.status}`);
                console.log('  filledQty:', status.filledQty);
                console.log('  remainingQty:', status.remainingQty);
                console.log('  avgPrice:', status.avgPrice);
                console.log('  cancelReason:', status.cancelReason);

                if (status.rawResponse) {
                    console.log('\n  === 完整 API 响应 ===');
                    console.log(JSON.stringify(status.rawResponse, null, 2));
                    console.log('  ====================\n');
                }

                lastStatus = statusStr;
            }

            if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
                console.log('\n🛑 订单被取消/过期!');
                console.log('取消原因:', status.cancelReason || '未知');
                break;
            }

            if (status.status === 'FILLED') {
                console.log('\n✅ 订单已成交!');
                break;
            }
        }

        await new Promise(r => setTimeout(r, 1000));
    }

    // 4. 尝试取消订单（如果还在挂单）
    if (lastStatus.includes('OPEN') || lastStatus.includes('PARTIALLY')) {
        console.log('\n4. 取消测试订单...');
        const cancelled = await trader.cancelOrder(result.hash);
        console.log('取消结果:', cancelled);
    }

    console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
