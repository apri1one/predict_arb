/**
 * 查找活跃市场用于测试
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
    console.log('搜索活跃市场...\n');

    // 获取最新的市场
    const res = await fetch('https://api.predict.fun/v1/markets?limit=100&sortBy=createdAt&sortOrder=desc', {
        headers: { 'x-api-key': API_KEY }
    });
    const data = await res.json() as { data: any[] };

    let found = false;
    for (const m of data.data || []) {
        // 获取市场详情
        const detailRes = await fetch(`https://api.predict.fun/v1/markets/${m.id}`, {
            headers: { 'x-api-key': API_KEY }
        });
        const detailData = await detailRes.json() as { data: any };
        const detail = detailData.data;

        if (detail.status === 'RESOLVED' || detail.closed) {
            continue;
        }

        // 获取订单簿
        const bookRes = await fetch(`https://api.predict.fun/v1/markets/${m.id}/orderbook`, {
            headers: { 'x-api-key': API_KEY }
        });
        const bookData = await bookRes.json() as { data: any };
        const book = bookData.data;

        const hasBids = book?.bids?.length > 0;
        const hasAsks = book?.asks?.length > 0;

        console.log(`[${m.id}] ${m.title?.slice(0, 50)}`);
        console.log(`  status=${detail.status} bids=${hasBids} asks=${hasAsks}`);

        if (hasBids || hasAsks) {
            console.log('\n=== 找到可用市场 ===');
            console.log('  ID:', m.id);
            console.log('  Title:', m.title);
            console.log('  Status:', detail.status);
            console.log('  isNegRisk:', detail.isNegRisk);
            console.log('  isYieldBearing:', detail.isYieldBearing);
            console.log('  feeRateBps:', detail.feeRateBps);
            console.log('  Best Bid:', book.bids?.[0] || 'none');
            console.log('  Best Ask:', book.asks?.[0] || 'none');
            found = true;
            break;
        }
    }

    if (!found) {
        console.log('\n没有找到有订单簿的活跃市场');
    }
}

main().catch(console.error);
