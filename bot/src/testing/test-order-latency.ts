/**
 * 订单状态延迟测试脚本
 *
 * 测试内容：
 * 1. Predict: API 响应延迟、链上事件监听延迟
 * 2. Polymarket: API 响应延迟、WebSocket User Channel
 *
 * 使用方法：
 * npx tsx src/testing/test-order-latency.ts [--predict | --polymarket | --all]
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载环境变量 (从项目根目录)
config({ path: resolve(__dirname, '../../../.env') });

// ============================================================================
// 配置
// ============================================================================

const PREDICT_API_BASE = 'https://api.predict.fun';
const POLYMARKET_CLOB_API = 'https://clob.polymarket.com';
const POLYMARKET_WS_MARKET = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const POLYMARKET_WS_USER = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

// RPC 节点
const BSC_RPC_LIST = [
    'https://bsc-dataseed1.binance.org',
    'https://bsc-dataseed2.binance.org',
    'https://bsc.publicnode.com',
];
const POLYGON_RPC_LIST = [
    'https://polygon-rpc.com',
    'https://polygon.llamarpc.com',
    'https://polygon-bor-rpc.publicnode.com',
];

// 合约地址
const PREDICT_CTF_EXCHANGE = '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689';
const POLYMARKET_CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

// OrderFilled 事件 ABI
const ORDER_FILLED_EVENT = 'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)';

// ============================================================================
// 工具函数
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatMs(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

async function measureLatency<T>(
    name: string,
    fn: () => Promise<T>
): Promise<{ result: T | null; latency: number; error?: string }> {
    const start = Date.now();
    try {
        const result = await fn();
        return { result, latency: Date.now() - start };
    } catch (e: any) {
        return { result: null, latency: Date.now() - start, error: e.message };
    }
}

// ============================================================================
// Predict 延迟测试
// ============================================================================

async function testPredictLatency(): Promise<void> {
    console.log('\n' + '='.repeat(70));
    console.log('📊 Predict (BSC) 延迟测试');
    console.log('='.repeat(70));

    const apiKey = process.env.PREDICT_API_KEY;

    // 1. API 基础延迟测试
    console.log('\n🌐 API 延迟测试:');

    // 测试市场列表 (只需要 API Key)
    if (apiKey) {
        const { latency: marketsLatency, error: marketsError } = await measureLatency(
            'markets',
            async () => {
                const res = await fetch(`${PREDICT_API_BASE}/v1/markets?first=1`, {
                    headers: { 'X-Api-Key': apiKey },
                });
                if (!res.ok) throw new Error(`${res.status}`);
                return res.json();
            }
        );
        console.log(`   GET /v1/markets: ${formatMs(marketsLatency)}${marketsError ? ` ❌ ${marketsError}` : ' ✅'}`);

        // 测试订单簿
        const { latency: bookLatency, error: bookError } = await measureLatency(
            'orderbook',
            async () => {
                const res = await fetch(`${PREDICT_API_BASE}/v1/markets/1/orderbook`, {
                    headers: { 'X-Api-Key': apiKey },
                });
                if (!res.ok) throw new Error(`${res.status}`);
                return res.json();
            }
        );
        console.log(`   GET /v1/markets/{id}/orderbook: ${formatMs(bookLatency)}${bookError ? ` ❌ ${bookError}` : ' ✅'}`);
    } else {
        console.log('   ⚠️ 缺少 PREDICT_API_KEY，跳过 API 测试');
    }

    // 2. 链上延迟测试
    console.log('\n⛓️ BSC 链上延迟测试:');

    for (const rpc of BSC_RPC_LIST) {
        const provider = new ethers.JsonRpcProvider(rpc);

        // 测试区块获取
        const { result: blockNumber, latency: blockLatency, error: blockError } = await measureLatency(
            'block',
            () => provider.getBlockNumber()
        );

        if (blockError) {
            console.log(`   ${rpc.split('/')[2]}: ❌ ${blockError.slice(0, 50)}`);
            continue;
        }

        console.log(`   ${rpc.split('/')[2]}:`);
        console.log(`     - 最新区块: ${blockNumber} (${formatMs(blockLatency)})`);

        // 测试事件查询 (减少范围避免限速)
        const contract = new ethers.Contract(PREDICT_CTF_EXCHANGE, [ORDER_FILLED_EVENT], provider);
        const { result: events, latency: eventLatency, error: eventError } = await measureLatency(
            'events',
            () => contract.queryFilter(
                contract.filters.OrderFilled(),
                blockNumber! - 10,
                blockNumber!
            )
        );

        if (eventError) {
            console.log(`     - 事件查询 (10 blocks): ❌ ${eventError.slice(0, 40)}`);
        } else {
            console.log(`     - 事件查询 (10 blocks): ${formatMs(eventLatency)}, ${events!.length} 个事件`);
        }

        // 只测试第一个成功的 RPC
        break;
    }

    // 3. 延迟对比总结
    console.log('\n📋 Predict 延迟总结:');
    console.log('   - BSC 出块时间: ~3 秒');
    console.log('   - API 订单状态获取: 5-11 秒 (实际观察)');
    console.log('   - 链上事件延迟: 出块后 + RPC 传播 ≈ 3-5 秒');
    console.log('   - 结论: 链上监听理论可行但需处理重组，API 延迟较高');
}

// ============================================================================
// Polymarket 延迟测试
// ============================================================================

interface PolyAuth {
    apiKey: string;
    secret: string;
    passphrase: string;
}

function buildPolyHeaders(
    auth: PolyAuth,
    method: string,
    path: string
): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method + path;
    const signature = createHmac('sha256', Buffer.from(auth.secret, 'base64'))
        .update(message)
        .digest('base64');

    return {
        'POLY_API_KEY': auth.apiKey,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': auth.passphrase,
    };
}

async function testPolymarketLatency(): Promise<void> {
    console.log('\n' + '='.repeat(70));
    console.log('📊 Polymarket (Polygon) 延迟测试');
    console.log('='.repeat(70));

    // 1. 公开 API 延迟测试
    console.log('\n🌐 公开 API 延迟测试:');

    // 市场列表
    const { result: markets, latency: marketsLatency } = await measureLatency(
        'markets',
        async () => {
            const res = await fetch(`${POLYMARKET_CLOB_API}/markets?limit=1`);
            if (!res.ok) throw new Error(`${res.status}`);
            return res.json() as Promise<any[]>;
        }
    );
    console.log(`   GET /markets: ${formatMs(marketsLatency)} ✅`);

    // 订单簿
    if (markets && markets.length > 0) {
        const tokenId = markets[0].tokens?.[0]?.token_id;
        if (tokenId) {
            const { latency: bookLatency } = await measureLatency(
                'book',
                async () => {
                    const res = await fetch(`${POLYMARKET_CLOB_API}/book?token_id=${tokenId}`);
                    if (!res.ok) throw new Error(`${res.status}`);
                    return res.json();
                }
            );
            console.log(`   GET /book: ${formatMs(bookLatency)} ✅`);
        }
    }

    // 2. 认证 API 测试
    const apiKey = process.env.POLYMARKET_API_KEY;
    const secret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_PASSPHRASE;

    if (apiKey && secret && passphrase) {
        console.log('\n🔐 认证 API 延迟测试:');
        const auth: PolyAuth = { apiKey, secret, passphrase };

        const { latency: ordersLatency, error: ordersError } = await measureLatency(
            'orders',
            async () => {
                const path = '/data/orders';
                const headers = buildPolyHeaders(auth, 'GET', path);
                const res = await fetch(`${POLYMARKET_CLOB_API}${path}`, { headers });
                if (!res.ok) throw new Error(`${res.status}`);
                return res.json();
            }
        );
        console.log(`   GET /data/orders: ${formatMs(ordersLatency)}${ordersError ? ` ⚠️ ${ordersError}` : ' ✅'}`);
    }

    // 3. WebSocket Market Channel 测试
    console.log('\n📡 WebSocket Market Channel 测试:');
    await testWebSocketChannel(POLYMARKET_WS_MARKET, 'market', markets?.[0]?.tokens?.[0]?.token_id);

    // 4. WebSocket User Channel 测试
    if (apiKey && secret && passphrase) {
        console.log('\n📡 WebSocket User Channel 测试:');
        await testWebSocketUserChannel({ apiKey, secret, passphrase });
    }

    // 5. 链上延迟测试
    console.log('\n⛓️ Polygon 链上延迟测试:');

    for (const rpc of POLYGON_RPC_LIST) {
        const provider = new ethers.JsonRpcProvider(rpc);

        const { result: blockNumber, latency: blockLatency, error: blockError } = await measureLatency(
            'block',
            () => provider.getBlockNumber()
        );

        if (blockError) {
            console.log(`   ${rpc.split('/')[2]}: ❌ ${blockError.slice(0, 50)}`);
            continue;
        }

        console.log(`   ${rpc.split('/')[2]}:`);
        console.log(`     - 最新区块: ${blockNumber} (${formatMs(blockLatency)})`);

        // 测试事件查询
        const contract = new ethers.Contract(POLYMARKET_CTF_EXCHANGE, [ORDER_FILLED_EVENT], provider);
        const { result: events, latency: eventLatency, error: eventError } = await measureLatency(
            'events',
            () => contract.queryFilter(
                contract.filters.OrderFilled(),
                blockNumber! - 5,
                blockNumber!
            )
        );

        if (eventError) {
            console.log(`     - 事件查询 (5 blocks): ❌ ${eventError.slice(0, 40)}`);
        } else {
            console.log(`     - 事件查询 (5 blocks): ${formatMs(eventLatency)}, ${events!.length} 个事件`);
        }

        break;
    }

    // 6. 延迟对比总结
    console.log('\n📋 Polymarket 延迟总结:');
    console.log('   - Polygon 出块时间: ~2 秒');
    console.log('   - API 订单状态获取: < 500ms');
    console.log('   - WebSocket Market Channel: 实时订单簿推送');
    console.log('   - WebSocket User Channel: 实时订单/成交推送 ⭐');
    console.log('   - 结论: User Channel 是最快的订单状态获取方式');
}

async function testWebSocketChannel(url: string, type: string, testAssetId?: string): Promise<void> {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const ws = new WebSocket(url);
        let messageCount = 0;

        const timeout = setTimeout(() => {
            console.log(`   ⏱️ 5秒内收到 ${messageCount} 条消息`);
            ws.close();
            resolve();
        }, 5000);

        ws.onopen = () => {
            const connectLatency = Date.now() - startTime;
            console.log(`   连接成功: ${formatMs(connectLatency)}`);

            if (testAssetId) {
                const msg = { type, assets_ids: [testAssetId] };
                ws.send(JSON.stringify(msg));
                console.log(`   已订阅: ${testAssetId.slice(0, 20)}...`);
            }
        };

        ws.onmessage = () => {
            messageCount++;
            if (messageCount === 1) {
                console.log(`   首条消息: ${formatMs(Date.now() - startTime)}`);
            }
        };

        ws.onerror = (err: any) => {
            console.log(`   ❌ 错误: ${err.message || 'unknown'}`);
        };

        ws.onclose = () => {
            clearTimeout(timeout);
            resolve();
        };
    });
}

async function testWebSocketUserChannel(auth: PolyAuth): Promise<void> {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const ws = new WebSocket(POLYMARKET_WS_USER);
        let subscribed = false;

        const timeout = setTimeout(() => {
            console.log(`   ⏱️ 10秒测试完成`);
            ws.close();
            resolve();
        }, 10000);

        ws.onopen = () => {
            const connectLatency = Date.now() - startTime;
            console.log(`   连接成功: ${formatMs(connectLatency)}`);

            // 发送订阅消息
            const subscribeMsg = {
                type: 'user',
                markets: [],
                auth: {
                    apiKey: auth.apiKey,
                    secret: auth.secret,
                    passphrase: auth.passphrase,
                },
            };
            ws.send(JSON.stringify(subscribeMsg));
            console.log(`   已发送订阅请求...`);
        };

        ws.onmessage = (event) => {
            const msgLatency = Date.now() - startTime;
            const data = event.data.toString();

            try {
                const parsed = JSON.parse(data);
                const eventType = parsed.event_type || parsed.type || 'unknown';

                if (eventType === 'error' || parsed.error) {
                    console.log(`   ❌ 错误 (${formatMs(msgLatency)}): ${parsed.message || data.slice(0, 80)}`);
                } else if (!subscribed) {
                    subscribed = true;
                    console.log(`   ✅ 订阅成功 (${formatMs(msgLatency)})`);
                    console.log(`   📊 等待订单更新推送... (无活跃订单时无消息是正常的)`);
                } else if (eventType === 'trade') {
                    console.log(`   📥 Trade: status=${parsed.status}, price=${parsed.price} (${formatMs(msgLatency)})`);
                } else if (eventType === 'order') {
                    console.log(`   📥 Order: ${parsed.type} (${formatMs(msgLatency)})`);
                }
            } catch {
                console.log(`   📥 原始消息 (${formatMs(msgLatency)}): ${data.slice(0, 60)}...`);
            }
        };

        ws.onerror = (err: any) => {
            console.log(`   ❌ WebSocket 错误: ${err.message || 'unknown'}`);
        };

        ws.onclose = (event) => {
            if (!subscribed) {
                console.log(`   关闭: code=${event.code}, reason=${event.reason || '(未订阅)'}`);
            }
            clearTimeout(timeout);
            resolve();
        };
    });
}

// ============================================================================
// 主函数
// ============================================================================

async function main(): Promise<void> {
    console.log('╔════════════════════════════════════════════════════════════════════╗');
    console.log('║               订单状态延迟测试工具 v1.1                             ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝');

    const args = process.argv.slice(2);
    const testAll = args.length === 0 || args.includes('--all');
    const testPredict = testAll || args.includes('--predict');
    const testPolymarket = testAll || args.includes('--polymarket');

    if (testPredict) {
        await testPredictLatency();
    }

    if (testPolymarket) {
        await testPolymarketLatency();
    }

    // 优化建议
    console.log('\n' + '='.repeat(70));
    console.log('💡 优化建议');
    console.log('='.repeat(70));
    console.log(`
┌─────────────────────────────────────────────────────────────────────┐
│ 当前瓶颈: Predict API 订单状态获取 5-11 秒                          │
├─────────────────────────────────────────────────────────────────────┤
│ 方案 1: 链上事件监听 (BSC)                                          │
│   - 优点: 理论延迟 3-5 秒 (出块时间 + RPC 传播)                      │
│   - 缺点: 需要处理区块重组，公共 RPC 有限速                          │
│   - 实现: ethers.js + contract.on('OrderFilled', ...)               │
├─────────────────────────────────────────────────────────────────────┤
│ 方案 2: 指数退避轮询                                                │
│   - 优点: 无需额外基础设施，立即可用                                │
│   - 实现: 100ms → 200ms → 500ms → 1000ms → 2000ms                   │
│   - 收益: 快速成交时延迟从 5s 降至 1-2s                             │
├─────────────────────────────────────────────────────────────────────┤
│ Polymarket 优化: WebSocket User Channel                             │
│   - 当前: API 轮询 150ms × 3 次 = 450ms                             │
│   - 优化: WS 实时推送，延迟 < 100ms                                 │
│   - 实现: 订阅 user channel，监听 trade 事件                        │
└─────────────────────────────────────────────────────────────────────┘
`);

    console.log('\n📚 参考文档:');
    console.log('   - Polymarket WebSocket: https://docs.polymarket.com/developers/CLOB/websocket/');
    console.log('   - BSC Explorer: https://bscscan.com/address/' + PREDICT_CTF_EXCHANGE);
    console.log('   - Polygon Explorer: https://polygonscan.com/address/' + POLYMARKET_CTF_EXCHANGE);
}

main().catch(console.error);
