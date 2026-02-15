/**
 * 深度监控竞态条件测试
 *
 * 测试 isDepthAdjusting 标志是否正确防止主循环误判深度监控取消的订单
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '../../../.env') });

// ============================================================================
// 测试用类型定义
// ============================================================================

interface TaskContext {
    task: { id: string; status: string; quantity: number; totalQuantity: number };
    isPaused: boolean;
    isDepthAdjusting?: boolean;
    currentOrderHash?: string;
    totalPredictFilled: number;
    signal: { aborted: boolean };
}

// ============================================================================
// 测试辅助函数
// ============================================================================

function createMockContext(overrides?: Partial<TaskContext>): TaskContext {
    return {
        task: { id: 'test-task-1', status: 'PREDICT_SUBMITTED', quantity: 100, totalQuantity: 100 },
        isPaused: false,
        isDepthAdjusting: false,
        currentOrderHash: 'hash-abc123',
        totalPredictFilled: 0,
        signal: { aborted: false },
        ...overrides,
    };
}

function simulateMainLoopCancelCheck(ctx: TaskContext, watchedOrderHash: string): {
    shouldTriggerExternalCancel: boolean;
    reason: string;
} {
    // 模拟 task-executor.ts 2288 行的判断逻辑
    if (ctx.currentOrderHash !== watchedOrderHash || ctx.isPaused || ctx.isDepthAdjusting) {
        return {
            shouldTriggerExternalCancel: false,
            reason: `Guard-managed cancel (hash changed: ${ctx.currentOrderHash !== watchedOrderHash}, isPaused: ${ctx.isPaused}, isDepthAdjusting: ${!!ctx.isDepthAdjusting})`,
        };
    }

    return {
        shouldTriggerExternalCancel: true,
        reason: 'External cancel detected',
    };
}

// ============================================================================
// 测试用例
// ============================================================================

interface TestCase {
    name: string;
    setup: () => TaskContext;
    watchedOrderHash: string;
    expectedResult: { shouldTriggerExternalCancel: boolean; reason: string };
}

const testCases: TestCase[] = [
    {
        name: '正常情况：订单 hash 未变化，非暂停，非深度调整',
        setup: () => createMockContext({
            currentOrderHash: 'hash-abc123',
            isPaused: false,
            isDepthAdjusting: false,
        }),
        watchedOrderHash: 'hash-abc123',
        expectedResult: {
            shouldTriggerExternalCancel: true,
            reason: 'External cancel detected',
        },
    },
    {
        name: '深度恢复场景：isDepthAdjusting=true，订单取消中',
        setup: () => createMockContext({
            currentOrderHash: 'hash-abc123',
            isPaused: false,
            isDepthAdjusting: true,
        }),
        watchedOrderHash: 'hash-abc123',
        expectedResult: {
            shouldTriggerExternalCancel: false,
            reason: 'Guard-managed cancel (hash changed: false, isPaused: false, isDepthAdjusting: true)',
        },
    },
    {
        name: '深度扩增场景：isDepthAdjusting=true，hash 即将变化',
        setup: () => createMockContext({
            currentOrderHash: 'hash-abc123',
            isPaused: false,
            isDepthAdjusting: true,
        }),
        watchedOrderHash: 'hash-old-order',
        expectedResult: {
            shouldTriggerExternalCancel: false,
            reason: 'Guard-managed cancel (hash changed: true, isPaused: false, isDepthAdjusting: true)',
        },
    },
    {
        name: '深度调整场景：isDepthAdjusting=true，正在取消旧订单',
        setup: () => createMockContext({
            currentOrderHash: undefined,
            isPaused: false,
            isDepthAdjusting: true,
        }),
        watchedOrderHash: 'hash-abc123',
        expectedResult: {
            shouldTriggerExternalCancel: false,
            reason: 'Guard-managed cancel (hash changed: true, isPaused: false, isDepthAdjusting: true)',
        },
    },
    {
        name: '深度暂停场景：isPaused=true，订单已取消',
        setup: () => createMockContext({
            currentOrderHash: undefined,
            isPaused: true,
            isDepthAdjusting: false,
        }),
        watchedOrderHash: 'hash-abc123',
        expectedResult: {
            shouldTriggerExternalCancel: false,
            reason: 'Guard-managed cancel (hash changed: true, isPaused: true, isDepthAdjusting: false)',
        },
    },
    {
        name: '价格守护取消：hash 已变化',
        setup: () => createMockContext({
            currentOrderHash: 'hash-new-order',
            isPaused: false,
            isDepthAdjusting: false,
        }),
        watchedOrderHash: 'hash-abc123',
        expectedResult: {
            shouldTriggerExternalCancel: false,
            reason: 'Guard-managed cancel (hash changed: true, isPaused: false, isDepthAdjusting: false)',
        },
    },
    {
        name: '边界情况：深度调整完成但标志未清除（bug）',
        setup: () => createMockContext({
            currentOrderHash: 'hash-new-order',
            isPaused: false,
            isDepthAdjusting: true, // 应该已清除但未清除
        }),
        watchedOrderHash: 'hash-new-order',
        expectedResult: {
            shouldTriggerExternalCancel: false,
            reason: 'Guard-managed cancel (hash changed: false, isPaused: false, isDepthAdjusting: true)',
        },
    },
    {
        name: '竞态情况：主循环检测时深度监控刚开始取消',
        setup: () => createMockContext({
            currentOrderHash: 'hash-abc123',
            isPaused: false,
            isDepthAdjusting: true, // 刚设置标志
        }),
        watchedOrderHash: 'hash-abc123',
        expectedResult: {
            shouldTriggerExternalCancel: false,
            reason: 'Guard-managed cancel (hash changed: false, isPaused: false, isDepthAdjusting: true)',
        },
    },
    {
        name: '竞态情况：深度监控取消失败，订单仍存在',
        setup: () => createMockContext({
            currentOrderHash: 'hash-abc123', // 取消失败，hash 未清除
            isPaused: true,
            isDepthAdjusting: false, // 已完成调整尝试
        }),
        watchedOrderHash: 'hash-abc123',
        expectedResult: {
            shouldTriggerExternalCancel: false,
            reason: 'Guard-managed cancel (hash changed: false, isPaused: true, isDepthAdjusting: false)',
        },
    },
];

// ============================================================================
// 时序模拟测试
// ============================================================================

interface TimelineEvent {
    timestamp: number;
    actor: 'depth-monitor' | 'main-loop';
    action: string;
    ctx: TaskContext;
}

function simulateRaceConditionTimeline(): { success: boolean; events: TimelineEvent[] } {
    const events: TimelineEvent[] = [];
    let ctx = createMockContext({
        currentOrderHash: 'hash-order-1',
        isPaused: false,
        isDepthAdjusting: false,
    });

    // t=0: 深度监控检测到深度不足
    events.push({
        timestamp: 0,
        actor: 'depth-monitor',
        action: '检测到深度不足，设置 isDepthAdjusting=true',
        ctx: { ...ctx },
    });
    ctx.isDepthAdjusting = true;

    // t=50: 深度监控调用 cancelOrder
    events.push({
        timestamp: 50,
        actor: 'depth-monitor',
        action: 'cancelOrder 调用中（模拟网络延迟 300ms）',
        ctx: { ...ctx },
    });

    // t=100: 主循环检测订单状态
    events.push({
        timestamp: 100,
        actor: 'main-loop',
        action: 'getOrderStatus 返回 CANCELLED',
        ctx: { ...ctx },
    });

    const checkResult = simulateMainLoopCancelCheck(ctx, 'hash-order-1');
    events.push({
        timestamp: 100,
        actor: 'main-loop',
        action: `取消检测: ${checkResult.reason}`,
        ctx: { ...ctx },
    });

    // t=350: cancelOrder 完成
    events.push({
        timestamp: 350,
        actor: 'depth-monitor',
        action: 'cancelOrder 完成，清除 currentOrderHash',
        ctx: { ...ctx },
    });
    ctx.currentOrderHash = undefined;

    // t=400: 深度监控重新下单
    events.push({
        timestamp: 400,
        actor: 'depth-monitor',
        action: '重新下单，设置新 hash',
        ctx: { ...ctx },
    });
    ctx.currentOrderHash = 'hash-order-2';

    // t=450: 深度监控清除标志
    events.push({
        timestamp: 450,
        actor: 'depth-monitor',
        action: '清除 isDepthAdjusting=false',
        ctx: { ...ctx },
    });
    ctx.isDepthAdjusting = false;

    const success = !checkResult.shouldTriggerExternalCancel;
    return { success, events };
}

// ============================================================================
// 主测试函数
// ============================================================================

async function runTests() {
    console.log('========================================');
    console.log('深度监控竞态条件测试');
    console.log('========================================\n');

    let passedCount = 0;
    let failedCount = 0;

    // 基础逻辑测试
    console.log('📋 基础逻辑测试\n');
    for (const testCase of testCases) {
        const ctx = testCase.setup();
        const result = simulateMainLoopCancelCheck(ctx, testCase.watchedOrderHash);

        const passed =
            result.shouldTriggerExternalCancel === testCase.expectedResult.shouldTriggerExternalCancel;

        if (passed) {
            console.log(`✅ ${testCase.name}`);
            console.log(`   期望: ${testCase.expectedResult.shouldTriggerExternalCancel ? '外部取消' : '保护机制取消'}`);
            console.log(`   实际: ${result.shouldTriggerExternalCancel ? '外部取消' : '保护机制取消'}`);
            console.log(`   原因: ${result.reason}\n`);
            passedCount++;
        } else {
            console.log(`❌ ${testCase.name}`);
            console.log(`   期望: ${testCase.expectedResult.shouldTriggerExternalCancel ? '外部取消' : '保护机制取消'}`);
            console.log(`   实际: ${result.shouldTriggerExternalCancel ? '外部取消' : '保护机制取消'}`);
            console.log(`   原因: ${result.reason}\n`);
            failedCount++;
        }
    }

    // 时序模拟测试
    console.log('\n⏱️  时序模拟测试\n');
    console.log('场景: 深度监控正在取消订单时，主循环检测到订单状态变为 CANCELLED\n');

    const timeline = simulateRaceConditionTimeline();

    console.log('时序事件:');
    for (const event of timeline.events) {
        const actor = event.actor === 'depth-monitor' ? '深度监控' : '主循环';
        console.log(`  t=${event.timestamp.toString().padStart(3)}ms | ${actor.padEnd(8)} | ${event.action}`);
        console.log(`           状态: hash=${event.ctx.currentOrderHash?.slice(0, 10) || 'null'}, isDepthAdjusting=${!!event.ctx.isDepthAdjusting}, isPaused=${event.ctx.isPaused}`);
    }

    if (timeline.success) {
        console.log('\n✅ 时序测试通过: isDepthAdjusting 标志成功防止了误判\n');
        passedCount++;
    } else {
        console.log('\n❌ 时序测试失败: 主循环误判为外部取消\n');
        failedCount++;
    }

    // 测试总结
    console.log('========================================');
    console.log('测试总结');
    console.log('========================================');
    console.log(`✅ 通过: ${passedCount}`);
    console.log(`❌ 失败: ${failedCount}`);
    console.log(`📊 总计: ${passedCount + failedCount}`);
    console.log(`🎯 成功率: ${((passedCount / (passedCount + failedCount)) * 100).toFixed(1)}%\n`);

    if (failedCount > 0) {
        console.log('⚠️  存在失败的测试用例，请检查代码逻辑');
        process.exit(1);
    } else {
        console.log('🎉 所有测试通过！');
    }
}

// ============================================================================
// 执行测试
// ============================================================================

runTests().catch((err) => {
    console.error('测试执行失败:', err);
    process.exit(1);
});
