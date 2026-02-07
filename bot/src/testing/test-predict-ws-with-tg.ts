/**
 * Predict WebSocket 钱包事件测试 - 带 Telegram 通知
 *
 * 收到事件时发送 TG 通知，明显标注来源
 *
 * 用法:
 *   npx tsx src/testing/test-predict-ws-with-tg.ts [marketId]
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import { WebSocket } from 'ws';
import { Interface, formatUnits } from 'ethers';
import { getPredictTrader } from '../dashboard/predict-trader.js';
import { PredictRestClient } from '../predict/rest-client.js';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.PREDICT_API_KEY || '';
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS || '';
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const PREDICT_WS_URL = 'wss://ws.predict.fun/ws';
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
    '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
    '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
].map(a => a.toLowerCase());

// ============================================================================
// Telegram 通知
// ============================================================================

async function sendTelegram(message: string): Promise<void> {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log('[TG] 未配置 Telegram，跳过发送');
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID,
                text: message,
                parse_mode: 'HTML',
            }),
        });

        if (!res.ok) {
            console.error('[TG] 发送失败:', await res.text());
        } else {
            console.log('[TG] 已发送通知');
        }
    } catch (e: any) {
        console.error('[TG] 发送异常:', e.message);
    }
}

// ============================================================================
// 工具函数
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp(): string {
    return new Date().toISOString().slice(11, 23);
}

// ============================================================================
// 主测试
// ============================================================================

async function main(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Predict WS + BSC WSS 延迟对比测试 (带 TG 通知)');
    console.log('='.repeat(60));

    if (!API_KEY || !SMART_WALLET) {
        console.error('错误: 缺少环境变量');
        process.exit(1);
    }

    console.log(`\nSmart Wallet: ${SMART_WALLET}`);
    console.log(`Telegram: ${TG_BOT_TOKEN ? '已配置' : '未配置'}`);

    // 发送测试开始通知
    await sendTelegram(`🧪 <b>[TEST START]</b>\n开始 Predict WS vs BSC WSS 延迟测试`);

    // 1. 初始化 trader 获取 JWT
    console.log('\n[1] 初始化 PredictTrader...');
    const trader = getPredictTrader();
    await trader.init();

    // @ts-ignore
    const jwt = trader.jwt as string;
    if (!jwt) {
        console.error('无法获取 JWT');
        process.exit(1);
    }
    console.log(`JWT: ${jwt.slice(0, 20)}...`);

    // 记录时间
    const results = {
        placeTime: 0,
        predictWsTime: 0,
        predictWsEvent: '',
        bscWssTime: 0,
        orderHash: '',
    };

    // 2. 连接 Predict WebSocket
    console.log('\n[2] 连接 Predict WebSocket...');
    const predictWs = new WebSocket(`${PREDICT_WS_URL}?apiKey=${encodeURIComponent(API_KEY)}`);

    await new Promise<void>((resolve, reject) => {
        predictWs.on('open', () => {
            console.log(`[${timestamp()}] Predict WS 已连接`);

            predictWs.send(JSON.stringify({
                method: 'subscribe',
                requestId: 1,
                params: [`predictWalletEvents/${jwt}`],
            }));
        });

        predictWs.on('message', async (data) => {
            const msg = JSON.parse(data.toString());

            // 心跳
            if (msg.type === 'M' && msg.topic === 'heartbeat') {
                predictWs.send(JSON.stringify({ method: 'heartbeat', data: msg.data }));
                return;
            }

            // 订阅响应
            if (msg.type === 'R' && msg.requestId === 1) {
                if (msg.success) {
                    console.log(`[${timestamp()}] Predict WS 订阅成功`);
                    resolve();
                } else {
                    reject(new Error('订阅失败'));
                }
                return;
            }

            // 钱包事件
            if (msg.type === 'M' && msg.topic?.startsWith('predictWalletEvents/')) {
                const eventData = msg.data;
                const eventType = eventData?.type || 'unknown';

                if (results.placeTime > 0 && results.predictWsTime === 0) {
                    results.predictWsTime = Date.now();
                    results.predictWsEvent = eventType;
                    const latency = results.predictWsTime - results.placeTime;

                    console.log(`\n[${timestamp()}] 🔵 PREDICT WS 事件: ${eventType}, 延迟: ${latency}ms`);

                    // 发送 TG 通知 - 明显标注来源
                    await sendTelegram(
                        `🔵🔵🔵 <b>[PREDICT WS]</b> 🔵🔵🔵\n\n` +
                        `<b>事件类型:</b> ${eventType}\n` +
                        `<b>延迟:</b> ${latency}ms\n` +
                        `<b>订单ID:</b> ${eventData?.orderId || 'N/A'}\n` +
                        `<b>数量:</b> ${eventData?.details?.quantity || 'N/A'}\n` +
                        `<b>价格:</b> ${eventData?.details?.price || 'N/A'}\n\n` +
                        `<i>来源: Predict 官方 WebSocket</i>`
                    );
                }
            }
        });

        predictWs.on('error', (err) => {
            console.error('Predict WS 错误:', err.message);
        });
    });

    // 3. 连接 BSC WebSocket
    console.log('\n[3] 连接 BSC WebSocket...');
    const bscWs = new WebSocket(BSC_WSS_URL);

    await new Promise<void>((resolve) => {
        bscWs.on('open', () => {
            console.log(`[${timestamp()}] BSC WSS 已连接`);

            const paddedAddress = '0x' + '0'.repeat(24) + SMART_WALLET.slice(2).toLowerCase();

            // maker 订阅
            bscWs.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_subscribe',
                params: ['logs', {
                    address: EXCHANGES,
                    topics: [ORDER_FILLED_TOPIC, null, paddedAddress],
                }],
            }));

            // taker 订阅
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

        bscWs.on('message', async (data) => {
            const msg = JSON.parse(data.toString());

            if (msg.method === 'eth_subscription' && results.placeTime > 0) {
                const log = msg.params?.result;
                if (log && results.bscWssTime === 0) {
                    results.bscWssTime = Date.now();
                    const latency = results.bscWssTime - results.placeTime;

                    let takerAmount = 'N/A';
                    try {
                        const decoded = orderFilledInterface.parseLog({ topics: log.topics, data: log.data });
                        if (decoded) {
                            takerAmount = formatUnits(decoded.args[6], 18);
                        }
                    } catch { /* ignore */ }

                    console.log(`\n[${timestamp()}] 🟠 BSC WSS 事件: OrderFilled, 延迟: ${latency}ms`);

                    // 发送 TG 通知 - 明显标注来源
                    await sendTelegram(
                        `🟠🟠🟠 <b>[BSC WSS]</b> 🟠🟠🟠\n\n` +
                        `<b>事件类型:</b> OrderFilled\n` +
                        `<b>延迟:</b> ${latency}ms\n` +
                        `<b>成交数量:</b> ${takerAmount}\n` +
                        `<b>交易哈希:</b> ${log.transactionHash?.slice(0, 20)}...\n\n` +
                        `<i>来源: BSC 链上事件</i>`
                    );
                }
            }
        });

        bscWs.on('error', (err) => {
            console.error('BSC WSS 错误:', err.message);
            resolve();
        });
    });

    // 4. 查找市场并下单
    console.log('\n[4] 查找市场...');
    const client = new PredictRestClient({ apiKey: API_KEY });

    const args = process.argv.slice(2);
    const marketIdArg = parseInt(args[0], 10) || undefined;

    let marketId: number;
    let askPrice: number;
    let orderQty: number;

    if (marketIdArg) {
        marketId = marketIdArg;
        const ob = await client.getOrderBook(marketId);
        askPrice = ob.asks![0][0];
        orderQty = Math.max(Math.ceil(1.1 / askPrice), 2);
    } else {
        const matches = await client.getOrderMatches({ limit: 20 });
        const marketIds = [...new Set(matches.map(m => m.market?.id).filter(Boolean))] as number[];

        for (const id of marketIds.slice(0, 10)) {
            try {
                const ob = await client.getOrderBook(id);
                if (ob.asks?.length > 0 && ob.asks[0][0] >= 0.01 && ob.asks[0][0] <= 0.95) {
                    marketId = id;
                    askPrice = ob.asks[0][0];
                    orderQty = Math.max(Math.ceil(1.1 / askPrice), 2);
                    break;
                }
            } catch { /* ignore */ }
        }
    }

    const orderValue = askPrice! * orderQty!;
    console.log(`市场: ${marketId!}, 价格: ${askPrice!}, 数量: ${orderQty!}, 价值: $${orderValue.toFixed(2)}`);

    if (orderValue > 3) {
        console.log('⚠️ 订单金额超过 $3，跳过');
        predictWs.close();
        bscWs.close();
        process.exit(0);
    }

    // 5. 下单
    console.log('\n[5] 提交订单...');
    results.placeTime = Date.now();

    const result = await trader.placeOrder({
        marketId: marketId!,
        side: 'BUY',
        price: askPrice!,
        quantity: orderQty!,
        outcome: 'YES',
    });

    const placeLatency = Date.now() - results.placeTime;
    results.orderHash = result.hash || '';

    if (!result.success) {
        console.error(`下单失败: ${result.error}`);
        await sendTelegram(`❌ 下单失败: ${result.error}`);
    } else {
        console.log(`✅ 下单成功! Hash: ${result.hash}, 耗时: ${placeLatency}ms`);

        await sendTelegram(
            `📝 <b>[下单成功]</b>\n\n` +
            `<b>市场:</b> ${marketId!}\n` +
            `<b>操作:</b> BUY ${orderQty!} YES @ ${askPrice!}\n` +
            `<b>价值:</b> $${orderValue.toFixed(2)}\n` +
            `<b>Hash:</b> ${result.hash?.slice(0, 20)}...\n` +
            `<b>下单耗时:</b> ${placeLatency}ms\n\n` +
            `<i>等待 WS 事件通知...</i>`
        );
    }

    // 6. 等待事件
    console.log('\n[6] 等待 WS 事件 (30秒)...');
    await sleep(30000);

    // 7. 汇总
    console.log('\n' + '='.repeat(60));
    console.log('延迟对比结果');
    console.log('='.repeat(60));

    const summary: string[] = [];

    if (results.predictWsTime > 0) {
        const latency = results.predictWsTime - results.placeTime;
        console.log(`🔵 Predict WS: ${latency}ms (${results.predictWsEvent})`);
        summary.push(`🔵 Predict WS: ${latency}ms`);
    } else {
        console.log(`🔵 Predict WS: 未收到`);
        summary.push(`🔵 Predict WS: 未收到`);
    }

    if (results.bscWssTime > 0) {
        const latency = results.bscWssTime - results.placeTime;
        console.log(`🟠 BSC WSS: ${latency}ms`);
        summary.push(`🟠 BSC WSS: ${latency}ms`);
    } else {
        console.log(`🟠 BSC WSS: 未收到`);
        summary.push(`🟠 BSC WSS: 未收到`);
    }

    // 发送汇总
    await sendTelegram(
        `📊 <b>[测试结果]</b>\n\n` +
        summary.join('\n') + '\n\n' +
        `<b>下单耗时:</b> ${placeLatency}ms\n` +
        `<b>订单Hash:</b> ${results.orderHash.slice(0, 20)}...`
    );

    predictWs.close();
    bscWs.close();

    console.log('\n测试完成!');
    process.exit(0);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
