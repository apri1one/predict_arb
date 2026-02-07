/**
 * Predict API 限流测试脚本
 *
 * 测试目标:
 * 1. 验证官方文档的 240 次/分钟限制
 * 2. 测试 3 个 API key 的独立限制
 * 3. 测试并发调用的效果
 *
 * 用法: npx tsx src/testing/test-api-rate-limit.ts
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载 .env
function loadEnv() {
    const envPath = join(__dirname, '..', '..', '..', '.env');
    if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                if (!process.env[key]) {
                    process.env[key] = value;
                }
            }
        }
    }
}

loadEnv();

// 收集所有 API keys
function getApiKeys(): string[] {
    const keys: string[] = [];

    // 优先使用扫描专用 key
    const primaryScanKey = process.env['PREDICT_API_KEY_SCAN'];
    if (primaryScanKey) keys.push(primaryScanKey);

    for (let i = 2; i <= 10; i++) {
        const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
        if (key) keys.push(key);
    }

    // 回退到主 key
    if (keys.length === 0) {
        const fallbackKey = process.env['PREDICT_API_KEY'];
        if (fallbackKey) keys.push(fallbackKey);
    }

    return keys;
}

// API 调用统计
interface KeyStats {
    key: string;
    keyShort: string;
    successCount: number;
    failCount: number;
    rateLimitCount: number;
    totalLatency: number;
    errors: string[];
}

// 测试单个 API 调用
async function callApi(apiKey: string, marketId: number): Promise<{ success: boolean; status: number; latency: number; error?: string }> {
    const start = Date.now();
    try {
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey }
        });
        const latency = Date.now() - start;
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { success: false, status: res.status, latency, error: text.slice(0, 100) };
        }
        return { success: res.ok, status: res.status, latency };
    } catch (error: any) {
        const latency = Date.now() - start;
        return { success: false, status: 0, latency, error: error.message };
    }
}

// 测试单个 key 的限流
async function testSingleKeyLimit(apiKey: string, targetRpm: number, durationSec: number): Promise<KeyStats> {
    const keyShort = `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
    const stats: KeyStats = {
        key: apiKey,
        keyShort,
        successCount: 0,
        failCount: 0,
        rateLimitCount: 0,
        totalLatency: 0,
        errors: [],
    };

    const marketIds = [289, 290, 291, 292, 293]; // 测试用的市场 ID
    const intervalMs = (60 * 1000) / targetRpm; // 每次调用间隔
    const totalCalls = Math.floor((durationSec * 1000) / intervalMs);

    console.log(`\n📊 测试 Key ${keyShort}: 目标 ${targetRpm} RPM, 持续 ${durationSec}s, 预计 ${totalCalls} 次调用`);

    const startTime = Date.now();

    for (let i = 0; i < totalCalls; i++) {
        const marketId = marketIds[i % marketIds.length];
        const result = await callApi(apiKey, marketId);

        stats.totalLatency += result.latency;

        if (result.success) {
            stats.successCount++;
        } else if (result.status === 429) {
            stats.rateLimitCount++;
            if (stats.rateLimitCount <= 3) {
                console.log(`  ⚠️ Rate limit hit at call #${i + 1}`);
            }
        } else {
            stats.failCount++;
            if (stats.errors.length < 10) {
                stats.errors.push(`HTTP ${result.status}: ${result.error || 'unknown'}`);
            }
        }

        // 实时进度 (每 50 次)
        if ((i + 1) % 50 === 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rpm = stats.successCount / elapsed * 60;
            console.log(`  Progress: ${i + 1}/${totalCalls} | Success: ${stats.successCount} | RateLimit: ${stats.rateLimitCount} | RPM: ${rpm.toFixed(1)}`);
        }

        // 等待间隔
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const actualRpm = stats.successCount / elapsed * 60;
    const avgLatency = stats.totalLatency / (stats.successCount + stats.failCount + stats.rateLimitCount);

    console.log(`\n✅ Key ${keyShort} 测试完成:`);
    console.log(`   成功: ${stats.successCount} | 失败: ${stats.failCount} | 限流: ${stats.rateLimitCount}`);
    console.log(`   实际 RPM: ${actualRpm.toFixed(1)} | 平均延迟: ${avgLatency.toFixed(0)}ms`);

    return stats;
}

// 测试多个 key 并发
async function testMultiKeyParallel(apiKeys: string[], callsPerKey: number): Promise<void> {
    console.log(`\n🔥 并发测试: ${apiKeys.length} 个 key, 每个 ${callsPerKey} 次调用`);

    const marketIds = [289, 290, 291, 292, 293];
    const results: Map<string, { success: number; rateLimit: number; fail: number }> = new Map();

    // 初始化统计
    for (const key of apiKeys) {
        results.set(key, { success: 0, rateLimit: 0, fail: 0 });
    }

    const startTime = Date.now();

    // 并发调用所有 key
    const promises: Promise<void>[] = [];

    for (let i = 0; i < callsPerKey; i++) {
        for (const apiKey of apiKeys) {
            const marketId = marketIds[i % marketIds.length];
            const promise = callApi(apiKey, marketId).then(result => {
                const stat = results.get(apiKey)!;
                if (result.success) stat.success++;
                else if (result.status === 429) stat.rateLimit++;
                else stat.fail++;
            });
            promises.push(promise);
        }

        // 批量等待，避免瞬间发送太多
        if (promises.length >= apiKeys.length * 10) {
            await Promise.all(promises);
            promises.length = 0;

            // 短暂等待
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    // 等待剩余
    await Promise.all(promises);

    const elapsed = (Date.now() - startTime) / 1000;
    const totalSuccess = Array.from(results.values()).reduce((sum, s) => sum + s.success, 0);
    const totalRpm = totalSuccess / elapsed * 60;

    console.log(`\n📈 并发测试结果 (${elapsed.toFixed(1)}s):`);
    console.log(`   总 RPM: ${totalRpm.toFixed(1)} (${apiKeys.length} keys combined)`);

    for (const [key, stat] of results) {
        const keyShort = `${key.slice(0, 4)}...${key.slice(-4)}`;
        const keyRpm = stat.success / elapsed * 60;
        console.log(`   ${keyShort}: 成功=${stat.success}, 限流=${stat.rateLimit}, 失败=${stat.fail}, RPM=${keyRpm.toFixed(1)}`);
    }
}

// 主测试流程
async function main() {
    console.log('═'.repeat(60));
    console.log('  Predict API 限流测试');
    console.log('═'.repeat(60));

    const apiKeys = getApiKeys();
    console.log(`\n🔑 发现 ${apiKeys.length} 个 API key:`);
    for (const key of apiKeys) {
        console.log(`   - ${key.slice(0, 4)}...${key.slice(-4)}`);
    }

    if (apiKeys.length === 0) {
        console.error('\n❌ 未找到 API key，请检查 .env 配置');
        process.exit(1);
    }

    // 测试 1: 单个 key 的限制 (目标 300 RPM，测试 30 秒)
    console.log('\n' + '─'.repeat(60));
    console.log('测试 1: 单 Key 限流测试 (目标 300 RPM)');
    console.log('─'.repeat(60));

    const singleKeyStats = await testSingleKeyLimit(apiKeys[0], 300, 30);

    // 测试 2: 多 key 串行测试
    if (apiKeys.length > 1) {
        console.log('\n' + '─'.repeat(60));
        console.log('测试 2: 多 Key 独立限流测试');
        console.log('─'.repeat(60));

        for (let i = 1; i < Math.min(apiKeys.length, 3); i++) {
            await testSingleKeyLimit(apiKeys[i], 250, 20);
        }
    }

    // 测试 3: 并发测试
    console.log('\n' + '─'.repeat(60));
    console.log('测试 3: 多 Key 并发测试');
    console.log('─'.repeat(60));

    await testMultiKeyParallel(apiKeys.slice(0, 3), 100);

    // 总结
    console.log('\n' + '═'.repeat(60));
    console.log('  测试总结');
    console.log('═'.repeat(60));
    console.log(`
建议:
- 如果单 key 限流在 ~240 RPM，则官方限制准确
- 如果多 key 并发总 RPM 接近 ${apiKeys.length} × 240 = ${apiKeys.length * 240}，则 key 独立计费
- 根据测试结果调整扫描间隔和并发度
`);
}

main().catch(console.error);
