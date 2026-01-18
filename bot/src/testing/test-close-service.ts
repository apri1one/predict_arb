/**
 * 平仓服务测试脚本
 *
 * 测试内容:
 * 1. 加载市场映射缓存
 * 2. 获取扩展持仓数据
 * 3. 匹配双腿持仓
 * 4. 计算平仓机会
 * 5. 验证市场详情字段
 * 6. 测试 TaskService TAKER+SELL 校验
 *
 * 用法: npx tsx src/testing/test-close-service.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { calculateCloseOpportunities, getClosePositions, refreshMarketMatches } from '../dashboard/close-service.js';
import { getTaskService } from '../dashboard/task-service.js';
import type { CloseOpportunity } from '../dashboard/types.js';

// 测试结果统计
let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        console.log(`   ✅ ${message}`);
        passCount++;
    } else {
        console.log(`   ❌ ${message}`);
        failCount++;
    }
}

async function testCloseService() {
    console.log('═'.repeat(60));
    console.log('  测试1: 平仓服务核心功能');
    console.log('═'.repeat(60));

    // 1. 刷新市场映射
    console.log('\n1.1 加载市场映射...');
    refreshMarketMatches();
    console.log('   ✅ 市场映射加载完成');
    passCount++;

    // 2. 获取可平仓持仓
    console.log('\n1.2 查询可平仓持仓...');
    const positions = await getClosePositions();
    console.log(`   找到 ${positions.length} 个可平仓持仓`);

    if (positions.length > 0) {
        console.log('\n   持仓详情:');
        for (const pos of positions) {
            console.log(`   ─────────────────────────────────`);
            console.log(`   市场: ${pos.title}`);
            console.log(`   方向: ${pos.arbSide}`);
            console.log(`   Predict: ${pos.predictLeg.shares} shares @ ${(pos.predictLeg.avgPrice * 100).toFixed(1)}¢`);
            console.log(`   Polymarket: ${pos.polymarketLeg.shares} shares @ ${(pos.polymarketLeg.avgPrice * 100).toFixed(1)}¢`);
            console.log(`   可平仓: ${pos.matchedShares} shares`);
            console.log(`   总成本: $${pos.entryCostTotal.toFixed(2)} (${(pos.entryCostPerShare * 100).toFixed(1)}¢/share)`);
        }
    }

    // 3. 计算平仓机会
    console.log('\n1.3 计算平仓机会...');
    const opportunities = await calculateCloseOpportunities();
    console.log(`   找到 ${opportunities.length} 个平仓机会`);

    if (opportunities.length > 0) {
        console.log('\n   机会详情:');
        for (const opp of opportunities) {
            console.log(`   ═════════════════════════════════`);
            console.log(`   市场: ${opp.title}`);
            console.log(`   方向: ${opp.arbSide} | 可卖: ${opp.maxCloseShares} shares`);
            console.log(`   成本: ${(opp.entryCostPerShare * 100).toFixed(1)}¢/share`);
            console.log('');
            console.log(`   T-T (Taker-Taker):`);
            console.log(`     Predict Bid: ${(opp.tt.predictBid * 100).toFixed(1)}¢ (深度 ${opp.tt.predictBidDepth.toFixed(0)})`);
            console.log(`     Poly Bid:    ${(opp.tt.polyBid * 100).toFixed(1)}¢ (深度 ${opp.tt.polyBidDepth.toFixed(0)})`);
            console.log(`     Fee:         ${(opp.tt.predictFee * 100).toFixed(2)}¢`);
            console.log(`     预估收益:    $${opp.tt.estProfitTotal.toFixed(2)} (${opp.tt.estProfitPct.toFixed(1)}%)`);
            console.log(`     有效:        ${opp.tt.isValid ? '✅' : '❌'}`);
            console.log('');
            console.log(`   M-T (Maker-Taker):`);
            console.log(`     Predict Ask: ${(opp.mt.predictAsk * 100).toFixed(1)}¢`);
            console.log(`     Poly Bid:    ${(opp.mt.polyBid * 100).toFixed(1)}¢`);
            console.log(`     Fee:         0¢ (Maker)`);
            console.log(`     预估收益:    $${opp.mt.estProfitTotal.toFixed(2)} (${opp.mt.estProfitPct.toFixed(1)}%)`);
            console.log(`     有效:        ${opp.mt.isValid ? '✅' : '❌'}`);
        }
    }

    // 4. 汇总
    console.log('\n' + '─'.repeat(60));
    console.log('  汇总');
    console.log('─'.repeat(60));

    const validTT = opportunities.filter(o => o.tt.isValid);
    const validMT = opportunities.filter(o => o.mt.isValid);
    const totalTTProfit = validTT.reduce((sum, o) => sum + o.tt.estProfitTotal, 0);
    const totalMTProfit = validMT.reduce((sum, o) => sum + o.mt.estProfitTotal, 0);

    console.log(`  可平仓持仓:    ${positions.length}`);
    console.log(`  T-T 有效机会:  ${validTT.length} (预估 +$${totalTTProfit.toFixed(2)})`);
    console.log(`  M-T 有效机会:  ${validMT.length} (预估 +$${totalMTProfit.toFixed(2)})`);

    return opportunities;
}

async function testMarketDetailFields(opportunities: CloseOpportunity[]) {
    console.log('\n' + '═'.repeat(60));
    console.log('  测试2: 市场详情字段验证');
    console.log('═'.repeat(60));

    if (opportunities.length === 0) {
        console.log('\n   ⚠️  无平仓机会，跳过市场详情字段测试');
        return;
    }

    console.log('\n2.1 验证新增字段存在性...');
    const opp = opportunities[0];

    assert(typeof opp.polymarketYesTokenId === 'string', 'polymarketYesTokenId 字段存在');
    assert(typeof opp.polymarketNoTokenId === 'string', 'polymarketNoTokenId 字段存在');
    assert(typeof opp.negRisk === 'boolean', 'negRisk 字段存在');
    assert(typeof opp.tickSize === 'number', 'tickSize 字段存在');

    console.log('\n2.2 验证字段值有效性...');
    // Token IDs 应为非空字符串（如果获取到了）
    if (opp.polymarketYesTokenId && opp.polymarketNoTokenId) {
        assert(opp.polymarketYesTokenId.length > 10, 'YES Token ID 格式正确');
        assert(opp.polymarketNoTokenId.length > 10, 'NO Token ID 格式正确');
        assert(opp.polymarketYesTokenId !== opp.polymarketNoTokenId, 'YES/NO Token ID 不相同');
    } else {
        console.log('   ⚠️  Token IDs 未获取到（可能是 API 问题）');
    }

    assert(opp.tickSize > 0 && opp.tickSize <= 0.1, 'tickSize 在合理范围内');

    console.log(`\n   市场详情示例:`);
    console.log(`   - YES Token: ${opp.polymarketYesTokenId || '(未获取)'}`);
    console.log(`   - NO Token:  ${opp.polymarketNoTokenId || '(未获取)'}`);
    console.log(`   - negRisk:   ${opp.negRisk}`);
    console.log(`   - tickSize:  ${opp.tickSize}`);
}

async function testTaskServiceValidation() {
    console.log('\n' + '═'.repeat(60));
    console.log('  测试3: TaskService TAKER+SELL 校验');
    console.log('═'.repeat(60));

    const taskService = getTaskService();
    await taskService.init();

    console.log('\n3.1 测试 TAKER+SELL 必填字段校验...');

    // 测试缺少 predictPrice 时的错误
    try {
        taskService.createTask({
            type: 'SELL',
            strategy: 'TAKER',
            marketId: 99999,
            title: 'Test Market',
            polymarketConditionId: 'test-condition',
            polymarketNoTokenId: 'test-no-token',
            polymarketYesTokenId: 'test-yes-token',
            isInverted: false,
            tickSize: 0.01,
            negRisk: false,
            arbSide: 'YES',
            predictPrice: 0,  // Invalid
            polymarketMinBid: 0.5,
            polymarketMaxAsk: 0,
            quantity: 10,
            entryCost: 5,
            minProfitBuffer: 0.001,
            orderTimeout: 60000,
            maxHedgeRetries: 3,
            feeRateBps: 200,
        });
        assert(false, 'TAKER+SELL 缺少 predictPrice 应报错');
    } catch (e: any) {
        assert(e.message.includes('predictPrice'), 'TAKER+SELL 缺少 predictPrice 正确报错');
    }

    // 测试缺少 polymarketMinBid 时的错误
    try {
        taskService.createTask({
            type: 'SELL',
            strategy: 'TAKER',
            marketId: 99998,
            title: 'Test Market 2',
            polymarketConditionId: 'test-condition-2',
            polymarketNoTokenId: 'test-no-token',
            polymarketYesTokenId: 'test-yes-token',
            isInverted: false,
            tickSize: 0.01,
            negRisk: false,
            arbSide: 'YES',
            predictPrice: 0.5,
            polymarketMinBid: 0,  // Invalid
            polymarketMaxAsk: 0,
            quantity: 10,
            entryCost: 5,
            minProfitBuffer: 0.001,
            orderTimeout: 60000,
            maxHedgeRetries: 3,
            feeRateBps: 200,
        });
        assert(false, 'TAKER+SELL 缺少 polymarketMinBid 应报错');
    } catch (e: any) {
        assert(e.message.includes('polymarketMinBid'), 'TAKER+SELL 缺少 polymarketMinBid 正确报错');
    }

    // 测试缺少 entryCost 时的错误
    try {
        taskService.createTask({
            type: 'SELL',
            strategy: 'TAKER',
            marketId: 99997,
            title: 'Test Market 3',
            polymarketConditionId: 'test-condition-3',
            polymarketNoTokenId: 'test-no-token',
            polymarketYesTokenId: 'test-yes-token',
            isInverted: false,
            tickSize: 0.01,
            negRisk: false,
            arbSide: 'YES',
            predictPrice: 0.5,
            polymarketMinBid: 0.4,
            polymarketMaxAsk: 0,
            quantity: 10,
            entryCost: 0,  // Invalid
            minProfitBuffer: 0.001,
            orderTimeout: 60000,
            maxHedgeRetries: 3,
            feeRateBps: 200,
        });
        assert(false, 'TAKER+SELL 缺少 entryCost 应报错');
    } catch (e: any) {
        assert(e.message.includes('entryCost'), 'TAKER+SELL 缺少 entryCost 正确报错');
    }

    console.log('\n3.2 测试 TAKER+BUY 仍需原有字段...');

    // 测试 TAKER+BUY 仍需要 predictAskPrice
    try {
        taskService.createTask({
            type: 'BUY',
            strategy: 'TAKER',
            marketId: 99996,
            title: 'Test Market BUY',
            polymarketConditionId: 'test-condition-buy',
            polymarketNoTokenId: 'test-no-token',
            polymarketYesTokenId: 'test-yes-token',
            isInverted: false,
            tickSize: 0.01,
            negRisk: false,
            arbSide: 'YES',
            predictPrice: 0.5,
            polymarketMinBid: 0.4,
            polymarketMaxAsk: 0.5,
            quantity: 10,
            minProfitBuffer: 0.001,
            orderTimeout: 60000,
            maxHedgeRetries: 3,
            feeRateBps: 200,
            // predictAskPrice 缺失
            maxTotalCost: 0.95,
        });
        assert(false, 'TAKER+BUY 缺少 predictAskPrice 应报错');
    } catch (e: any) {
        assert(e.message.includes('predictAskPrice'), 'TAKER+BUY 缺少 predictAskPrice 正确报错');
    }
}

async function main() {
    console.log('\n' + '█'.repeat(60));
    console.log('  平仓服务完整测试');
    console.log('█'.repeat(60));

    // 运行所有测试
    const opportunities = await testCloseService();
    await testMarketDetailFields(opportunities);
    await testTaskServiceValidation();

    // 最终汇总
    console.log('\n' + '█'.repeat(60));
    console.log('  测试结果汇总');
    console.log('█'.repeat(60));
    console.log(`\n  ✅ 通过: ${passCount}`);
    console.log(`  ❌ 失败: ${failCount}`);
    console.log(`  总计:   ${passCount + failCount}`);

    if (failCount > 0) {
        console.log('\n  ⚠️  存在失败的测试用例，请检查');
        process.exit(1);
    } else {
        console.log('\n  🎉 所有测试通过！');
    }
}

main().catch(console.error);
