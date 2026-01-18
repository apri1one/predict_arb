/**
 * Polymarket 下单测试脚本
 * 测试在买一价下单 1 share，然后撤销订单，测量延迟
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import * as crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../..', '.env') });

// ============================================================================
// 配置
// ============================================================================

const CLOB_BASE_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

// CTF Exchange 合约地址 (Polymarket)
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
// NegRisk Exchange 合约地址
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// 获取正确的 Domain (基于 negRisk)
function getDomain(negRisk: boolean) {
    return {
        name: 'Polymarket CTF Exchange',
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE,
    };
}

// EIP-712 Domain (默认，非 negRisk)
const DOMAIN = getDomain(false);

// Order 类型定义
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

interface OrderData {
    salt: string;
    maker: string;
    signer: string;
    taker: string;
    tokenId: string;
    makerAmount: string;
    takerAmount: string;
    expiration: string;
    nonce: string;
    feeRateBps: string;
    side: number;  // 0 = BUY, 1 = SELL
    signatureType: number;
}

interface EnvConfig {
    polyTraderAddress: string;
    polyTraderPrivateKey: string;
    polyApiKey: string;
    polyApiSecret: string;
    polyPassphrase: string;
    polyProxyAddress: string;
}

function loadConfig(): EnvConfig {
    return {
        polyTraderAddress: process.env.POLYMARKET_TRADER_ADDRESS || '',
        polyTraderPrivateKey: process.env.POLYMARKET_TRADER_PRIVATE_KEY || '',
        polyApiKey: process.env.POLYMARKET_API_KEY || '',
        polyApiSecret: process.env.POLYMARKET_API_SECRET || '',
        polyPassphrase: process.env.POLYMARKET_PASSPHRASE || '',
        polyProxyAddress: process.env.POLYMARKET_PROXY_ADDRESS || '',
    };
}

// ============================================================================
// API 认证
// ============================================================================

function buildHeaders(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    method: string,
    path: string,
    body: string = '',
    address: string = ''
): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method + path + body;
    const secretBuffer = Buffer.from(apiSecret, 'base64');
    const signature = crypto
        .createHmac('sha256', secretBuffer)
        .update(message, 'utf-8')
        .digest('base64');
    const urlSafeSignature = signature.replace(/\+/g, '-').replace(/\//g, '_');

    const headers: Record<string, string> = {
        'POLY_API_KEY': apiKey,
        'POLY_SIGNATURE': urlSafeSignature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': passphrase,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    if (address) {
        headers['POLY_ADDRESS'] = address;
    }

    return headers;
}

// ============================================================================
// 获取市场订单簿
// ============================================================================

interface OrderbookLevel {
    price: string;
    size: string;
}

interface Orderbook {
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
}

async function getOrderbook(tokenId: string): Promise<Orderbook> {
    const url = `${CLOB_BASE_URL}/book?token_id=${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to get orderbook: ${res.status}`);
    }
    return await res.json() as Orderbook;
}

// ============================================================================
// 获取活跃市场
// ============================================================================

interface MarketInfo {
    tokenId: string;
    question: string;
    negRisk: boolean;
}

async function getActiveMarket(): Promise<MarketInfo | null> {
    // 从命令行参数获取 tokenId (可选)
    const argTokenId = process.argv[2];
    if (argTokenId) {
        console.log(`  使用命令行指定的 Token ID`);
        return { tokenId: argTokenId, question: 'User specified market', negRisk: false };
    }

    // 使用 sampling-simplified-markets 获取活跃市场 (有流动性奖励的市场)
    try {
        const url = `${CLOB_BASE_URL}/sampling-simplified-markets?limit=20`;
        console.log(`  查询采样市场...`);
        const res = await fetch(url);
        if (res.ok) {
            const response = await res.json() as any;
            const markets = response.data || response || [];
            console.log(`  找到 ${markets.length} 个采样市场`);

            for (const market of markets) {
                // 检查市场是否接受订单
                if (!market.accepting_orders || market.closed) continue;

                if (market.tokens && market.tokens.length > 0) {
                    const tokenId = market.tokens[0].token_id;
                    try {
                        const book = await getOrderbook(tokenId);
                        if (book.bids && book.bids.length > 0) {
                            return {
                                tokenId,
                                question: market.question || market.condition_id || 'Sampling market',
                                negRisk: market.neg_risk === true,
                            };
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
        }
    } catch (e: any) {
        console.log(`  采样市场查询失败: ${e.message}`);
    }

    // 回退：使用普通 markets API
    try {
        const url = `${CLOB_BASE_URL}/markets?limit=50&active=true`;
        console.log(`  查询普通市场...`);
        const res = await fetch(url);
        if (res.ok) {
            const response = await res.json() as any;
            const markets = response.data || response || [];
            console.log(`  找到 ${markets.length} 个市场`);

            for (const market of markets.slice(0, 20)) {
                if (!market.accepting_orders || market.closed) continue;

                if (market.tokens && market.tokens.length > 0) {
                    const tokenId = market.tokens[0].token_id;
                    try {
                        const book = await getOrderbook(tokenId);
                        if (book.bids && book.bids.length > 0) {
                            return {
                                tokenId,
                                question: market.question || 'Unknown',
                                negRisk: market.neg_risk === true,
                            };
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
        }
    } catch (e: any) {
        console.log(`  普通市场查询失败: ${e.message}`);
    }

    return null;
}

// ============================================================================
// 创建和签署订单
// ============================================================================

async function createSignedOrder(
    wallet: ethers.Wallet,
    funderAddress: string,
    tokenId: string,
    price: number,
    size: number,
    side: 'BUY' | 'SELL',
    signatureType: number = 0,
    negRisk: boolean = false
): Promise<{ order: OrderData; signature: string }> {
    // 计算金额 (USDC 使用 6 位小数)
    const sizeInUnits = BigInt(Math.floor(size * 1e6));
    const priceInUnits = BigInt(Math.floor(price * 1e6));

    let makerAmount: bigint;
    let takerAmount: bigint;

    if (side === 'BUY') {
        // BUY: maker 给 USDC, taker 给 shares
        makerAmount = (sizeInUnits * priceInUnits) / BigInt(1e6);
        takerAmount = sizeInUnits;
    } else {
        // SELL: maker 给 shares, taker 给 USDC
        makerAmount = sizeInUnits;
        takerAmount = (sizeInUnits * priceInUnits) / BigInt(1e6);
    }

    // 生成随机 salt (Polymarket 使用 random * timestamp 格式)
    const salt = Math.round(Math.random() * Date.now());
    const nonce = 0;

    // GTC 订单的 expiration 必须是 "0"
    // 只有 GTD (Good-Till-Date) 订单才需要设置过期时间
    const expiration = BigInt(0);

    // 用于签名的数据 (使用正确的类型)
    const orderForSigning = {
        salt: salt,  // number
        maker: funderAddress,  // address
        signer: wallet.address,  // address
        taker: '0x0000000000000000000000000000000000000000',  // address
        tokenId: BigInt(tokenId),  // uint256
        makerAmount: makerAmount,  // bigint
        takerAmount: takerAmount,  // bigint
        expiration: expiration,  // bigint (0)
        nonce: nonce,  // number (0)
        feeRateBps: 0,  // number
        side: side === 'BUY' ? 0 : 1,  // uint8
        signatureType: signatureType,  // uint8
    };

    console.log(`  订单数据(签名用):`);
    console.log(`    salt: ${orderForSigning.salt}`);
    console.log(`    maker: ${orderForSigning.maker}`);
    console.log(`    signer: ${orderForSigning.signer}`);
    console.log(`    tokenId: ${orderForSigning.tokenId}`);
    console.log(`    makerAmount: ${orderForSigning.makerAmount}`);
    console.log(`    takerAmount: ${orderForSigning.takerAmount}`);
    console.log(`    side: ${orderForSigning.side}`);
    console.log(`    signatureType: ${orderForSigning.signatureType}`);

    // 获取正确的 domain
    const domain = getDomain(negRisk);
    console.log(`  使用合约: ${domain.verifyingContract}`);
    console.log(`  negRisk: ${negRisk}`);

    // 签署订单 (EIP-712)
    const signature = await wallet.signTypedData(domain, ORDER_TYPES, orderForSigning);
    console.log(`  签名: ${signature.slice(0, 40)}...`);

    // 返回用于 API 的订单数据 (字符串格式)
    const order: OrderData = {
        salt: salt.toString(),
        maker: funderAddress,
        signer: wallet.address,
        taker: '0x0000000000000000000000000000000000000000',
        tokenId: tokenId,
        makerAmount: makerAmount.toString(),
        takerAmount: takerAmount.toString(),
        expiration: expiration.toString(),
        nonce: nonce.toString(),
        feeRateBps: '0',
        side: side === 'BUY' ? 0 : 1,
        signatureType: signatureType,
    };

    return { order, signature };
}

// ============================================================================
// 提交订单
// ============================================================================

async function postOrder(
    cfg: EnvConfig,
    order: OrderData,
    signature: string,
    tickSize: string = '0.01'
): Promise<{ orderId: string; latency: number }> {
    const path = '/order';
    const body = JSON.stringify({
        order: {
            salt: parseInt(order.salt, 10),
            maker: order.maker,
            signer: order.signer,
            taker: order.taker,
            tokenId: order.tokenId,
            makerAmount: order.makerAmount,
            takerAmount: order.takerAmount,
            expiration: order.expiration,
            nonce: order.nonce,
            feeRateBps: order.feeRateBps,
            side: order.side === 0 ? 'BUY' : 'SELL',
            signatureType: order.signatureType,
            signature: signature,
        },
        // owner 必须是 API Key 本身（不是地址！）
        // Python SDK: body = order_to_json(order, self.creds.api_key, orderType)
        owner: cfg.polyApiKey,  // API Key 作为 owner
        orderType: 'GTC',
    });

    console.log(`  请求体: ${body.slice(0, 500)}...`);

    const headers = buildHeaders(
        cfg.polyApiKey,
        cfg.polyApiSecret,
        cfg.polyPassphrase,
        'POST',
        path,
        body,
        cfg.polyTraderAddress  // EOA 地址用于认证
    );

    const startTime = performance.now();
    const res = await fetch(`${CLOB_BASE_URL}${path}`, {
        method: 'POST',
        headers,
        body,
    });
    const endTime = performance.now();
    const latency = endTime - startTime;

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Post order failed (${res.status}): ${errorText}`);
    }

    const data = await res.json() as any;
    return {
        orderId: data.orderID || data.id || data.order_id,
        latency,
    };
}

// ============================================================================
// 撤销订单
// ============================================================================

async function cancelOrder(
    cfg: EnvConfig,
    orderId: string
): Promise<{ success: boolean; latency: number; response?: any }> {
    // 端点: DELETE /order (TypeScript SDK: CANCEL_ORDER = "/order")
    // Body: { orderID: string }
    const path = '/order';

    // 使用紧凑 JSON 格式（与 Python SDK 一致）
    // Python SDK: json.dumps(body, separators=(",", ":"), ensure_ascii=False)
    const body = JSON.stringify({ orderID: orderId });


    const headers = buildHeaders(
        cfg.polyApiKey,
        cfg.polyApiSecret,
        cfg.polyPassphrase,
        'DELETE',
        path,
        body,
        cfg.polyTraderAddress
    );

    const startTime = performance.now();
    const res = await fetch(`${CLOB_BASE_URL}${path}`, {
        method: 'DELETE',
        headers,
        body,
    });
    const endTime = performance.now();
    const latency = endTime - startTime;

    const responseText = await res.text();

    let responseData;
    try {
        responseData = JSON.parse(responseText);
    } catch {
        responseData = responseText;
    }

    if (!res.ok) {
        throw new Error(`Cancel order failed (${res.status}): ${responseText}`);
    }

    return { success: true, latency, response: responseData };
}

// ============================================================================
// 获取 API Key 信息
// ============================================================================

async function getApiKeyInfo(cfg: EnvConfig): Promise<string | null> {
    const path = '/auth/api-keys';
    const headers = buildHeaders(
        cfg.polyApiKey,
        cfg.polyApiSecret,
        cfg.polyPassphrase,
        'GET',
        path,
        '',
        cfg.polyTraderAddress  // 用 EOA 地址
    );

    try {
        const res = await fetch(`${CLOB_BASE_URL}${path}`, { headers });
        if (res.ok) {
            const data = await res.json() as string | null;
            console.log(`  API Keys 信息: ${JSON.stringify(data, null, 2)}`);
            return data;
        } else {
            console.log(`  获取 API Keys 失败: ${res.status} ${await res.text()}`);
        }
    } catch (e: any) {
        console.log(`  获取 API Keys 错误: ${e.message}`);
    }
    return null;
}

// 获取用户的订单
async function getOpenOrders(cfg: EnvConfig): Promise<void> {
    const path = '/data/orders?state=LIVE';
    const headers = buildHeaders(
        cfg.polyApiKey,
        cfg.polyApiSecret,
        cfg.polyPassphrase,
        'GET',
        path,
        '',
        cfg.polyTraderAddress
    );

    try {
        const res = await fetch(`${CLOB_BASE_URL}${path}`, { headers });
        const data = await res.json() as any;
        console.log(`  开放订单: ${JSON.stringify(data, null, 2).slice(0, 300)}`);
    } catch (e: any) {
        console.log(`  获取订单失败: ${e.message}`);
    }
}

// ============================================================================
// 主函数
// ============================================================================

async function main() {
    console.log('═'.repeat(60));
    console.log('  Polymarket 下单延迟测试');
    console.log('═'.repeat(60));

    const cfg = loadConfig();

    // 检查配置
    if (!cfg.polyTraderPrivateKey || !cfg.polyApiKey || !cfg.polyProxyAddress) {
        console.error('\n❌ 缺少必要配置:');
        console.error('   - POLYMARKET_TRADER_PRIVATE_KEY');
        console.error('   - POLYMARKET_API_KEY/SECRET/PASSPHRASE');
        console.error('   - POLYMARKET_PROXY_ADDRESS');
        process.exit(1);
    }

    console.log('\n📋 配置检查:');
    console.log(`  EOA 地址(env):  ${cfg.polyTraderAddress}`);
    console.log(`  代理钱包:       ${cfg.polyProxyAddress}`);
    console.log(`  API Key:        ${cfg.polyApiKey.slice(0, 10)}...`);

    // 创建钱包
    const wallet = new ethers.Wallet(cfg.polyTraderPrivateKey);
    console.log(`  私钥派生地址:   ${wallet.address}`);

    // 检查地址是否匹配
    if (cfg.polyTraderAddress.toLowerCase() !== wallet.address.toLowerCase()) {
        console.error(`\n❌ 地址不匹配!`);
        console.error(`   env 中配置的地址: ${cfg.polyTraderAddress}`);
        console.error(`   私钥派生的地址:   ${wallet.address}`);
        console.error(`   请确保 POLYMARKET_TRADER_ADDRESS 与 POLYMARKET_TRADER_PRIVATE_KEY 匹配`);
        process.exit(1);
    }

    // 获取 API Key 关联信息
    console.log('\n🔑 查询 API Key 信息...');
    await getApiKeyInfo(cfg);

    // 获取开放订单
    console.log('\n📋 查询用户开放订单...');
    await getOpenOrders(cfg);

    // 获取活跃市场
    console.log('\n🔍 获取活跃市场...');
    const market = await getActiveMarket();
    if (!market) {
        console.error('❌ 未找到有流动性的市场');
        process.exit(1);
    }

    console.log(`  市场: ${market.question.slice(0, 50)}...`);
    console.log(`  Token ID: ${market.tokenId.slice(0, 20)}...`);
    console.log(`  NegRisk: ${market.negRisk}`);

    // 获取订单簿
    console.log('\n📊 获取订单簿...');
    const book = await getOrderbook(market.tokenId);

    if (!book.bids || book.bids.length === 0) {
        console.error('❌ 无买单');
        process.exit(1);
    }

    const bestBid = parseFloat(book.bids[0].price);
    const bestAsk = book.asks && book.asks.length > 0 ? parseFloat(book.asks[0].price) : null;

    console.log(`  买一价: $${bestBid.toFixed(4)}`);
    if (bestAsk) console.log(`  卖一价: $${bestAsk.toFixed(4)}`);

    // 在买一价下单 (不会立即成交)
    const orderPrice = bestBid;
    const orderSize = 5; // 最小 5 shares (Polymarket 要求)

    console.log('\n📝 创建订单...');
    console.log(`  方向: BUY`);
    console.log(`  价格: $${orderPrice.toFixed(4)}`);
    console.log(`  数量: ${orderSize} share`);

    try {
        // 签署订单
        // signatureType: 0 = EOA, 1 = POLY_PROXY (Magic Proxy), 2 = POLY_GNOSIS_SAFE
        // maker = funder = proxy 地址（资金所在地址）
        // signer = EOA 地址（签名用）
        // 使用 signatureType 2 (POLY_GNOSIS_SAFE) 因为验证显示是 Gnosis Safe 类型
        const signStart = performance.now();
        const { order, signature } = await createSignedOrder(
            wallet,
            cfg.polyProxyAddress,  // maker = funder = proxy 地址 (Gnosis Safe)
            market.tokenId,
            orderPrice,
            orderSize,
            'BUY',
            2,  // signatureType: 2 = POLY_GNOSIS_SAFE
            market.negRisk  // 传递 negRisk 参数
        );
        const signEnd = performance.now();
        console.log(`  签名耗时: ${(signEnd - signStart).toFixed(2)}ms`);

        // 提交订单
        console.log('\n📤 提交订单...');
        const { orderId, latency: postLatency } = await postOrder(cfg, order, signature);
        console.log(`  ✅ 订单已提交`);
        console.log(`  订单 ID: ${orderId}`);
        console.log(`  提交延迟: ${postLatency.toFixed(2)}ms`);

        // 等待一下
        await new Promise(resolve => setTimeout(resolve, 500));

        // 撤销订单
        console.log('\n🗑️  撤销订单...');
        const { success, latency: cancelLatency, response: cancelResponse } = await cancelOrder(cfg, orderId);
        console.log(`  ✅ 订单已撤销`);
        console.log(`  响应: ${JSON.stringify(cancelResponse)}`);
        console.log(`  撤销延迟: ${cancelLatency.toFixed(2)}ms`);

        // 总结
        console.log('\n' + '─'.repeat(60));
        console.log('📊 延迟统计:');
        console.log(`  订单签名:   ${(signEnd - signStart).toFixed(2)}ms`);
        console.log(`  订单提交:   ${postLatency.toFixed(2)}ms`);
        console.log(`  订单撤销:   ${cancelLatency.toFixed(2)}ms`);
        console.log(`  总往返:     ${(postLatency + cancelLatency).toFixed(2)}ms`);

    } catch (error: any) {
        console.error(`\n❌ 错误: ${error.message}`);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('  测试完成');
    console.log('═'.repeat(60) + '\n');
}

main().catch(console.error);
