/**
 * 快速 API 测试 - 并发压力测试
 * 测试 3 个 key 的并发表现和错误类型
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

// 收集 API keys
function getApiKeys(): string[] {
    const keys: string[] = [];
    const primaryScanKey = process.env['PREDICT_API_KEY_SCAN'];
    if (primaryScanKey) keys.push(primaryScanKey);
    for (let i = 2; i <= 10; i++) {
        const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
        if (key) keys.push(key);
    }
    if (keys.length === 0) {
        const fallbackKey = process.env['PREDICT_API_KEY'];
        if (fallbackKey) keys.push(fallbackKey);
    }
    return keys;
}

interface CallResult {
    key: string;
    success: boolean;
    status: number;
    latency: number;
    error?: string;
}

// 单次 API 调用
async function callApi(apiKey: string, marketId: number): Promise<CallResult> {
    const start = Date.now();
    const keyShort = `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
    try {
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey }
        });
        const latency = Date.now() - start;
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { key: keyShort, success: false, status: res.status, latency, error: text.slice(0, 200) };
        }
        return { key: keyShort, success: true, status: res.status, latency };
    } catch (error: any) {
        const latency = Date.now() - start;
        return { key: keyShort, success: false, status: 0, latency, error: error.message };
    }
}

// 主测试
async function main() {
    console.log('═'.repeat(60));
    console.log('  快速 API 压力测试');
    console.log('═'.repeat(60));

    const apiKeys = getApiKeys();
    console.log(`\n🔑 发现 ${apiKeys.length} 个 API key`);

    if (apiKeys.length === 0) {
        console.error('❌ 未找到 API key');
        process.exit(1);
    }

    const marketIds = [889, 890, 892, 895, 874];  // 有 orderbook 的市场
    const CALLS_PER_KEY = 200;  // 每个 key 200 次调用
    const BATCH_SIZE = 40;      // 每批 40 个并发

    // 统计
    const stats = new Map<string, { success: number; fail: number; rateLimit: number; latencies: number[]; errors: string[] }>();
    for (const key of apiKeys) {
        const keyShort = `${key.slice(0, 4)}...${key.slice(-4)}`;
        stats.set(keyShort, { success: 0, fail: 0, rateLimit: 0, latencies: [], errors: [] });
    }

    console.log(`\n📊 测试配置: ${apiKeys.length} keys × ${CALLS_PER_KEY} calls = ${apiKeys.length * CALLS_PER_KEY} total`);
    console.log(`   并发批次大小: ${BATCH_SIZE}`);

    const startTime = Date.now();

    // 分批并发调用
    for (let batch = 0; batch < CALLS_PER_KEY / BATCH_SIZE; batch++) {
        const promises: Promise<CallResult>[] = [];

        for (let i = 0; i < BATCH_SIZE; i++) {
            const callIndex = batch * BATCH_SIZE + i;
            if (callIndex >= CALLS_PER_KEY) break;

            for (const key of apiKeys) {
                const marketId = marketIds[callIndex % marketIds.length];
                promises.push(callApi(key, marketId));
            }
        }

        const results = await Promise.all(promises);

        for (const result of results) {
            const stat = stats.get(result.key)!;
            stat.latencies.push(result.latency);

            if (result.success) {
                stat.success++;
            } else if (result.status === 429) {
                stat.rateLimit++;
            } else {
                stat.fail++;
                if (stat.errors.length < 5 && result.error) {
                    stat.errors.push(`HTTP ${result.status}: ${result.error}`);
                }
            }
        }

        // 进度
        const done = (batch + 1) * BATCH_SIZE * apiKeys.length;
        const total = CALLS_PER_KEY * apiKeys.length;
        process.stdout.write(`\r  进度: ${Math.min(done, total)}/${total}`);

        // 短暂等待避免瞬间压力过大
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    const elapsed = (Date.now() - startTime) / 1000;
    console.log('\n');

    // 统计结果
    console.log('─'.repeat(60));
    console.log('  测试结果');
    console.log('─'.repeat(60));

    let totalSuccess = 0;
    let totalFail = 0;
    let totalRateLimit = 0;

    for (const [keyShort, stat] of stats) {
        totalSuccess += stat.success;
        totalFail += stat.fail;
        totalRateLimit += stat.rateLimit;

        const avgLatency = stat.latencies.length > 0
            ? stat.latencies.reduce((a, b) => a + b, 0) / stat.latencies.length
            : 0;
        const rpm = stat.success / elapsed * 60;

        console.log(`\n📦 Key ${keyShort}:`);
        console.log(`   成功: ${stat.success} | 失败: ${stat.fail} | 限流: ${stat.rateLimit}`);
        console.log(`   RPM: ${rpm.toFixed(1)} | 平均延迟: ${avgLatency.toFixed(0)}ms`);

        if (stat.errors.length > 0) {
            console.log(`   错误样本:`);
            for (const err of stat.errors) {
                console.log(`     - ${err}`);
            }
        }
    }

    const totalRpm = totalSuccess / elapsed * 60;

    console.log('\n' + '═'.repeat(60));
    console.log('  总结');
    console.log('═'.repeat(60));
    console.log(`耗时: ${elapsed.toFixed(1)}s`);
    console.log(`总成功: ${totalSuccess} | 总失败: ${totalFail} | 总限流: ${totalRateLimit}`);
    console.log(`总 RPM: ${totalRpm.toFixed(1)} (${apiKeys.length} keys 合计)`);
    console.log(`单 key 平均 RPM: ${(totalRpm / apiKeys.length).toFixed(1)}`);

    if (totalRateLimit > 0) {
        console.log(`\n⚠️ 检测到限流！考虑降低调用频率`);
    } else if (totalFail > 0) {
        console.log(`\n⚠️ ${totalFail} 次失败但无限流，可能是网络/服务端问题`);
    } else {
        console.log(`\n✅ 全部成功，可以尝试提高并发`);
    }
}

main().catch(console.error);
