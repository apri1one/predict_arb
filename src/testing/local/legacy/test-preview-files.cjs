const http = require('http');

async function testFile(path) {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: 'localhost',
            port: 3005,
            path: path,
            method: 'GET'
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`${path}: ${res.statusCode} (${data.length} bytes)`);
                resolve();
            });
        });
        req.on('error', (e) => {
            console.log(`${path}: ERROR - ${e.message}`);
            resolve();
        });
        req.setTimeout(3000, () => {
            console.log(`${path}: TIMEOUT`);
            req.destroy();
            resolve();
        });
        req.end();
    });
}

async function main() {
    console.log('测试前端文件加载:\n');
    await testFile('/');
    await testFile('/preview/runtime.js');
    await testFile('/preview/icons.jsx');
    await testFile('/preview/sse.js');
    await testFile('/preview/components.jsx');
    await testFile('/preview/app.jsx');
    await testFile('/api/stream');
}

main();
