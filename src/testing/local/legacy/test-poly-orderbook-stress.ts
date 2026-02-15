/**
 * Polymarket 订单簿 API 压力测试
 *
 * 测试内容：
 * 1. 单次请求延迟
 * 2. 并发请求性能
 * 3. 高频请求限流测试
 */

const CLOB_BASE_URL = 'https://clob.polymarket.com';

// 测试用的 token IDs (从体育市场获取)
const TEST_TOKEN_IDS = [
    '25379891398898088982992aborede40725611537190774889572934651401540517980547',
    '91752867975433437658488350137632286578381516325821217851853543411203664390356',
    '10046461595843aborede7852227454429577819572816647991561816923847738',
    '58584522515744764974815478261412816928215612841954428615764978564',
];

interface TestResult {
    success: boolean;
    latency: number;
    error?: string;
}

async function fetchOrderBook(tokenId: string): Promise<TestResult> {
    const start = Date.now();
    try {
        const res = await fetch(`${CLOB_BASE_URL}/book?token_id=${tokenId}`);
        const latency = Date.now() - start;

        if (!res.ok) {
            return { success: false, latency, error: `HTTP ${res.status}` };
        }

        const data = await res.json();
        return { success: true, latency };
    } catch (error: any) {
        return { success: false, latency: Date.now() - start, error: error.message };
    }
}

async function testSingleRequests(tokenIds: string[], rounds: number): Promise<void> {
    console.log(`\n=== 单次请求测试 (${rounds} 轮) ===\n`);

    const allLatencies: number[] = [];
    let failures = 0;

    for (let i = 0; i < rounds; i++) {
        for (const tokenId of tokenIds) {
            const result = await fetchOrderBook(tokenId);
            if (result.success) {
                allLatencies.push(result.latency);
            } else {
                failures++;
                console.log(`  失败: ${result.error}`);
            }
        }
        process.stdout.write(`\r  进度: ${i + 1}/${rounds}`);
    }

    console.log('\n');

    if (allLatencies.length > 0) {
        allLatencies.sort((a, b) => a - b);
        const avg = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
        const p50 = allLatencies[Math.floor(allLatencies.length * 0.5)];
        const p95 = allLatencies[Math.floor(allLatencies.length * 0.95)];
        const p99 = allLatencies[Math.floor(allLatencies.length * 0.99)];

        console.log(`  总请求: ${allLatencies.length + failures}`);
        console.log(`  成功: ${allLatencies.length}, 失败: ${failures}`);
        console.log(`  延迟 - 平均: ${avg.toFixed(0)}ms, P50: ${p50}ms, P95: ${p95}ms, P99: ${p99}ms`);
    }
}

async function testConcurrent(tokenIds: string[], concurrency: number, rounds: number): Promise<void> {
    console.log(`\n=== 并发测试 (并发=${concurrency}, ${rounds} 轮) ===\n`);

    const allLatencies: number[] = [];
    let failures = 0;

    for (let i = 0; i < rounds; i++) {
        const start = Date.now();

        // 并发请求所有 token
        const promises = tokenIds.slice(0, concurrency).map(tokenId => fetchOrderBook(tokenId));
        const results = await Promise.all(promises);

        const roundLatency = Date.now() - start;

        for (const result of results) {
            if (result.success) {
                allLatencies.push(result.latency);
            } else {
                failures++;
            }
        }

        process.stdout.write(`\r  进度: ${i + 1}/${rounds} | 本轮耗时: ${roundLatency}ms`);
    }

    console.log('\n');

    if (allLatencies.length > 0) {
        allLatencies.sort((a, b) => a - b);
        const avg = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
        const p50 = allLatencies[Math.floor(allLatencies.length * 0.5)];
        const p95 = allLatencies[Math.floor(allLatencies.length * 0.95)];

        console.log(`  总请求: ${allLatencies.length + failures}`);
        console.log(`  成功: ${allLatencies.length}, 失败: ${failures}`);
        console.log(`  延迟 - 平均: ${avg.toFixed(0)}ms, P50: ${p50}ms, P95: ${p95}ms`);
    }
}

async function testHighFrequency(tokenId: string, intervalMs: number, durationSec: number): Promise<void> {
    console.log(`\n=== 高频测试 (间隔=${intervalMs}ms, 持续=${durationSec}秒) ===\n`);

    const results: TestResult[] = [];
    const endTime = Date.now() + durationSec * 1000;
    let requestCount = 0;

    while (Date.now() < endTime) {
        const result = await fetchOrderBook(tokenId);
        results.push(result);
        requestCount++;

        process.stdout.write(`\r  请求: ${requestCount} | 最新延迟: ${result.latency}ms | ${result.success ? '✓' : '✗'}`);

        await new Promise(r => setTimeout(r, intervalMs));
    }

    console.log('\n');

    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);

    if (successes.length > 0) {
        const latencies = successes.map(r => r.latency).sort((a, b) => a - b);
        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const p95 = latencies[Math.floor(latencies.length * 0.95)];

        console.log(`  总请求: ${results.length}`);
        console.log(`  成功: ${successes.length}, 失败: ${failures.length}`);
        console.log(`  成功率: ${(successes.length / results.length * 100).toFixed(1)}%`);
        console.log(`  延迟 - 平均: ${avg.toFixed(0)}ms, P95: ${p95}ms`);

        if (failures.length > 0) {
            const errorTypes = new Map<string, number>();
            for (const f of failures) {
                const err = f.error || 'unknown';
                errorTypes.set(err, (errorTypes.get(err) || 0) + 1);
            }
            console.log(`  错误类型:`, Object.fromEntries(errorTypes));
        }
    }
}

async function testBatchEndpoint(tokenIds: string[], rounds: number): Promise<void> {
    console.log(`\n=== 批量 API 测试 (/books endpoint, ${rounds} 轮) ===\n`);

    const allLatencies: number[] = [];
    let failures = 0;

    for (let i = 0; i < rounds; i++) {
        const start = Date.now();
        try {
            const res = await fetch(`${CLOB_BASE_URL}/books`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tokenIds),
            });
            const latency = Date.now() - start;

            if (res.ok) {
                allLatencies.push(latency);
            } else {
                failures++;
                console.log(`  失败: HTTP ${res.status}`);
            }
        } catch (error: any) {
            failures++;
            console.log(`  失败: ${error.message}`);
        }

        process.stdout.write(`\r  进度: ${i + 1}/${rounds}`);
    }

    console.log('\n');

    if (allLatencies.length > 0) {
        allLatencies.sort((a, b) => a - b);
        const avg = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
        const p95 = allLatencies[Math.floor(allLatencies.length * 0.95)];

        console.log(`  批量大小: ${tokenIds.length} tokens`);
        console.log(`  成功: ${allLatencies.length}, 失败: ${failures}`);
        console.log(`  延迟 - 平均: ${avg.toFixed(0)}ms, P95: ${p95}ms`);
        console.log(`  每 token 平均: ${(avg / tokenIds.length).toFixed(1)}ms`);
    }
}

async function main() {
    console.log('========================================');
    console.log('  Polymarket 订单簿 API 压力测试');
    console.log('========================================');

    // 先获取真实的 token IDs
    console.log('\n获取测试用 token IDs...');

    const tokenIds: string[] = [];
    try {
        const res = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&tag_id=745&sports_market_types=moneyline');
        const markets = await res.json() as any[];

        for (const m of markets) {
            try {
                const ids = JSON.parse(m.clobTokenIds || '[]');
                tokenIds.push(...ids);
            } catch {}
        }

        console.log(`获取到 ${tokenIds.length} 个 token IDs`);
    } catch (error) {
        console.log('获取失败，使用默认 token IDs');
        tokenIds.push(...TEST_TOKEN_IDS);
    }

    if (tokenIds.length === 0) {
        console.log('没有可用的 token IDs，退出');
        return;
    }

    const testTokens = tokenIds.slice(0, 32);  // 最多测试 32 个 (16 市场 × 2)

    // 1. 单次请求测试
    await testSingleRequests(testTokens.slice(0, 4), 10);

    // 2. 并发测试 (模拟 16 市场 × 2 token = 32 并发)
    await testConcurrent(testTokens, 32, 20);

    // 3. 高频测试 - 100ms 间隔 (10 req/s)
    await testHighFrequency(testTokens[0], 100, 10);

    // 4. 高频测试 - 50ms 间隔 (20 req/s)
    await testHighFrequency(testTokens[0], 50, 10);

    // 5. 批量 API 测试
    await testBatchEndpoint(testTokens, 20);

    // 6. 极限测试 - 无间隔并发
    console.log('\n=== 极限测试 (无间隔连续并发) ===\n');
    const extremeStart = Date.now();
    let extremeSuccess = 0;
    let extremeFail = 0;

    for (let i = 0; i < 100; i++) {
        const promises = testTokens.slice(0, 10).map(t => fetchOrderBook(t));
        const results = await Promise.all(promises);
        extremeSuccess += results.filter(r => r.success).length;
        extremeFail += results.filter(r => !r.success).length;
        process.stdout.write(`\r  请求: ${(i + 1) * 10} | 成功: ${extremeSuccess} | 失败: ${extremeFail}`);
    }

    const extremeDuration = (Date.now() - extremeStart) / 1000;
    console.log(`\n  总耗时: ${extremeDuration.toFixed(1)}s`);
    console.log(`  QPS: ${(1000 / extremeDuration).toFixed(1)} req/s`);
    console.log(`  成功率: ${(extremeSuccess / (extremeSuccess + extremeFail) * 100).toFixed(1)}%`);

    console.log('\n========================================');
    console.log('  测试完成');
    console.log('========================================\n');
}

main().catch(console.error);
