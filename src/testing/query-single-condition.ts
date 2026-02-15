/**
 * 直接查询单个 conditionId，验证它在 Polymarket 上是否存在
 */

async function querySingleCondition() {
    const testConditions = [
        {
            name: 'Fed 利率决策',
            conditionId: '0xe93c89c41d1bb08d3bb40066d8565df301a696563b2542256e6e8bbbb1ec490d',
            predictId: 521
        },
        {
            name: 'Bitcoin $80k vs $100k',
            conditionId: '0x2690f6e83044f515477728cd0b786174bda89340ddc1c22a90b07b6215860be6',
            predictId: 542
        },
        {
            name: 'Super Bowl - Buffalo',
            conditionId: '0x39d45b454dcf932767962ad9cbd858c5a6ec21d4d48318a484775b2e83264467',
            predictId: 706
        }
    ];

    for (const test of testConditions) {
        console.log(`\n检查: ${test.name} (Predict ID: ${test.predictId})`);
        console.log(`Condition ID: ${test.conditionId}\n`);

        // 尝试多个 API 端点
        const endpoints = [
            `https://gamma-api.polymarket.com/markets?condition_id=${test.conditionId}`,
            `https://clob.polymarket.com/markets/${test.conditionId}`,
            `https://data-api.polymarket.com/markets/${test.conditionId}`
        ];

        for (const url of endpoints) {
            try {
                console.log(`  尝试: ${url.split('?')[0]}...`);
                const res = await fetch(url);
                const status = res.status;
                const text = await res.text();

                console.log(`    Status: ${status}`);

                if (status === 200 && text && text !== '[]' && text !== 'null') {
                    console.log(`    ✅ 找到数据!`);
                    console.log(`    内容: ${text.substring(0, 200)}...`);
                } else if (status === 404) {
                    console.log(`    ❌ 404 Not Found`);
                } else if (text === '[]') {
                    console.log(`    ❌ 返回空数组`);
                } else {
                    console.log(`    ❌ 无有效数据: ${text}`);
                }
            } catch (error: any) {
                console.log(`    ❌ 错误: ${error.message}`);
            }
        }

        console.log();
    }
}

querySingleCondition().catch(console.error);
