/**
 * 检查所有市场状态
 */

import * as fs from 'fs';
import * as path from 'path';

// 加载 .env
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
        const match = line.trim().match(/^([^#=]+)=(.*)$/);
        if (match) process.env[match[1].trim()] = match[2].trim();
    }
}

const API_KEY = process.env.PREDICT_API_KEY!;

async function main() {
    console.log('获取所有市场...\n');

    const res = await fetch('https://api.predict.fun/v1/markets?limit=200', {
        headers: { 'x-api-key': API_KEY }
    });
    const data = await res.json() as { data: any[] };

    const statusCounts: Record<string, number> = {};
    const activeMarkets: any[] = [];

    for (const m of data.data || []) {
        // 获取市场详情
        const detailRes = await fetch(`https://api.predict.fun/v1/markets/${m.id}`, {
            headers: { 'x-api-key': API_KEY }
        });
        const detailData = await detailRes.json() as { data: any };
        const status = detailData.data?.status || 'UNKNOWN';

        statusCounts[status] = (statusCounts[status] || 0) + 1;

        if (status !== 'RESOLVED') {
            activeMarkets.push({
                id: m.id,
                title: m.title?.slice(0, 40),
                status: status,
                closed: detailData.data?.closed
            });
        }
    }

    console.log('状态统计:');
    for (const [status, count] of Object.entries(statusCounts)) {
        console.log(`  ${status}: ${count}`);
    }

    console.log('\n非 RESOLVED 市场:');
    if (activeMarkets.length === 0) {
        console.log('  (无)');
    } else {
        for (const m of activeMarkets) {
            console.log(`  [${m.id}] ${m.title} - ${m.status} closed=${m.closed}`);
        }
    }
}

main().catch(console.error);
