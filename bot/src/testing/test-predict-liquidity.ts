/**
 * 测试: Predict API 市场级 volume24h / liquidity 数据
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(import.meta.dirname, '../../../.env') });

const PREDICT_API = 'https://api.predict.fun';

async function test() {
    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) { console.log('No PREDICT_API_KEY'); process.exit(1); }

    // 1. 获取按 24h volume 排序的前 10 个市场
    console.log('=== Predict API 流动性数据测试 ===\n');
    const url = `${PREDICT_API}/v1/markets?status=OPEN&sort=VOLUME_24H_DESC&first=10`;
    console.log(`请求: ${url}\n`);

    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    if (!res.ok) {
        console.error(`请求失败: ${res.status} ${res.statusText}`);
        const body = await res.text();
        console.error('Body:', body.slice(0, 200));
        return;
    }

    const data = await res.json() as { data?: any[]; cursor?: string };
    const markets = data.data || [];
    console.log(`返回 ${markets.length} 个市场\n`);

    if (markets.length > 0) {
        // 打印样本市场的字段
        const sample = markets[0];
        console.log('--- 样本市场字段 ---');
        for (const key of Object.keys(sample)) {
            const val = sample[key];
            const display = typeof val === 'string' && val.length > 60
                ? val.slice(0, 60) + '...'
                : JSON.stringify(val);
            console.log(`  ${key}: ${display}`);
        }
    }

    // 2. 获取前 5 个市场的 stats
    console.log('\n=== Stats 测试 ===\n');
    console.log(`${'#'.padStart(3)} | ${'Vol/Liq'.padStart(8)} | ${'24h Vol'.padStart(12)} | ${'Liquidity'.padStart(12)} | Title`);
    console.log('-'.repeat(100));

    for (let i = 0; i < Math.min(5, markets.length); i++) {
        const m = markets[i];
        try {
            const statsRes = await fetch(`${PREDICT_API}/v1/markets/${m.id}/stats`, {
                headers: { 'x-api-key': apiKey },
            });
            if (!statsRes.ok) {
                console.log(`  #${i + 1} Stats 失败: ${statsRes.status} - ${m.title?.slice(0, 40)}`);
                continue;
            }
            const statsData = await statsRes.json() as any;
            const s = statsData.data;
            const vol24h = s.volume24hUsd ?? 0;
            const liq = s.totalLiquidityUsd ?? 0;
            const ratio = liq > 0 ? (vol24h / liq).toFixed(2) : 'N/A';
            console.log(
                `${String(i + 1).padStart(3)} | ` +
                `${String(ratio).padStart(8)} | ` +
                `$${formatNum(vol24h).padStart(11)} | ` +
                `$${formatNum(liq).padStart(11)} | ` +
                `${(m.title || '').slice(0, 50)}`
            );
        } catch (err: any) {
            console.log(`  #${i + 1} 异常: ${err?.message || err}`);
        }
    }

    console.log('\n完成');
}

function formatNum(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toFixed(0);
}

test().catch(console.error);
