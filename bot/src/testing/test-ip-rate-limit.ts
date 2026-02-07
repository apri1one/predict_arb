/**
 * 测试同 IP 多 API Key 是否共享 Rate Limit
 *
 * 测试方法：
 * 1. 使用所有可用的 API Key 并发请求
 * 2. 逐步增加请求频率
 * 3. 观察是否在总请求量达到某个阈值时被限流
 */

import 'dotenv/config';

const API_BASE = 'https://api.predict.fun';
const TEST_MARKET_ID = 947;  // 用于测试的市场 ID

// 收集所有可用的 API Key
function collectApiKeys(): { key: string; name: string }[] {
    const keys: { key: string; name: string }[] = [];

    // 扫描 Keys
    const scanKey = process.env.PREDICT_API_KEY_SCAN;
    if (scanKey) keys.push({ key: scanKey, name: 'SCAN' });

    for (let i = 2; i <= 10; i++) {
        const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
        if (key) keys.push({ key, name: `SCAN_${i}` });
    }

    // 交易 Key
    const tradeKey = process.env.PREDICT_API_KEY_TRADE;
    if (tradeKey) keys.push({ key: tradeKey, name: 'TRADE' });

    // 通用 Key
    const generalKey = process.env.PREDICT_API_KEY;
    if (generalKey && !keys.some(k => k.key === generalKey)) {
        keys.push({ key: generalKey, name: 'GENERAL' });
    }

    return keys;
}

interface RequestResult {
    keyName: string;
    success: boolean;
    status: number;
    latency: number;
    timestamp: number;
}

async function makeRequest(key: string, keyName: string): Promise<RequestResult> {
    const start = Date.now();
    try {
        const res = await fetch(`${API_BASE}/v1/markets/${TEST_MARKET_ID}/orderbook`, {
            headers: { 'x-api-key': key },
        });
        return {
            keyName,
            success: res.ok,
            status: res.status,
            latency: Date.now() - start,
            timestamp: Date.now(),
        };
    } catch (err: any) {
        return {
            keyName,
            success: false,
            status: 0,
            latency: Date.now() - start,
            timestamp: Date.now(),
        };
    }
}

async function runTest() {
    const keys = collectApiKeys();
    console.log(`\n🔑 找到 ${keys.length} 个 API Key:\n`);
    keys.forEach(k => console.log(`   - ${k.name}: ${k.key.slice(0, 8)}...`));

    if (keys.length === 0) {
        console.error('❌ 未找到任何 API Key');
        process.exit(1);
    }

    // 测试参数
    const testDurationSec = 30;
    const targetRps = [4, 8, 12, 16, 20];  // 逐步增加 RPS

    console.log(`\n📊 测试计划: ${testDurationSec}s 每阶段, RPS 目标: ${targetRps.join(' → ')}\n`);
    console.log('=' .repeat(70));

    for (const rps of targetRps) {
        console.log(`\n🚀 测试 RPS=${rps} (${keys.length} Keys 并发)...\n`);

        const intervalMs = 1000 / rps;
        const results: RequestResult[] = [];
        const startTime = Date.now();
        let requestIndex = 0;

        // 运行测试
        while (Date.now() - startTime < testDurationSec * 1000) {
            const key = keys[requestIndex % keys.length];
            const result = await makeRequest(key.key, key.name);
            results.push(result);
            requestIndex++;

            // 控制请求频率
            const elapsed = Date.now() - startTime;
            const expectedRequests = Math.floor(elapsed / intervalMs);
            if (requestIndex > expectedRequests) {
                await new Promise(r => setTimeout(r, intervalMs - (elapsed % intervalMs)));
            }
        }

        // 统计结果
        const totalRequests = results.length;
        const successCount = results.filter(r => r.success).length;
        const rateLimitCount = results.filter(r => r.status === 429).length;
        const avgLatency = results.reduce((sum, r) => sum + r.latency, 0) / results.length;
        const actualRps = totalRequests / testDurationSec;

        // 按 Key 统计
        const keyStats = new Map<string, { success: number; fail: number; rateLimit: number }>();
        for (const r of results) {
            const stat = keyStats.get(r.keyName) || { success: 0, fail: 0, rateLimit: 0 };
            if (r.success) stat.success++;
            else if (r.status === 429) stat.rateLimit++;
            else stat.fail++;
            keyStats.set(r.keyName, stat);
        }

        console.log(`   总请求: ${totalRequests} | 成功: ${successCount} | 429: ${rateLimitCount} | 实际 RPS: ${actualRps.toFixed(1)}`);
        console.log(`   平均延迟: ${avgLatency.toFixed(0)}ms`);
        console.log(`   各 Key 统计:`);
        for (const [name, stat] of keyStats) {
            const total = stat.success + stat.fail + stat.rateLimit;
            console.log(`     ${name}: ${stat.success}/${total} 成功, ${stat.rateLimit} 限流`);
        }

        // 如果触发了大量限流，提前结束
        if (rateLimitCount > totalRequests * 0.3) {
            console.log(`\n⚠️  限流率超过 30%，停止测试`);
            break;
        }

        // 等待限流恢复
        console.log(`\n   等待 10s 恢复...`);
        await new Promise(r => setTimeout(r, 10000));
    }

    console.log('\n' + '=' .repeat(70));
    console.log('测试完成');
}

runTest().catch(console.error);
