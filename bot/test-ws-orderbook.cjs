/**
 * 测试 Predict WebSocket 订单簿订阅
 */

require('dotenv').config({ path: '../.env' });
const WebSocket = require('ws');

const API_KEY = process.env.PREDICT_API_KEY || '';
const WS_URL = `wss://ws.predict.fun/ws?apiKey=${encodeURIComponent(API_KEY)}`;

// 活跃市场 ID
const MARKET_IDS = [896, 1165, 898];

console.log('Predict WebSocket 订单簿测试');
console.log('='.repeat(50));

const ws = new WebSocket(WS_URL);
let messageCount = 0;
let orderbookUpdates = 0;
const startTime = Date.now();
const updateTimes = [];

ws.on('open', () => {
    const elapsed = Date.now() - startTime;
    console.log(`\n[${elapsed}ms] 连接成功!`);

    // 订阅多个市场的订单簿
    for (let i = 0; i < MARKET_IDS.length; i++) {
        const subscribeMsg = {
            method: 'subscribe',
            requestId: i + 1,
            params: [`predictOrderbook/${MARKET_IDS[i]}`],
        };
        console.log(`[${elapsed}ms] 订阅市场 ${MARKET_IDS[i]}`);
        ws.send(JSON.stringify(subscribeMsg));
    }
});

ws.on('message', (data) => {
    messageCount++;
    const elapsed = Date.now() - startTime;
    const msg = data.toString();

    try {
        const parsed = JSON.parse(msg);

        if (parsed.type === 'M' && parsed.topic === 'heartbeat') {
            ws.send(JSON.stringify({
                method: 'heartbeat',
                data: parsed.data,
            }));
            return;
        }

        if (parsed.type === 'R') {
            console.log(`[${elapsed}ms] 订阅响应: requestId=${parsed.requestId}, success=${parsed.success}`);
            return;
        }

        if (parsed.type === 'M' && parsed.topic?.startsWith('predictOrderbook/')) {
            orderbookUpdates++;
            const marketId = parsed.topic.split('/')[1];
            const ob = parsed.data;
            updateTimes.push(elapsed);

            // 只显示前 10 次更新
            if (orderbookUpdates <= 10) {
                const bestBid = ob?.bids?.[0] ? `${ob.bids[0][0]}@${ob.bids[0][1].toFixed(2)}` : 'N/A';
                const bestAsk = ob?.asks?.[0] ? `${ob.asks[0][0]}@${ob.asks[0][1].toFixed(2)}` : 'N/A';
                console.log(`[${elapsed}ms] 市场 ${marketId}: bid=${bestBid}, ask=${bestAsk}`);
            } else if (orderbookUpdates === 11) {
                console.log(`[${elapsed}ms] ... 更多更新省略 ...`);
            }
            return;
        }
    } catch {
        // ignore
    }
});

ws.on('error', (err) => {
    const elapsed = Date.now() - startTime;
    console.error(`[${elapsed}ms] 错误:`, err.message);
});

ws.on('close', (code, reason) => {
    const elapsed = Date.now() - startTime;
    console.log(`\n[${elapsed}ms] 连接关闭`);

    // 统计
    console.log('\n' + '='.repeat(50));
    console.log('统计:');
    console.log(`总消息数: ${messageCount}`);
    console.log(`订单簿更新: ${orderbookUpdates}`);

    if (updateTimes.length >= 2) {
        const intervals = [];
        for (let i = 1; i < updateTimes.length; i++) {
            intervals.push(updateTimes[i] - updateTimes[i - 1]);
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        console.log(`平均更新间隔: ${avgInterval.toFixed(0)}ms`);
        console.log(`最小间隔: ${Math.min(...intervals)}ms`);
        console.log(`最大间隔: ${Math.max(...intervals)}ms`);
    }

    process.exit(0);
});

setTimeout(() => {
    console.log('\n30 秒测试完成...');
    ws.close();
}, 30000);

console.log('\n等待连接...');
