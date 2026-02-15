const http = require('http');

// Test if preview page is serving
const options = {
    hostname: 'localhost',
    port: 3005,
    path: '/preview',
    method: 'GET'
};

const req = http.request(options, (res) => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Headers: ${JSON.stringify(res.headers, null, 2)}`);

    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        console.log('\n=== Response Body ===');
        console.log(data.substring(0, 500));
    });
});

req.on('error', (e) => {
    console.error(`Request error: ${e.message}`);
});

req.end();
