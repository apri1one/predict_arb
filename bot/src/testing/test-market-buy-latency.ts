/**
 * 市价买入延迟测试 - 对比 Polygon WSS vs User Channel vs API
 *
 * 测试流程：
 * 1. 搜索 Fed 相关市场
 * 2. 连接 Polygon 链上 WSS 和 User Channel
 * 3. 市价买入指定数量
 * 4. 对比各数据源的成交确认延迟
 *
 * 使用方法：
 * npx tsx src/testing/test-market-buy-latency.ts
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
const CHAIN_ID = 137;

const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';

const ORDER_FILLED_ABI = [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

const orderFilledInterface = new Interface(ORDER_FILLED_ABI);

const POLYGON_WSS_URL = process.env.POLYGON_WSS_URL ||
    'wss://polygon-mainnet.g.alchemy.com/v2/erI6C5ZK7xg6o8Ql-yuBcclJPhtDGg73';

// 测试参数
const TEST_QUANTITY = 2;  // 买入 2 shares

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
// 搜索 Fed 市场
// ============================================================================

async function findFedMarket(): Promise<{
    question: string;
    tokenId: string;
    negRisk: boolean;
    conditionId: string;
    bestAsk: number;
} | null> {
    console.log('🔍 搜索 Fed 相关市场...');

    try {
        const res = await fetch('https://gamma-api.polymarket.com/markets?_limit=100&active=true&closed=false');
        const markets = await res.json() as any[];

        // 搜索 Fed/FOMC 相关且 January 相关的市场
        const fedMarkets = markets.filter(m =>
            m.question &&
            m.acceptingOrders &&
            m.enableOrderBook &&
            (
                m.question.toLowerCase().includes('fed') ||
                m.question.toLowerCase().includes('fomc') ||
                m.question.toLowerCase().includes('interest rate')
            ) &&
            (
                m.question.toLowerCase().includes('january') ||
                m.question.toLowerCase().includes('jan ')
            )
        );

        console.log(`   找到 ${fedMarkets.length} 个 Fed+January 相关市场`);

        // 如果没有找到，放宽条件
        let targetMarkets = fedMarkets;
        if (fedMarkets.length === 0) {
            targetMarkets = markets.filter(m =>
                m.question &&
                m.acceptingOrders &&
                m.enableOrderBook &&
                (
                    m.question.toLowerCase().includes('fed') ||
                    m.question.toLowerCase().includes('fomc')
                )
            );
            console.log(`   放宽条件后找到 ${targetMarkets.length} 个 Fed 相关市场`);
        }

        for (const m of targetMarkets) {
            let tokens: string[];
            try {
                tokens = JSON.parse(m.clobTokenIds);
            } catch {
                continue;
            }
            if (tokens.length === 0) continue;

            // 获取订单簿检查流动性
            const yesTokenId = tokens[0];
            const bookRes = await fetch(`${CLOB_BASE_URL}/book?token_id=${yesTokenId}`);
            if (!bookRes.ok) continue;

            const book = await bookRes.json() as { asks: { price: string; size: string }[] };
            if (!book.asks || book.asks.length === 0) continue;

            const bestAsk = parseFloat(book.asks[0].price);
            const bestAskSize = parseFloat(book.asks[0].size);

            // 需要有足够的流动性来买 TEST_QUANTITY shares
            if (bestAskSize >= TEST_QUANTITY) {
                console.log(`\n   ✅ 找到市场: ${m.question?.slice(0, 70)}...`);
                console.log(`   Token ID: ${yesTokenId.slice(0, 25)}...`);
                console.log(`   Best Ask: $${bestAsk} (size: ${bestAskSize})`);
                console.log(`   negRisk: ${m.negRisk}`);

                return {
                    question: m.question,
                    tokenId: yesTokenId,
                    negRisk: m.negRisk || false,
                    conditionId: m.conditionId,
                    bestAsk,
                };
            }
        }

        console.log('   ❌ 没有找到流动性足够的 Fed 市场');
        return null;
    } catch (e: any) {
        console.error(`   搜索异常: ${e.message}`);
        return null;
    }
}

// ============================================================================
// Polygon WSS 连接
// ============================================================================

async function connectPolygonWss(
    proxyAddress: string,
    onEvent: (event: any) => void
): Promise<WebSocket | null> {
    return new Promise((resolve) => {
        const ws = new WebSocket(POLYGON_WSS_URL);
        let resolved = false;

        ws.onopen = () => {
            console.log('   ✅ Polygon WSS 已连接');

            const subscribeRequest = {
                jsonrpc: '2.0',
                id: 1,
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
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data.toString());

                if (msg.id === 1 && msg.result) {
                    console.log(`   📥 订阅成功: ${msg.result}`);
                    if (!resolved) {
                        resolved = true;
                        resolve(ws);
                    }
                    return;
                }

                if (msg.method === 'eth_subscription' && msg.params?.result) {
                    const log = msg.params.result;
                    const timestamp = Date.now();

                    try {
                        const decoded = orderFilledInterface.parseLog({
                            topics: log.topics,
                            data: log.data,
                        });

                        if (decoded) {
                            onEvent({
                                orderHash: decoded.args[0],
                                maker: decoded.args[1],
                                taker: decoded.args[2],
                                makerAssetId: decoded.args[3].toString(),
                                takerAssetId: decoded.args[4].toString(),
                                makerAmountFilled: Number(formatUnits(decoded.args[5], 6)),
                                takerAmountFilled: Number(formatUnits(decoded.args[6], 6)),
                                blockNumber: parseInt(log.blockNumber, 16),
                                txHash: log.transactionHash,
                                timestamp,
                            });
                        }
                    } catch { /* ignore */ }
                }
            } catch { /* ignore */ }
        };

        ws.onerror = () => { /* ignore */ };

        ws.onclose = () => {
            if (!resolved) resolve(null);
        };

        setTimeout(() => {
            if (!resolved) {
                ws.close();
                resolve(null);
            }
        }, 10000);
    });
}

// ============================================================================
// User Channel 连接
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

            ws.send(JSON.stringify({
                type: 'USER',
                markets: [],
                auth: { apiKey, secret, passphrase },
            }));

            if (!resolved) {
                resolved = true;
                resolve(ws);
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data.toString());
                onEvent(data);
            } catch { /* ignore */ }
        };

        ws.onerror = () => { /* ignore */ };
        ws.onclose = () => { if (!resolved) resolve(null); };

        setTimeout(() => {
            if (!resolved) {
                ws.close();
                resolve(null);
            }
        }, 5000);
    });
}

// ============================================================================
// 下市价单
// ============================================================================

async function placeMarketBuyOrder(
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
        // 市价单用 IOC，价格设高一点确保成交
        const marketPrice = Math.min(price * 1.1, 0.99); // 高于 best ask 10%，但不超过 0.99

        const alignedQty = Math.floor(quantity * 100) / 100;
        const sizeInUnits = BigInt(Math.round(alignedQty * 1e6));
        const priceInUnits = BigInt(Math.floor(marketPrice * 1e6));

        const makerAmount = (sizeInUnits * priceInUnits) / BigInt(1e6);
        const takerAmount = sizeInUnits;

        const salt = Math.round(Math.random() * Date.now());
        const expiration = BigInt(0);

        const orderForSigning = {
            salt,
            maker: proxyAddress,
            signer: wallet.address,
            taker: '0x0000000000000000000000000000000000000000',
            tokenId: BigInt(tokenId),
            makerAmount,
            takerAmount,
            expiration,
            nonce: 0,
            feeRateBps: 0,
            side: 0, // BUY
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
                salt,
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
            orderType: 'IOC', // 立即成交或取消
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

// ============================================================================
// 获取订单状态
// ============================================================================

async function getOrderStatus(
    apiKey: string,
    secret: string,
    passphrase: string,
    traderAddress: string,
    orderId: string
): Promise<{ status: string; filledQty: number; price: number } | null> {
    try {
        const path = `/data/order/${orderId}`;
        const headers = buildHmacHeaders(apiKey, secret, passphrase, traderAddress, 'GET', path);

        const res = await fetch(`${CLOB_BASE_URL}${path}`, { headers });
        if (!res.ok) return null;

        const data = await res.json() as any;
        return {
            status: data.status || 'UNKNOWN',
            filledQty: parseFloat(data.size_matched || '0'),
            price: parseFloat(data.price || '0'),
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
    console.log('║           市价买入延迟测试 - Fed 市场                               ║');
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
    console.log(`📍 测试数量: ${TEST_QUANTITY} shares\n`);

    // 1. 搜索 Fed 市场
    const market = await findFedMarket();
    if (!market) {
        console.error('\n❌ 无法找到合适的 Fed 市场');
        return;
    }

    // 收集事件
    const events: WsEvent[] = [];
    let polygonFillTime: number | null = null;
    let userChannelFillTime: number | null = null;
    let polygonFillDetails: any = null;

    // 2. 连接 WebSocket
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📡 连接 WebSocket');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const polygonWs = await connectPolygonWss(proxyAddress, (event) => {
        // 检查是否是我们的订单成交 (通过 maker/taker 地址匹配)
        const makerLower = event.maker.toLowerCase();
        const takerLower = event.taker.toLowerCase();
        const proxyLower = proxyAddress.toLowerCase();

        const isOurs = makerLower === proxyLower || takerLower === proxyLower;

        if (isOurs) {
            if (!polygonFillTime) {
                polygonFillTime = event.timestamp;
                polygonFillDetails = event;
                console.log(`   📥 [POLYGON] 我们的订单成交!`);
                console.log(`      Block: ${event.blockNumber}, TxHash: ${event.txHash?.slice(0, 20)}...`);
                console.log(`      Maker: ${event.maker.slice(0, 15)}...`);
                console.log(`      Taker: ${event.taker.slice(0, 15)}...`);
            }
        }

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

    const userChannelWs = await connectUserChannel(apiKey, secret, passphrase, (event) => {
        const eventType = event.type || event.event_type || 'unknown';

        // 检查是否是成交事件
        if (eventType.toUpperCase() === 'TRADE' || eventType.toUpperCase() === 'MATCHED') {
            if (!userChannelFillTime) {
                userChannelFillTime = Date.now();
                console.log(`   📥 [USER-CH] 成交事件: ${eventType}`);
            }
        }

        events.push({
            source: 'user-channel',
            type: eventType,
            time: Date.now(),
            data: event,
        });
    });

    if (!userChannelWs) {
        console.error('❌ User Channel 连接失败');
        polygonWs.close();
        return;
    }

    await sleep(2000);

    // 3. 下市价单
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📝 下市价单');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   市场: ${market.question.slice(0, 60)}...`);
    console.log(`   数量: ${TEST_QUANTITY} shares`);
    console.log(`   预期价格: ~$${market.bestAsk}`);
    console.log(`   预期成本: ~$${(TEST_QUANTITY * market.bestAsk).toFixed(2)} USDC`);

    events.length = 0;
    const orderSubmitTime = Date.now();
    console.log(`\n⏱️ 下单时间: ${new Date(orderSubmitTime).toISOString()}`);

    const orderId = await placeMarketBuyOrder(
        wallet,
        apiKey,
        secret,
        passphrase,
        traderAddress,
        proxyAddress,
        market.tokenId,
        market.bestAsk,
        TEST_QUANTITY,
        market.negRisk
    );

    const orderResponseTime = Date.now();

    if (!orderId) {
        console.error('❌ 下单失败');
        polygonWs.close();
        userChannelWs.close();
        return;
    }

    console.log(`   ✅ 订单已提交: ${orderId}`);
    console.log(`   HTTP 响应: ${formatMs(orderResponseTime - orderSubmitTime)}`);

    // 4. 等待成交确认 - 增加到 15 秒以等待链上确认
    console.log('\n   等待成交确认 (15秒)...');

    // 轮询 API 确认成交
    let apiConfirmTime: number | null = null;
    let finalStatus: { status: string; filledQty: number; price: number } | null = null;

    const pollStart = Date.now();
    while (Date.now() - pollStart < 15000) {
        const status = await getOrderStatus(apiKey, secret, passphrase, traderAddress, orderId);
        if (status) {
            if (status.status === 'MATCHED' || status.status === 'CANCELLED') {
                if (!apiConfirmTime) {
                    apiConfirmTime = Date.now();
                }
                finalStatus = status;
                // 不要立即跳出，继续等待链上事件
                if (polygonFillTime) break;
            }
        }
        await sleep(100);
    }

    // 再等待几秒看是否有链上事件
    if (!polygonFillTime) {
        console.log('   继续等待链上事件 (5秒)...');
        await sleep(5000);
    }

    // 5. 输出结果
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 延迟分析');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    console.log(`\n📋 订单状态: ${finalStatus?.status || 'UNKNOWN'}`);
    console.log(`   成交数量: ${finalStatus?.filledQty || 0} shares`);
    console.log(`   成交价格: $${finalStatus?.price || 0}`);

    console.log('\n📊 各数据源确认延迟:');

    const latencies: { source: string; latency: number | null }[] = [];

    if (polygonFillTime) {
        const lat = polygonFillTime - orderSubmitTime;
        latencies.push({ source: 'Polygon WSS (链上)', latency: lat });
        console.log(`   Polygon 链上 WSS: ${formatMs(lat)}`);
        if (polygonFillDetails) {
            console.log(`      - Block: ${polygonFillDetails.blockNumber}`);
            console.log(`      - TxHash: ${polygonFillDetails.txHash?.slice(0, 30)}...`);
        }
    } else {
        latencies.push({ source: 'Polygon WSS (链上)', latency: null });
        console.log(`   Polygon 链上 WSS: 未收到事件`);
        // 打印收到的所有链上事件数量
        const polygonEvents = events.filter(e => e.source === 'polygon');
        console.log(`      (收到 ${polygonEvents.length} 个其他地址的 OrderFilled 事件)`);
    }

    if (userChannelFillTime) {
        const lat = userChannelFillTime - orderSubmitTime;
        latencies.push({ source: 'User Channel WS', latency: lat });
        console.log(`   User Channel WS: ${formatMs(lat)}`);
    } else {
        latencies.push({ source: 'User Channel WS', latency: null });
        console.log(`   User Channel WS: 未收到成交事件`);
    }

    if (apiConfirmTime) {
        const lat = apiConfirmTime - orderSubmitTime;
        latencies.push({ source: 'API 轮询', latency: lat });
        console.log(`   API 轮询确认: ${formatMs(lat)}`);
    } else {
        latencies.push({ source: 'API 轮询', latency: null });
        console.log(`   API 轮询: 超时未确认`);
    }

    // User Channel 事件统计
    const userEvents = events.filter(e => e.source === 'user-channel');
    if (userEvents.length > 0) {
        console.log(`\n   User Channel 收到的事件:`);
        for (const e of userEvents) {
            const lat = e.time - orderSubmitTime;
            console.log(`     - ${e.type}: ${formatMs(lat)}`);
        }
    }

    // 判断最快的数据源
    const validLatencies = latencies.filter(l => l.latency !== null);
    if (validLatencies.length > 0) {
        validLatencies.sort((a, b) => (a.latency || 0) - (b.latency || 0));
        const fastest = validLatencies[0];
        console.log(`\n🏆 最快数据源: ${fastest.source} (${formatMs(fastest.latency!)})`);

        if (validLatencies.length > 1) {
            const second = validLatencies[1];
            const diff = (second.latency || 0) - (fastest.latency || 0);
            console.log(`   比第二名 ${second.source} 快 ${formatMs(diff)}`);
        }
    }

    // 关闭连接
    polygonWs.close();
    userChannelWs.close();

    console.log('\n✅ 测试完成\n');
}

main().catch(console.error);
