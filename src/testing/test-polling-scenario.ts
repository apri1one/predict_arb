/**
 * 实际轮询场景测试
 *
 * 模拟: 60 个市场, 1 秒轮询间隔, 持续 60 秒
 * 目标: 验证 1 秒间隔是否触发限流
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
    const envPath = join(process.cwd(), '.env');
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

// 有活跃 orderbook 的市场
const MARKET_IDS = [
    521, 696, 697, 705, 706, 785, 874, 878, 891, 897,
    905, 906, 925, 933, 957, 975, 985, 987, 988, 990,
    993, 1017, 1163, 1169, 1170, 1185, 1187, 1242, 1273, 1274,
    // 复制一份模拟 60 个市场
    889, 890, 892, 895, 521, 696, 697, 705, 706, 785,
    874, 878, 891, 897, 905, 906, 925, 933, 957, 975,
    985, 987, 988, 990, 993, 1017, 1163, 1169, 1170, 1185
];

interface Stats {
    success: number;
    fail: number;
    rateLimit: number;
    latencies: number[];
    errors: Map<number, number>;  // status code -> count
}

async function callOrderbook(apiKey: string, marketId: number): Promise<{ ok: boolean; status: number; latency: number }> {
    const start = Date.now();
    try {
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey }
        });
        return { ok: res.ok, status: res.status, latency: Date.now() - start };
    } catch {
        return { ok: false, status: 0, latency: Date.now() - start };
    }
}

async function main() {
    console.log('═'.repeat(60));
    console.log('  实际轮询场景测试');
    console.log('═'.repeat(60));

    const allKeys = getApiKeys();
    // 模拟：1个key用于全局扫描，2个key用于订单簿刷新
    const apiKeys = allKeys.slice(1, 3);  // 只用后 2 个 key
    console.log(`\n策略: 1 key 全局扫描 + 2 keys 订单簿刷新`);
    console.log(`全局扫描 key: ${allKeys[0]?.slice(0,4)}...`);
    console.log(`订单簿刷新 keys: ${apiKeys.map(k => k.slice(0,4) + '...').join(', ')}`);

    const MARKETS_COUNT = 30;  // 再减少市场数量
    const POLL_INTERVAL_MS = 1000;  // 1 秒
    const DURATION_SEC = 90;        // 90 秒
    const ROUNDS = Math.floor(DURATION_SEC * 1000 / POLL_INTERVAL_MS);  // 根据间隔计算轮数

    console.log(`\n配置:`);
    console.log(`  API Keys: ${apiKeys.length} 个`);
    console.log(`  市场数量: ${MARKETS_COUNT} 个`);
    console.log(`  轮询间隔: ${POLL_INTERVAL_MS}ms`);
    console.log(`  测试时长: ${DURATION_SEC}s`);
    console.log(`  预期调用: ${MARKETS_COUNT * ROUNDS} 次 (${MARKETS_COUNT * ROUNDS / DURATION_SEC * 60} RPM)`);

    if (apiKeys.length === 0) {
        console.error('❌ 未找到 API key');
        process.exit(1);
    }

    const stats: Stats = {
        success: 0,
        fail: 0,
        rateLimit: 0,
        latencies: [],
        errors: new Map()
    };

    const markets = MARKET_IDS.slice(0, MARKETS_COUNT);
    const startTime = Date.now();
    let keyIndex = 0;

    console.log(`\n开始测试...\n`);

    for (let round = 0; round < ROUNDS; round++) {
        const roundStart = Date.now();

        // 并发请求所有市场
        const promises = markets.map((marketId, idx) => {
            // 轮换使用 API keys
            const key = apiKeys[(keyIndex + idx) % apiKeys.length];
            return callOrderbook(key, marketId);
        });

        const results = await Promise.all(promises);

        // 统计
        for (const r of results) {
            stats.latencies.push(r.latency);
            if (r.ok) {
                stats.success++;
            } else if (r.status === 429) {
                stats.rateLimit++;
            } else {
                stats.fail++;
                stats.errors.set(r.status, (stats.errors.get(r.status) || 0) + 1);
            }
        }

        // 进度
        const elapsed = (Date.now() - startTime) / 1000;
        const currentRpm = stats.success / elapsed * 60;
        process.stdout.write(`\r  轮次 ${round + 1}/${ROUNDS} | 成功: ${stats.success} | 限流: ${stats.rateLimit} | 失败: ${stats.fail} | RPM: ${currentRpm.toFixed(0)}  `);

        // 如果触发大量限流，提前停止
        if (stats.rateLimit > 50) {
            console.log('\n\n⚠️ 检测到大量限流，提前停止测试');
            break;
        }

        // 等待下一轮
        keyIndex++;
        const roundDuration = Date.now() - roundStart;
        const waitTime = Math.max(0, POLL_INTERVAL_MS - roundDuration);
        if (waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    const totalElapsed = (Date.now() - startTime) / 1000;
    const avgLatency = stats.latencies.length > 0
        ? stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length
        : 0;
    const actualRpm = stats.success / totalElapsed * 60;

    console.log('\n\n' + '─'.repeat(60));
    console.log('  测试结果');
    console.log('─'.repeat(60));
    console.log(`\n耗时: ${totalElapsed.toFixed(1)}s`);
    console.log(`总调用: ${stats.success + stats.fail + stats.rateLimit}`);
    console.log(`成功: ${stats.success} (${(stats.success / (stats.success + stats.fail + stats.rateLimit) * 100).toFixed(1)}%)`);
    console.log(`失败: ${stats.fail}`);
    console.log(`限流 (429): ${stats.rateLimit}`);
    console.log(`实际 RPM: ${actualRpm.toFixed(1)}`);
    console.log(`平均延迟: ${avgLatency.toFixed(0)}ms`);

    if (stats.errors.size > 0) {
        console.log(`\n错误分布:`);
        for (const [status, count] of stats.errors) {
            console.log(`  HTTP ${status}: ${count} 次`);
        }
    }

    console.log('\n' + '═'.repeat(60));
    if (stats.rateLimit === 0) {
        console.log('✅ 1 秒轮询 60 个市场：无限流问题');
    } else if (stats.rateLimit < 10) {
        console.log('⚠️ 少量限流，可以考虑稍微降低频率');
    } else {
        console.log('❌ 大量限流，需要降低轮询频率或增加 API key');
    }
    console.log('═'.repeat(60));
}

main().catch(console.error);
