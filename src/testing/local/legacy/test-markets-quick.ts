import * as fs from 'fs';
import * as path from 'path';

function loadEnv() {
    // .env 在项目根目录
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
        console.log('✅ 已加载 .env');
    } else {
        console.log('❌ 未找到 .env:', envPath);
    }
}

loadEnv();

const apiKey = process.env.PREDICT_API_KEY || '';

async function main() {
    let allMarkets = [];
    let cursor = null;
    let page = 0;

    // 获取前 5 页 (约 100 个市场)
    while (page < 5) {
        const url = cursor
            ? `https://api.predict.fun/v1/markets?first=20&after=${cursor}`
            : 'https://api.predict.fun/v1/markets?first=20';

        const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
        const data = await res.json() as any;

        if (!data.success || !data.data || data.data.length === 0) break;

        allMarkets.push(...data.data);
        cursor = data.cursor;
        page++;

        if (!cursor) break;
    }

    const data = { data: allMarkets };

    console.log('市场总数:', data.data?.length);
    console.log('\n统计:\n');

    let registered = 0;
    let withPolymarket = 0;
    let registeredWithPolymarket = 0;

    for (const m of (data.data || [])) {
        const hasPolymarket = m.polymarketConditionIds && m.polymarketConditionIds.length > 0;
        const isRegistered = m.status === 'REGISTERED';

        if (isRegistered) registered++;
        if (hasPolymarket) withPolymarket++;
        if (isRegistered && hasPolymarket) {
            registeredWithPolymarket++;
            console.log(`  ✅ ID:${m.id} ${m.title.substring(0, 50)}`);
        }
    }

    console.log(`\n总计:`);
    console.log(`  REGISTERED 状态: ${registered}`);
    console.log(`  有 Polymarket 链接: ${withPolymarket}`);
    console.log(`  REGISTERED + 有 Polymarket: ${registeredWithPolymarket}`);
}

main().catch(console.error);
