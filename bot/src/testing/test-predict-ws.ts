/**
 * Predict WebSocket 功能测试
 *
 * 测试内容:
 * 1. 订单簿 WebSocket 订阅延迟 vs REST API 轮询
 * 2. 钱包事件订阅（订单状态变更）延迟 vs BSC WSS
 * 3. 下单后各渠道通知的延迟对比
 *
 * 用法:
 *   npx tsx src/testing/test-predict-ws.ts
 */

import { config } from 'dotenv';
config({ path: '../.env' });
import { PredictWsClient, type OrderbookUpdateData, type WalletEventData } from '../services/predict-ws-client.js';
import { PredictRestClient } from '../predict/rest-client.js';
import { getBscOrderWatcher, type OrderFilledEvent } from '../services/bsc-order-watcher.js';
import { getPredictTrader } from '../dashboard/predict-trader.js';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.PREDICT_API_KEY || '';
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS || '';

// 测试用市场 ID (需要是有活跃订单簿的市场)
// 可以通过 REST API 获取活跃市场
let TEST_MARKET_ID = 0;

// ============================================================================
// 工具函数
// ============================================================================

function formatMs(ms: number): string {
    return `${ms.toFixed(0)}ms`;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// 测试 1: 订单簿 WebSocket vs REST API
// ============================================================================

async function testOrderbookLatency(marketId: number): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log(`测试 1: 订单簿延迟对比 (Market ${marketId})`);
    console.log('='.repeat(60));

    const restClient = new PredictRestClient({ apiKey: API_KEY });

    // 创建 WebSocket 客户端
    const wsClient = new PredictWsClient({
        apiKey: API_KEY,
    });

    // 统计
    const wsUpdates: { timestamp: number; data: OrderbookUpdateData }[] = [];
    let wsConnectTime = 0;
    let wsFirstUpdateTime = 0;

    try {
        // 1. 连接 WebSocket
        const connectStart = Date.now();
        await wsClient.connect();
        wsConnectTime = Date.now() - connectStart;
        console.log(`\n[WebSocket] 连接耗时: ${formatMs(wsConnectTime)}`);

        // 2. 订阅订单簿
        const subscribeStart = Date.now();
        const subscribed = await wsClient.subscribeOrderbook(marketId, (data) => {
            const now = Date.now();
            if (wsUpdates.length === 0) {
                wsFirstUpdateTime = now - subscribeStart;
            }
            wsUpdates.push({ timestamp: now, data });
        });

        if (!subscribed) {
            console.error('[WebSocket] 订阅失败');
            return;
        }

        const subscribeTime = Date.now() - subscribeStart;
        console.log(`[WebSocket] 订阅耗时: ${formatMs(subscribeTime)}`);

        // 3. 等待收集 WebSocket 更新 (10 秒)
        console.log('\n收集 10 秒数据...');
        await sleep(10000);

        // 4. 同时进行 REST API 轮询测试
        console.log('\n测试 REST API 轮询延迟 (10 次)...');
        const restLatencies: number[] = [];

        for (let i = 0; i < 10; i++) {
            const start = Date.now();
            await restClient.getOrderBook(marketId);
            const latency = Date.now() - start;
            restLatencies.push(latency);
            await sleep(200); // 避免频率限制
        }

        // 5. 输出结果
        console.log('\n' + '-'.repeat(40));
        console.log('结果汇总:');
        console.log('-'.repeat(40));

        console.log(`\n[REST API]`);
        console.log(`  请求次数: ${restLatencies.length}`);
        console.log(`  平均延迟: ${formatMs(restLatencies.reduce((a, b) => a + b, 0) / restLatencies.length)}`);
        console.log(`  最小延迟: ${formatMs(Math.min(...restLatencies))}`);
        console.log(`  最大延迟: ${formatMs(Math.max(...restLatencies))}`);

        console.log(`\n[WebSocket]`);
        console.log(`  连接耗时: ${formatMs(wsConnectTime)}`);
        console.log(`  首次更新: ${wsFirstUpdateTime > 0 ? formatMs(wsFirstUpdateTime) : 'N/A'}`);
        console.log(`  更新次数: ${wsUpdates.length}`);

        if (wsUpdates.length >= 2) {
            const intervals = [];
            for (let i = 1; i < wsUpdates.length; i++) {
                intervals.push(wsUpdates[i].timestamp - wsUpdates[i - 1].timestamp);
            }
            const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            console.log(`  平均间隔: ${formatMs(avgInterval)}`);
            console.log(`  最小间隔: ${formatMs(Math.min(...intervals))}`);
            console.log(`  最大间隔: ${formatMs(Math.max(...intervals))}`);
        }

        // 显示最新订单簿快照
        if (wsUpdates.length > 0) {
            const latest = wsUpdates[wsUpdates.length - 1].data;
            console.log(`\n[最新订单簿]`);
            console.log(`  Bids: ${latest.bids.slice(0, 3).map(([p, s]) => `${p}@${s}`).join(', ')}`);
            console.log(`  Asks: ${latest.asks.slice(0, 3).map(([p, s]) => `${p}@${s}`).join(', ')}`);
        }

    } finally {
        wsClient.disconnect();
    }
}

// ============================================================================
// 测试 2: 下单延迟对比 (官方 WS vs BSC WSS)
// ============================================================================

async function testOrderLatency(marketId: number): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log(`测试 2: 订单状态延迟对比 (Market ${marketId})`);
    console.log('='.repeat(60));

    const trader = getPredictTrader();
    await trader.init();

    // 获取 JWT (用于钱包事件订阅)
    // JWT 通过 trader 内部认证获取，这里需要通过 REST API 重新获取
    const restClient = new PredictRestClient({ apiKey: API_KEY });

    // 签名获取 JWT
    console.log('\n获取 JWT...');
    let jwt = '';
    try {
        const authMsg = await restClient.getAuthMessage(SMART_WALLET);
        // 这里需要签名，但 restClient 没有签名能力
        // 我们将直接使用 trader 的内部 JWT (通过反射或其他方式)
        // 暂时跳过钱包事件测试
        console.log('[注意] JWT 获取需要签名，将跳过官方 WS 钱包事件测试');
    } catch (e: any) {
        console.log('[注意] JWT 获取失败:', e.message);
    }

    // 创建 WebSocket 客户端 (订单簿订阅，用于获取卖一价)
    const wsClient = new PredictWsClient({ apiKey: API_KEY, jwt });

    // 启动 BSC WSS
    const bscWatcher = getBscOrderWatcher(SMART_WALLET);

    // 延迟记录
    const latencyRecords: {
        orderHash: string;
        placeTime: number;
        bscWssTime?: number;
        predictWsTime?: number;
        restApiTime?: number;
    }[] = [];

    try {
        // 1. 连接 WebSocket
        console.log('\n连接 WebSocket...');
        await wsClient.connect();

        // 2. 启动 BSC WSS
        console.log('启动 BSC WSS...');
        await bscWatcher.start();

        // 3. 获取订单簿找卖一价
        console.log('\n获取订单簿...');
        const orderbook = await trader.getOrderbook(marketId);
        if (!orderbook || orderbook.asks.length === 0) {
            console.error('订单簿为空，无法测试');
            return;
        }

        const bestAsk = orderbook.asks[0];
        const askPrice = bestAsk[0];
        const askSize = bestAsk[1];

        console.log(`卖一价: ${askPrice} @ ${askSize}`);

        // 4. 计算下单数量 (确保 > 最小金额)
        const minOrderValue = 1.0; // $1 USD
        const minQty = Math.ceil(minOrderValue / askPrice);
        const orderQty = Math.max(minQty, 1);
        const orderValue = askPrice * orderQty;

        console.log(`计划下单: BUY ${orderQty} @ ${askPrice} (价值 $${orderValue.toFixed(2)})`);

        if (orderValue > 5) {
            console.log('[警告] 订单金额超过 $5，取消测试');
            return;
        }

        // 5. 设置 BSC WSS 监听
        let bscWssReceived = false;
        bscWatcher.on('orderFilled', (event: OrderFilledEvent) => {
            if (!bscWssReceived) {
                bscWssReceived = true;
                const record = latencyRecords[latencyRecords.length - 1];
                if (record) {
                    record.bscWssTime = Date.now();
                    console.log(`[BSC WSS] 收到成交事件: ${formatMs(record.bscWssTime - record.placeTime)}`);
                }
            }
        });

        // 6. 下单
        console.log('\n提交订单...');
        const placeTime = Date.now();
        const result = await trader.placeOrder({
            marketId,
            side: 'BUY',
            price: askPrice,
            quantity: orderQty,
        });

        if (!result.success || !result.hash) {
            console.error('下单失败:', result.error);
            return;
        }

        const placeLatency = Date.now() - placeTime;
        console.log(`下单成功: ${result.hash}`);
        console.log(`下单耗时: ${formatMs(placeLatency)}`);

        latencyRecords.push({
            orderHash: result.hash,
            placeTime,
        });

        // 7. 轮询 REST API 获取状态
        console.log('\n轮询订单状态...');
        const pollStart = Date.now();
        let restApiReceived = false;

        for (let i = 0; i < 60; i++) { // 最多 30 秒
            const status = await trader.getOrderStatus(result.hash);

            if (status && (status.status === 'FILLED' || status.status === 'PARTIALLY_FILLED')) {
                if (!restApiReceived) {
                    restApiReceived = true;
                    const record = latencyRecords[latencyRecords.length - 1];
                    record.restApiTime = Date.now();
                    console.log(`[REST API] 收到成交状态: ${formatMs(record.restApiTime - record.placeTime)}`);
                }
                break;
            }

            if (status && (status.status === 'CANCELLED' || status.status === 'EXPIRED')) {
                console.log(`[REST API] 订单 ${status.status}: ${status.cancelReason || 'unknown'}`);
                break;
            }

            await sleep(500);
        }

        // 8. 等待所有通知到达
        console.log('\n等待 5 秒收集所有通知...');
        await sleep(5000);

        // 9. 输出结果
        console.log('\n' + '-'.repeat(40));
        console.log('延迟对比结果:');
        console.log('-'.repeat(40));

        const record = latencyRecords[latencyRecords.length - 1];
        if (record) {
            console.log(`\n订单: ${record.orderHash.slice(0, 20)}...`);
            console.log(`下单时间: ${new Date(record.placeTime).toISOString()}`);

            const results: { source: string; latency: number }[] = [];

            if (record.bscWssTime) {
                results.push({ source: 'BSC WSS', latency: record.bscWssTime - record.placeTime });
            }
            if (record.predictWsTime) {
                results.push({ source: 'Predict WS', latency: record.predictWsTime - record.placeTime });
            }
            if (record.restApiTime) {
                results.push({ source: 'REST API', latency: record.restApiTime - record.placeTime });
            }

            // 按延迟排序
            results.sort((a, b) => a.latency - b.latency);

            console.log('\n延迟排名:');
            results.forEach((r, i) => {
                console.log(`  ${i + 1}. ${r.source}: ${formatMs(r.latency)}`);
            });

            if (results.length === 0) {
                console.log('  [警告] 未收到任何成交通知');
            }
        }

    } finally {
        wsClient.disconnect();
        bscWatcher.stop();
    }
}

// ============================================================================
// 测试 3: 仅测试 WebSocket 连接和订单簿订阅
// ============================================================================

async function testWsConnectionOnly(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('测试 3: WebSocket 连接和订阅测试');
    console.log('='.repeat(60));

    const wsClient = new PredictWsClient({ apiKey: API_KEY });

    try {
        // 连接
        console.log('\n正在连接 Predict WebSocket...');
        const connectStart = Date.now();
        await wsClient.connect();
        console.log(`连接成功! 耗时: ${formatMs(Date.now() - connectStart)}`);

        // 获取活跃市场
        console.log('\n获取活跃市场...');
        const restClient = new PredictRestClient({ apiKey: API_KEY });
        const markets = await restClient.getActiveMarkets(10);

        if (markets.length === 0) {
            console.log('没有活跃市场');
            return;
        }

        // 选择第一个有订单簿的市场
        let selectedMarket = null;
        for (const market of markets) {
            try {
                const ob = await restClient.getOrderBook(market.id);
                if (ob.asks.length > 0 || ob.bids.length > 0) {
                    selectedMarket = market;
                    TEST_MARKET_ID = market.id;
                    break;
                }
            } catch { /* ignore */ }
        }

        if (!selectedMarket) {
            console.log('没有找到有订单簿的市场');
            return;
        }

        console.log(`\n选择市场: ${selectedMarket.id} - ${selectedMarket.title?.slice(0, 50)}...`);

        // 订阅订单簿
        let updateCount = 0;
        const subscribeStart = Date.now();
        const subscribed = await wsClient.subscribeOrderbook(selectedMarket.id, (data) => {
            updateCount++;
            if (updateCount <= 5) {
                console.log(`  [更新 ${updateCount}] Bids: ${data.bids.length}, Asks: ${data.asks.length}`);
            }
        });

        if (!subscribed) {
            console.log('订阅失败');
            return;
        }

        console.log(`订阅成功! 耗时: ${formatMs(Date.now() - subscribeStart)}`);

        // 等待更新
        console.log('\n等待 15 秒收集更新...');
        await sleep(15000);

        // 输出统计
        const stats = wsClient.getStats();
        console.log('\n' + '-'.repeat(40));
        console.log('统计信息:');
        console.log('-'.repeat(40));
        console.log(`总消息数: ${stats.totalMessages}`);
        console.log(`订单簿更新: ${stats.orderbookUpdates}`);
        console.log(`钱包事件: ${stats.walletEvents}`);
        console.log(`心跳丢失: ${stats.heartbeatsMissed}`);
        console.log(`订阅主题: ${stats.subscribedTopics.join(', ')}`);

    } finally {
        wsClient.disconnect();
        console.log('\n已断开连接');
    }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    console.log('Predict WebSocket 功能测试');
    console.log('='.repeat(60));

    if (!API_KEY) {
        console.error('错误: 未设置 PREDICT_API_KEY');
        process.exit(1);
    }

    if (!SMART_WALLET) {
        console.error('错误: 未设置 PREDICT_SMART_WALLET_ADDRESS');
        process.exit(1);
    }

    console.log(`API Key: ${API_KEY.slice(0, 8)}...`);
    console.log(`Smart Wallet: ${SMART_WALLET.slice(0, 10)}...`);

    // 解析命令行参数
    const args = process.argv.slice(2);
    const testMode = args[0] || 'connection';
    const marketIdArg = parseInt(args[1], 10);

    try {
        switch (testMode) {
            case 'connection':
            case 'conn':
                // 仅测试连接和订阅
                await testWsConnectionOnly();
                break;

            case 'orderbook':
            case 'ob':
                // 测试订单簿延迟
                if (isNaN(marketIdArg)) {
                    // 先找一个市场
                    await testWsConnectionOnly();
                }
                if (TEST_MARKET_ID > 0) {
                    await testOrderbookLatency(TEST_MARKET_ID);
                }
                break;

            case 'order':
                // 测试下单延迟 (会实际下单!)
                if (isNaN(marketIdArg)) {
                    console.error('用法: npx tsx test-predict-ws.ts order <marketId>');
                    console.error('例如: npx tsx test-predict-ws.ts order 123');
                    process.exit(1);
                }
                await testOrderLatency(marketIdArg);
                break;

            case 'all':
                // 运行所有测试
                await testWsConnectionOnly();
                if (TEST_MARKET_ID > 0) {
                    await testOrderbookLatency(TEST_MARKET_ID);
                }
                break;

            default:
                console.log(`
用法: npx tsx src/testing/test-predict-ws.ts <mode> [marketId]

模式:
  connection  仅测试 WebSocket 连接和订阅 (默认)
  orderbook   测试订单簿延迟对比 (WS vs REST)
  order       测试下单延迟对比 (需要 marketId，会实际下单!)
  all         运行所有非下单测试

示例:
  npx tsx src/testing/test-predict-ws.ts connection
  npx tsx src/testing/test-predict-ws.ts orderbook
  npx tsx src/testing/test-predict-ws.ts order 123
`);
        }

    } catch (e) {
        console.error('测试出错:', e);
        process.exit(1);
    }

    console.log('\n测试完成!');
    process.exit(0);
}

main();
