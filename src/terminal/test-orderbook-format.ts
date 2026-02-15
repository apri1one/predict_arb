/**
 * 测试 API 订单簿返回格式
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载 .env
function loadEnv() {
    const envPath = join(process.cwd(), '.env');
    if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                if (!process.env[key]) {
                    process.env[key] = value;
                }
            }
        }
    }
}

loadEnv();

const apiKey = process.env.PREDICT_API_KEY || '';

async function main() {
    console.log('=== 测试 Predict 订单簿格式 ===\n');

    try {
        const res = await fetch('https://api.predict.fun/v1/markets/441/orderbook', {
            headers: { 'x-api-key': apiKey }
        });
        const data = await res.json() as any;

        console.log('Predict API 完整响应:');
        console.log(JSON.stringify(data, null, 2).substring(0, 1500));
        console.log('\nPredict API 响应结构:');
        console.log('  data.data 存在:', !!data.data);
        console.log('  bids 类型:', Array.isArray(data.data?.bids) ? 'Array' : typeof data.data?.bids);
        console.log('  asks 类型:', Array.isArray(data.data?.asks) ? 'Array' : typeof data.data?.asks);

        if (data.data?.bids?.length > 0) {
            console.log('\n  bids[0] 完整内容:', JSON.stringify(data.data.bids[0]));
            console.log('  bids[0] 类型:', typeof data.data.bids[0]);
            console.log('  bids[0].price:', data.data.bids[0]?.price);
            console.log('  bids[0][0] (如果是数组):', data.data.bids[0]?.[0]);
        } else {
            console.log('\n  bids 为空');
        }

        if (data.data?.asks?.length > 0) {
            console.log('\n  asks[0] 完整内容:', JSON.stringify(data.data.asks[0]));
            console.log('  asks[0] 类型:', typeof data.data.asks[0]);
            console.log('  asks[0].price:', data.data.asks[0]?.price);
            console.log('  asks[0][0] (如果是数组):', data.data.asks[0]?.[0]);
        } else {
            console.log('\n  asks 为空');
        }
    } catch (e) {
        console.log('Predict API 错误:', e);
    }

    console.log('\n\n=== 测试 Polymarket 订单簿格式 ===\n');

    try {
        // 先获取 token
        const conditionId = '0xafc235557ace53ff0b0d2e93392314a7c3f3daab26a79050e985c11282f66df7';
        const marketRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
        const marketData = await marketRes.json() as any;

        console.log('Polymarket 市场完整响应:');
        console.log(JSON.stringify(marketData, null, 2).substring(0, 1500));
        console.log('\nPolymarket 市场信息:');
        console.log('  tokens 数量:', marketData.tokens?.length);

        if (marketData.tokens?.length > 0) {
            console.log('  token[0] (YES):', marketData.tokens[0]?.token_id?.substring(0, 20) + '...');
            console.log('  token[0] outcome:', marketData.tokens[0]?.outcome);

            if (marketData.tokens?.length > 1) {
                console.log('  token[1] (NO):', marketData.tokens[1]?.token_id?.substring(0, 20) + '...');
                console.log('  token[1] outcome:', marketData.tokens[1]?.outcome);
            }
        }

        const yesTokenId = marketData.tokens?.[0]?.token_id;
        if (yesTokenId) {
            const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${yesTokenId}`);
            const bookData = await bookRes.json() as any;

            console.log('\nPolymarket 订单簿:');
            console.log('  bids 数量:', bookData.bids?.length);
            console.log('  asks 数量:', bookData.asks?.length);

            if (bookData.bids?.length > 0) {
                console.log('\n  bids[0] 完整内容:', JSON.stringify(bookData.bids[0]));
                console.log('  bids[0].price:', bookData.bids[0]?.price);
            }

            if (bookData.asks?.length > 0) {
                console.log('\n  asks[0] 完整内容:', JSON.stringify(bookData.asks[0]));
                console.log('  asks[0].price:', bookData.asks[0]?.price);
            }
        }
    } catch (e) {
        console.log('Polymarket API 错误:', e);
    }
}

main();
