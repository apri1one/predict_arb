// 测试 SSE 连接
const http = require('http');

console.log('正在连接 SSE 端点: http://localhost:3002/api/stream...\n');

const req = http.request({
    hostname: 'localhost',
    port: 3002,
    path: '/api/stream',
    method: 'GET',
    headers: {
        'Accept': 'text/event-stream'
    }
}, (res) => {
    console.log('✅ 连接成功，状态码:', res.statusCode);
    console.log('📋 响应头:', JSON.stringify(res.headers, null, 2));
    console.log('\n📡 接收到的事件:\n');

    let buffer = '';
    let eventCount = 0;

    res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const event of lines) {
            if (event.trim()) {
                eventCount++;
                console.log(`--- 事件 #${eventCount} ---`);
                const eventLines = event.split('\n');
                for (const line of eventLines) {
                    if (line.startsWith('event:')) {
                        console.log(`类型: ${line.substring(6).trim()}`);
                    } else if (line.startsWith('data:')) {
                        try {
                            const data = JSON.parse(line.substring(5));
                            if (Array.isArray(data)) {
                                console.log(`数据: 数组 [${data.length} 项]`);
                                if (data[0]) {
                                    console.log(`样本:`, JSON.stringify(data[0], null, 2).substring(0, 300));
                                }
                            } else {
                                console.log(`数据:`, JSON.stringify(data, null, 2).substring(0, 500));
                            }
                        } catch (e) {
                            console.log(`数据: ${line.substring(5, 200)}...`);
                        }
                    }
                }
                console.log('');
            }
        }
    });

    res.on('end', () => {
        console.log('连接关闭');
    });
});

req.on('error', (e) => {
    console.error('❌ 连接错误:', e.message);
});

req.end();

// 10 秒后自动关闭
setTimeout(() => {
    console.log('\n⏱️  测试结束');
    process.exit(0);
}, 10000);
