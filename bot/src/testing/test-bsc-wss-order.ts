/**
 * BSC WebSocket 订阅测试 - 链上活动监控与 API 时间差对比
 *
 * 功能:
 * 1. 连接 BSC WebSocket 订阅智能钱包相关的链上事件
 * 2. 下一个小额市价单
 * 3. 对比 WSS 事件和 API 订单状态的时间差
 */

import { WebSocket } from 'ws';
import { ethers, formatUnits, parseUnits, Interface, Log } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载环境变量
dotenv.config({ path: path.join(__dirname, '../../..', '.env') });

// ============================================================================
// 常量
// ============================================================================

const BSC_WSS_URL = 'wss://bsc-mainnet.nodereal.io/ws/v1/69a15e71374d4a15bfbf51e7bff2c656';
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS || '0xe81b9D1c038BB2E7C24b40C9281Fe19F43D1d313';

// Predict Exchange 合约地址
const EXCHANGES = {
    CTF_EXCHANGE: '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
    NEG_RISK_CTF_EXCHANGE: '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
    YIELD_BEARING_CTF_EXCHANGE: '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
    YIELD_BEARING_NEG_RISK_CTF_EXCHANGE: '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
};

// USDC 合约地址 (BSC)
const USDC_ADDRESS = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

// CTF Exchange 事件 ABI (基于标准 CTF Exchange)
// 参考: https://github.com/Polymarket/ctf-exchange
const CTF_EXCHANGE_EVENTS = [
    // OrderMatched 事件 - 订单成交时触发
    'event OrderMatched(bytes32 indexed takerOrderHash, address indexed takerAddr, address makerAddr, uint256 takerAssetId, uint256 makerAssetId, uint256 takerAmountFilled, uint256 makerAmountFilled)',
    // OrdersMatched 事件 - 批量成交
    'event OrdersMatched(bytes32[] takerOrderHashes, address indexed taker, bytes32 indexed makerOrderHash, address indexed maker, uint256 takerAssetId, uint256 makerAssetId, uint256 takerAmountFilled, uint256 makerAmountFilled)',
    // OrderFilled 事件
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
    // Transfer 事件 (ERC20/ERC1155)
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
];

const ctfInterface = new Interface(CTF_EXCHANGE_EVENTS);

// 事件签名 Topic
const EVENT_TOPICS = {
    OrderMatched: ethers.id('OrderMatched(bytes32,address,address,uint256,uint256,uint256,uint256)'),
    OrdersMatched: ethers.id('OrdersMatched(bytes32[],address,bytes32,address,uint256,uint256,uint256,uint256)'),
    OrderFilled: ethers.id('OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'),
    Transfer: ethers.id('Transfer(address,address,uint256)'),
    TransferSingle: ethers.id('TransferSingle(address,address,address,uint256,uint256)'),
    TransferBatch: ethers.id('TransferBatch(address,address,address,uint256[],uint256[])'),
};

// ============================================================================
// WebSocket 订阅管理
// ============================================================================

interface WssEvent {
    timestamp: number;
    blockNumber: number;
    txHash: string;
    eventName: string;
    decoded: Record<string, unknown>;
    raw: unknown;
}

class BscWssSubscriber {
    private ws: WebSocket | null = null;
    private subscriptionIds: Map<string, string> = new Map();
    private events: WssEvent[] = [];
    private onEventCallback: ((event: WssEvent) => void) | null = null;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private requestId = 1;

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            console.log(`[WSS] 连接到 ${BSC_WSS_URL.substring(0, 50)}...`);

            this.ws = new WebSocket(BSC_WSS_URL);

            this.ws.on('open', () => {
                console.log('[WSS] ✅ 连接成功');
                this.reconnectAttempts = 0;
                resolve();
            });

            this.ws.on('message', (data) => this.handleMessage(data.toString()));

            this.ws.on('error', (err) => {
                console.error('[WSS] ❌ 连接错误:', err.message);
                reject(err);
            });

            this.ws.on('close', () => {
                console.log('[WSS] 连接关闭');
                this.handleReconnect();
            });
        });
    }

    private handleMessage(data: string): void {
        try {
            const msg = JSON.parse(data);

            // 订阅确认
            if (msg.id && msg.result) {
                console.log(`[WSS] 订阅确认: ${msg.result}`);
                return;
            }

            // 订阅数据
            if (msg.method === 'eth_subscription' && msg.params) {
                const { subscription, result } = msg.params;
                this.handleSubscriptionData(subscription, result);
            }
        } catch (err) {
            console.error('[WSS] 消息解析失败:', err);
        }
    }

    private handleSubscriptionData(subscriptionId: string, result: any): void {
        const timestamp = Date.now();

        // 判断订阅类型
        const subType = this.getSubscriptionType(subscriptionId);

        if (subType === 'logs') {
            this.handleLogEvent(result, timestamp);
        } else if (subType === 'pendingTransactions') {
            this.handlePendingTx(result, timestamp);
        } else if (subType === 'newHeads') {
            // 新区块头
            console.log(`[WSS] 新区块: #${parseInt(result.number, 16)} @ ${new Date(timestamp).toISOString()}`);
        }
    }

    private handleLogEvent(log: any, timestamp: number): void {
        const event: WssEvent = {
            timestamp,
            blockNumber: parseInt(log.blockNumber, 16),
            txHash: log.transactionHash,
            eventName: 'Unknown',
            decoded: {},
            raw: log,
        };

        // 尝试解码事件
        try {
            const topic0 = log.topics[0];

            // 识别事件类型
            for (const [name, sig] of Object.entries(EVENT_TOPICS)) {
                if (topic0 === sig) {
                    event.eventName = name;
                    break;
                }
            }

            // 解码事件数据
            if (event.eventName !== 'Unknown') {
                try {
                    const decoded = ctfInterface.parseLog({
                        topics: log.topics,
                        data: log.data,
                    });
                    if (decoded) {
                        event.decoded = {
                            name: decoded.name,
                            args: Object.fromEntries(
                                decoded.fragment.inputs.map((input, i) => [
                                    input.name,
                                    this.formatValue(decoded.args[i]),
                                ])
                            ),
                        };
                    }
                } catch {
                    // 解码失败，保留原始数据
                    event.decoded = {
                        topic0,
                        topics: log.topics,
                        data: log.data,
                    };
                }
            } else {
                event.decoded = {
                    topic0,
                    topics: log.topics,
                    data: log.data,
                };
            }
        } catch (err) {
            console.error('[WSS] 事件解码失败:', err);
        }

        this.events.push(event);

        console.log(`\n[WSS] 📡 链上事件 @ ${new Date(timestamp).toISOString()}`);
        console.log(`  区块: #${event.blockNumber}`);
        console.log(`  交易: ${event.txHash}`);
        console.log(`  事件: ${event.eventName}`);
        console.log(`  解码:`, JSON.stringify(event.decoded, null, 2));

        if (this.onEventCallback) {
            this.onEventCallback(event);
        }
    }

    private handlePendingTx(txHash: string, timestamp: number): void {
        console.log(`[WSS] 📤 Pending TX: ${txHash} @ ${new Date(timestamp).toISOString()}`);
    }

    private formatValue(val: any): string {
        if (typeof val === 'bigint') {
            return val.toString();
        }
        if (val._isBigNumber) {
            return val.toString();
        }
        return String(val);
    }

    private getSubscriptionType(subscriptionId: string): string {
        for (const [type, id] of this.subscriptionIds.entries()) {
            if (id === subscriptionId) return type;
        }
        return 'unknown';
    }

    private handleReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[WSS] 达到最大重连次数，停止重连');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        console.log(`[WSS] ${delay}ms 后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

        setTimeout(() => this.connect(), delay);
    }

    /**
     * 订阅指定地址相关的日志事件
     */
    async subscribeToAddressLogs(addresses: string[]): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket 未连接');
        }

        const id = this.requestId++;
        const params = {
            address: addresses,
            // 不过滤 topics，获取所有事件
        };

        const request = {
            jsonrpc: '2.0',
            id,
            method: 'eth_subscribe',
            params: ['logs', params],
        };

        console.log(`[WSS] 订阅地址日志:`, addresses);
        this.ws.send(JSON.stringify(request));

        // 等待订阅确认
        await new Promise<void>((resolve) => {
            const handler = (data: Buffer) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === id && msg.result) {
                    this.subscriptionIds.set('logs', msg.result);
                    resolve();
                }
            };
            this.ws!.once('message', handler);
            setTimeout(() => resolve(), 3000);
        });
    }

    /**
     * 订阅新区块头
     */
    async subscribeToNewHeads(): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket 未连接');
        }

        const id = this.requestId++;
        const request = {
            jsonrpc: '2.0',
            id,
            method: 'eth_subscribe',
            params: ['newHeads'],
        };

        console.log(`[WSS] 订阅新区块头`);
        this.ws.send(JSON.stringify(request));
    }

    onEvent(callback: (event: WssEvent) => void): void {
        this.onEventCallback = callback;
    }

    getEvents(): WssEvent[] {
        return this.events;
    }

    close(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// ============================================================================
// Predict API 客户端 (简化版)
// ============================================================================

const PREDICT_API_BASE = 'https://api.predict.fun';

async function getMarkets(): Promise<any[]> {
    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) throw new Error('PREDICT_API_KEY 未设置');

    const resp = await fetch(`${PREDICT_API_BASE}/v1/markets?status=ACTIVE&first=20`, {
        headers: { 'x-api-key': apiKey },
    });

    if (!resp.ok) {
        throw new Error(`获取市场失败: ${resp.status}`);
    }

    const data = await resp.json();
    return data.data?.markets || [];
}

async function getOrderbook(marketId: number): Promise<{ bids: number[][]; asks: number[][] }> {
    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) throw new Error('PREDICT_API_KEY 未设置');

    const resp = await fetch(`${PREDICT_API_BASE}/v1/markets/${marketId}/orderbook`, {
        headers: { 'x-api-key': apiKey },
    });

    if (!resp.ok) {
        throw new Error(`获取订单簿失败: ${resp.status}`);
    }

    const data = await resp.json();
    return {
        bids: data.data?.bids || [],
        asks: data.data?.asks || [],
    };
}

// ============================================================================
// 主测试流程
// ============================================================================

async function exploreHistoricalTx(): Promise<void> {
    console.log('\n========================================');
    console.log('第一步: 查询历史交易以了解事件结构');
    console.log('========================================\n');

    const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org');

    // 用户提供的历史交易
    const txHashes = [
        '0xd484cbe91d31463167fdffd3cf9ce4566739b08b279255eea346e41ebbf5aa69', // Match Orders
        '0xd1ea607d935fe2249be208f32a8ca9b46c07008efcc3785d5145b5e722613048', // Match Orders
        '0x6e5ca5c014960baaf29324651c7268bff3237344d6494dfa04df41ac541370b9', // Handle Ops
    ];

    for (const txHash of txHashes) {
        console.log(`\n--- 交易: ${txHash.substring(0, 20)}... ---`);

        try {
            const receipt = await provider.getTransactionReceipt(txHash);
            if (!receipt) {
                console.log('  交易未找到');
                continue;
            }

            console.log(`  区块: #${receipt.blockNumber}`);
            console.log(`  状态: ${receipt.status === 1 ? '成功' : '失败'}`);
            console.log(`  Gas Used: ${receipt.gasUsed.toString()}`);
            console.log(`  日志数量: ${receipt.logs.length}`);

            // 解析日志
            for (let i = 0; i < receipt.logs.length; i++) {
                const log = receipt.logs[i];
                console.log(`\n  日志 #${i}:`);
                console.log(`    地址: ${log.address}`);
                console.log(`    Topics[0]: ${log.topics[0]}`);

                // 识别事件
                let eventName = 'Unknown';
                for (const [name, sig] of Object.entries(EVENT_TOPICS)) {
                    if (log.topics[0] === sig) {
                        eventName = name;
                        break;
                    }
                }
                console.log(`    事件类型: ${eventName}`);

                // 尝试解码
                if (eventName === 'Transfer') {
                    if (log.topics.length >= 3) {
                        const from = '0x' + log.topics[1].slice(26);
                        const to = '0x' + log.topics[2].slice(26);
                        const value = BigInt(log.data);
                        console.log(`    From: ${from}`);
                        console.log(`    To: ${to}`);
                        console.log(`    Value: ${formatUnits(value, 18)} (假设 18 位精度)`);
                    }
                } else if (eventName === 'TransferSingle') {
                    if (log.topics.length >= 4) {
                        const operator = '0x' + log.topics[1].slice(26);
                        const from = '0x' + log.topics[2].slice(26);
                        const to = '0x' + log.topics[3].slice(26);
                        // data 包含 id 和 value
                        const dataHex = log.data.slice(2);
                        const id = BigInt('0x' + dataHex.slice(0, 64));
                        const value = BigInt('0x' + dataHex.slice(64, 128));
                        console.log(`    Operator: ${operator}`);
                        console.log(`    From: ${from}`);
                        console.log(`    To: ${to}`);
                        console.log(`    Token ID: ${id.toString()}`);
                        console.log(`    Value: ${formatUnits(value, 18)}`);
                    }
                } else if (eventName === 'OrderFilled' || eventName === 'OrderMatched') {
                    try {
                        const decoded = ctfInterface.parseLog({
                            topics: log.topics as string[],
                            data: log.data,
                        });
                        if (decoded) {
                            console.log(`    解码成功:`);
                            for (let j = 0; j < decoded.fragment.inputs.length; j++) {
                                const input = decoded.fragment.inputs[j];
                                const val = decoded.args[j];
                                console.log(`      ${input.name}: ${typeof val === 'bigint' ? val.toString() : val}`);
                            }
                        }
                    } catch (e) {
                        console.log(`    解码失败: ${e}`);
                    }
                } else {
                    // 打印原始数据
                    console.log(`    Data: ${log.data.substring(0, 66)}...`);
                    if (log.topics.length > 1) {
                        for (let t = 1; t < log.topics.length; t++) {
                            console.log(`    Topics[${t}]: ${log.topics[t]}`);
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`  查询失败: ${err}`);
        }
    }
}

async function runWssSubscriptionTest(): Promise<void> {
    console.log('\n========================================');
    console.log('第二步: 启动 WSS 订阅监控');
    console.log('========================================\n');

    const subscriber = new BscWssSubscriber();

    try {
        await subscriber.connect();

        // 订阅智能钱包相关的事件
        // 包括所有 Exchange 合约和 USDC 转账
        const addresses = [
            SMART_WALLET.toLowerCase(),
            ...Object.values(EXCHANGES).map(a => a.toLowerCase()),
            USDC_ADDRESS.toLowerCase(),
        ];

        await subscriber.subscribeToAddressLogs(addresses);
        await subscriber.subscribeToNewHeads();

        console.log('\n[INFO] WSS 订阅已启动，等待事件...');
        console.log(`[INFO] 监控地址: ${SMART_WALLET}`);
        console.log('[INFO] 监控合约:', Object.keys(EXCHANGES).join(', '));

        // 等待事件
        let eventReceived = false;
        subscriber.onEvent((event) => {
            eventReceived = true;
            console.log(`\n[EVENT] 收到事件: ${event.eventName}`);
        });

        // 持续监控 60 秒
        console.log('\n[INFO] 持续监控 60 秒...\n');
        console.log('如果您在其他地方进行 Predict 交易，这里会显示链上事件。');
        console.log('按 Ctrl+C 提前退出。\n');

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 60000);
        });

        subscriber.close();

        const events = subscriber.getEvents();
        console.log(`\n[结果] 共收到 ${events.length} 个事件`);

    } catch (err) {
        console.error('[ERROR]', err);
        subscriber.close();
    }
}

async function main(): Promise<void> {
    console.log('========================================');
    console.log('BSC WebSocket 订阅测试');
    console.log('========================================');
    console.log(`智能钱包: ${SMART_WALLET}`);
    console.log(`WSS URL: ${BSC_WSS_URL.substring(0, 50)}...`);
    console.log('');

    // 检查环境变量
    if (!process.env.PREDICT_API_KEY) {
        console.error('错误: PREDICT_API_KEY 未设置');
        process.exit(1);
    }

    // 第一步: 探索历史交易
    await exploreHistoricalTx();

    // 第二步: 启动 WSS 订阅
    await runWssSubscriptionTest();

    console.log('\n========================================');
    console.log('测试完成');
    console.log('========================================');
}

// 运行
main().catch(console.error);
