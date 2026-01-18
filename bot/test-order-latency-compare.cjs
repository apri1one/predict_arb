/**
 * 下单延迟对比测试
 *
 * 对比以下渠道的订单状态通知延迟:
 * 1. Predict 官方 WebSocket (predictWalletEvents/{jwt})
 * 2. BSC WSS (链上 OrderFilled 事件)
 * 3. REST API 轮询
 *
 * 测试方法:
 * 1. 找一个有活跃订单簿的市场
 * 2. 以卖一价下一个小额买单 (确保立即成交)
 * 3. 记录各渠道收到通知的时间
 *
 * 用法:
 *   node test-order-latency-compare.cjs [marketId]
 */

require('dotenv').config({ path: '../.env' });
const WebSocket = require('ws');
const { ethers } = require('ethers');

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.PREDICT_API_KEY;
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY;

const API_BASE = 'https://api.predict.fun';
const WS_URL = 'wss://ws.predict.fun/ws';
const BSC_WSS_URL = 'wss://bsc-rpc.publicnode.com';

// OrderFilled 事件签名
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';

// Exchange 地址
const EXCHANGES = [
    '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
    '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
    '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
    '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
].map(a => a.toLowerCase());

// ============================================================================
// 工具函数
// ============================================================================

async function fetchJson(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            ...options.headers,
        },
    });
    return res.json();
}

async function findActiveMarket() {
    console.log('查找有活跃订单簿的市场...');

    // 获取最近成交
    const matches = await fetchJson(`${API_BASE}/v1/orders/matches?limit=20`);
    const marketIds = [...new Set(matches.data?.map(m => m.market?.id).filter(Boolean))];

    for (const id of marketIds.slice(0, 10)) {
        const ob = await fetchJson(`${API_BASE}/v1/markets/${id}/orderbook`);
        if (ob.data?.asks?.length > 0) {
            const market = await fetchJson(`${API_BASE}/v1/markets/${id}`);
            const askPrice = ob.data.asks[0][0];
            const askSize = ob.data.asks[0][1];

            // 计算最小下单量 (需要 > $1)
            const minQty = Math.ceil(1.1 / askPrice);

            if (askSize >= minQty && askPrice >= 0.01 && askPrice <= 0.99) {
                console.log(`找到市场 ${id}: ${market.data?.title?.slice(0, 50)}...`);
                console.log(`  卖一价: ${askPrice} @ ${askSize.toFixed(2)}`);
                console.log(`  最小数量: ${minQty}`);
                return {
                    id,
                    title: market.data?.title,
                    askPrice,
                    askSize,
                    minQty,
                    isNegRisk: market.data?.isNegRisk || false,
                    outcomes: market.data?.outcomes || [],
                };
            }
        }
    }

    return null;
}

// ============================================================================
// 仅测试 BSC WSS 延迟 (不下单)
// ============================================================================

async function testBscWssOnly() {
    console.log('\n' + '='.repeat(60));
    console.log('测试 BSC WSS 连接和事件接收');
    console.log('='.repeat(60));

    return new Promise((resolve) => {
        const ws = new WebSocket(BSC_WSS_URL);
        const startTime = Date.now();
        let eventCount = 0;

        ws.on('open', () => {
            const elapsed = Date.now() - startTime;
            console.log(`[${elapsed}ms] BSC WSS 连接成功`);

            // 订阅所有 Exchange 的 OrderFilled 事件
            const paddedAddress = '0x' + '0'.repeat(24) + SMART_WALLET.slice(2).toLowerCase();

            // 作为 maker 订阅
            ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_subscribe',
                params: ['logs', {
                    address: EXCHANGES,
                    topics: [ORDER_FILLED_TOPIC, null, paddedAddress],
                }],
            }));

            // 作为 taker 订阅
            ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'eth_subscribe',
                params: ['logs', {
                    address: EXCHANGES,
                    topics: [ORDER_FILLED_TOPIC, null, null, paddedAddress],
                }],
            }));
        });

        ws.on('message', (data) => {
            const elapsed = Date.now() - startTime;
            const msg = JSON.parse(data.toString());

            if (msg.id === 1 || msg.id === 2) {
                const subType = msg.id === 1 ? 'maker' : 'taker';
                console.log(`[${elapsed}ms] BSC 订阅成功 (${subType}): ${msg.result}`);
                return;
            }

            if (msg.method === 'eth_subscription') {
                eventCount++;
                const log = msg.params?.result;
                if (log) {
                    const orderHash = log.topics?.[1] || 'unknown';
                    console.log(`[${elapsed}ms] 收到 OrderFilled 事件: ${orderHash.slice(0, 20)}...`);
                }
            }
        });

        ws.on('error', (err) => {
            console.error('BSC WSS 错误:', err.message);
        });

        // 监听 30 秒
        setTimeout(() => {
            console.log(`\n监听结束，收到 ${eventCount} 个事件`);
            ws.close();
            resolve();
        }, 30000);

        console.log('\n监听 30 秒中... (等待 OrderFilled 事件)');
    });
}

// ============================================================================
// 测试 Predict 官方 WS + REST API 延迟对比
// ============================================================================

async function testPredictWsVsRest() {
    console.log('\n' + '='.repeat(60));
    console.log('测试 Predict WebSocket vs REST API 订单簿延迟');
    console.log('='.repeat(60));

    const market = await findActiveMarket();
    if (!market) {
        console.log('未找到合适的市场');
        return;
    }

    const wsUpdates = [];
    const restLatencies = [];

    // 1. 连接 WebSocket
    const ws = new WebSocket(`${WS_URL}?apiKey=${encodeURIComponent(API_KEY)}`);

    await new Promise((resolve) => {
        ws.on('open', () => {
            console.log('\nWebSocket 连接成功');

            // 订阅订单簿
            ws.send(JSON.stringify({
                method: 'subscribe',
                requestId: 1,
                params: [`predictOrderbook/${market.id}`],
            }));
            resolve();
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'M' && msg.topic === 'heartbeat') {
                ws.send(JSON.stringify({ method: 'heartbeat', data: msg.data }));
                return;
            }

            if (msg.type === 'M' && msg.topic?.startsWith('predictOrderbook/')) {
                wsUpdates.push({
                    time: Date.now(),
                    bids: msg.data?.bids?.length || 0,
                    asks: msg.data?.asks?.length || 0,
                });
            }
        });
    });

    // 2. 并行测试 REST API
    console.log('\n测试 REST API 延迟 (10 次)...');
    for (let i = 0; i < 10; i++) {
        const start = Date.now();
        await fetchJson(`${API_BASE}/v1/markets/${market.id}/orderbook`);
        restLatencies.push(Date.now() - start);
        await new Promise(r => setTimeout(r, 200));
    }

    // 3. 等待 WebSocket 更新
    console.log('等待 WebSocket 更新 (15 秒)...');
    await new Promise(r => setTimeout(r, 15000));

    ws.close();

    // 4. 输出结果
    console.log('\n' + '-'.repeat(50));
    console.log('结果:');
    console.log('-'.repeat(50));

    console.log('\n[REST API]');
    console.log(`  平均延迟: ${(restLatencies.reduce((a, b) => a + b, 0) / restLatencies.length).toFixed(0)}ms`);
    console.log(`  最小延迟: ${Math.min(...restLatencies)}ms`);
    console.log(`  最大延迟: ${Math.max(...restLatencies)}ms`);

    console.log('\n[WebSocket]');
    console.log(`  更新次数: ${wsUpdates.length}`);
    if (wsUpdates.length >= 2) {
        const intervals = [];
        for (let i = 1; i < wsUpdates.length; i++) {
            intervals.push(wsUpdates[i].time - wsUpdates[i - 1].time);
        }
        console.log(`  平均间隔: ${(intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(0)}ms`);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log('订单延迟对比测试');
    console.log('='.repeat(60));

    if (!API_KEY || !SMART_WALLET) {
        console.error('错误: 缺少必要的环境变量');
        process.exit(1);
    }

    console.log(`Smart Wallet: ${SMART_WALLET.slice(0, 10)}...`);

    const args = process.argv.slice(2);
    const mode = args[0] || 'ws-rest';

    switch (mode) {
        case 'bsc':
            await testBscWssOnly();
            break;

        case 'ws-rest':
        default:
            await testPredictWsVsRest();
            break;
    }

    console.log('\n测试完成!');
    process.exit(0);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
