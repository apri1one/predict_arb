/**
 * 使用 CLOB API 完整匹配所有 Predict-Polymarket 市场
 */

import * as fs from 'fs';
import * as path from 'path';

// 加载 .env
function loadEnv() {
    const envPath = path.join(process.cwd(), '..', '.env');
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

async function matchAllPolymarketMarkets() {
    console.log('============================================================');
    console.log('   使用 CLOB API 完整匹配 Predict-Polymarket 市场');
    console.log('============================================================\n');

    // 1. 获取所有 Predict 有 Polymarket 关联的市场
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
        }

        cursor = data.cursor || null;
        if (page >= 10) break;
    } while (cursor);

    const linkedMarkets = allMarkets.filter(m =>
        m.status === 'REGISTERED' &&
        m.polymarketConditionIds?.length > 0
    );

    console.log(`找到 ${linkedMarkets.length} 个有 Polymarket 关联的 REGISTERED 市场\n`);

    // 2. 通过 CLOB API 查询每个 conditionId
    console.log('--- 查询 Polymarket 市场数据 ---\n');

    const matched: any[] = [];
    const failed: any[] = [];

    for (const predictMarket of linkedMarkets) {
        const conditionId = predictMarket.polymarketConditionIds[0];

        try {
            const res = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);

            if (res.status === 200) {
                const polyMarket = await res.json();
                matched.push({
                    predictMarket,
                    polyMarket
                });
                console.log(`✅ ${predictMarket.title || predictMarket.question}`);
            } else {
                failed.push({
                    predictMarket,
                    error: `HTTP ${res.status}`
                });
                console.log(`❌ ${predictMarket.title || predictMarket.question} (HTTP ${res.status})`);
            }
        } catch (error: any) {
            failed.push({
                predictMarket,
                error: error.message
            });
            console.log(`❌ ${predictMarket.title || predictMarket.question} (错误: ${error.message})`);
        }

        // 避免请求过快
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\n成功匹配: ${matched.length} / ${linkedMarkets.length}\n`);

    // 3. 分析匹配结果
    console.log('--- 匹配详情 ---\n');

    matched.forEach((item, i) => {
        const p = item.predictMarket;
        const poly = item.polyMarket;

        console.log(`${i + 1}. ${p.title || p.question}`);
        console.log(`   Predict ID: ${p.id}`);
        console.log(`   Polymarket:`);
        console.log(`     - Question: ${poly.question || 'N/A'}`);
        console.log(`     - Condition ID: ${poly.condition_id || conditionId}`);
        console.log(`     - Active: ${poly.active}`);
        console.log(`     - Closed: ${poly.closed}`);
        console.log(`     - Accepting Orders: ${poly.accepting_orders}`);
        console.log();
    });

    if (failed.length > 0) {
        console.log('--- 匹配失败 ---\n');
        failed.forEach((item, i) => {
            console.log(`${i + 1}. ${item.predictMarket.title || item.predictMarket.question}`);
            console.log(`   错误: ${item.error}`);
            console.log();
        });
    }

    // 4. 保存结果到文件
    const output = {
        timestamp: new Date().toISOString(),
        summary: {
            total: linkedMarkets.length,
            matched: matched.length,
            failed: failed.length
        },
        matches: matched.map(item => ({
            predict: {
                id: item.predictMarket.id,
                title: item.predictMarket.title || item.predictMarket.question,
                question: item.predictMarket.question,
                conditionId: item.predictMarket.polymarketConditionIds[0]
            },
            polymarket: {
                question: item.polyMarket.question,
                conditionId: item.polyMarket.condition_id,
                active: item.polyMarket.active,
                closed: item.polyMarket.closed,
                acceptingOrders: item.polyMarket.accepting_orders
            }
        }))
    };

    const outputPath = path.join(process.cwd(), 'polymarket-match-result.json');
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

    console.log('============================================================');
    console.log(`结果已保存到: ${outputPath}`);
    console.log('============================================================');
}

matchAllPolymarketMarkets().catch(console.error);
