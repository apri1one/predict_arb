/**
 * Polygon 链上 WSS vs Polymarket API 延迟对比测试
 *
 * 测试流程：
 * 1. 连接 Polygon Alchemy WSS，订阅 OrderFilled 事件
 * 2. 连接 Polymarket User Channel WS（作为对照）
 * 3. 下一个不会成交的限价单 (GTC, 低价)
 * 4. 比较：
 *    - Polygon 链上 WSS（只有成交时才有事件）
 *    - Polymarket User Channel WS（订单状态变更）
 *    - Polymarket API 轮询
 * 5. 取消订单并清理
 *
 * 注意：链上 OrderFilled 事件只在订单成交时触发
 *      对于不成交的限价单，只有 User Channel 会有事件
 *
 * 使用方法：
 * npx tsx src/testing/test-polygon-wss-latency.ts
 */

import { Wallet } from 'ethers';
import * as crypto from 'crypto';
import { Interface, formatUnits } from 'ethers';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

// ============================================================================
// 配置
// ============================================================================

const CLOB_BASE_URL = 'https://clob.polymarket.com';
const WS_USER_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const CHAIN_ID = 137; // Polygon

// Polymarket Exchange 合约地址 (Polygon)
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// OrderFilled 事件签名（与 Predict 相同的 ABI）
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';

const ORDER_FILLED_ABI = [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

const orderFilledInterface = new Interface(ORDER_FILLED_ABI);

// Polygon Alchemy WSS URL
const POLYGON_WSS_URL = process.env.POLYGON_WSS_URL ||
    'wss://polygon-mainnet.g.alchemy.com/v2/erI6C5ZK7xg6o8Ql-yuBcclJPhtDGg73';

// 测试参数
// Polymarket 最小订单 ~$5 USDC
const TEST_PRICE = 0.02;       // 2 分钱，不会成交
const TEST_QUANTITY = 300;     // 300 shares × $0.02 = $6 USDC
const TEST_SIDE = 'BUY';

// EIP-712 Order 类型
const ORDER_TYPES = {
    Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
    ],
};

// ============================================================================
// 类型定义
// ============================================================================

interface OrderFilledEvent {
    orderHash: string;
    maker: string;
    taker: string;
    makerAssetId: string;
    takerAssetId: string;
    makerAmountFilled: number;
    takerAmountFilled: number;
    fee: number;
    blockNumber: number;
    txHash: string;
    timestamp: number;
}

interface WsEvent {
    source: 'polygon' | 'user-channel';
    type: string;
    time: number;
    data: any;
}

// ============================================================================
// 工具函数
// ============================================================================

function formatMs(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function buildHmacHeaders(
    apiKey: string,
    secret: string,
    passphrase: string,
    traderAddress: string,
    method: string,
    path: string,
    body?: string
): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method + path + (body || '');
    const signature = crypto
        .createHmac('sha256', Buffer.from(secret, 'base64'))
        .update(message, 'utf-8')
        .digest('base64');
    const urlSafeSignature = signature.replace(/\+/g, '-').replace(/\//g, '_');

    return {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'POLY_API_KEY': apiKey,
        'POLY_SIGNATURE': urlSafeSignature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': passphrase,
        'POLY_ADDRESS': traderAddress,
    };
}

// ============================================================================
// Polygon WSS 连接
// ============================================================================

async function connectPolygonWss(
    proxyAddress: string,
    onEvent: (event: OrderFilledEvent) => void
): Promise<WebSocket | null> {
    return new Promise((resolve) => {
        console.log(`   连接: ${POLYGON_WSS_URL.slice(0, 50)}...`);

        const ws = new WebSocket(POLYGON_WSS_URL);
        let resolved = false;
        let subscriptionId: string | null = null;
        let requestId = 1;

        ws.onopen = () => {
            console.log('   ✅ Polygon WSS 已连接');

            // 订阅 OrderFilled 事件（监控所有 Exchange 合约）
            const subscribeRequest = {
                jsonrpc: '2.0',
                id: requestId++,
                method: 'eth_subscribe',
                params: [
                    'logs',
                    {
                        address: [CTF_EXCHANGE.toLowerCase(), NEG_RISK_EXCHANGE.toLowerCase()],
                        topics: [ORDER_FILLED_TOPIC],
                    },
                ],
            };

            ws.send(JSON.stringify(subscribeRequest));
            console.log('   📤 已发送订阅请求 (OrderFilled events)');
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data.toString());

                // 订阅确认
                if (msg.id === 1 && msg.result) {
                    subscriptionId = msg.result;
                    console.log(`   📥 订阅成功: ${subscriptionId}`);
                    if (!resolved) {
                        resolved = true;
                        resolve(ws);
                    }
                    return;
                }

                // 链上事件
                if (msg.method === 'eth_subscription' && msg.params?.result) {
                    const log = msg.params.result;
                    const timestamp = Date.now();

                    try {
                        const decoded = orderFilledInterface.parseLog({
                            topics: log.topics,
                            data: log.data,
                        });

                        if (decoded) {
                            const filledEvent: OrderFilledEvent = {
                                orderHash: decoded.args[0],
                                maker: decoded.args[1],
                                taker: decoded.args[2],
                                makerAssetId: decoded.args[3].toString(),
                                takerAssetId: decoded.args[4].toString(),
                                makerAmountFilled: Number(formatUnits(decoded.args[5], 6)),
                                takerAmountFilled: Number(formatUnits(decoded.args[6], 6)),
                                fee: Number(formatUnits(decoded.args[7], 6)),
                                blockNumber: parseInt(log.blockNumber, 16),
                                txHash: log.transactionHash,
                                timestamp,
                            };

                            console.log(`   📥 [POLYGON] OrderFilled 事件!`);
                            console.log(`      OrderHash: ${filledEvent.orderHash.slice(0, 20)}...`);
                            console.log(`      Maker: ${filledEvent.maker.slice(0, 15)}...`);
                            console.log(`      Block: ${filledEvent.blockNumber}`);
                            onEvent(filledEvent);
                        }
                    } catch {
                        // 解析失败，忽略
                    }
                }
            } catch {
                // JSON 解析失败
            }
        };

        ws.onerror = (err: any) => {
            console.log(`   ❌ Polygon WSS 错误: ${err.message || 'unknown'}`);
        };

        ws.onclose = (event) => {
            console.log(`   ⚠️ Polygon WSS 关闭: code=${event.code}`);
            if (!resolved) {
                resolve(null);
            }
        };

        // 连接超时
        setTimeout(() => {
            if (!resolved) {
                console.log('   ❌ Polygon WSS 连接超时');
                ws.close();
                resolve(null);
            }
        }, 10000);
    });
}

// ============================================================================
// Polymarket User Channel 连接
// ============================================================================

async function connectUserChannel(
    apiKey: string,
    secret: string,
    passphrase: string,
    onEvent: (event: any) => void
): Promise<WebSocket | null> {
    return new Promise((resolve) => {
        const ws = new WebSocket(WS_USER_URL);
        let resolved = false;

        ws.onopen = () => {
            console.log('   ✅ User Channel 已连接');

            const subscribeMsg = {
                type: 'USER',
                markets: [],
                auth: {
                    apiKey,
                    secret,
                    passphrase,
                },
            };
            ws.send(JSON.stringify(subscribeMsg));
            console.log('   📤 已发送订阅请求 (User Channel)');

            // User Channel 不发送订阅确认
            if (!resolved) {
                resolved = true;
                resolve(ws);
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data.toString());
                console.log(`   📥 [USER-CH] ${data.event_type || data.type || 'unknown'}`);
                onEvent(data);
            } catch {
                // 忽略
            }
        };

        ws.onerror = (err: any) => {
            console.log(`   ❌ User Channel 错误: ${err.message || 'unknown'}`);
        };

        ws.onclose = (event) => {
            console.log(`   ⚠️ User Channel 关闭: code=${event.code}`);
            if (!resolved) {
                resolve(null);
            }
        };

        setTimeout(() => {
            if (!resolved) {
                console.log('   ❌ User Channel 连接超时');
                ws.close();
                resolve(null);
            }
        }, 5000);
    });
}

// ============================================================================
// 订单操作
// ============================================================================

async function getTestToken(): Promise<{ tokenId: string; negRisk: boolean; conditionId: string } | null> {
    try {
        const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50');
        if (!gammaRes.ok) return null;

        const gammaMarkets = await gammaRes.json() as any[];

        for (const m of gammaMarkets) {
            if (m.acceptingOrders && m.enableOrderBook && m.clobTokenIds) {
                let tokens: string[];
                try {
                    tokens = JSON.parse(m.clobTokenIds);
                } catch {
                    continue;
                }
                if (tokens.length === 0) continue;

                console.log(`   找到市场: ${m.question?.slice(0, 50)}...`);
                console.log(`   negRisk: ${m.negRisk}`);
                return {
                    tokenId: tokens[0],
                    negRisk: m.negRisk || false,
                    conditionId: m.conditionId,
                };
            }
        }

        return null;
    } catch (e: any) {
        console.log(`   获取市场异常: ${e.message}`);
        return null;
    }
}

async function placeTestOrder(
    wallet: Wallet,
    apiKey: string,
    secret: string,
    passphrase: string,
    traderAddress: string,
    proxyAddress: string,
    tokenId: string,
    price: number,
    quantity: number,
    negRisk: boolean
): Promise<string | null> {
    try {
        const alignedQty = Math.floor(quantity * 100) / 100;
        const sizeInUnits = BigInt(Math.round(alignedQty * 1e6));
        const priceInUnits = BigInt(Math.floor(price * 1e6));

        const makerAmount = (sizeInUnits * priceInUnits) / BigInt(1e6);
        const takerAmount = sizeInUnits;

        const salt = Math.round(Math.random() * Date.now());
        const expiration = BigInt(0);

        const orderForSigning = {
            salt: salt,
            maker: proxyAddress,
            signer: wallet.address,
            taker: '0x0000000000000000000000000000000000000000',
            tokenId: BigInt(tokenId),
            makerAmount: makerAmount,
            takerAmount: takerAmount,
            expiration: expiration,
            nonce: 0,
            feeRateBps: 0,
            side: 0,
            signatureType: 2,
        };

        const verifyingContract = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE;
        const domain = {
            name: 'Polymarket CTF Exchange',
            version: '1',
            chainId: CHAIN_ID,
            verifyingContract,
        };

        const signature = await wallet.signTypedData(domain, ORDER_TYPES, orderForSigning);

        const body = JSON.stringify({
            order: {
                salt: salt,
                maker: proxyAddress,
                signer: wallet.address,
                taker: '0x0000000000000000000000000000000000000000',
                tokenId,
                makerAmount: makerAmount.toString(),
                takerAmount: takerAmount.toString(),
                expiration: expiration.toString(),
                nonce: '0',
                feeRateBps: '0',
                side: 'BUY',
                signatureType: 2,
                signature,
            },
            owner: apiKey,
            orderType: 'GTC',
        });

        const path = '/order';
        const headers = buildHmacHeaders(apiKey, secret, passphrase, traderAddress, 'POST', path, body);

        const res = await fetch(`${CLOB_BASE_URL}${path}`, {
            method: 'POST',
            headers,
            body,
        });

        if (!res.ok) {
            const text = await res.text();
            console.error(`   ❌ 下单失败: ${res.status} - ${text.slice(0, 100)}`);
            return null;
        }

        const data = await res.json() as any;
        return data.orderID || data.id || data.order_id;
    } catch (e: any) {
        console.error(`   ❌ 下单异常: ${e.message}`);
        return null;
    }
}

async function cancelOrder(
    apiKey: string,
    secret: string,
    passphrase: string,
    traderAddress: string,
    orderId: string
): Promise<boolean> {
    try {
        const body = JSON.stringify({ orderID: orderId });
        const path = '/order';
        const headers = buildHmacHeaders(apiKey, secret, passphrase, traderAddress, 'DELETE', path, body);

        const res = await fetch(`${CLOB_BASE_URL}${path}`, {
            method: 'DELETE',
            headers,
            body,
        });

        return res.ok;
    } catch {
        return false;
    }
}

async function getOrderStatus(
    apiKey: string,
    secret: string,
    passphrase: string,
    traderAddress: string,
    orderId: string
): Promise<{ status: string; filledQty: number } | null> {
    try {
        const path = `/data/order/${orderId}`;
        const headers = buildHmacHeaders(apiKey, secret, passphrase, traderAddress, 'GET', path);

        const res = await fetch(`${CLOB_BASE_URL}${path}`, { headers });
        if (!res.ok) return null;

        const data = await res.json() as any;
        return {
            status: data.status || 'UNKNOWN',
            filledQty: parseFloat(data.size_matched || '0'),
        };
    } catch {
        return null;
    }
}

// ============================================================================
// 主测试
// ============================================================================

async function main(): Promise<void> {
    console.log('╔════════════════════════════════════════════════════════════════════╗');
    console.log('║     Polygon 链上 WSS vs Polymarket API 延迟对比测试                 ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');

    // 检查环境变量
    const apiKey = process.env.POLYMARKET_API_KEY;
    const secret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_PASSPHRASE;
    const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;
    const privateKey = process.env.POLYMARKET_TRADER_PRIVATE_KEY;

    if (!apiKey || !secret || !passphrase || !proxyAddress || !privateKey) {
        console.error('❌ 缺少必要的环境变量');
        return;
    }

    const wallet = new Wallet(privateKey);
    const traderAddress = process.env.POLYMARKET_TRADER_ADDRESS || wallet.address;

    console.log(`📍 代理钱包: ${proxyAddress}`);
    console.log(`📍 签名地址: ${wallet.address}`);
    console.log(`📍 Polygon WSS: ${POLYGON_WSS_URL.slice(0, 50)}...`);
    console.log('');

    // 收集事件
    const events: WsEvent[] = [];

    // 1. 连接 Polygon WSS
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📡 步骤 1: 连接 Polygon 链上 WSS (Alchemy)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const polygonWs = await connectPolygonWss(proxyAddress, (event) => {
        events.push({
            source: 'polygon',
            type: 'OrderFilled',
            time: event.timestamp,
            data: event,
        });
    });

    if (!polygonWs) {
        console.error('❌ Polygon WSS 连接失败');
        return;
    }

    // 2. 连接 Polymarket User Channel
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📡 步骤 2: 连接 Polymarket User Channel');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const userChannelWs = await connectUserChannel(apiKey, secret, passphrase, (event) => {
        events.push({
            source: 'user-channel',
            type: event.event_type || event.type || 'unknown',
            time: Date.now(),
            data: event,
        });
    });

    if (!userChannelWs) {
        console.error('❌ User Channel 连接失败');
        polygonWs.close();
        return;
    }

    // 等待 WebSocket 稳定
    await sleep(2000);

    // 3. 获取测试市场
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 步骤 3: 获取测试市场');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const testMarket = await getTestToken();
    if (!testMarket) {
        console.error('❌ 无法获取测试市场');
        polygonWs.close();
        userChannelWs.close();
        return;
    }

    const { tokenId, negRisk } = testMarket;
    console.log(`   Token ID: ${tokenId.slice(0, 25)}...`);

    // 4. 下单测试
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📝 步骤 4: 下单并监听');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   价格: $${TEST_PRICE} (低价，预期不会成交)`);
    console.log(`   数量: ${TEST_QUANTITY} shares`);
    console.log(`   金额: $${(TEST_PRICE * TEST_QUANTITY).toFixed(2)} USDC`);

    events.length = 0; // 清空之前的事件

    const orderSubmitTime = Date.now();
    console.log(`\n⏱️ 下单时间: ${new Date(orderSubmitTime).toISOString()}`);

    const orderId = await placeTestOrder(
        wallet,
        apiKey,
        secret,
        passphrase,
        traderAddress,
        proxyAddress,
        tokenId,
        TEST_PRICE,
        TEST_QUANTITY,
        negRisk
    );

    if (!orderId) {
        console.error('❌ 下单失败');
        polygonWs.close();
        userChannelWs.close();
        return;
    }

    const orderResponseTime = Date.now();
    console.log(`   ✅ 订单已提交: ${orderId}`);
    console.log(`   HTTP 响应: ${formatMs(orderResponseTime - orderSubmitTime)}`);

    // 等待事件
    console.log('\n   等待 WebSocket 事件 (5秒)...');
    await sleep(5000);

    // 轮询 API 获取状态
    const apiStatus = await getOrderStatus(apiKey, secret, passphrase, traderAddress, orderId);
    const apiQueryTime = Date.now();

    // 5. 分析结果
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 步骤 5: 延迟分析');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // 统计各来源的事件
    const polygonEvents = events.filter(e => e.source === 'polygon');
    const userChannelEvents = events.filter(e => e.source === 'user-channel');

    console.log(`\n📥 收到的事件:`);
    console.log(`   Polygon 链上: ${polygonEvents.length} 个 OrderFilled 事件`);
    console.log(`   User Channel: ${userChannelEvents.length} 个事件`);

    if (userChannelEvents.length > 0) {
        for (const e of userChannelEvents) {
            const latency = e.time - orderSubmitTime;
            console.log(`     - ${e.type}: ${formatMs(latency)} (延迟)`);
        }
    }

    if (polygonEvents.length > 0) {
        for (const e of polygonEvents) {
            const latency = e.time - orderSubmitTime;
            console.log(`     - OrderFilled: ${formatMs(latency)} (延迟)`);
        }
    }

    console.log(`\n📊 API 查询结果:`);
    console.log(`   状态: ${apiStatus?.status || 'N/A'}`);
    console.log(`   已成交: ${apiStatus?.filledQty || 0}`);
    console.log(`   查询延迟: ${formatMs(apiQueryTime - orderSubmitTime)}`);

    // 6. 取消订单
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🗑️ 步骤 6: 取消订单');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    events.length = 0;
    const cancelTime = Date.now();

    const cancelled = await cancelOrder(apiKey, secret, passphrase, traderAddress, orderId);
    const cancelResponseTime = Date.now();

    console.log(`   取消结果: ${cancelled ? '✅ 成功' : '❌ 失败'}`);
    console.log(`   HTTP 响应: ${formatMs(cancelResponseTime - cancelTime)}`);

    // 等待取消事件
    await sleep(2000);

    const cancelEvents = events.filter(e => e.source === 'user-channel');
    if (cancelEvents.length > 0) {
        for (const e of cancelEvents) {
            const latency = e.time - cancelTime;
            console.log(`   📥 User Channel: ${e.type} (${formatMs(latency)})`);
        }
    }

    // 7. 总结
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 测试总结');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    console.log(`
┌─────────────────────────────────────────────────────────────────────────┐
│  数据源               │ 用途                    │ 事件类型              │
├─────────────────────────────────────────────────────────────────────────┤
│  Polygon WSS (链上)   │ 监控订单成交            │ OrderFilled           │
│  User Channel WS      │ 订单状态变更            │ PLACEMENT/CANCELLATION│
│  CLOB API             │ 订单详情查询            │ REST 轮询             │
└─────────────────────────────────────────────────────────────────────────┘

💡 结论:
   1. Polygon 链上 WSS 已成功连接 (Alchemy)
   2. 订阅 CTF_EXCHANGE & NEG_RISK_EXCHANGE 的 OrderFilled 事件
   3. 对于不成交的限价单：
      - 链上 WSS: 无事件（订单未成交 = 无链上交易）
      - User Channel: 有 PLACEMENT/CANCELLATION 事件
   4. 如果需要监控订单成交，链上 WSS 是最快的数据源
`);

    // 关闭连接
    polygonWs.close();
    userChannelWs.close();

    console.log('✅ 测试完成\n');
}

main().catch(console.error);
