/**
 * 扫描所有 Predict 市场（不限于有交易的）
 */

import * as fs from 'fs';
import * as path from 'path';

// 加载 .env
function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

const PREDICT_API_KEY = process.env.PREDICT_API_KEY!;
const PREDICT_BASE_URL = 'https://api.predict.fun';

async function scanAllMarkets() {
    console.log('============================================================');
    console.log('   扫描所有 Predict 市场');
    console.log('============================================================\n');

    // 1. 获取所有市场（不限于有交易的）
    console.log('--- 1. 获取所有 Predict 市场 ---\n');

    const allMarkets: any[] = [];
    let cursor: string | null = null;
    let page = 0;

    do {
        const url = cursor
            ? `${PREDICT_BASE_URL}/v1/markets?first=50&after=${cursor}`
            : `${PREDICT_BASE_URL}/v1/markets?first=50`;

        const res = await fetch(url, {
            headers: { 'x-api-key': PREDICT_API_KEY }
        });

        const data = await res.json() as any;

        if (data.data && Array.isArray(data.data)) {
            allMarkets.push(...data.data);
            page++;
            console.log(`  第 ${page} 页: 获取 ${data.data.length} 个市场`);
        }

        cursor = data.cursor || null;

        // 限制最多10页，防止无限循环
        if (page >= 10) break;
    } while (cursor);

    console.log(`\n总计获取: ${allMarkets.length} 个市场\n`);

    // 2. 筛选有 Polymarket 关联的市场
    const linkedMarkets = allMarkets.filter(m =>
        m.polymarketConditionIds && m.polymarketConditionIds.length > 0
    );

    console.log(`--- 2. 有 Polymarket 关联的市场 ---\n`);
    console.log(`找到 ${linkedMarkets.length} 个市场\n`);

    linkedMarkets.forEach((m, i) => {
        console.log(`${i + 1}. ${m.title}`);
        console.log(`   ID: ${m.id}`);
        console.log(`   Status: ${m.status}`);
        console.log(`   Condition ID: ${m.polymarketConditionIds[0]}`);
        console.log();
    });

    // 3. 按状态分组
    const byStatus = linkedMarkets.reduce((acc, m) => {
        acc[m.status] = (acc[m.status] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    console.log('--- 3. 按状态分组 ---\n');
    Object.entries(byStatus).forEach(([status, count]) => {
        console.log(`  ${status}: ${count} 个`);
    });

    console.log('\n============================================================');
}

scanAllMarkets().catch(console.error);
