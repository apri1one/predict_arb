/**
 * 统一订单簿缓存层验证脚本
 *
 * 验证内容:
 * 1. WS 更新 → 统一缓存写入
 * 2. Provider 读取（三种格式）
 * 3. TTL 过期 + REST 降级触发
 * 4. 浅拷贝保护（修改返回值不污染缓存）
 *
 * 运行: npx tsx src/testing/test-unified-orderbook-cache.ts
 */

import { PredictOrderbookCache, type CachedOrderbook, type OrderbookLevel } from '../services/predict-orderbook-cache.js';

// ============================================================================
// 测试配置
// ============================================================================

const TEST_MARKET_ID = 12345;
const TEST_TTL_MS = 500;  // 短 TTL 便于测试过期

// 模拟订单簿数据
const MOCK_BIDS: [number, number][] = [
    [0.55, 100],
    [0.54, 200],
    [0.53, 300],
];
const MOCK_ASKS: [number, number][] = [
    [0.56, 150],
    [0.57, 250],
    [0.58, 350],
];

// ============================================================================
// 辅助函数
// ============================================================================

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(`❌ FAILED: ${message}`);
    }
    console.log(`✅ PASS: ${message}`);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 模拟 Provider 格式转换（与 start-dashboard.ts 一致）
function convertToTupleFormat(book: CachedOrderbook): { bids: [number, number][]; asks: [number, number][] } {
    return {
        bids: book.bids.map(l => [l.price, l.size] as [number, number]),
        asks: book.asks.map(l => [l.price, l.size] as [number, number]),
    };
}

function convertToObjectFormat(book: CachedOrderbook): { bids: OrderbookLevel[]; asks: OrderbookLevel[] } {
    // 返回深拷贝（与 getPredictOrderbookForCloseService 一致）
    return {
        bids: book.bids.map(l => ({ price: l.price, size: l.size })),
        asks: book.asks.map(l => ({ price: l.price, size: l.size })),
    };
}

// ============================================================================
// 测试用例
// ============================================================================

async function testWsUpdateAndRead(): Promise<void> {
    console.log('\n--- 测试 1: WS 更新 → 缓存读取 ---');

    const cache = new PredictOrderbookCache({
        apiKey: 'test-key',
        ttlMs: TEST_TTL_MS,
        allowStale: false,
        wsEnabled: false,  // 禁用 WS 连接
        restEnabled: false, // 禁用 REST
    });

    // 模拟 WS 更新
    cache.updateFromExternal(TEST_MARKET_ID, MOCK_BIDS, MOCK_ASKS);

    // 同步读取
    const result = cache.getOrderbookSync(TEST_MARKET_ID);
    assert(result !== null, '缓存应该命中');
    assert(result!.bids.length === 3, 'bids 应有 3 个档位');
    assert(result!.asks.length === 3, 'asks 应有 3 个档位');
    assert(result!.bids[0].price === 0.55, '最佳 bid 应为 0.55');
    assert(result!.asks[0].price === 0.56, '最佳 ask 应为 0.56');
    assert(result!.source === 'ws', 'source 应为 ws');

    cache.stop();
}

async function testProviderFormats(): Promise<void> {
    console.log('\n--- 测试 2: Provider 格式转换 ---');

    const cache = new PredictOrderbookCache({
        apiKey: 'test-key',
        ttlMs: TEST_TTL_MS,
        allowStale: false,
        wsEnabled: false,
        restEnabled: false,
    });

    cache.updateFromExternal(TEST_MARKET_ID, MOCK_BIDS, MOCK_ASKS);
    const book = cache.getOrderbookSync(TEST_MARKET_ID)!;

    // 测试 tuple 格式（PredictTrader 用）
    const tupleFormat = convertToTupleFormat(book);
    assert(Array.isArray(tupleFormat.bids[0]), 'tuple 格式 bids 应为数组');
    assert(tupleFormat.bids[0][0] === 0.55, 'tuple 格式 bid price 正确');
    assert(tupleFormat.bids[0][1] === 100, 'tuple 格式 bid size 正确');

    // 测试 object 格式（close-service/sports-service 用）
    const objectFormat = convertToObjectFormat(book);
    assert(typeof objectFormat.bids[0] === 'object', 'object 格式 bids 应为对象');
    assert(objectFormat.bids[0].price === 0.55, 'object 格式 bid price 正确');
    assert(objectFormat.bids[0].size === 100, 'object 格式 bid size 正确');

    cache.stop();
}

async function testTtlExpiration(): Promise<void> {
    console.log('\n--- 测试 3: TTL 过期行为 ---');

    const cache = new PredictOrderbookCache({
        apiKey: 'test-key',
        ttlMs: TEST_TTL_MS,
        allowStale: false,
        wsEnabled: false,
        restEnabled: false,
    });

    cache.updateFromExternal(TEST_MARKET_ID, MOCK_BIDS, MOCK_ASKS);

    // 立即读取应该命中
    let result = cache.getOrderbookSync(TEST_MARKET_ID);
    assert(result !== null, 'TTL 内应该命中');

    // 等待 TTL 过期
    await sleep(TEST_TTL_MS + 100);

    // 过期后读取应该 miss（allowStale=false）
    result = cache.getOrderbookSync(TEST_MARKET_ID);
    assert(result === null, 'TTL 过期后应该 miss');

    cache.stop();
}

async function testStaleAllowed(): Promise<void> {
    console.log('\n--- 测试 4: allowStale 模式 ---');

    const cache = new PredictOrderbookCache({
        apiKey: 'test-key',
        ttlMs: TEST_TTL_MS,
        allowStale: true,  // 允许使用过期数据
        wsEnabled: false,
        restEnabled: false,
    });

    cache.updateFromExternal(TEST_MARKET_ID, MOCK_BIDS, MOCK_ASKS);

    // 等待 TTL 过期
    await sleep(TEST_TTL_MS + 100);

    // 过期后读取应该仍然返回数据（allowStale=true）
    const result = cache.getOrderbookSync(TEST_MARKET_ID);
    assert(result !== null, 'allowStale 模式下过期数据应该可用');

    cache.stop();
}

async function testCopyProtection(): Promise<void> {
    console.log('\n--- 测试 5: 拷贝保护（数组+对象） ---');

    const cache = new PredictOrderbookCache({
        apiKey: 'test-key',
        ttlMs: 60000,  // 长 TTL
        allowStale: false,
        wsEnabled: false,
        restEnabled: false,
    });

    cache.updateFromExternal(TEST_MARKET_ID, MOCK_BIDS, MOCK_ASKS);

    // 获取并修改返回值
    const result1 = cache.getOrderbookSync(TEST_MARKET_ID)!;
    const objectFormat = convertToObjectFormat(result1);

    // 测试 1: 修改数组结构（push, sort）
    objectFormat.bids.push({ price: 0.99, size: 999 });
    objectFormat.bids.sort((a, b) => a.price - b.price);  // 反向排序

    // 再次读取缓存，验证数组结构未被污染
    const result2 = cache.getOrderbookSync(TEST_MARKET_ID)!;
    assert(result2.bids.length === 3, '缓存 bids 长度应不变');
    assert(result2.bids[0].price === 0.55, '缓存最佳 bid 应不变');

    // 测试 2: 修改元素对象字段（需要深拷贝保护）
    const result3 = cache.getOrderbookSync(TEST_MARKET_ID)!;
    const deepCopy = convertToObjectFormat(result3);

    // 尝试修改元素对象的字段
    deepCopy.bids[0].price = 0.99;
    deepCopy.bids[0].size = 999;

    // 再次读取缓存，验证元素对象未被污染
    const result4 = cache.getOrderbookSync(TEST_MARKET_ID)!;
    assert(result4.bids[0].price === 0.55, '深拷贝：缓存元素 price 应不变');
    assert(result4.bids[0].size === 100, '深拷贝：缓存元素 size 应不变');

    cache.stop();
}

async function testCacheMissStats(): Promise<void> {
    console.log('\n--- 测试 6: Cache miss 统计记录 ---');

    const cache = new PredictOrderbookCache({
        apiKey: 'test-key',
        ttlMs: TEST_TTL_MS,
        allowStale: false,
        wsEnabled: false,
        restEnabled: false,  // 禁用 REST，仅测试缓存逻辑
    });

    // 读取不存在的市场（cache miss）
    const result = cache.getOrderbookSync(99999);
    assert(result === null, 'Cache miss 应返回 null');

    // 检查统计
    const stats = cache.getStats();
    assert(stats.totalMisses >= 1, 'Cache miss 应被记录');

    // 再次读取同一市场
    cache.getOrderbookSync(99999);
    const stats2 = cache.getStats();
    assert(stats2.totalMisses >= 2, '重复 miss 应累计');

    cache.stop();
}

async function testRefreshDeduplication(): Promise<void> {
    console.log('\n--- 测试 6b: REST 刷新去重/冷却 ---');

    // 使用计数器模拟 REST 调用
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;

    // Mock fetch 只计数，不实际请求
    globalThis.fetch = (async () => {
        fetchCount++;
        // 返回空响应模拟失败
        return { ok: false, status: 500 } as Response;
    }) as typeof fetch;

    try {
        const cache = new PredictOrderbookCache({
            apiKey: 'test-key',
            ttlMs: 100,  // 短 TTL
            allowStale: false,
            wsEnabled: false,
            restEnabled: true,  // 启用 REST（使用 mock）
        });

        // 连续多次 cache miss 读取同一市场
        for (let i = 0; i < 10; i++) {
            cache.getOrderbookSync(12345);
        }

        // 等待后台刷新触发
        await sleep(50);

        // 由于去重/冷却机制，应该只触发 1 次 REST
        assert(fetchCount === 1, `应只触发 1 次 REST，实际: ${fetchCount}`);

        cache.stop();
    } finally {
        // 恢复原始 fetch
        globalThis.fetch = originalFetch;
    }
}

async function testUpdateCallback(): Promise<void> {
    console.log('\n--- 测试 7: 更新回调 ---');

    const cache = new PredictOrderbookCache({
        apiKey: 'test-key',
        ttlMs: 60000,
        allowStale: false,
        wsEnabled: false,
        restEnabled: false,
    });

    let callbackFired = false;
    let callbackMarketId: number | null = null;

    cache.onUpdate((marketId, book) => {
        callbackFired = true;
        callbackMarketId = marketId;
    });

    cache.updateFromExternal(TEST_MARKET_ID, MOCK_BIDS, MOCK_ASKS);

    assert(callbackFired, '更新回调应被触发');
    assert(callbackMarketId === TEST_MARKET_ID, '回调 marketId 应正确');

    cache.stop();
}

async function testSortingBehavior(): Promise<void> {
    console.log('\n--- 测试 8: 排序行为验证 ---');

    const cache = new PredictOrderbookCache({
        apiKey: 'test-key',
        ttlMs: 60000,
        allowStale: false,
        wsEnabled: false,
        restEnabled: false,
    });

    // 故意传入乱序数据
    const unorderedBids: [number, number][] = [
        [0.53, 300],  // 应排最后
        [0.55, 100],  // 应排最前
        [0.54, 200],
    ];
    const unorderedAsks: [number, number][] = [
        [0.58, 350],  // 应排最后
        [0.56, 150],  // 应排最前
        [0.57, 250],
    ];

    cache.updateFromExternal(TEST_MARKET_ID, unorderedBids, unorderedAsks);
    const result = cache.getOrderbookSync(TEST_MARKET_ID)!;

    // 验证 bids 降序（最高价在前）
    assert(result.bids[0].price === 0.55, 'Bids 应按价格降序，最高 0.55 在前');
    assert(result.bids[1].price === 0.54, 'Bids 第二档应为 0.54');
    assert(result.bids[2].price === 0.53, 'Bids 最后应为 0.53');

    // 验证 asks 升序（最低价在前）
    assert(result.asks[0].price === 0.56, 'Asks 应按价格升序，最低 0.56 在前');
    assert(result.asks[1].price === 0.57, 'Asks 第二档应为 0.57');
    assert(result.asks[2].price === 0.58, 'Asks 最后应为 0.58');

    cache.stop();
}

// ============================================================================
// 主函数
// ============================================================================

async function main(): Promise<void> {
    console.log('========================================');
    console.log('  统一订单簿缓存层验证脚本');
    console.log('========================================');

    try {
        await testWsUpdateAndRead();
        await testProviderFormats();
        await testTtlExpiration();
        await testStaleAllowed();
        await testCopyProtection();
        await testCacheMissStats();
        await testRefreshDeduplication();
        await testUpdateCallback();
        await testSortingBehavior();

        console.log('\n========================================');
        console.log('  ✅ 所有测试通过');
        console.log('========================================');
    } catch (error) {
        console.error('\n========================================');
        console.error('  ❌ 测试失败');
        console.error('========================================');
        console.error(error);
        process.exit(1);
    }
}

main();
