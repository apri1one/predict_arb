const http = require('http');

http.get('http://localhost:3005/api/data', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const d = JSON.parse(data);
        const takers = d.opportunities
            .filter(o => o.strategy === 'TAKER')
            .sort((a, b) => b.profitPercent - a.profitPercent);

        console.log('=== TAKER 机会列表 (按利润排序) ===\n');
        takers.slice(0, 10).forEach((o, i) => {
            const title = o.title || 'Unknown';
            console.log(`${i + 1}. [${o.marketId}] ${title.slice(0, 50)}...`);
            console.log(`   利润: ${o.profitPercent?.toFixed(2) || 'N/A'}% | 深度: ${o.maxQuantity || 'N/A'} shares`);
            console.log(`   Predict Ask: ${o.predictAsk?.toFixed(3) || 'N/A'} | Poly Ask: ${o.polymarketPrice?.toFixed(3) || 'N/A'}`);
            console.log(`   Total Cost: ${o.totalCost?.toFixed(4) || 'N/A'} | Fee: ${o.feeRateBps || 'N/A'} bps`);
            console.log('');
        });
    });
}).on('error', e => console.error('Error:', e.message));
