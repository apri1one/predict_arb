// 测试 Predict 订单簿 API
const https = require('https');

const marketId = 286;
const apiKey = process.env.PREDICT_API_KEY || '';

if (!apiKey) {
    console.error('❌ 缺少 PREDICT_API_KEY 环境变量');
    process.exit(1);
}

console.log(`测试市场 ${marketId} 的订单簿...\n`);

const options = {
    hostname: 'api.predict.fun',
    port: 443,
    path: `/v1/markets/${marketId}/orderbook`,
    method: 'GET',
    headers: {
        'x-api-key': apiKey
    }
};

const req = https.request(options, (res) => {
    console.log(`状态码: ${res.statusCode}`);
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            console.log('\n响应数据:');
            console.log(JSON.stringify(json, null, 2));

            if (json.data) {
                console.log('\n订单簿统计:');
                console.log(`Bids: ${json.data.bids?.length || 0} 档`);
                console.log(`Asks: ${json.data.asks?.length || 0} 档`);

                if (json.data.bids && json.data.bids.length > 0) {
                    console.log(`\n最优买单: ${JSON.stringify(json.data.bids[0])}`);
                }
                if (json.data.asks && json.data.asks.length > 0) {
                    console.log(`最优卖单: ${JSON.stringify(json.data.asks[0])}`);
                }
            }
        } catch (e) {
            console.error('解析错误:', e.message);
            console.log('原始数据:', data);
        }
        process.exit(0);
    });
});

req.on('error', (e) => {
    console.error('请求错误:', e.message);
    process.exit(1);
});

req.end();
