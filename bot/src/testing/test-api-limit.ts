/**
 * Predict API 限流测试脚本
 *
 * 测试单个 API key 的请求速率极限
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// 加载项目根目录的 .env 文件
config({ path: resolve(import.meta.dirname, '../../../.env') });

const API_BASE_URL = 'https://api.predict.fun';
const API_KEY = process.env.PREDICT_API_KEY_SCAN || process.env.PREDICT_API_KEY;

if (!API_KEY) {
    console.error('❌ 未配置 PREDICT_API_KEY_SCAN 或 PREDICT_API_KEY');
    process.exit(1);
}

interface TestResult {
    timestamp: number;
    success: boolean;
    status: number;
    latencyMs: number;
    error?: string;
}

const results: TestResult[] = [];
let running = true;

// 统计数据
let totalRequests = 0;
let successCount = 0;
let rateLimitCount = 0;
let errorCount = 0;

/**
 * 发送单次 API 请求
 */
async function sendRequest(): Promise<TestResult> {
    const start = Date.now();
    try {
        const res = await fetch(`${API_BASE_URL}/v1/markets?limit=1`, {
            headers: { 'x-api-key': API_KEY! },
        });

        const latencyMs = Date.now() - start;
        const success = res.ok;

        return {
            timestamp: Date.now(),
            success,
            status: res.status,
            latencyMs,
            error: success ? undefined : `HTTP ${res.status}`,
        };
    } catch (error: any) {
        return {
            timestamp: Date.now(),
            success: false,
            status: 0,
            latencyMs: Date.now() - start,
            error: error.message,
        };
    }
}

/**
 * 并发测试 - 指定 RPS (每秒请求数)
 */
async function testRps(rps: number, durationSec: number): Promise<void> {
    console.log(`\n🔥 测试 ${rps} RPS，持续 ${durationSec} 秒...`);

    const intervalMs = 1000 / rps;
    const totalToSend = rps * durationSec;
    let sent = 0;

    const startTime = Date.now();
    const localResults: TestResult[] = [];

    // 使用 setInterval 保持稳定的请求频率
    await new Promise<void>((resolve) => {
        const timer = setInterval(async () => {
            if (sent >= totalToSend || !running) {
                clearInterval(timer);
                resolve();
                return;
            }

            sent++;
            totalRequests++;

            // 异步发送，不等待
            sendRequest().then(result => {
                localResults.push(result);
                results.push(result);

                if (result.success) {
                    successCount++;
                } else if (result.status === 429) {
                    rateLimitCount++;
                } else {
                    errorCount++;
                }
            });
        }, intervalMs);
    });

    // 等待所有请求完成
    await new Promise(r => setTimeout(r, 2000));

    // 统计本轮结果
    const elapsed = (Date.now() - startTime) / 1000;
    const localSuccess = localResults.filter(r => r.success).length;
    const localRateLimit = localResults.filter(r => r.status === 429).length;
    const localError = localResults.filter(r => !r.success && r.status !== 429).length;
    const avgLatency = localResults.length > 0
        ? (localResults.reduce((sum, r) => sum + r.latencyMs, 0) / localResults.length).toFixed(0)
        : 0;

    console.log(`  发送: ${sent}, 成功: ${localSuccess}, 429限流: ${localRateLimit}, 其他错误: ${localError}`);
    console.log(`  实际耗时: ${elapsed.toFixed(1)}s, 平均延迟: ${avgLatency}ms`);
    console.log(`  成功率: ${(localSuccess / sent * 100).toFixed(1)}%`);
}

/**
 * 递增测试 - 找到限流阈值
 */
async function findRateLimit(): Promise<void> {
    console.log('📊 Predict API 限流测试');
    console.log('='.repeat(60));
    console.log(`API Key: ${API_KEY!.slice(0, 8)}...${API_KEY!.slice(-4)}`);
    console.log('');

    // 先预热
    console.log('🔄 预热中...');
    for (let i = 0; i < 5; i++) {
        await sendRequest();
        await new Promise(r => setTimeout(r, 200));
    }

    // 递增测试 RPS
    const rpsLevels = [1, 2, 5, 10, 15, 20, 30, 40, 50, 60, 80, 100];

    for (const rps of rpsLevels) {
        if (!running) break;

        await testRps(rps, 10);  // 每个级别测试 10 秒

        // 如果 429 超过 30%，停止测试
        const recentResults = results.slice(-rps * 10);
        const recentRateLimit = recentResults.filter(r => r.status === 429).length;
        const rateLimitPct = recentRateLimit / recentResults.length * 100;

        if (rateLimitPct > 30) {
            console.log(`\n⚠️  429 比例超过 30%，停止测试`);
            break;
        }

        // 间隔休息，避免累积限流
        console.log('  休息 5 秒...');
        await new Promise(r => setTimeout(r, 5000));
    }

    // 最终统计
    console.log('\n' + '='.repeat(60));
    console.log('📊 最终统计:');
    console.log(`  总请求: ${totalRequests}`);
    console.log(`  成功: ${successCount} (${(successCount / totalRequests * 100).toFixed(1)}%)`);
    console.log(`  429 限流: ${rateLimitCount} (${(rateLimitCount / totalRequests * 100).toFixed(1)}%)`);
    console.log(`  其他错误: ${errorCount} (${(errorCount / totalRequests * 100).toFixed(1)}%)`);

    // 计算安全 RPS
    if (rateLimitCount > 0) {
        // 找到第一个出现 429 的 RPS 级别
        const firstRateLimitIdx = results.findIndex(r => r.status === 429);
        if (firstRateLimitIdx >= 0) {
            const firstRateLimitTime = results[firstRateLimitIdx].timestamp;
            const requestsBeforeLimit = results.filter(r => r.timestamp < firstRateLimitTime).length;
            console.log(`\n💡 建议:`);
            console.log(`  在出现首个 429 之前完成了约 ${requestsBeforeLimit} 个请求`);
        }
    }
}

/**
 * 持续压力测试 - 固定 RPS
 */
async function sustainedTest(rps: number, durationSec: number): Promise<void> {
    console.log('📊 Predict API 持续压力测试');
    console.log('='.repeat(60));
    console.log(`API Key: ${API_KEY!.slice(0, 8)}...${API_KEY!.slice(-4)}`);
    console.log(`目标 RPS: ${rps}, 持续时间: ${durationSec}s`);
    console.log('');

    await testRps(rps, durationSec);

    // 最终统计
    console.log('\n' + '='.repeat(60));
    console.log('📊 最终统计:');
    console.log(`  总请求: ${totalRequests}`);
    console.log(`  成功: ${successCount} (${(successCount / totalRequests * 100).toFixed(1)}%)`);
    console.log(`  429 限流: ${rateLimitCount} (${(rateLimitCount / totalRequests * 100).toFixed(1)}%)`);
    console.log(`  其他错误: ${errorCount} (${(errorCount / totalRequests * 100).toFixed(1)}%)`);
}

// 优雅退出
process.on('SIGINT', () => {
    console.log('\n\n⏹️  收到中断信号，正在停止...');
    running = false;
});

// 主函数
async function main() {
    const args = process.argv.slice(2);

    if (args[0] === 'sustained' && args[1]) {
        // 持续压力测试: npx tsx test-api-limit.ts sustained 10 60
        const rps = parseInt(args[1]) || 10;
        const duration = parseInt(args[2]) || 60;
        await sustainedTest(rps, duration);
    } else {
        // 默认: 递增测试找阈值
        await findRateLimit();
    }
}

main().catch(console.error);
