/**
 * 列出活跃市场
 */

import * as fs from 'fs';
import * as path from 'path';

// 加载 .env
const envPath = path.join(process.cwd(), '..', '.env');
if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
        const match = line.trim().match(/^([^#=]+)=(.*)$/);
        if (match) process.env[match[1].trim()] = match[2].trim();
    }
}

const API_KEY = process.env.PREDICT_API_KEY!;

async function main() {
    console.log('API_KEY:', API_KEY ? API_KEY.slice(0, 10) + '...' : 'NOT SET');

    // 不过滤 active，获取所有市场
    const res = await fetch('https://api.predict.fun/v1/markets?limit=100', {
        headers: { 'x-api-key': API_KEY }
    });

    console.log('Response status:', res.status);

    if (!res.ok) {
        const text = await res.text();
        console.error('API Error:', text);
        return;
    }

    const data = await res.json() as { data: any[] };
    console.log('Markets count:', (data.data || []).length);

    console.log('市场列表 (前20个):\n');
    for (const m of (data.data || []).slice(0, 20)) {
        // 获取市场详情看真实状态
        const detailRes = await fetch(`https://api.predict.fun/v1/markets/${m.id}`, {
            headers: { 'x-api-key': API_KEY }
        });
        const detailData = await detailRes.json() as { data: any };
        const detail = detailData.data;

        const title = (m.title || '').slice(0, 40);
        const statusMark = detail.status === 'RESOLVED' ? '[已结算]' : (detail.status === 'ACTIVE' ? '[活跃]' : `[${detail.status}]`);
        console.log(`[${m.id}] ${statusMark} ${title}`);
        console.log(`    negRisk=${m.isNegRisk} yield=${m.isYieldBearing}`);
    }
}

main().catch(console.error);
