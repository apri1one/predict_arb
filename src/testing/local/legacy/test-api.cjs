// 测试 API 数据格式
const http = require('http');

console.log('测试 /api/data 端点...\n');

http.get('http://localhost:3003/api/data', (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            console.log('✅ 响应成功');
            console.log('\n📊 统计信息:');
            console.log(JSON.stringify(json.stats, null, 2));
            console.log('\n💰 套利机会数量:', json.opportunities?.length || 0);
            if (json.opportunities?.[0]) {
                console.log('\n📝 第一个机会样本:');
                console.log(JSON.stringify(json.opportunities[0], null, 2));
            }
        } catch (e) {
            console.error('❌ 解析错误:', e.message);
            console.log('原始数据:', data.substring(0, 500));
        }
        process.exit(0);
    });
}).on('error', (e) => {
    console.error('❌ 请求错误:', e.message);
    process.exit(1);
});
