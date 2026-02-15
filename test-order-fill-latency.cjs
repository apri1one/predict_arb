/**
 * 下单成交延迟测试
 *
 * 实际下一个小额买单，测试各渠道的成交通知延迟:
 * 1. REST API 轮询
 * 2. BSC WSS (链上 OrderFilled 事件)
 *
 * ⚠️ 警告: 此测试会实际下单，请确认金额后再运行
 *
 * 用法:
 *   node test-order-fill-latency.cjs [marketId]
 */

require('dotenv').config({ path: '../.env' });
const WebSocket = require('ws');
const { Wallet, JsonRpcProvider, parseUnits, formatUnits, Interface } = require('ethers');

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.PREDICT_API_KEY;
const API_KEY_TRADE = process.env.PREDICT_API_KEY_TRADE || API_KEY;
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY;

const API_BASE = 'https://api.predict.fun';
const BSC_WSS_URL = 'wss://bsc-rpc.publicnode.com';
const BSC_RPC_URL = 'https://bsc-dataseed1.binance.org';

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

async function fetchJsonAuth(url, jwt, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY_TRADE,
            'Authorization': `Bearer ${jwt}`,
            ...options.headers,
        },
    });
    return res.json();
}

async function getJwt() {
    // 1. 获取签名消息
    const msgRes = await fetchJson(`${API_BASE}/v1/auth/message`);
    const message = msgRes.data?.message;
    if (!message) throw new Error('Failed to get auth message');

    // 2. 签名
    const provider = new JsonRpcProvider(BSC_RPC_URL);
    const wallet = new Wallet(PRIVATE_KEY, provider);

    // 使用 @predictdotfun/sdk 的签名方法会更准确
    // 这里简化为直接签名
    const signature = await wallet.signMessage(message);

    // 3. 提交认证
    const authRes = await fetch(`${API_BASE}/v1/auth`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY_TRADE,
        },
        body: JSON.stringify({
            signer: SMART_WALLET,
            signature,
            message,
        }),
    });

    const authData = await authRes.json();
    if (!authData.data?.token) {
        console.log('Auth response:', JSON.stringify(authData, null, 2));
        throw new Error('Failed to get JWT');
    }

    return authData.data.token;
}

async function findActiveMarket() {
    console.log('查找有活跃订单簿的市场...');

    const matches = await fetchJson(`${API_BASE}/v1/orders/matches?limit=20`);
    const marketIds = [...new Set(matches.data?.map(m => m.market?.id).filter(Boolean))];

    for (const id of marketIds.slice(0, 10)) {
        const ob = await fetchJson(`${API_BASE}/v1/markets/${id}/orderbook`);
        if (ob.data?.asks?.length > 0) {
            const market = await fetchJson(`${API_BASE}/v1/markets/${id}`);
            const askPrice = ob.data.asks[0][0];
            const askSize = ob.data.asks[0][1];

            const minQty = Math.ceil(1.1 / askPrice);

            if (askSize >= minQty && askPrice >= 0.01 && askPrice <= 0.95) {
                const outcomes = market.data?.outcomes || [];
                const yesOutcome = outcomes.find(o => o.name === 'Yes' || o.indexSet === 1);

                if (yesOutcome) {
                    return {
                        id,
                        title: market.data?.title,
                        askPrice,
                        askSize,
                        minQty,
                        isNegRisk: market.data?.isNegRisk || false,
                        yesTokenId: yesOutcome.onChainId,
                        feeRateBps: market.data?.feeRateBps || Math.round((market.data?.baseFeeRate || 0.02) * 10000),
                    };
                }
            }
        }
    }

    return null;
}

// ============================================================================
// 主测试
// ============================================================================

async function runTest(marketId) {
    console.log('\n' + '='.repeat(60));
    console.log('下单成交延迟测试');
    console.log('='.repeat(60));

    // 1. 获取市场信息
    let market;
    if (marketId) {
        const ob = await fetchJson(`${API_BASE}/v1/markets/${marketId}/orderbook`);
        const marketInfo = await fetchJson(`${API_BASE}/v1/markets/${marketId}`);
        const outcomes = marketInfo.data?.outcomes || [];
        const yesOutcome = outcomes.find(o => o.name === 'Yes' || o.indexSet === 1);

        market = {
            id: marketId,
            title: marketInfo.data?.title,
            askPrice: ob.data?.asks?.[0]?.[0],
            askSize: ob.data?.asks?.[0]?.[1],
            minQty: Math.ceil(1.1 / (ob.data?.asks?.[0]?.[0] || 0.5)),
            isNegRisk: marketInfo.data?.isNegRisk || false,
            yesTokenId: yesOutcome?.onChainId,
            feeRateBps: marketInfo.data?.feeRateBps || 200,
        };
    } else {
        market = await findActiveMarket();
    }

    if (!market || !market.askPrice) {
        console.log('未找到合适的市场或订单簿为空');
        return;
    }

    console.log(`\n市场: ${market.id} - ${market.title?.slice(0, 50)}...`);
    console.log(`卖一价: ${market.askPrice} @ ${market.askSize?.toFixed(2)}`);
    console.log(`Token ID: ${market.yesTokenId}`);
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

    // 2. 启动 BSC WSS 监听
    console.log('\n启动 BSC WSS 监听...');
    const bscWs = new WebSocket(BSC_WSS_URL);

    const results = {
        placeTime: 0,
        bscWssTime: 0,
        restApiTime: 0,
        orderHash: '',
    };

    await new Promise((resolve) => {
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
                        console.log(`  OrderHash: ${decoded.args[0].slice(0, 20)}...`);
                        console.log(`  TakerAmount: ${formatUnits(decoded.args[6], 18)}`);
                    } catch (e) {
                        // ignore
                    }
                }
            }
        });
    });

    // 3. 使用 SDK 下单
    console.log('\n使用 predict-trader 下单...');

    // 动态导入 predict-trader (ESM 模块)
    const { getPredictTrader } = await import('./src/dashboard/predict-trader.js');
    const trader = getPredictTrader();
    await trader.init();

    // 4. 下单
    console.log('\n提交订单...');
    results.placeTime = Date.now();

    const orderResult = await trader.placeOrder({
        marketId: market.id,
        side: 'BUY',
        price: orderPrice,
        quantity: orderQty,
        outcome: 'YES',
    });

    if (!orderResult.success) {
        console.log(`下单失败: ${orderResult.error}`);
        bscWs.close();
        return;
    }

    results.orderHash = orderResult.hash;
    const placeLatency = Date.now() - results.placeTime;
    console.log(`下单成功! Hash: ${results.orderHash}`);
    console.log(`下单耗时: ${placeLatency}ms`);

    // 5. REST API 轮询
    console.log('\n开始 REST API 轮询...');
    const pollStart = Date.now();
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

        await new Promise(r => setTimeout(r, 500));
    }

    // 6. 等待 BSC WSS
    if (results.bscWssTime === 0) {
        console.log('\n等待 BSC WSS 事件 (5秒)...');
        await new Promise(r => setTimeout(r, 5000));
    }

    bscWs.close();

    // 7. 输出结果
    console.log('\n' + '='.repeat(60));
    console.log('延迟对比结果');
    console.log('='.repeat(60));

    console.log(`\n订单: ${results.orderHash}`);
    console.log(`下单时间: ${new Date(results.placeTime).toISOString()}`);

    const latencies = [];

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

    if (!filled) {
        console.log('\n⚠️ 订单可能未成交，请检查订单状态');
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    if (!API_KEY || !SMART_WALLET || !PRIVATE_KEY) {
        console.error('错误: 缺少必要的环境变量');
        console.error('需要: PREDICT_API_KEY, PREDICT_SMART_WALLET_ADDRESS, PREDICT_SIGNER_PRIVATE_KEY');
        process.exit(1);
    }

    console.log('下单成交延迟测试');
    console.log('='.repeat(60));
    console.log(`Smart Wallet: ${SMART_WALLET.slice(0, 10)}...`);

    const args = process.argv.slice(2);
    const marketId = parseInt(args[0], 10) || null;

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
