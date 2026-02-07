/**
 * Predict WebSocket 钱包事件订阅测试
 *
 * 专门测试 predictWalletEvents/{jwt} 订阅
 * 打印详细日志，验证是否能收到订单状态事件
 *
 * 用法:
 *   npx tsx src/testing/test-predict-ws-wallet-events.ts [marketId]
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import { WebSocket } from 'ws';
import { getPredictTrader } from '../dashboard/predict-trader.js';
import { PredictRestClient } from '../predict/rest-client.js';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.PREDICT_API_KEY || '';
const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS || '';

const PREDICT_WS_URL = 'wss://ws.predict.fun/ws';

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
    console.log('Predict WebSocket 钱包事件订阅测试');
    console.log('='.repeat(60));

    if (!API_KEY || !SMART_WALLET) {
        console.error('错误: 缺少 PREDICT_API_KEY 或 PREDICT_SMART_WALLET_ADDRESS');
        process.exit(1);
    }

    console.log(`\nSmart Wallet: ${SMART_WALLET}`);
    console.log(`API Key: ${API_KEY.slice(0, 8)}...`);

    // 1. 初始化 trader 获取 JWT
    console.log('\n[1] 初始化 PredictTrader 获取 JWT...');
    const trader = getPredictTrader();
    await trader.init();

    // @ts-ignore - 访问私有属性
    const jwt = trader.jwt as string;
    if (!jwt) {
        console.error('无法获取 JWT');
        process.exit(1);
    }

    console.log(`JWT Token: ${jwt.slice(0, 30)}...`);
    console.log(`JWT 长度: ${jwt.length}`);

    // 解码 JWT payload 查看内容
    try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
        console.log('\nJWT Payload:');
        console.log(`  sub (address): ${payload.sub}`);
        console.log(`  iat: ${new Date(payload.iat * 1000).toISOString()}`);
        console.log(`  exp: ${new Date(payload.exp * 1000).toISOString()}`);

        // 验证 JWT 中的地址是否与 SMART_WALLET 一致
        if (payload.sub?.toLowerCase() !== SMART_WALLET.toLowerCase()) {
            console.warn(`\n⚠️ 警告: JWT 地址 (${payload.sub}) 与 SMART_WALLET (${SMART_WALLET}) 不一致!`);
        } else {
            console.log(`\n✅ JWT 地址与 SMART_WALLET 一致`);
        }
    } catch (e) {
        console.log('JWT 解码失败');
    }

    // 2. 连接 WebSocket
    console.log('\n[2] 连接 Predict WebSocket...');
    const ws = new WebSocket(`${PREDICT_WS_URL}?apiKey=${encodeURIComponent(API_KEY)}`);

    let subscribed = false;
    let messageCount = 0;
    let walletEventCount = 0;

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('连接超时'));
        }, 15000);

        ws.on('open', () => {
            clearTimeout(timeout);
            console.log(`[${timestamp()}] WebSocket 已连接`);

            // 订阅钱包事件
            const topic = `predictWalletEvents/${jwt}`;
            console.log(`\n[3] 订阅钱包事件...`);
            console.log(`Topic: predictWalletEvents/<jwt>`);
            console.log(`Topic 长度: ${topic.length}`);

            ws.send(JSON.stringify({
                method: 'subscribe',
                requestId: 1,
                params: [topic],
            }));
        });

        ws.on('message', (data) => {
            messageCount++;
            const msg = JSON.parse(data.toString());

            // 心跳
            if (msg.type === 'M' && msg.topic === 'heartbeat') {
                console.log(`[${timestamp()}] 心跳`);
                ws.send(JSON.stringify({ method: 'heartbeat', data: msg.data }));
                return;
            }

            // 订阅响应
            if (msg.type === 'R' && msg.requestId === 1) {
                if (msg.success) {
                    console.log(`[${timestamp()}] ✅ 订阅成功!`);
                    console.log(`  响应: ${JSON.stringify(msg)}`);
                    subscribed = true;
                    resolve();
                } else {
                    console.error(`[${timestamp()}] ❌ 订阅失败!`);
                    console.error(`  错误: ${JSON.stringify(msg.error)}`);
                    reject(new Error('订阅失败'));
                }
                return;
            }

            // 钱包事件
            if (msg.type === 'M' && msg.topic?.startsWith('predictWalletEvents/')) {
                walletEventCount++;
                console.log(`\n[${timestamp()}] 📬 收到钱包事件 #${walletEventCount}!`);
                console.log(`  完整数据: ${JSON.stringify(msg.data, null, 2)}`);
                return;
            }

            // 其他消息
            console.log(`[${timestamp()}] 其他消息: ${JSON.stringify(msg).slice(0, 200)}`);
        });

        ws.on('error', (err) => {
            console.error(`[${timestamp()}] WebSocket 错误: ${err.message}`);
        });

        ws.on('close', (code) => {
            console.log(`[${timestamp()}] WebSocket 关闭: code=${code}`);
        });
    });

    if (!subscribed) {
        console.error('订阅失败，退出');
        ws.close();
        process.exit(1);
    }

    // 3. 查找市场并下单
    const args = process.argv.slice(2);
    const marketIdArg = parseInt(args[0], 10) || undefined;

    console.log('\n[4] 查找市场...');
    const client = new PredictRestClient({ apiKey: API_KEY });

    let marketId: number;
    let askPrice: number;
    let orderQty: number;

    if (marketIdArg) {
        marketId = marketIdArg;
        const ob = await client.getOrderBook(marketId);
        if (!ob.asks?.[0]) {
            console.error('订单簿为空');
            ws.close();
            process.exit(1);
        }
        askPrice = ob.asks[0][0];
        orderQty = Math.max(Math.ceil(1.1 / askPrice), 2);
    } else {
        // 自动查找市场
        const matches = await client.getOrderMatches({ limit: 20 });
        const marketIds = [...new Set(matches.map(m => m.market?.id).filter(Boolean))] as number[];

        let found = false;
        for (const id of marketIds.slice(0, 10)) {
            try {
                const ob = await client.getOrderBook(id);
                if (ob.asks?.length > 0) {
                    askPrice = ob.asks[0][0];
                    if (askPrice >= 0.01 && askPrice <= 0.95) {
                        marketId = id;
                        orderQty = Math.max(Math.ceil(1.1 / askPrice), 2);
                        found = true;
                        break;
                    }
                }
            } catch { /* ignore */ }
        }

        if (!found) {
            console.error('未找到合适的市场');
            ws.close();
            process.exit(1);
        }
    }

    const orderValue = askPrice! * orderQty!;
    console.log(`市场: ${marketId!}`);
    console.log(`卖一价: ${askPrice!}`);
    console.log(`下单数量: ${orderQty!}`);
    console.log(`订单价值: $${orderValue.toFixed(2)}`);

    if (orderValue > 3) {
        console.log('\n⚠️ 订单金额超过 $3，跳过下单');
        console.log('\n等待 30 秒观察是否有其他钱包事件...');
        await sleep(30000);
        ws.close();
        process.exit(0);
    }

    // 4. 下单
    console.log('\n[5] 提交订单...');
    const placeTime = Date.now();

    const result = await trader.placeOrder({
        marketId: marketId!,
        side: 'BUY',
        price: askPrice!,
        quantity: orderQty!,
        outcome: 'YES',
    });

    const placeLatency = Date.now() - placeTime;

    if (!result.success) {
        console.error(`下单失败: ${result.error}`);
    } else {
        console.log(`✅ 下单成功!`);
        console.log(`  Hash: ${result.hash}`);
        console.log(`  耗时: ${placeLatency}ms`);
    }

    // 5. 等待钱包事件
    console.log('\n[6] 等待钱包事件 (30秒)...');
    console.log('如果订阅正确，应该会收到订单相关事件');

    const waitStart = Date.now();
    while (Date.now() - waitStart < 30000) {
        await sleep(1000);
        process.stdout.write('.');
    }
    console.log();

    // 6. 汇总
    console.log('\n' + '='.repeat(60));
    console.log('测试结果汇总');
    console.log('='.repeat(60));
    console.log(`总消息数: ${messageCount}`);
    console.log(`钱包事件数: ${walletEventCount}`);

    if (walletEventCount === 0) {
        console.log('\n⚠️ 未收到任何钱包事件!');
        console.log('可能原因:');
        console.log('  1. JWT 中的地址与下单地址不一致');
        console.log('  2. 订单未成功提交到系统');
        console.log('  3. 服务器端事件推送延迟或故障');
    } else {
        console.log(`\n✅ 收到 ${walletEventCount} 个钱包事件`);
    }

    ws.close();
    console.log('\n测试完成!');
    process.exit(0);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
