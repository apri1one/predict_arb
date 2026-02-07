/**
 * Polymarket WebSocket User Channel vs API 延迟对比测试
 *
 * 测试流程：
 * 1. 连接 WS User Channel
 * 2. 下一个不会成交的限价单 (GTC, 低价)
 * 3. 对比 WS 推送 vs API 轮询的延迟
 * 4. 取消订单，再次对比延迟
 *
 * 使用方法：
 * npx tsx src/testing/test-poly-ws-latency.ts
 */

import { Wallet } from 'ethers';
import * as crypto from 'crypto';
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

// 测试参数
// 注意: Polymarket 最小订单大小是 $5-15 USDC
// 用低价但足够大的数量来确保满足最小订单要求
const TEST_PRICE = 0.02;      // 2 分钱，不会成交
const TEST_QUANTITY = 500;    // 500 shares × $0.02 = $10 USDC
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
// 工具函数
// ============================================================================

function formatMs(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
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
    // URL safe 转换 (必须!)
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
// 测试结果
// ============================================================================

interface TestResult {
    event: string;
    wsLatency: number | null;
    apiLatency: number | null;
    wsFirst: boolean;
    diff: number;
}

const results: TestResult[] = [];

// ============================================================================
// 主测试
// ============================================================================

async function main(): Promise<void> {
    console.log('╔════════════════════════════════════════════════════════════════════╗');
    console.log('║       Polymarket WebSocket vs API 延迟对比测试                      ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');

    // 检查环境变量
    const apiKey = process.env.POLYMARKET_API_KEY;
    const secret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_PASSPHRASE;
    const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;
    const privateKey = process.env.POLYMARKET_TRADER_PRIVATE_KEY;

    if (!apiKey || !secret || !passphrase || !proxyAddress || !privateKey) {
        console.error('❌ 缺少必要的环境变量');
        console.error('   需要: POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE');
        console.error('         POLYMARKET_PROXY_ADDRESS, POLYMARKET_TRADER_PRIVATE_KEY');
        return;
    }

    const wallet = new Wallet(privateKey);
    const traderAddress = process.env.POLYMARKET_TRADER_ADDRESS || wallet.address;
    console.log(`📍 钱包地址: ${wallet.address}`);
    console.log(`📍 代理地址: ${proxyAddress}`);
    console.log(`📍 交易地址: ${traderAddress}\n`);

    // 1. 获取一个活跃市场的 token
    console.log('🔍 获取测试市场...');
    const testMarket = await getTestToken();
    if (!testMarket) {
        console.error('❌ 无法获取测试市场');
        return;
    }
    const { tokenId, negRisk, conditionId } = testMarket;
    console.log(`   Token ID: ${tokenId.slice(0, 20)}...`);
    console.log(`   Condition ID: ${conditionId.slice(0, 20)}...`);
    console.log(`   Exchange: ${negRisk ? 'NEG_RISK' : 'CTF'}\n`);

    // 2. 连接 WebSocket User Channel
    console.log('📡 连接 WebSocket User Channel...');
    const wsEvents: Array<{ type: string; time: number; data: any }> = [];

    const ws = await connectUserChannel(apiKey, secret, passphrase, (event) => {
        wsEvents.push({
            type: event.event_type || event.type || 'unknown',
            time: Date.now(),
            data: event,
        });
        console.log(`   📥 WS 收到: ${event.event_type || event.type} @ ${new Date().toISOString()}`);
    });

    if (!ws) {
        console.error('❌ WebSocket 连接失败');
        return;
    }

    // 等待 WS 稳定
    await sleep(2000);
    console.log('');

    // 3. 下限价单测试
    console.log('=' .repeat(70));
    console.log('📝 测试 1: 下单延迟对比');
    console.log('='.repeat(70));

    const orderSubmitTime = Date.now();
    console.log(`\n⏱️ 下单时间: ${new Date(orderSubmitTime).toISOString()}`);
    console.log(`   价格: ${TEST_PRICE}, 数量: ${TEST_QUANTITY}, 方向: ${TEST_SIDE}`);

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
        ws.close();
        return;
    }

    const orderPlacedTime = Date.now();
    console.log(`   ✅ 订单已提交: ${orderId}`);
    console.log(`   HTTP 响应延迟: ${formatMs(orderPlacedTime - orderSubmitTime)}`);

    // 等待 WS 事件
    const wsPlacementEvent = await waitForWsEvent(wsEvents, 'placement', orderId, 5000);
    const wsPlacementTime = wsPlacementEvent ? wsPlacementEvent.time : null;

    // API 轮询检测
    const apiDetectTime = await pollUntilDetected(apiKey, secret, passphrase, traderAddress, orderId, 5000);

    // 记录结果
    if (wsPlacementTime && apiDetectTime) {
        const wsLatency = wsPlacementTime - orderSubmitTime;
        const apiLatency = apiDetectTime - orderSubmitTime;
        results.push({
            event: '下单 (PLACEMENT)',
            wsLatency,
            apiLatency,
            wsFirst: wsLatency < apiLatency,
            diff: Math.abs(wsLatency - apiLatency),
        });
        console.log(`\n   📊 WS 检测延迟: ${formatMs(wsLatency)}`);
        console.log(`   📊 API 检测延迟: ${formatMs(apiLatency)}`);
        console.log(`   📊 差异: ${wsLatency < apiLatency ? 'WS 快' : 'API 快'} ${formatMs(Math.abs(wsLatency - apiLatency))}`);
    } else {
        console.log(`\n   ⚠️ WS 检测: ${wsPlacementTime ? formatMs(wsPlacementTime - orderSubmitTime) : '未收到'}`);
        console.log(`   ⚠️ API 检测: ${apiDetectTime ? formatMs(apiDetectTime - orderSubmitTime) : '超时'}`);
    }

    // 4. 取消订单测试
    console.log('\n' + '='.repeat(70));
    console.log('📝 测试 2: 取消订单延迟对比');
    console.log('='.repeat(70));

    await sleep(1000);
    wsEvents.length = 0; // 清空之前的事件

    const cancelSubmitTime = Date.now();
    console.log(`\n⏱️ 取消时间: ${new Date(cancelSubmitTime).toISOString()}`);

    const cancelled = await cancelOrder(apiKey, secret, passphrase, traderAddress, orderId);
    const cancelResponseTime = Date.now();

    if (!cancelled) {
        console.error('❌ 取消订单失败');
    } else {
        console.log(`   ✅ 取消请求已发送`);
        console.log(`   HTTP 响应延迟: ${formatMs(cancelResponseTime - cancelSubmitTime)}`);
    }

    // 等待 WS 事件
    const wsCancelEvent = await waitForWsEvent(wsEvents, 'cancellation', orderId, 5000);
    const wsCancelTime = wsCancelEvent ? wsCancelEvent.time : null;

    // API 轮询检测取消状态
    const apiCancelTime = await pollUntilCancelled(apiKey, secret, passphrase, traderAddress, orderId, 5000);

    // 记录结果
    if (wsCancelTime && apiCancelTime) {
        const wsLatency = wsCancelTime - cancelSubmitTime;
        const apiLatency = apiCancelTime - cancelSubmitTime;
        results.push({
            event: '取消 (CANCELLATION)',
            wsLatency,
            apiLatency,
            wsFirst: wsLatency < apiLatency,
            diff: Math.abs(wsLatency - apiLatency),
        });
        console.log(`\n   📊 WS 检测延迟: ${formatMs(wsLatency)}`);
        console.log(`   📊 API 检测延迟: ${formatMs(apiLatency)}`);
        console.log(`   📊 差异: ${wsLatency < apiLatency ? 'WS 快' : 'API 快'} ${formatMs(Math.abs(wsLatency - apiLatency))}`);
    } else {
        console.log(`\n   ⚠️ WS 检测: ${wsCancelTime ? formatMs(wsCancelTime - cancelSubmitTime) : '未收到'}`);
        console.log(`   ⚠️ API 检测: ${apiCancelTime ? formatMs(apiCancelTime - cancelSubmitTime) : '超时'}`);
    }

    // 关闭 WS
    ws.close();

    // 5. 输出总结
    console.log('\n' + '='.repeat(70));
    console.log('📋 测试总结');
    console.log('='.repeat(70));

    if (results.length > 0) {
        console.log('\n┌────────────────────┬────────────┬────────────┬──────────┬──────────┐');
        console.log('│ 事件               │ WS 延迟    │ API 延迟   │ 更快者   │ 差异     │');
        console.log('├────────────────────┼────────────┼────────────┼──────────┼──────────┤');
        for (const r of results) {
            const wsStr = r.wsLatency !== null ? formatMs(r.wsLatency).padEnd(10) : 'N/A'.padEnd(10);
            const apiStr = r.apiLatency !== null ? formatMs(r.apiLatency).padEnd(10) : 'N/A'.padEnd(10);
            const winner = r.wsFirst ? 'WS ⚡' : 'API';
            console.log(`│ ${r.event.padEnd(18)} │ ${wsStr} │ ${apiStr} │ ${winner.padEnd(8)} │ ${formatMs(r.diff).padEnd(8)} │`);
        }
        console.log('└────────────────────┴────────────┴────────────┴──────────┴──────────┘');

        const avgWs = results.filter(r => r.wsLatency).reduce((a, b) => a + (b.wsLatency || 0), 0) / results.length;
        const avgApi = results.filter(r => r.apiLatency).reduce((a, b) => a + (b.apiLatency || 0), 0) / results.length;

        console.log(`\n📈 平均延迟: WS ${formatMs(avgWs)} vs API ${formatMs(avgApi)}`);
        console.log(`📈 WS 比 API 快: ${formatMs(avgApi - avgWs)}`);
    } else {
        console.log('\n⚠️ 没有足够的数据进行对比');
    }

    console.log('\n💡 结论:');
    console.log('   WebSocket User Channel 可实时推送订单状态变更');
    console.log('   建议将 polymarket-trader.ts 的轮询改为 WS 监听');
}

// ============================================================================
// 辅助函数
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getTestToken(): Promise<{ tokenId: string; negRisk: boolean; conditionId: string } | null> {
    try {
        // 使用 Gamma API 获取真正活跃的市场
        const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50');
        if (!gammaRes.ok) {
            console.log(`   Gamma API 返回 ${gammaRes.status}`);
            return null;
        }
        const gammaMarkets = await gammaRes.json() as any[];

        // 找一个接受订单的市场
        for (const m of gammaMarkets) {
            if (m.acceptingOrders && m.enableOrderBook && m.clobTokenIds) {
                // 解析 clobTokenIds
                let tokens: string[];
                try {
                    tokens = JSON.parse(m.clobTokenIds);
                } catch {
                    continue;
                }
                if (tokens.length === 0) continue;

                console.log(`   找到市场: ${m.question?.slice(0, 50)}...`);
                console.log(`   enableOrderBook: ${m.enableOrderBook}`);
                console.log(`   acceptingOrders: ${m.acceptingOrders}`);
                console.log(`   negRisk: ${m.negRisk}`);
                return {
                    tokenId: tokens[0], // YES token
                    negRisk: m.negRisk || false,
                    conditionId: m.conditionId,
                };
            }
        }

        console.log('   没有找到接受订单的活跃市场');
        // 打印前几个市场的状态用于调试
        for (let i = 0; i < Math.min(5, gammaMarkets.length); i++) {
            const m = gammaMarkets[i];
            console.log(`   市场 ${i}: acceptingOrders=${m.acceptingOrders}, enableOrderBook=${m.enableOrderBook}, question=${m.question?.slice(0, 40)}`);
        }
        return null;
    } catch (e: any) {
        console.log(`   获取市场异常: ${e.message}`);
        return null;
    }
}

async function connectUserChannel(
    apiKey: string,
    secret: string,
    passphrase: string,
    onMessage: (event: any) => void
): Promise<WebSocket | null> {
    return new Promise((resolve) => {
        const ws = new WebSocket(WS_USER_URL);
        let resolved = false;

        ws.onopen = () => {
            console.log('   ✅ WebSocket 已连接');

            // 正确的订阅消息格式 (type 大写 'USER')
            // 参考: https://github.com/discountry/polymarket-websocket-client
            const subscribeMsg = {
                type: 'USER',  // 大写!
                markets: [],   // 空数组表示订阅所有市场的用户事件
                auth: {
                    apiKey,
                    secret,
                    passphrase,
                },
            };
            ws.send(JSON.stringify(subscribeMsg));
            console.log('   📤 已发送订阅请求 (type: USER)');

            // User Channel 不发送订阅确认，直接认为连接成功
            // 只有当有订单事件时才会收到消息
            if (!resolved) {
                resolved = true;
                resolve(ws);
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data.toString());
                // 传递事件给回调
                onMessage(data);
            } catch (e) {
                console.log(`   ⚠️ 无法解析消息: ${event.data.toString().slice(0, 50)}`);
            }
        };

        ws.onerror = (err: any) => {
            console.log(`   ❌ WebSocket 错误: ${err.message || 'unknown'}`);
        };

        ws.onclose = (event) => {
            console.log(`   ⚠️ WebSocket 关闭: code=${event.code}, reason=${event.reason}`);
            if (!resolved) {
                resolve(null);
            }
        };

        // 如果 5 秒内没有连接成功则超时
        setTimeout(() => {
            if (!resolved) {
                console.log('   ❌ WebSocket 连接超时');
                ws.close();
                resolve(null);
            }
        }, 5000);
    });
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
        // 计算金额 (和 polymarket-trader.ts 一致)
        // 使用 1e6 精度 (USDC 6 位小数)
        const alignedQty = Math.floor(quantity * 100) / 100;
        const sizeInUnits = BigInt(Math.round(alignedQty * 1e6));
        const priceInUnits = BigInt(Math.floor(price * 1e6));

        // BUY: 支付 USDC，获得 tokens
        const makerAmount = (sizeInUnits * priceInUnits) / BigInt(1e6);
        const takerAmount = sizeInUnits;

        const salt = Math.round(Math.random() * Date.now());
        // GTC 订单 expiration 必须为 0
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
            side: 0, // BUY
            signatureType: 2,  // POLY_GNOSIS_SAFE
        };

        // 根据 negRisk 选择正确的 exchange 地址
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
                signatureType: 2,  // POLY_GNOSIS_SAFE
                signature,
            },
            owner: apiKey,
            orderType: 'GTC', // 限价单，不会立即成交
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

async function waitForWsEvent(
    events: Array<{ type: string; time: number; data: any }>,
    eventType: string,
    orderId: string,
    timeoutMs: number
): Promise<{ type: string; time: number; data: any } | null> {
    const start = Date.now();
    const eventTypeLower = eventType.toLowerCase();

    while (Date.now() - start < timeoutMs) {
        // 检查是否已有匹配的事件
        for (const e of events) {
            // User Channel 事件格式: { event_type: "order", type: "PLACEMENT" | "CANCELLATION" | "UPDATE" }
            const msgEventType = e.data.event_type?.toLowerCase() || '';
            const msgType = e.data.type?.toLowerCase() || '';

            // 匹配 "placement" -> type: "PLACEMENT"
            // 匹配 "cancellation" -> type: "CANCELLATION"
            const matchesType = msgType.includes(eventTypeLower) || msgEventType.includes(eventTypeLower);

            if (matchesType) {
                // 检查 orderId 是否匹配 (User Channel 使用 id 字段)
                const dataOrderId = e.data.id || e.data.order_id || '';
                if (!dataOrderId || dataOrderId === orderId) {
                    return e;
                }
            }
        }
        await sleep(50);
    }

    return null;
}

async function pollUntilDetected(
    apiKey: string,
    secret: string,
    passphrase: string,
    traderAddress: string,
    orderId: string,
    timeoutMs: number
): Promise<number | null> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        try {
            const path = `/data/order/${orderId}`;
            const headers = buildHmacHeaders(apiKey, secret, passphrase, traderAddress, 'GET', path);

            const res = await fetch(`${CLOB_BASE_URL}${path}`, { headers });

            if (res.ok) {
                return Date.now();
            }
        } catch { /* ignore */ }

        await sleep(100);
    }

    return null;
}

async function pollUntilCancelled(
    apiKey: string,
    secret: string,
    passphrase: string,
    traderAddress: string,
    orderId: string,
    timeoutMs: number
): Promise<number | null> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        try {
            const path = `/data/order/${orderId}`;
            const headers = buildHmacHeaders(apiKey, secret, passphrase, traderAddress, 'GET', path);

            const res = await fetch(`${CLOB_BASE_URL}${path}`, { headers });

            if (res.ok) {
                const data = await res.json() as any;
                if (data.status === 'CANCELLED' || data.status === 'MATCHED') {
                    return Date.now();
                }
            }
        } catch { /* ignore */ }

        await sleep(100);
    }

    return null;
}

main().catch(console.error);
