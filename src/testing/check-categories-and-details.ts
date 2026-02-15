/**
 * 检查分类和单个市场详情，寻找前端过滤线索
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

async function checkCategoriesAndDetails() {
    console.log('============================================================');
    console.log('   检查分类和市场详情');
    console.log('============================================================\n');

    // 1. 获取分类
    console.log('--- 1. 获取所有分类 ---\n');

    try {
        const catRes = await fetch(`${PREDICT_BASE_URL}/v1/categories`, {
            headers: { 'x-api-key': PREDICT_API_KEY }
        });

        const categories = await catRes.json();
        console.log(`找到 ${categories.length || 0} 个分类\n`);

        if (Array.isArray(categories) && categories.length > 0) {
            categories.forEach((cat: any, i: number) => {
                console.log(`${i + 1}. ${cat.name || cat.slug || JSON.stringify(cat)}`);
            });
        } else {
            console.log('无分类数据或格式异常');
            console.log(JSON.stringify(categories, null, 2).substring(0, 500));
        }
    } catch (error: any) {
        console.error('获取分类失败:', error.message);
    }

    console.log();

    // 2. 获取几个市场的详情，对比字段差异
    console.log('--- 2. 获取市场详情（有 Polymarket vs 无 Polymarket）---\n');

    // 获取有 Polymarket 关联的市场
    const marketsRes = await fetch(`${PREDICT_BASE_URL}/v1/markets?first=100`, {
        headers: { 'x-api-key': PREDICT_API_KEY }
    });

    const marketsData = await marketsRes.json() as any;
    const allMarkets = marketsData.data || [];
    const registeredMarkets = allMarkets.filter((m: any) => m.status === 'REGISTERED');

    const withPolymarket = registeredMarkets.filter((m: any) =>
        m.polymarketConditionIds?.length > 0
    );

    const withoutPolymarket = registeredMarkets.filter((m: any) =>
        !m.polymarketConditionIds || m.polymarketConditionIds.length === 0
    );

    console.log(`有 Polymarket: ${withPolymarket.length} 个`);
    console.log(`无 Polymarket: ${withoutPolymarket.length} 个\n`);

    // 获取详情对比
    const sampleWithPoly = withPolymarket[0];
    const sampleWithoutPoly = withoutPolymarket[0];

    if (sampleWithPoly) {
        console.log('有 Polymarket 的市场详情:');
        console.log(`  ID: ${sampleWithPoly.id}`);
        console.log(`  Title: ${sampleWithPoly.title}`);

        try {
            const detailRes = await fetch(`${PREDICT_BASE_URL}/v1/markets/${sampleWithPoly.id}`, {
                headers: { 'x-api-key': PREDICT_API_KEY }
            });

            const detail = await detailRes.json();
            console.log('  详情字段:', Object.keys(detail));
            console.log('  完整数据:');
            console.log(JSON.stringify(detail, null, 2).substring(0, 1000));
        } catch (error: any) {
            console.error('  获取详情失败:', error.message);
        }

        console.log();
    }

    if (sampleWithoutPoly) {
        console.log('无 Polymarket 的市场详情:');
        console.log(`  ID: ${sampleWithoutPoly.id}`);
        console.log(`  Title: ${sampleWithoutPoly.title}`);

        try {
            const detailRes = await fetch(`${PREDICT_BASE_URL}/v1/markets/${sampleWithoutPoly.id}`, {
                headers: { 'x-api-key': PREDICT_API_KEY }
            });

            const detail = await detailRes.json();
            console.log('  详情字段:', Object.keys(detail));
            console.log('  完整数据:');
            console.log(JSON.stringify(detail, null, 2).substring(0, 1000));
        } catch (error: any) {
            console.error('  获取详情失败:', error.message);
        }

        console.log();
    }

    // 3. 检查是否有其他 API 参数可以过滤
    console.log('--- 3. 测试不同的 API 参数 ---\n');

    const testParams = [
        { name: '无参数', url: `${PREDICT_BASE_URL}/v1/markets?first=100` },
        { name: 'status=REGISTERED', url: `${PREDICT_BASE_URL}/v1/markets?first=100&status=REGISTERED` },
        { name: 'featured=true', url: `${PREDICT_BASE_URL}/v1/markets?first=100&featured=true` },
        { name: 'active=true', url: `${PREDICT_BASE_URL}/v1/markets?first=100&active=true` }
    ];

    for (const test of testParams) {
        try {
            console.log(`测试: ${test.name}`);
            const res = await fetch(test.url, {
                headers: { 'x-api-key': PREDICT_API_KEY }
            });

            const data = await res.json() as any;
            const count = data.data?.length || 0;
            console.log(`  返回: ${count} 个市场`);

            if (count === 25 || count === 26 || count === 24) {
                console.log(`  ⚠️ 接近目标数量 25！`);
            }
        } catch (error: any) {
            console.error(`  错误: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log('\n============================================================');
}

checkCategoriesAndDetails().catch(console.error);
