/**
 * Task Executor 测试脚本
 *
 * 测试 Phase 2 交易执行层
 * 注意: 这会提交真实订单，请使用小金额测试
 */

const BASE_URL = 'http://localhost:3005';

interface Task {
    id: string;
    type: 'BUY' | 'SELL';
    status: string;
    marketId: number;
    title: string;
    predictPrice: number;
    quantity: number;
    error?: string;
}

interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
}

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

function log(msg: string, color: keyof typeof colors = 'reset') {
    console.log(`${colors[color]}${msg}${colors.reset}`);
}

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function testTaskExecutor(): Promise<void> {
    console.log('');
    log('═'.repeat(60), 'cyan');
    log('  Task Executor 测试 (Phase 2)', 'cyan');
    log('═'.repeat(60), 'cyan');
    console.log('');

    // 检查 Dashboard 是否运行
    log('1️⃣  检查 Dashboard 连接...', 'yellow');
    try {
        const res = await fetch(`${BASE_URL}/api/data`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        log('   ✅ Dashboard 已连接', 'green');
    } catch (error: any) {
        log(`   ❌ Dashboard 未运行: ${error.message}`, 'red');
        log('   请先启动: npm run dashboard', 'dim');
        process.exit(1);
    }
    console.log('');

    // 获取可用市场
    log('2️⃣  获取可用市场...', 'yellow');
    let markets: any[] = [];
    try {
        const res = await fetch(`${BASE_URL}/api/data`);
        const data = await res.json() as any;
        markets = data.opportunities || [];
        log(`   找到 ${markets.length} 个套利机会`, 'green');

        if (markets.length > 0) {
            const top = markets[0];
            log(`   最佳机会: ${top.title?.slice(0, 40)}...`, 'dim');
            log(`   利润: ${top.profitPercent?.toFixed(2)}%, 深度: $${top.maxQuantity?.toFixed(2)}`, 'dim');
        }
    } catch (error: any) {
        log(`   ⚠️  获取市场失败: ${error.message}`, 'yellow');
    }
    console.log('');

    // 创建测试任务 (使用模拟数据，不会真正执行)
    log('3️⃣  创建测试任务...', 'yellow');
    let taskId = '';

    const testInput = {
        type: 'BUY',
        marketId: 999999,  // 使用不存在的市场 ID 避免真实交易
        title: 'Test Task - Phase 2 Validation',
        polymarketConditionId: '0xtest123',
        polymarketNoTokenId: '999999999',
        polymarketYesTokenId: '999999998',
        isInverted: false,
        tickSize: 0.01,
        predictPrice: 0.45,
        polymarketMaxAsk: 0.50,
        polymarketMinBid: 0.40,
        quantity: 1,  // 最小数量
        minProfitBuffer: 0.005,
        orderTimeout: 10000,  // 10秒超时
        maxHedgeRetries: 1,
        idempotencyKey: `test-executor-${Date.now()}`,
    };

    try {
        const res = await fetch(`${BASE_URL}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testInput),
        });
        const data: ApiResponse<Task> = await res.json();

        if (data.success && data.data) {
            taskId = data.data.id;
            log(`   ✅ 任务已创建: ${taskId}`, 'green');
            log(`   状态: ${data.data.status}`, 'dim');
        } else {
            throw new Error(data.error || 'Unknown error');
        }
    } catch (error: any) {
        log(`   ❌ 创建失败: ${error.message}`, 'red');
        process.exit(1);
    }
    console.log('');

    // 启动任务执行
    log('4️⃣  启动任务执行...', 'yellow');
    try {
        const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/start`, {
            method: 'POST',
        });
        const data: ApiResponse<Task> = await res.json();

        if (data.success) {
            log(`   ✅ 任务已启动`, 'green');
        } else {
            log(`   ⚠️  启动响应: ${data.error}`, 'yellow');
        }
    } catch (error: any) {
        log(`   ❌ 启动失败: ${error.message}`, 'red');
    }
    console.log('');

    // 轮询任务状态
    log('5️⃣  监控任务状态 (10秒)...', 'yellow');
    const startTime = Date.now();
    const maxWait = 10000;
    let lastStatus = '';

    while (Date.now() - startTime < maxWait) {
        try {
            const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`);
            const data: ApiResponse<Task> = await res.json();

            if (data.success && data.data) {
                const task = data.data;
                if (task.status !== lastStatus) {
                    lastStatus = task.status;
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    log(`   [${elapsed}s] 状态: ${task.status}`, 'cyan');

                    if (task.error) {
                        log(`   错误: ${task.error}`, 'red');
                    }
                }

                // 终态检查
                if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
                    break;
                }
            }
        } catch (error: any) {
            log(`   轮询错误: ${error.message}`, 'red');
        }

        await sleep(500);
    }
    console.log('');

    // 清理: 取消并删除任务
    log('6️⃣  清理测试任务...', 'yellow');
    try {
        // 第一次 DELETE 取消任务
        await fetch(`${BASE_URL}/api/tasks/${taskId}`, { method: 'DELETE' });
        await sleep(100);

        // 第二次 DELETE 删除任务
        await fetch(`${BASE_URL}/api/tasks/${taskId}`, { method: 'DELETE' });

        log('   ✅ 任务已清理', 'green');
    } catch (error: any) {
        log(`   ⚠️  清理警告: ${error.message}`, 'yellow');
    }
    console.log('');

    // 测试结果
    log('═'.repeat(60), 'cyan');
    log('  测试完成', 'cyan');
    log('═'.repeat(60), 'cyan');
    console.log('');
    log('说明:', 'yellow');
    log('  - 任务使用了不存在的市场 ID (999999)', 'dim');
    log('  - 预期状态: PENDING → PREDICT_SUBMITTED → FAILED', 'dim');
    log('  - 因为 Predict API 会拒绝无效的市场 ID', 'dim');
    console.log('');
    log('要测试真实交易，请:', 'yellow');
    log('  1. 从 Dashboard 选择一个真实的套利机会', 'dim');
    log('  2. 使用该机会的参数创建任务', 'dim');
    log('  3. 确保账户有足够余额', 'dim');
    console.log('');
}

// SSE 监听测试
async function testSSE(): Promise<void> {
    log('7️⃣  测试 SSE 实时推送 (5秒)...', 'yellow');

    return new Promise((resolve) => {
        const events: string[] = [];

        // 使用 fetch 模拟 SSE (Node.js 原生不支持 EventSource)
        fetch(`${BASE_URL}/api/stream`).then(async res => {
            const reader = res.body?.getReader();
            if (!reader) {
                log('   ⚠️  无法获取 SSE 流', 'yellow');
                resolve();
                return;
            }

            const decoder = new TextDecoder();
            const timeout = setTimeout(() => {
                reader.cancel();
                log(`   收到 ${events.length} 个事件类型: ${[...new Set(events)].join(', ')}`, 'green');
                resolve();
            }, 5000);

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const text = decoder.decode(value);
                    const eventMatches = text.match(/event: (\w+)/g);
                    if (eventMatches) {
                        for (const match of eventMatches) {
                            events.push(match.replace('event: ', ''));
                        }
                    }
                }
            } catch (e) {
                // 预期的取消
            }

            clearTimeout(timeout);
        }).catch(err => {
            log(`   ⚠️  SSE 连接失败: ${err.message}`, 'yellow');
            resolve();
        });
    });
}

async function main() {
    await testTaskExecutor();
    await testSSE();
}

main().catch(console.error);
