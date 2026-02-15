/**
 * 测试单 key 极限并发数
 * 目标：找出每个 key 同时发起多少请求不会触发限流
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
                if (!process.env[match[1].trim()]) {
                    process.env[match[1].trim()] = match[2].trim();
                }
            }
        }
    }
}

loadEnv();

function getApiKey(): string {
    return process.env['PREDICT_API_KEY_SCAN'] || process.env['PREDICT_API_KEY'] || '';
}

const MARKET_IDS = [889, 890, 892, 895, 874, 521, 696, 697, 705, 706];

async function fetchOrderbook(apiKey: string, marketId: number): Promise<{ ok: boolean; status: number; latency: number }> {
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

async function testConcurrency(concurrency: number, rounds: number): Promise<{ success: number; rateLimit: number; avgLatency: number }> {
    const apiKey = getApiKey();
    let success = 0;
    let rateLimit = 0;
    let totalLatency = 0;
    let count = 0;

    for (let round = 0; round < rounds; round++) {
        const promises = [];
        for (let i = 0; i < concurrency; i++) {
            const marketId = MARKET_IDS[i % MARKET_IDS.length];
            promises.push(fetchOrderbook(apiKey, marketId));
        }

        const results = await Promise.all(promises);

        for (const r of results) {
            totalLatency += r.latency;
            count++;
            if (r.ok) success++;
            else if (r.status === 429) rateLimit++;
        }

        // 短暂等待
        await new Promise(r => setTimeout(r, 100));
    }

    return {
        success,
        rateLimit,
        avgLatency: Math.round(totalLatency / count)
    };
}

async function main() {
    console.log('═'.repeat(60));
    console.log('  单 Key 极限并发测试');
    console.log('═'.repeat(60));

    const apiKey = getApiKey();
    if (!apiKey) {
        console.error('❌ 未找到 API key');
        process.exit(1);
    }
    console.log(`\nAPI Key: ${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`);

    const ROUNDS = 5;  // 每个并发度测试 5 轮

    const concurrencyLevels = [50, 60, 80, 100];

    console.log(`\n测试配置: 每个并发度 ${ROUNDS} 轮\n`);
    console.log('并发数 | 成功 | 限流 | 平均延迟');
    console.log('─'.repeat(40));

    for (const concurrency of concurrencyLevels) {
        const result = await testConcurrency(concurrency, ROUNDS);
        const total = ROUNDS * concurrency;
        const status = result.rateLimit > 0 ? '❌' : '✅';
        console.log(`${status} ${concurrency.toString().padStart(4)} | ${result.success.toString().padStart(4)}/${total} | ${result.rateLimit.toString().padStart(4)} | ${result.avgLatency}ms`);

        if (result.rateLimit > total * 0.1) {
            console.log(`\n⚠️ 并发 ${concurrency} 触发大量限流，停止测试`);
            break;
        }

        // 等待一段时间再测试下一个
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log('\n' + '═'.repeat(60));
    console.log('建议: 选择不触发限流的最大并发数');
    console.log('═'.repeat(60));
}

main().catch(console.error);
