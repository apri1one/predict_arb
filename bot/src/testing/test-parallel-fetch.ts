/**
 * 测试并发获取订单簿的实际耗时
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
    const envPath = join(__dirname, '..', '..', '..', '.env');
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

// 有效的市场 ID
const PREDICT_MARKET_IDS = [889, 890, 892, 895, 874, 521, 696, 697, 705, 706, 785, 878, 891, 897, 905, 906, 925, 933, 957, 975, 985, 987, 988, 990, 993, 1017, 1163, 1169, 1170, 1185, 1187, 1242, 1273, 1274, 1275, 1276, 1277, 1278, 1279, 1280, 1281, 1282, 1283, 1284, 1285];

// 测试 Polymarket token IDs (随机选几个)
const POLY_TOKEN_IDS = [
    '21742633143463906290569050155826241533067272736897614950488156847949938836455',
    '48331043336612883890938759509493159234755048973500640148014422747788308965732',
    '69236923620077691027083946871148646972011131466059644796654161903044970987404'
];

async function fetchPredictOrderbook(marketId: number, apiKey: string): Promise<number> {
    const start = Date.now();
    try {
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey }
        });
        await res.json();
        return Date.now() - start;
    } catch {
        return Date.now() - start;
    }
}

async function fetchPolymarketOrderbook(tokenId: string): Promise<number> {
    const start = Date.now();
    try {
        const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        await res.json();
        return Date.now() - start;
    } catch {
        return Date.now() - start;
    }
}

async function main() {
    console.log('═'.repeat(60));
    console.log('  并发获取订单簿耗时测试');
    console.log('═'.repeat(60));

    // 从环境变量获取 API key
    const apiKey = process.env['PREDICT_API_KEY'] || process.env['PREDICT_API_KEY_SCAN'] || '';
    if (!apiKey) {
        console.error('❌ 未找到 API key');
        process.exit(1);
    }

    const testCounts = [10, 20, 30, 45];

    for (const count of testCounts) {
        console.log(`\n测试 ${count} 个并发请求...`);

        // 测试 Predict API
        const predictStart = Date.now();
        const predictPromises = PREDICT_MARKET_IDS.slice(0, count).map(id =>
            fetchPredictOrderbook(id, apiKey)
        );
        const predictLatencies = await Promise.all(predictPromises);
        const predictTotal = Date.now() - predictStart;
        const predictAvg = predictLatencies.reduce((a, b) => a + b, 0) / predictLatencies.length;
        const predictMax = Math.max(...predictLatencies);

        console.log(`  Predict: 总耗时 ${predictTotal}ms, 平均单请求 ${predictAvg.toFixed(0)}ms, 最慢 ${predictMax}ms`);

        // 测试 Polymarket API
        const polyStart = Date.now();
        const polyPromises = [];
        for (let i = 0; i < count; i++) {
            polyPromises.push(fetchPolymarketOrderbook(POLY_TOKEN_IDS[i % POLY_TOKEN_IDS.length]));
        }
        const polyLatencies = await Promise.all(polyPromises);
        const polyTotal = Date.now() - polyStart;
        const polyAvg = polyLatencies.reduce((a, b) => a + b, 0) / polyLatencies.length;
        const polyMax = Math.max(...polyLatencies);

        console.log(`  Polymarket: 总耗时 ${polyTotal}ms, 平均单请求 ${polyAvg.toFixed(0)}ms, 最慢 ${polyMax}ms`);

        // 测试同时获取两个平台
        const bothStart = Date.now();
        const bothPromises = PREDICT_MARKET_IDS.slice(0, count).map((id, idx) =>
            Promise.all([
                fetchPredictOrderbook(id, apiKey),
                fetchPolymarketOrderbook(POLY_TOKEN_IDS[idx % POLY_TOKEN_IDS.length])
            ])
        );
        await Promise.all(bothPromises);
        const bothTotal = Date.now() - bothStart;

        console.log(`  双平台并发: 总耗时 ${bothTotal}ms`);

        // 等待 1 秒再测试下一个
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log('\n' + '═'.repeat(60));
}

main().catch(console.error);
