const http = require('http');

async function testEndpoint(path, description) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'localhost',
            port: 3005,
            path: path,
            method: 'GET'
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                console.log(`\n=== ${description} ===`);
                console.log(`Status: ${res.statusCode}`);
                console.log(`Content-Type: ${res.headers['content-type']}`);
                console.log(`Data length: ${data.length}`);
                if (data.length < 500) {
                    console.log(`Content: ${data}`);
                } else {
                    console.log(`Content preview: ${data.substring(0, 200)}...`);
                }
                resolve();
            });
        });

        req.on('error', (e) => {
            console.error(`\n=== ${description} ===`);
            console.error(`Error: ${e.message}`);
            resolve();
        });

        req.setTimeout(3000, () => {
            console.error(`\n=== ${description} ===`);
            console.error('Timeout');
            req.destroy();
            resolve();
        });

        req.end();
    });
}

async function main() {
    await testEndpoint('/', 'Homepage (/)');
    await testEndpoint('/assets/index-DWCBCkHZ.js', 'JavaScript bundle');
    await testEndpoint('/assets/index-DpGXC462.css', 'CSS bundle');
    await testEndpoint('/api/stats', 'API Stats');
}

main();
