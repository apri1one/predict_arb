/**
 * Task API 测试脚本
 *
 * 测试 Phase 1 实现的任务 CRUD API
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
}

interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}

async function testTaskApi(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Task API 测试');
    console.log('='.repeat(60));
    console.log('');

    // 1. 获取任务列表 (应为空)
    console.log('1️⃣  获取任务列表...');
    try {
        const res = await fetch(`${BASE_URL}/api/tasks`);
        const data: ApiResponse<Task[]> = await res.json();
        console.log(`   状态: ${res.status}`);
        console.log(`   成功: ${data.success}`);
        console.log(`   任务数: ${data.data?.length || 0}`);
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
        console.log('   确保 Dashboard 正在运行: npm run dashboard');
        process.exit(1);
    }

    // 2. 创建任务
    console.log('2️⃣  创建测试任务...');
    let taskId = '';
    try {
        const createInput = {
            type: 'BUY',
            marketId: 999,
            title: 'Test Market',
            polymarketConditionId: '0x1234567890',
            polymarketNoTokenId: '12345',
            polymarketYesTokenId: '12346',
            isInverted: false,
            tickSize: 0.01,
            predictPrice: 0.45,
            polymarketMaxAsk: 0.50,
            polymarketMinBid: 0.40,
            quantity: 100,
            minProfitBuffer: 0.005,
            orderTimeout: 30000,
            maxHedgeRetries: 3,
            idempotencyKey: `test-${Date.now()}`,
        };

        const res = await fetch(`${BASE_URL}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createInput),
        });
        const data: ApiResponse<Task> = await res.json();

        console.log(`   状态: ${res.status}`);
        console.log(`   成功: ${data.success}`);
        if (data.data) {
            taskId = data.data.id;
            console.log(`   任务 ID: ${taskId}`);
            console.log(`   任务状态: ${data.data.status}`);
        } else {
            console.log(`   错误: ${data.error}`);
        }
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
    }

    if (!taskId) {
        console.log('❌ 无法创建任务，测试中止');
        process.exit(1);
    }

    // 3. 获取单个任务
    console.log('3️⃣  获取单个任务...');
    try {
        const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`);
        const data: ApiResponse<Task> = await res.json();
        console.log(`   状态: ${res.status}`);
        console.log(`   成功: ${data.success}`);
        if (data.data) {
            console.log(`   任务 ID: ${data.data.id}`);
            console.log(`   市场 ID: ${data.data.marketId}`);
            console.log(`   类型: ${data.data.type}`);
            console.log(`   状态: ${data.data.status}`);
            console.log(`   价格: ${data.data.predictPrice}`);
        }
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
    }

    // 4. 获取任务列表 (应有 1 个)
    console.log('4️⃣  再次获取任务列表...');
    try {
        const res = await fetch(`${BASE_URL}/api/tasks`);
        const data: ApiResponse<Task[]> = await res.json();
        console.log(`   状态: ${res.status}`);
        console.log(`   成功: ${data.success}`);
        console.log(`   任务数: ${data.data?.length || 0}`);
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
    }

    // 5. 启动任务 (测试状态转换)
    console.log('5️⃣  启动任务...');
    try {
        const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/start`, {
            method: 'POST',
        });
        const data: ApiResponse<Task> = await res.json();
        console.log(`   状态: ${res.status}`);
        console.log(`   成功: ${data.success}`);
        if (data.data) {
            console.log(`   新状态: ${data.data.status}`);
        } else {
            console.log(`   错误: ${data.error}`);
        }
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
    }

    // 6. 尝试重复启动 (应失败)
    console.log('6️⃣  尝试重复启动 (应失败)...');
    try {
        const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/start`, {
            method: 'POST',
        });
        const data: ApiResponse<Task> = await res.json();
        console.log(`   状态: ${res.status}`);
        console.log(`   成功: ${data.success}`);
        console.log(`   错误: ${data.error || '(无)'}`);
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
    }

    // 7. 取消任务
    console.log('7️⃣  取消任务...');
    try {
        const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`, {
            method: 'DELETE',
        });
        const data: ApiResponse<Task> = await res.json();
        console.log(`   状态: ${res.status}`);
        console.log(`   成功: ${data.success}`);
        if (data.data) {
            console.log(`   新状态: ${data.data.status}`);
        } else {
            console.log(`   消息: ${data.message || data.error}`);
        }
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
    }

    // 8. 删除任务 (已取消，可删除)
    console.log('8️⃣  删除任务...');
    try {
        const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`, {
            method: 'DELETE',
        });
        const data: ApiResponse<Task> = await res.json();
        console.log(`   状态: ${res.status}`);
        console.log(`   成功: ${data.success}`);
        console.log(`   消息: ${data.message || '任务已删除'}`);
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
    }

    // 9. 验证删除
    console.log('9️⃣  验证删除...');
    try {
        const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`);
        const data: ApiResponse<Task> = await res.json();
        console.log(`   状态: ${res.status}`);
        console.log(`   成功: ${data.success}`);
        console.log(`   错误: ${data.error || '(无)'}`);
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
    }

    // 10. 测试幂等性 - 创建相同任务
    console.log('🔟  测试幂等性...');
    const idempotentKey = `idempotent-${Date.now()}`;
    try {
        const createInput = {
            type: 'BUY',
            marketId: 888,
            title: 'Idempotent Test',
            polymarketConditionId: '0xabcdef',
            polymarketNoTokenId: '88888',
            polymarketYesTokenId: '88889',
            isInverted: false,
            tickSize: 0.01,
            predictPrice: 0.50,
            polymarketMaxAsk: 0.55,
            polymarketMinBid: 0.45,
            quantity: 50,
            minProfitBuffer: 0.005,
            orderTimeout: 30000,
            maxHedgeRetries: 3,
            idempotencyKey: idempotentKey,
        };

        // 第一次创建
        const res1 = await fetch(`${BASE_URL}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createInput),
        });
        const data1: ApiResponse<Task> = await res1.json();
        console.log(`   第一次创建: ${data1.success ? '成功' : '失败'}`);
        if (data1.data) {
            console.log(`   任务 ID: ${data1.data.id}`);
        }

        // 第二次创建 (相同 idempotencyKey)
        const res2 = await fetch(`${BASE_URL}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createInput),
        });
        const data2: ApiResponse<Task> = await res2.json();
        console.log(`   第二次创建: ${data2.success ? '成功' : '失败 (预期)'}`);
        console.log(`   错误: ${data2.error || '(无)'}`);
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
    }

    // 11. 测试 market 锁
    console.log('1️⃣1️⃣  测试 Market 并发锁...');
    try {
        const createInput1 = {
            type: 'BUY',
            marketId: 777,
            title: 'Lock Test 1',
            polymarketConditionId: '0x777777',
            polymarketNoTokenId: '77777',
            polymarketYesTokenId: '77778',
            isInverted: false,
            tickSize: 0.01,
            predictPrice: 0.50,
            polymarketMaxAsk: 0.55,
            polymarketMinBid: 0.45,
            quantity: 50,
            minProfitBuffer: 0.005,
            orderTimeout: 30000,
            maxHedgeRetries: 3,
            idempotencyKey: `lock-1-${Date.now()}`,
        };

        const createInput2 = {
            ...createInput1,
            idempotencyKey: `lock-2-${Date.now()}`,
        };

        // 第一次创建
        const res1 = await fetch(`${BASE_URL}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createInput1),
        });
        const data1: ApiResponse<Task> = await res1.json();
        console.log(`   第一个任务: ${data1.success ? '成功' : '失败'}`);
        if (data1.data) {
            console.log(`   任务 ID: ${data1.data.id}`);
        }

        // 第二次创建 (相同 marketId，应被锁住)
        const res2 = await fetch(`${BASE_URL}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createInput2),
        });
        const data2: ApiResponse<Task> = await res2.json();
        console.log(`   第二个任务: ${data2.success ? '成功 (不期望)' : '失败 (预期)'}`);
        console.log(`   错误: ${data2.error || '(无)'}`);
        console.log('');
    } catch (error: any) {
        console.error(`   ❌ 错误: ${error.message}`);
    }

    console.log('='.repeat(60));
    console.log('✅ Task API 测试完成');
    console.log('='.repeat(60));
}

testTaskApi().catch(console.error);
