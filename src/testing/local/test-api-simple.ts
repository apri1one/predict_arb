/**
 * 简单 API 测试脚本
 * 测试 Predict 和 Polymarket API 连接
 */

import * as fs from 'fs';
import * as path from 'path';

// 手动加载 .env 文件
function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const match = trimmed.match(/^([^=]+)=(.*)$/);
                if (match) {
                    process.env[match[1].trim()] = match[2].trim();
                }
            }
        }
        console.log('✓ 已加载 .env 文件');
    } else {
        console.log('⚠ .env 文件未找到');
    }
}

loadEnv();

async function testPredictAPI() {
    console.log('\n' + '='.repeat(60));
    console.log('测试 Predict.fun API');
    console.log('='.repeat(60));

    const apiKey = process.env.PREDICT_API_KEY;
    const baseUrl = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';

    console.log(`\nAPI Base URL: ${baseUrl}`);
    console.log(`API Key: ${apiKey ? '已配置 (' + apiKey.slice(0, 10) + '...)' : '未配置'}`);

    if (!apiKey) {
        console.log('\n❌ 错误: PREDICT_API_KEY 未设置');
        return;
    }

    // Test 1: 获取市场列表
    console.log('\n[测试 1] 获取市场列表...');
    try {
        const startTime = Date.now();
        const res = await fetch(`${baseUrl}/v1/markets?first=20&status=ACTIVE`, {
            headers: { 'x-api-key': apiKey }
        });
        const latency = Date.now() - startTime;

        if (!res.ok) {
            const text = await res.text();
            console.log(`  ❌ HTTP ${res.status}: ${text}`);
            return;
        }

        const data = await res.json() as { data?: any[] };
        const markets = data.data || [];
        console.log(`  ✓ 获取成功 (延迟: ${latency}ms)`);
        console.log(`  ✓ 找到 ${markets.length} 个活跃市场`);

        if (markets.length > 0) {
            console.log('\n  前 5 个市场:');
            for (let i = 0; i < Math.min(5, markets.length); i++) {
                const m = markets[i];
                console.log(`  [${i + 1}] ID: ${m.id}`);
                console.log(`      标题: ${m.title?.slice(0, 50)}${m.title?.length > 50 ? '...' : ''}`);
                console.log(`      状态: ${m.status}`);
                console.log(`      Volume: $${(m.volume || 0).toLocaleString()}`);
                if (m.outcomes) {
                    console.log(`      结果数: ${m.outcomes.length}`);
                }
            }

            // Test 2: 获取订单簿
            const testMarket = markets[0];
            console.log(`\n[测试 2] 获取订单簿 (市场ID: ${testMarket.id})...`);
            try {
                const obStart = Date.now();
                const obRes = await fetch(`${baseUrl}/v1/markets/${testMarket.id}/orderbook`, {
                    headers: { 'x-api-key': apiKey }
                });
                const obLatency = Date.now() - obStart;

                if (!obRes.ok) {
                    const text = await obRes.text();
                    console.log(`  ❌ HTTP ${obRes.status}: ${text}`);
                } else {
                    const obData = await obRes.json() as {
                        bids?: [number, number][];
                        asks?: [number, number][];
                        updatedAt?: string;
                    };
                    console.log(`  ✓ 获取成功 (延迟: ${obLatency}ms)`);
                    console.log(`    Bids: ${obData.bids?.length || 0} 层`);
                    console.log(`    Asks: ${obData.asks?.length || 0} 层`);
                    if (obData.bids && obData.bids.length > 0) {
                        console.log(`    最佳 Bid: ${obData.bids[0][0]} @ ${obData.bids[0][1]}`);
                    }
                    if (obData.asks && obData.asks.length > 0) {
                        console.log(`    最佳 Ask: ${obData.asks[0][0]} @ ${obData.asks[0][1]}`);
                    }
                }
            } catch (error) {
                console.log(`  ❌ 订单簿获取失败: ${error}`);
            }
        }
    } catch (error) {
        console.log(`  ❌ 失败: ${error}`);
    }
}

async function testPolymarketAPI() {
    console.log('\n' + '='.repeat(60));
    console.log('测试 Polymarket API');
    console.log('='.repeat(60));

    const clobUrl = process.env.POLYMARKET_CLOB_BASE_URL || 'https://clob.polymarket.com';
    const gammaUrl = process.env.POLYMARKET_GAMMA_API_BASE_URL || 'https://gamma-api.polymarket.com';

    console.log(`\nCLOB Base URL: ${clobUrl}`);
    console.log(`Gamma API URL: ${gammaUrl}`);

    // Test 1: 获取市场列表 (Gamma API)
    console.log('\n[测试 1] 获取市场列表 (Gamma API)...');
    let markets: any[] = [];
    try {
        const startTime = Date.now();
        const res = await fetch(`${gammaUrl}/markets?active=true&closed=false&limit=20`);
        const latency = Date.now() - startTime;

        if (!res.ok) {
            const text = await res.text();
            console.log(`  ❌ HTTP ${res.status}: ${text}`);
        } else {
            markets = await res.json() as any[];
            console.log(`  ✓ 获取成功 (延迟: ${latency}ms)`);
            console.log(`  ✓ 找到 ${markets.length} 个市场`);

            // 过滤有效市场
            const validMarkets = markets.filter((m: any) =>
                m.clobTokenIds && m.clobTokenIds !== '[]' && m.clobTokenIds !== 'null'
            );
            console.log(`  ✓ ${validMarkets.length} 个市场有 CLOB Token ID`);

            if (validMarkets.length > 0) {
                console.log('\n  前 5 个市场:');
                for (let i = 0; i < Math.min(5, validMarkets.length); i++) {
                    const m = validMarkets[i];
                    console.log(`  [${i + 1}] 问题: ${m.question?.slice(0, 50)}...`);
                    console.log(`      Volume: $${((m.volumeNum || 0) / 1_000_000).toFixed(2)}M`);
                    console.log(`      Token IDs: ${m.clobTokenIds?.slice(0, 50)}...`);
                }
                markets = validMarkets;
            }
        }
    } catch (error) {
        console.log(`  ❌ 失败: ${error}`);
    }

    // Test 2: 获取订单簿 (CLOB API)
    if (markets.length > 0) {
        const testMarket = markets[0];
        let tokenId: string | null = null;

        try {
            const tokenIds = JSON.parse(testMarket.clobTokenIds);
            if (tokenIds && tokenIds.length > 0) {
                tokenId = tokenIds[0];
            }
        } catch (e) {
            console.log('  ⚠ 无法解析 Token ID');
        }

        if (tokenId) {
            console.log(`\n[测试 2] 获取订单簿 (Token: ${tokenId.slice(0, 30)}...)...`);
            try {
                const startTime = Date.now();
                const res = await fetch(`${clobUrl}/book?token_id=${tokenId}`);
                const latency = Date.now() - startTime;

                if (!res.ok) {
                    const text = await res.text();
                    console.log(`  ❌ HTTP ${res.status}: ${text}`);
                } else {
                    const book = await res.json() as {
                        bids?: { price: string; size: string }[];
                        asks?: { price: string; size: string }[];
                    };
                    console.log(`  ✓ 获取成功 (延迟: ${latency}ms)`);
                    console.log(`    Bids: ${book.bids?.length || 0} 层`);
                    console.log(`    Asks: ${book.asks?.length || 0} 层`);
                    if (book.bids && book.bids.length > 0) {
                        console.log(`    最佳 Bid: ${book.bids[0].price} @ ${book.bids[0].size}`);
                    }
                    if (book.asks && book.asks.length > 0) {
                        console.log(`    最佳 Ask: ${book.asks[0].price} @ ${book.asks[0].size}`);
                    }
                }
            } catch (error) {
                console.log(`  ❌ 失败: ${error}`);
            }
        }
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('API 连接测试');
    console.log('时间:', new Date().toLocaleString('zh-CN'));
    console.log('='.repeat(60));

    await testPredictAPI();
    await testPolymarketAPI();

    console.log('\n' + '='.repeat(60));
    console.log('测试完成');
    console.log('='.repeat(60));
}

main().catch(console.error);
