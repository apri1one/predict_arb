/**
 * 订单延迟测试 - WSS vs API 时间差对比
 *
 * 功能:
 * 1. 启动 WSS 订阅 Exchange 的 OrderFilled 事件
 * 2. 在 Predict 下一个小额市价单
 * 3. 对比 WSS 收到事件和 API 确认的时间差
 */

import { WebSocket } from 'ws';
import { ethers, formatUnits, parseUnits, Interface } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { PredictTrader } from '../dashboard/predict-trader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载环境变量
dotenv.config({ path: path.join(__dirname, '../../..', '.env') });

// ============================================================================
// 常量
// ============================================================================

const BSC_WSS_URL = 'wss://bsc-mainnet.nodereal.io/ws/v1/69a15e71374d4a15bfbf51e7bff2c656';
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS || '';

// Predict Exchange 合约地址
const EXCHANGES = {
    CTF_EXCHANGE: '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
    NEG_RISK_CTF_EXCHANGE: '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
    YIELD_BEARING_CTF_EXCHANGE: '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
    YIELD_BEARING_NEG_RISK_CTF_EXCHANGE: '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
};

// OrderFilled 事件签名
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';

// OrderFilled 事件 ABI
const ORDER_FILLED_ABI = [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

const orderFilledInterface = new Interface(ORDER_FILLED_ABI);

// ============================================================================
// 时间戳记录
// ============================================================================

interface TimingRecord {
    orderSubmitTime: number;     // 订单提交时间
    orderHash?: string;          // 订单哈希
    wssEventTime?: number;       // WSS 收到事件时间
    apiConfirmTime?: number;     // API 确认时间
    blockNumber?: number;        // 区块号
    txHash?: string;             // 交易哈希
}

// ============================================================================
// WSS 订阅
// ============================================================================

class ExchangeWssSubscriber {
    private ws: WebSocket | null = null;
    private onOrderFilledCallback: ((event: any, timestamp: number) => void) | null = null;
    private connected = false;

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            console.log(`[WSS] 连接到 BSC WebSocket...`);
            this.ws = new WebSocket(BSC_WSS_URL);

            const timeout = setTimeout(() => {
                reject(new Error('连接超时'));
            }, 10000);

            this.ws.on('open', () => {
                clearTimeout(timeout);
                this.connected = true;
                console.log('[WSS] ✅ 连接成功');
                resolve();
            });

            this.ws.on('message', (data) => this.handleMessage(data.toString()));
            this.ws.on('error', (err) => {
                clearTimeout(timeout);
                console.error('[WSS] ❌ 错误:', err.message);
                reject(err);
            });
            this.ws.on('close', () => {
                this.connected = false;
                console.log('[WSS] 连接关闭');
            });
        });
    }

    private handleMessage(data: string): void {
        try {
            const msg = JSON.parse(data);

            // 订阅确认
            if (msg.id && msg.result) {
                console.log(`[WSS] 订阅 ID: ${msg.result}`);
                return;
            }

            // 订阅数据
            if (msg.method === 'eth_subscription' && msg.params?.result) {
                const timestamp = Date.now();
                const log = msg.params.result;

                // 检查是否是 OrderFilled 事件
                if (log.topics && log.topics[0] === ORDER_FILLED_TOPIC) {
                    this.handleOrderFilled(log, timestamp);
                }
            }
        } catch (err) {
            // 忽略解析错误
        }
    }

    private handleOrderFilled(log: any, timestamp: number): void {
        try {
            const decoded = orderFilledInterface.parseLog({
                topics: log.topics,
                data: log.data,
            });

            if (!decoded) return;

            const event = {
                orderHash: decoded.args[0],
                maker: decoded.args[1],
                taker: decoded.args[2],
                makerAssetId: decoded.args[3].toString(),
                takerAssetId: decoded.args[4].toString(),
                makerAmountFilled: formatUnits(decoded.args[5], 18),
                takerAmountFilled: formatUnits(decoded.args[6], 18),
                fee: formatUnits(decoded.args[7], 18),
                blockNumber: parseInt(log.blockNumber, 16),
                txHash: log.transactionHash,
            };

            console.log(`\n[WSS] 📡 OrderFilled 事件 @ ${new Date(timestamp).toISOString()}`);
            console.log(`  区块: #${event.blockNumber}`);
            console.log(`  交易: ${event.txHash}`);
            console.log(`  订单哈希: ${event.orderHash}`);
            console.log(`  Maker: ${event.maker}`);
            console.log(`  Taker: ${event.taker}`);
            console.log(`  成交金额: ${event.makerAmountFilled} USDC → ${event.takerAmountFilled} tokens`);
            console.log(`  手续费: ${event.fee} USDC`);

            if (this.onOrderFilledCallback) {
                this.onOrderFilledCallback(event, timestamp);
            }
        } catch (err) {
            console.error('[WSS] 解码失败:', err);
        }
    }

    async subscribeToExchanges(): Promise<void> {
        if (!this.ws || !this.connected) {
            throw new Error('WebSocket 未连接');
        }

        // 订阅所有 Exchange 合约的 OrderFilled 事件
        const addresses = Object.values(EXCHANGES).map(a => a.toLowerCase());

        const request = {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_subscribe',
            params: [
                'logs',
                {
                    address: addresses,
                    topics: [ORDER_FILLED_TOPIC],
                },
            ],
        };

        console.log(`[WSS] 订阅 Exchange OrderFilled 事件...`);
        console.log(`  合约: ${addresses.length} 个`);
        this.ws.send(JSON.stringify(request));

        // 等待订阅确认
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    }

    onOrderFilled(callback: (event: any, timestamp: number) => void): void {
        this.onOrderFilledCallback = callback;
    }

    close(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// ============================================================================
// 查找合适的市场
// ============================================================================

const PREDICT_API_BASE = 'https://api.predict.fun';

interface MarketInfo {
    id: number;
    title: string;
    yesPrice: number;
    noPrice: number;
    askPrice: number;  // 最低卖价
    askQty: number;
}

async function findSuitableMarket(): Promise<MarketInfo | null> {
    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) throw new Error('PREDICT_API_KEY 未设置');

    console.log('\n[Market] 寻找合适的市场...');

    // 获取所有市场并筛选 REGISTERED 状态
    let cursor = '';
    let allMarkets: any[] = [];

    for (let i = 0; i < 15; i++) {
        const url = `${PREDICT_API_BASE}/v1/markets?first=100${cursor ? '&after=' + cursor : ''}`;
        const resp = await fetch(url, {
            headers: { 'x-api-key': apiKey },
        });

        if (!resp.ok) break;

        const data = await resp.json();
        const markets = Array.isArray(data.data) ? data.data : [];

        if (markets.length === 0) break;

        allMarkets = allMarkets.concat(markets);
        cursor = data.cursor;

        if (!cursor) break;
    }

    // 筛选 REGISTERED 状态的市场
    const registeredMarkets = allMarkets.filter(m => m.status === 'REGISTERED');
    console.log(`[Market] 找到 ${registeredMarkets.length} 个 REGISTERED 市场`);

    // 查找有足够流动性的市场
    for (const market of registeredMarkets) {
        try {
            // 获取订单簿
            const bookResp = await fetch(`${PREDICT_API_BASE}/v1/markets/${market.id}/orderbook`, {
                headers: { 'x-api-key': apiKey },
            });

            if (!bookResp.ok) continue;

            const bookData = await bookResp.json();
            const asks = bookData.data?.asks || [];

            // 检查是否有卖单 (价格 0.05-0.95, 数量 >= 1)
            if (asks.length > 0) {
                const [price, qty] = asks[0];
                if (price >= 0.05 && price <= 0.95 && qty >= 1) {
                    console.log(`[Market] ✅ 找到市场: ${market.title.substring(0, 50)}...`);
                    console.log(`  ID: ${market.id}`);
                    console.log(`  最佳卖价: ${price} x ${qty} shares`);
                    return {
                        id: market.id,
                        title: market.title,
                        yesPrice: price,
                        noPrice: 1 - price,
                        askPrice: price,
                        askQty: qty,
                    };
                }
            }
        } catch (err) {
            continue;
        }

        // 限制请求频率
        await new Promise(r => setTimeout(r, 100));
    }

    return null;
}

// ============================================================================
// 主测试流程
// ============================================================================

async function runLatencyTest(): Promise<void> {
    console.log('========================================');
    console.log('订单延迟测试 - WSS vs API');
    console.log('========================================');
    console.log(`智能钱包: ${SMART_WALLET}`);
    console.log('');

    // 检查环境变量
    if (!SMART_WALLET) {
        console.error('错误: PREDICT_SMART_WALLET_ADDRESS 未设置');
        process.exit(1);
    }

    const timing: TimingRecord = {
        orderSubmitTime: 0,
    };

    // 1. 启动 WSS 订阅
    console.log('\n--- 第一步: 启动 WSS 订阅 ---');
    const subscriber = new ExchangeWssSubscriber();

    try {
        await subscriber.connect();
        await subscriber.subscribeToExchanges();

        // 设置事件回调
        subscriber.onOrderFilled((event, timestamp) => {
            // 检查是否是我们的订单 (maker 或 taker 是我们的地址)
            const ourWallet = SMART_WALLET.toLowerCase();
            if (event.maker.toLowerCase() === ourWallet || event.taker.toLowerCase() === ourWallet) {
                timing.wssEventTime = timestamp;
                timing.blockNumber = event.blockNumber;
                timing.txHash = event.txHash;

                if (event.orderHash.toLowerCase().startsWith(timing.orderHash?.toLowerCase() || '')) {
                    console.log(`\n[TIMING] WSS 收到我们的订单事件!`);
                }
            }
        });

        // 2. 查找合适的市场
        console.log('\n--- 第二步: 查找市场 ---');
        const market = await findSuitableMarket();

        if (!market) {
            console.error('未找到合适的市场');
            subscriber.close();
            return;
        }

        // 3. 初始化 Trader
        console.log('\n--- 第三步: 初始化 Trader ---');
        const trader = new PredictTrader();
        await trader.init();
        console.log('[Trader] ✅ 初始化完成');

        // 4. 下单
        console.log('\n--- 第四步: 提交订单 ---');

        // 计算订单参数
        // 买 1 个 share，以当前卖一价
        const quantity = 1;
        const price = market.askPrice;
        const estimatedCost = price * quantity;

        console.log(`[Order] 市场: ${market.title.substring(0, 40)}...`);
        console.log(`[Order] 方向: BUY YES`);
        console.log(`[Order] 价格: ${price}`);
        console.log(`[Order] 数量: ${quantity}`);
        console.log(`[Order] 预估花费: ~${estimatedCost.toFixed(2)} USDC`);

        // 记录提交时间
        timing.orderSubmitTime = Date.now();
        console.log(`\n[TIMING] 订单提交时间: ${new Date(timing.orderSubmitTime).toISOString()}`);

        const result = await trader.placeBuyOrder({
            marketId: market.id,
            side: 'BUY',
            price: price,
            quantity: quantity,
            outcome: 'YES',
        });

        if (!result.success) {
            console.error(`[Order] ❌ 下单失败: ${result.error}`);
            subscriber.close();
            return;
        }

        timing.orderHash = result.hash;
        console.log(`[Order] ✅ 订单提交成功`);
        console.log(`[Order] Hash: ${result.hash}`);

        // 5. 轮询 API 等待成交
        console.log('\n--- 第五步: 等待成交 ---');
        const pollStart = Date.now();
        const maxWait = 30000; // 30秒超时
        let apiStatus = null;

        while (Date.now() - pollStart < maxWait) {
            const status = await trader.getOrderStatus(result.hash!);

            if (status) {
                if (status.status === 'FILLED' || status.status === 'PARTIALLY_FILLED') {
                    timing.apiConfirmTime = Date.now();
                    apiStatus = status;
                    console.log(`[API] ✅ 订单成交确认`);
                    console.log(`  状态: ${status.status}`);
                    console.log(`  成交数量: ${status.filledQty}`);
                    console.log(`  平均价格: ${status.avgPrice}`);
                    break;
                } else if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
                    console.log(`[API] ❌ 订单 ${status.status}`);
                    break;
                }
            }

            await new Promise(r => setTimeout(r, 200)); // 200ms 轮询间隔
        }

        // 6. 输出延迟统计
        console.log('\n========================================');
        console.log('延迟统计');
        console.log('========================================');
        console.log(`订单提交时间: ${new Date(timing.orderSubmitTime).toISOString()}`);

        if (timing.wssEventTime) {
            const wssLatency = timing.wssEventTime - timing.orderSubmitTime;
            console.log(`\nWSS 事件时间: ${new Date(timing.wssEventTime).toISOString()}`);
            console.log(`WSS 延迟: ${wssLatency} ms (从订单提交到收到链上事件)`);
            if (timing.blockNumber) {
                console.log(`区块号: #${timing.blockNumber}`);
            }
            if (timing.txHash) {
                console.log(`交易哈希: ${timing.txHash}`);
            }
        } else {
            console.log(`\nWSS 事件时间: 未收到 (可能订单未成交或事件过滤问题)`);
        }

        if (timing.apiConfirmTime) {
            const apiLatency = timing.apiConfirmTime - timing.orderSubmitTime;
            console.log(`\nAPI 确认时间: ${new Date(timing.apiConfirmTime).toISOString()}`);
            console.log(`API 延迟: ${apiLatency} ms (从订单提交到 API 确认成交)`);
        } else {
            console.log(`\nAPI 确认时间: 未确认`);
        }

        if (timing.wssEventTime && timing.apiConfirmTime) {
            const diff = timing.apiConfirmTime - timing.wssEventTime;
            console.log(`\n时间差: WSS 比 API ${diff > 0 ? '快' : '慢'} ${Math.abs(diff)} ms`);
        }

        // 等待一会儿确保收到所有事件
        console.log('\n等待 5 秒收集更多事件...');
        await new Promise(r => setTimeout(r, 5000));

        subscriber.close();

    } catch (err) {
        console.error('[ERROR]', err);
        subscriber.close();
    }
}

// ============================================================================
// 只监控模式 (不下单)
// ============================================================================

async function runMonitorOnly(): Promise<void> {
    console.log('========================================');
    console.log('Exchange 事件监控模式');
    console.log('========================================');
    console.log(`智能钱包: ${SMART_WALLET}`);
    console.log('');

    const subscriber = new ExchangeWssSubscriber();

    try {
        await subscriber.connect();
        await subscriber.subscribeToExchanges();

        subscriber.onOrderFilled((event, timestamp) => {
            const ourWallet = SMART_WALLET.toLowerCase();
            const isOurs = event.maker.toLowerCase() === ourWallet || event.taker.toLowerCase() === ourWallet;
            if (isOurs) {
                console.log(`\n⭐ 检测到我们的订单成交!`);
            }
        });

        console.log('\n[INFO] 监控已启动，按 Ctrl+C 退出...');
        console.log('[INFO] 在其他终端执行交易，这里会显示 OrderFilled 事件\n');

        // 持续运行
        await new Promise<void>(() => {});

    } catch (err) {
        console.error('[ERROR]', err);
        subscriber.close();
    }
}

// ============================================================================
// 入口
// ============================================================================

const args = process.argv.slice(2);

if (args.includes('--monitor')) {
    runMonitorOnly().catch(console.error);
} else {
    runLatencyTest().catch(console.error);
}
