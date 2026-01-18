/**
 * 全渠道订单成交延迟对比测试
 *
 * 对比三个渠道的成交通知延迟:
 * 1. Predict 官方 WebSocket (predictWalletEvents/{jwt})
 * 2. BSC WSS (链上 OrderFilled 事件)
 * 3. REST API 轮询
 *
 * ⚠️ 警告: 此测试会实际下单
 *
 * 用法:
 *   npx tsx src/testing/test-all-channels-latency.ts [marketId]
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import { WebSocket } from 'ws';
import { Interface, formatUnits, Wallet, JsonRpcProvider } from 'ethers';
import { getPredictTrader } from '../dashboard/predict-trader.js';
import { PredictRestClient } from '../predict/rest-client.js';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.PREDICT_API_KEY || '';
const API_KEY_TRADE = process.env.PREDICT_API_KEY_TRADE || API_KEY;
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS || '';
const PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY || '';

const API_BASE = 'https://api.predict.fun';
const PREDICT_WS_URL = 'wss://ws.predict.fun/ws';
const BSC_WSS_URL = 'wss://bsc-rpc.publicnode.com';
const BSC_RPC_URL = 'https://bsc-dataseed1.binance.org';

// OrderFilled 事件
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const ORDER_FILLED_ABI = [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];
const orderFilledInterface = new Interface(ORDER_FILLED_ABI);

// Exchange 地址 (全部 4 个)
const EXCHANGES = [
    '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',  // CTF_EXCHANGE
    '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',  // NEG_RISK_CTF_EXCHANGE
    '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',  // YIELD_BEARING_CTF_EXCHANGE
    '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',  // YIELD_BEARING_NEG_RISK_CTF_EXCHANGE
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
// JWT 获取（使用 SDK 签名）
// ============================================================================

async function getJwtToken(): Promise<string> {
    console.log('获取 JWT Token...');

    // 1. 获取签名消息
    const msgRes = await fetch(`${API_BASE}/v1/auth/message`, {
        headers: { 'x-api-key': API_KEY_TRADE },
    });
    const msgData = await msgRes.json() as { data: { message: string } };
    const message = msgData.data?.message;

    if (!message) {
        throw new Error('Failed to get auth message');
    }

    // 2. 使用 PredictTrader 的 OrderBuilder 签名
    // 先初始化 trader 以获取 orderBuilder
    const trader = getPredictTrader();
    await trader.init();

    // 通过反射获取内部 JWT（trader 已经认证过了）
    // @ts-ignore - 访问私有属性
    const jwt = trader.jwt;

    if (jwt) {
        console.log('JWT Token 已获取 (从 trader)');
        return jwt;
    }

    throw new Error('Failed to get JWT from trader');
}

// ============================================================================
// 主测试
// ============================================================================

async function runTest(marketIdArg?: number): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('全渠道订单成交延迟对比测试');
    console.log('='.repeat(60));

    // 1. 初始化 trader（这会获取 JWT）
    console.log('\n初始化 PredictTrader...');
    const trader = getPredictTrader();
    await trader.init();

    // 获取 JWT
    // @ts-ignore - 访问私有属性
    const jwt = trader.jwt as string;
    if (!jwt) {
        console.error('无法获取 JWT');
        return;
    }
    console.log(`JWT Token: ${jwt.slice(0, 20)}...`);

    // 2. 获取市场信息
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
    console.log(`NegRisk: ${market.isNegRisk}`);

    // 计算下单参数
    const orderQty = Math.max(market.minQty, 2);
    const orderPrice = market.askPrice;
    const orderValue = orderPrice * orderQty;

    console.log(`\n计划下单: BUY ${orderQty} YES @ ${orderPrice}`);
    console.log(`订单价值: $${orderValue.toFixed(2)}`);

    if (orderValue > 3) {
        console.log('\n⚠️ 订单金额超过 $3，跳过实际下单');
        return;
    }

    // 3. 结果记录
    const results = {
        placeTime: 0,
        placeEndTime: 0,
        predictWsTime: 0,
        predictWsEvent: '',
        bscWssTime: 0,
        restApiTime: 0,
        orderHash: '',
    };

    // 4. 启动 Predict 官方 WebSocket
    console.log('\n启动 Predict 官方 WebSocket...');
    const predictWs = new WebSocket(`${PREDICT_WS_URL}?apiKey=${encodeURIComponent(API_KEY)}`);

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Predict WS connection timeout'));
        }, 15000);

        predictWs.on('open', () => {
            clearTimeout(timeout);
            console.log('Predict WS 已连接');

            // 订阅钱包事件
            const subscribeMsg = {
                method: 'subscribe',
                requestId: 1,
                params: [`predictWalletEvents/${jwt}`],
            };
            predictWs.send(JSON.stringify(subscribeMsg));
        });

        predictWs.on('message', (data) => {
            const msg = JSON.parse(data.toString());

            // 心跳响应
            if (msg.type === 'M' && msg.topic === 'heartbeat') {
                predictWs.send(JSON.stringify({ method: 'heartbeat', data: msg.data }));
                return;
            }

            // 订阅响应
            if (msg.type === 'R' && msg.requestId === 1) {
                if (msg.success) {
                    console.log('Predict WS 钱包事件订阅成功');
                    resolve();
                } else {
                    console.error('Predict WS 订阅失败:', msg.error);
                    reject(new Error('Subscription failed'));
                }
                return;
            }

            // 钱包事件
            if (msg.type === 'M' && msg.topic?.startsWith('predictWalletEvents/')) {
                const eventData = msg.data;
                const eventType = eventData?.type || eventData?.event || eventData?.status || 'unknown';

                if (results.placeTime > 0 && results.predictWsTime === 0) {
                    results.predictWsTime = Date.now();
                    results.predictWsEvent = eventType;
                    const latency = results.predictWsTime - results.placeTime;
                    console.log(`\n[Predict WS] 收到事件: ${eventType}, 延迟: ${latency}ms`);
                    console.log(`  Data:`, JSON.stringify(eventData).slice(0, 200));
                }
            }
        });

        predictWs.on('error', (err) => {
            console.error('Predict WS 错误:', err.message);
        });
    });

    // 5. 启动 BSC WSS 监听
    console.log('\n启动 BSC WSS...');
    const bscWs = new WebSocket(BSC_WSS_URL);

    await new Promise<void>((resolve) => {
        bscWs.on('open', () => {
            console.log('BSC WSS 已连接');

            const paddedAddress = '0x' + '0'.repeat(24) + SMART_WALLET.slice(2).toLowerCase();

            // 作为 maker 订阅 (topic[2] = maker)
            bscWs.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_subscribe',
                params: ['logs', {
                    address: EXCHANGES,
                    topics: [ORDER_FILLED_TOPIC, null, paddedAddress],
                }],
            }));

            // 作为 taker 订阅 (topic[3] = taker)
            bscWs.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
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

    // 6. 下单
    console.log('\n' + '-'.repeat(40));
    console.log('提交订单...');
    results.placeTime = Date.now();

    const orderResult = await trader.placeOrder({
        marketId: market.id,
        side: 'BUY',
        price: orderPrice,
        quantity: orderQty,
        outcome: 'YES',
    });

    results.placeEndTime = Date.now();

    if (!orderResult.success || !orderResult.hash) {
        console.log(`下单失败: ${orderResult.error}`);
        predictWs.close();
        bscWs.close();
        return;
    }

    results.orderHash = orderResult.hash;
    const placeLatency = results.placeEndTime - results.placeTime;
    console.log(`下单成功! Hash: ${results.orderHash}`);
    console.log(`下单耗时: ${placeLatency}ms`);

    // 7. REST API 轮询
    console.log('\n开始 REST API 轮询...');

    for (let i = 0; i < 60; i++) {
        const status = await trader.getOrderStatus(results.orderHash);

        if (status && (status.status === 'FILLED' || status.status === 'PARTIALLY_FILLED')) {
            if (results.restApiTime === 0) {
                results.restApiTime = Date.now();
                const latency = results.restApiTime - results.placeTime;
                console.log(`\n[REST API] 订单已成交! 延迟: ${latency}ms`);
                console.log(`  Status: ${status.status}, FilledQty: ${status.filledQty}`);
            }
            break;
        }

        if (status && (status.status === 'CANCELLED' || status.status === 'EXPIRED')) {
            console.log(`\n[REST API] 订单 ${status.status}: ${status.cancelReason || 'unknown'}`);
            break;
        }

        await sleep(300); // 更频繁轮询
    }

    // 8. 等待所有通知
    console.log('\n等待所有通知到达 (5秒)...');
    await sleep(5000);

    predictWs.close();
    bscWs.close();

    // 9. 输出结果
    console.log('\n' + '='.repeat(60));
    console.log('延迟对比结果');
    console.log('='.repeat(60));

    console.log(`\n订单: ${results.orderHash}`);
    console.log(`下单时间: ${new Date(results.placeTime).toISOString()}`);
    console.log(`下单耗时: ${results.placeEndTime - results.placeTime}ms`);

    const latencies: { source: string; latency: number; note?: string }[] = [];

    if (results.predictWsTime > 0) {
        latencies.push({
            source: 'Predict WS',
            latency: results.predictWsTime - results.placeTime,
            note: results.predictWsEvent,
        });
    }
    if (results.bscWssTime > 0) {
        latencies.push({
            source: 'BSC WSS',
            latency: results.bscWssTime - results.placeTime,
        });
    }
    if (results.restApiTime > 0) {
        latencies.push({
            source: 'REST API',
            latency: results.restApiTime - results.placeTime,
        });
    }

    latencies.sort((a, b) => a.latency - b.latency);

    console.log('\n延迟排名 (从下单开始计时):');
    console.log('-'.repeat(40));
    latencies.forEach((r, i) => {
        const medal = ['🥇', '🥈', '🥉'][i] || '  ';
        const note = r.note ? ` (${r.note})` : '';
        console.log(`  ${medal} ${r.source}: ${r.latency}ms${note}`);
    });

    // 净延迟（减去下单耗时）
    const placeTime = results.placeEndTime - results.placeTime;
    console.log('\n净延迟 (从订单提交完成计时):');
    console.log('-'.repeat(40));
    latencies.forEach((r, i) => {
        const medal = ['🥇', '🥈', '🥉'][i] || '  ';
        const netLatency = r.latency - placeTime;
        console.log(`  ${medal} ${r.source}: ${netLatency}ms`);
    });

    if (latencies.length === 0) {
        console.log('\n⚠️ 未收到任何成交通知');
    }

    // 未收到的通知
    const missing = [];
    if (results.predictWsTime === 0) missing.push('Predict WS');
    if (results.bscWssTime === 0) missing.push('BSC WSS');
    if (results.restApiTime === 0) missing.push('REST API');

    if (missing.length > 0) {
        console.log(`\n⚠️ 以下渠道未收到通知: ${missing.join(', ')}`);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    if (!API_KEY || !SMART_WALLET || !PRIVATE_KEY) {
        console.error('错误: 缺少必要的环境变量');
        process.exit(1);
    }

    console.log('全渠道订单成交延迟对比测试');
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
