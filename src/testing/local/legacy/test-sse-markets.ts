// 测试 SSE markets 事件
const EventSource = require('eventsource');

const es = new EventSource('http://localhost:3005/api/stream');

es.addEventListener('markets', (e: any) => {
    const data = JSON.parse(e.data);
    console.log('\n📋 收到 markets 事件:');
    console.log('市场数量:', data.length);
    if (data.length > 0) {
        console.log('\n前3个市场:');
        data.slice(0, 3).forEach((m: any) => {
            console.log(`  ID ${m.predictId}: ${m.predictQuestion || m.predictTitle}`);
            console.log(`    endDate: ${m.endDate || '无'}`);
        });
    }
});

es.addEventListener('opportunity', (e: any) => {
    const data = JSON.parse(e.data);
    console.log(`\n💰 收到 opportunity 事件: ${data.length} 个机会`);
});

es.onerror = (e: any) => {
    console.error('SSE 错误:', e);
};

console.log('🔗 连接 SSE: http://localhost:3005/api/stream');
console.log('等待事件...\n');

setTimeout(() => {
    console.log('\n⏱️ 测试结束');
    es.close();
    process.exit(0);
}, 10000);
