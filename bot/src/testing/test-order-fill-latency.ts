/**
 * 下单成交延迟测试
 *
 * 实际下一个小额买单，测试各渠道的成交通知延迟:
 * 1. Predict WS (ORDER_FILLED 事件)
 * 2. BSC WSS (链上 OrderFilled 事件)
 * 3. REST API 轮询
 *
 * ⚠️ 警告: 此测试会实际下单，请确认金额后再运行
 *
 * 用法:
 *   npx tsx src/testing/test-order-fill-latency.ts [marketId]
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import { WebSocket } from 'ws';
import { Interface, formatUnits } from 'ethers';
import { getPredictTrader } from '../dashboard/predict-trader.js';
import { PredictRestClient } from '../predict/rest-client.js';
import { getPredictOrderWatcher } from '../services/predict-order-watcher.js';
import { getPredictWsClient, type WalletEventData } from '../services/predict-ws-client.js';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.PREDICT_API_KEY || '';
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS || '';
const BSC_WSS_URL = 'wss://bsc-rpc.publicnode.com';

// OrderFilled 事件
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const ORDER_FILLED_ABI = [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];
const orderFilledInterface = new Interface(ORDER_FILLED_ABI);

// Exchange 地址
const EXCHANGES = [
    '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
    '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
].map(a => a.toLowerCase());

// ============================================================================
// 工具函数
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface MarketInfo {
    id: number;
    title: string;
    askPrice: number;
    askSize: number;
    minQty: number;
    isNegRisk: boolean;
    yesTokenId: string;
}

async function findActiveMarket(): Promise<MarketInfo | null> {
    console.log('查找有活跃订单簿的市场...');

    const client = new PredictRestClient({ apiKey: API_KEY });
    const matches = await client.getOrderMatches({ limit: 20 });
    const marketIds = [...new Set(matches.map(m => m.market?.id).filter(Boolean))] as number[];

    for (const id of marketIds.slice(0, 10)) {
        try {
            const ob = await client.getOrderBook(id);
            if (ob.asks?.length > 0) {
                const market = await client.getMarket(id);
                const askPrice = ob.asks[0][0];
                const askSize = ob.asks[0][1];

                const minQty = Math.ceil(1.1 / askPrice);

                if (askSize >= minQty && askPrice >= 0.01 && askPrice <= 0.95) {
                    const outcomes = market.outcomes || [];
                    const yesOutcome = outcomes.find(o => o.name === 'Yes' || o.indexSet === 1);

                    if (yesOutcome) {
                        return {
                            id,
                            title: market.title || '',
                            askPrice,
                            askSize,
                            minQty,
                            isNegRisk: market.isNegRisk || false,
                            yesTokenId: yesOutcome.onChainId,
                        };
                    }
                }
            }
        } catch {
            // ignore
        }
    }

    return null;
}

// ============================================================================
// 主测试
// ============================================================================

async function runTest(marketIdArg?: number): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('下单成交延迟测试');
    console.log('='.repeat(60));

    // 1. 获取市场信息
    let market: MarketInfo | null = null;

    if (marketIdArg) {
        const client = new PredictRestClient({ apiKey: API_KEY });
        const ob = await client.getOrderBook(marketIdArg);
        const marketInfo = await client.getMarket(marketIdArg);
        const outcomes = marketInfo.outcomes || [];
        const yesOutcome = outcomes.find(o => o.name === 'Yes' || o.indexSet === 1);

        if (ob.asks?.[0] && yesOutcome) {
            market = {
                id: marketIdArg,
                title: marketInfo.title || '',
                askPrice: ob.asks[0][0],
                askSize: ob.asks[0][1],
                minQty: Math.ceil(1.1 / ob.asks[0][0]),
                isNegRisk: marketInfo.isNegRisk || false,
                yesTokenId: yesOutcome.onChainId,
            };
        }
    } else {
        market = await findActiveMarket();
    }

    if (!market) {
        console.log('未找到合适的市场或订单簿为空');
        return;
    }

    console.log(`\n市场: ${market.id} - ${market.title.slice(0, 50)}...`);
    console.log(`卖一价: ${market.askPrice} @ ${market.askSize.toFixed(2)}`);
    console.log(`Token ID: ${market.yesTokenId.slice(0, 20)}...`);
    console.log(`NegRisk: ${market.isNegRisk}`);

    // 计算下单参数
    const orderQty = Math.max(market.minQty, 2);
    const orderPrice = market.askPrice;
    const orderValue = orderPrice * orderQty;

    console.log(`\n计划下单: BUY ${orderQty} YES @ ${orderPrice}`);
    console.log(`订单价值: $${orderValue.toFixed(2)}`);

    if (orderValue > 3) {
        console.log('\n⚠️ 订单金额超过 $3，跳过实际下单');
        console.log('如需测试，请手动指定一个价格更低的市场');
        return;
    }

    const results = {
        placeTime: 0,
        predictWsTime: 0,
        bscWssTime: 0,
        restApiTime: 0,
        orderHash: '',
        orderId: '',
    };

    // 2. 启动 Predict WS 监听
    console.log('\n启动 Predict WS 监听...');
    const watcher = getPredictOrderWatcher(SMART_WALLET);
    await watcher.start();
    console.log('Predict WS 已连接');

    const wsClient = getPredictWsClient();
    if (!wsClient) {
        console.error('❌ 无法获取 Predict WS Client');
        process.exit(1);
    }

    const predictWsHandler = (event: WalletEventData) => {
        if (results.placeTime === 0) return; // 还没下单

        // 匹配 orderHash 或 orderId
        const matchByHash = event.orderHash && results.orderHash &&
            event.orderHash.toLowerCase() === results.orderHash.toLowerCase();
        const matchById = event.orderId && results.orderId &&
            event.orderId === results.orderId;

        if ((matchByHash || matchById) && event.type === 'ORDER_FILLED') {
            if (results.predictWsTime === 0) {
                results.predictWsTime = Date.now();
                const latency = results.predictWsTime - results.placeTime;
                console.log(`\n[Predict WS] 收到 ORDER_FILLED! 延迟: ${latency}ms`);
                console.log(`  OrderId: ${event.orderId}`);
            }
        }
    };
    wsClient.on('walletEvent', predictWsHandler);

    // 3. 启动 BSC WSS 监听
    console.log('\n启动 BSC WSS 监听...');
    const bscWs = new WebSocket(BSC_WSS_URL);

    await new Promise<void>((resolve) => {
        bscWs.on('open', () => {
            console.log('BSC WSS 已连接');

            const paddedAddress = '0x' + '0'.repeat(24) + SMART_WALLET.slice(2).toLowerCase();

            // 作为 taker 订阅 (我们是吃单方)
            bscWs.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_subscribe',
                params: ['logs', {
                    address: EXCHANGES,
                    topics: [ORDER_FILLED_TOPIC, null, null, paddedAddress],
                }],
            }));

            resolve();
        });

        bscWs.on('message', (data) => {
            const msg = JSON.parse(data.toString());

            if (msg.method === 'eth_subscription' && results.placeTime > 0) {
                const log = msg.params?.result;
                if (log && results.bscWssTime === 0) {
                    results.bscWssTime = Date.now();
                    const latency = results.bscWssTime - results.placeTime;
                    console.log(`\n[BSC WSS] 收到 OrderFilled! 延迟: ${latency}ms`);

                    try {
                        const decoded = orderFilledInterface.parseLog({ topics: log.topics, data: log.data });
                        if (decoded) {
                            console.log(`  OrderHash: ${String(decoded.args[0]).slice(0, 20)}...`);
                            console.log(`  TakerAmount: ${formatUnits(decoded.args[6], 18)}`);
                        }
                    } catch {
                        // ignore
                    }
                }
            }
        });

        bscWs.on('error', (err) => {
            console.error('BSC WSS 错误:', err.message);
            resolve();
        });
    });

    // 4. 初始化 trader
    console.log('\n初始化 PredictTrader...');
    const trader = getPredictTrader();
    await trader.init();

    // 5. 下单
    console.log('\n提交订单...');
    results.placeTime = Date.now();

    const orderResult = await trader.placeOrder({
        marketId: market.id,
        side: 'BUY',
        price: orderPrice,
        quantity: orderQty,
        outcome: 'YES',
    });

    if (!orderResult.success || !orderResult.hash) {
        console.log(`下单失败: ${orderResult.error}`);
        bscWs.close();
        watcher.stop();
        return;
    }

    results.orderHash = orderResult.hash;
    results.orderId = orderResult.orderId ? String(orderResult.orderId).replace(/n$/, '') : '';
    const placeLatency = Date.now() - results.placeTime;
    console.log(`下单成功! Hash: ${results.orderHash}`);
    console.log(`OrderId: ${results.orderId}`);
    console.log(`下单耗时: ${placeLatency}ms`);

    // 6. REST API 轮询
    console.log('\n开始 REST API 轮询...');
    let filled = false;

    for (let i = 0; i < 60; i++) {
        const status = await trader.getOrderStatus(results.orderHash);

        if (status && (status.status === 'FILLED' || status.status === 'PARTIALLY_FILLED')) {
            if (results.restApiTime === 0) {
                results.restApiTime = Date.now();
                const latency = results.restApiTime - results.placeTime;
                console.log(`\n[REST API] 订单已成交! 延迟: ${latency}ms`);
                console.log(`  Status: ${status.status}`);
                console.log(`  FilledQty: ${status.filledQty}`);
            }
            filled = true;
            break;
        }

        if (status && (status.status === 'CANCELLED' || status.status === 'EXPIRED')) {
            console.log(`\n[REST API] 订单 ${status.status}: ${status.cancelReason || 'unknown'}`);
            break;
        }

        await sleep(500);
    }

    // 7. 等待 WS 事件
    const needWait = results.bscWssTime === 0 || results.predictWsTime === 0;
    if (needWait) {
        console.log('\n等待 WS 事件 (10秒)...');
        for (let i = 0; i < 100; i++) {
            if (results.bscWssTime > 0 && results.predictWsTime > 0) break;
            await sleep(100);
        }
    }

    // 清理
    bscWs.close();
    wsClient.removeListener('walletEvent', predictWsHandler);
    watcher.stop();

    // 8. 输出结果
    console.log('\n' + '='.repeat(60));
    console.log('延迟对比结果');
    console.log('='.repeat(60));

    console.log(`\n订单: ${results.orderHash}`);
    console.log(`下单时间: ${new Date(results.placeTime).toISOString()}`);

    const latencies: { source: string; latency: number }[] = [];

    if (results.predictWsTime > 0) {
        latencies.push({ source: 'Predict WS', latency: results.predictWsTime - results.placeTime });
    }
    if (results.bscWssTime > 0) {
        latencies.push({ source: 'BSC WSS', latency: results.bscWssTime - results.placeTime });
    }
    if (results.restApiTime > 0) {
        latencies.push({ source: 'REST API', latency: results.restApiTime - results.placeTime });
    }

    latencies.sort((a, b) => a.latency - b.latency);

    console.log('\n延迟排名 (越小越快):');
    latencies.forEach((r, i) => {
        const medal = ['🥇', '🥈', '🥉'][i] || '  ';
        console.log(`  ${medal} ${r.source}: ${r.latency}ms`);
    });

    if (latencies.length >= 2) {
        const diff = latencies[1].latency - latencies[0].latency;
        console.log(`\n${latencies[0].source} 比 ${latencies[1].source} 快 ${diff}ms`);
    }

    // 输出汇总表格
    console.log('\n┌──────────────┬───────────┐');
    console.log('│ 数据源       │ 延迟      │');
    console.log('├──────────────┼───────────┤');
    console.log(`│ Predict WS   │ ${results.predictWsTime > 0 ? String(results.predictWsTime - results.placeTime).padStart(7) + 'ms' : '   未收到'} │`);
    console.log(`│ BSC WSS      │ ${results.bscWssTime > 0 ? String(results.bscWssTime - results.placeTime).padStart(7) + 'ms' : '   未收到'} │`);
    console.log(`│ REST API     │ ${results.restApiTime > 0 ? String(results.restApiTime - results.placeTime).padStart(7) + 'ms' : '   未收到'} │`);
    console.log('└──────────────┴───────────┘');

    if (!filled) {
        console.log('\n⚠️ 订单可能未成交，请检查订单状态');
    }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    if (!API_KEY || !SMART_WALLET) {
        console.error('错误: 缺少必要的环境变量');
        process.exit(1);
    }

    console.log('下单成交延迟测试');
    console.log('='.repeat(60));
    console.log(`Smart Wallet: ${SMART_WALLET.slice(0, 10)}...`);

    const args = process.argv.slice(2);
    const marketId = parseInt(args[0], 10) || undefined;

    if (marketId) {
        console.log(`指定市场: ${marketId}`);
    }

    await runTest(marketId);

    console.log('\n测试完成!');
    process.exit(0);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
