/**
 * 简单的 Predict WebSocket 连接测试 (CommonJS)
 */

require('dotenv').config({ path: '../.env' });
const WebSocket = require('ws');

const API_KEY = process.env.PREDICT_API_KEY || '';
const WS_URL = `wss://ws.predict.fun/ws?apiKey=${encodeURIComponent(API_KEY)}`;

console.log('Predict WebSocket 简单测试');
console.log('='.repeat(50));
console.log(`API Key: ${API_KEY.slice(0, 8)}...`);

const ws = new WebSocket(WS_URL);
let messageCount = 0;
const startTime = Date.now();

ws.on('open', () => {
    const elapsed = Date.now() - startTime;
    console.log(`\n[${elapsed}ms] 连接成功!`);

    // 发送订阅请求
    const subscribeMsg = {
        method: 'subscribe',
        requestId: 1,
        params: ['predictOrderbook/1'],
    };
    console.log(`[${elapsed}ms] 发送订阅请求`);
    ws.send(JSON.stringify(subscribeMsg));
});

ws.on('message', (data) => {
    messageCount++;
    const elapsed = Date.now() - startTime;
    const msg = data.toString();

    try {
        const parsed = JSON.parse(msg);

        if (parsed.type === 'M' && parsed.topic === 'heartbeat') {
            console.log(`[${elapsed}ms] 收到心跳, 回复中...`);
            ws.send(JSON.stringify({
                method: 'heartbeat',
                data: parsed.data,
            }));
            return;
        }

        if (parsed.type === 'R') {
            console.log(`[${elapsed}ms] 订阅响应: success=${parsed.success}`);
            return;
        }

        if (parsed.type === 'M' && parsed.topic?.startsWith('predictOrderbook/')) {
            const ob = parsed.data;
            console.log(`[${elapsed}ms] 订单簿更新: bids=${ob?.bids?.length || 0}, asks=${ob?.asks?.length || 0}`);
            return;
        }

        console.log(`[${elapsed}ms] 消息 #${messageCount}:`, msg.slice(0, 200));
    } catch {
        console.log(`[${elapsed}ms] 原始消息:`, msg.slice(0, 200));
    }
});

ws.on('error', (err) => {
    const elapsed = Date.now() - startTime;
    console.error(`[${elapsed}ms] 错误:`, err.message);
});

ws.on('close', (code, reason) => {
    const elapsed = Date.now() - startTime;
    console.log(`[${elapsed}ms] 连接关闭: code=${code}`);
    console.log(`\n总消息数: ${messageCount}`);
    process.exit(0);
});

setTimeout(() => {
    console.log('\n20 秒测试完成，关闭连接...');
    ws.close();
}, 20000);

console.log('\n等待连接...');
