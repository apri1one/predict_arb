/**
 * 调试 API 返回数据
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PredictRestClient } from '../predict/rest-client.js';

// 加载 .env
function loadEnv(): void {
    try {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const envPath = join(__dirname, '..', '..', '..', '.env');
        const envContent = readFileSync(envPath, 'utf-8');

        for (const line of envContent.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const [key, ...valueParts] = trimmed.split('=');
                const value = valueParts.join('=').trim();
                if (key && value && !process.env[key]) {
                    process.env[key] = value;
                }
            }
        }
    } catch (e) {
        console.error('Failed to load .env:', e);
    }
}

loadEnv();

async function main() {
    const client = new PredictRestClient();

    console.log('API Key configured:', client.hasApiKey());

    // 获取所有 REGISTERED 市场
    const markets = await client.getMarkets({ status: 'REGISTERED', limit: 100 });
    console.log('Total REGISTERED markets:', markets.length);

    // 过滤有 Polymarket 关联的
    const linked = markets.filter(m => m.polymarketConditionIds && m.polymarketConditionIds.length > 0);
    console.log('Markets with Polymarket link:', linked.length);

    console.log('\n--- Linked Markets ---');
    for (const m of linked) {
        console.log(`  ID:${m.id} "${m.title}"`);
        console.log(`    Polymarket: ${m.polymarketConditionIds[0]?.slice(0, 30)}...`);
    }

    // 测试获取订单簿
    if (linked.length > 0) {
        const testMarket = linked[0];
        console.log(`\n--- Testing orderbook for market ${testMarket.id} ---`);
        try {
            const book = await client.getOrderBook(testMarket.id);
            console.log('Orderbook:', {
                marketId: book.marketId,
                bidsCount: book.bids.length,
                asksCount: book.asks.length,
                bestBid: book.bids[0],
                bestAsk: book.asks[0],
            });
        } catch (e) {
            console.error('Failed to get orderbook:', e);
        }
    }

    // 测试 Polymarket API
    if (linked.length > 0) {
        const conditionId = linked[0].polymarketConditionIds[0];
        console.log(`\n--- Testing Polymarket API for condition: ${conditionId?.slice(0, 30)}... ---`);
        try {
            const response = await fetch(
                `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`
            );
            const data = await response.json();
            console.log('Polymarket response:', JSON.stringify(data, null, 2).slice(0, 500));
        } catch (e) {
            console.error('Failed to fetch Polymarket:', e);
        }
    }
}

main().catch(console.error);
