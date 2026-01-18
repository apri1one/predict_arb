/**
 * Debug Polymarket market API
 */

const CLOB_BASE_URL = 'https://clob.polymarket.com';

async function main() {
    // 测试 condition_id 查询
    const conditionId = '0xd8b9ff369452daebce1ac8cb6a29d6817903e85168356c72812317f38e317613';

    console.log('1. 测试 condition_id 查询...');
    const url1 = `${CLOB_BASE_URL}/markets?condition_id=${conditionId}`;
    console.log(`   URL: ${url1}`);
    const res1 = await fetch(url1);
    console.log(`   Status: ${res1.status}`);
    const data1 = await res1.json();
    console.log(`   Response: ${JSON.stringify(data1, null, 2).slice(0, 500)}`);

    // 测试直接获取市场
    console.log('\n2. 测试 sampling-simplified-markets...');
    const url2 = `${CLOB_BASE_URL}/sampling-simplified-markets?limit=2`;
    console.log(`   URL: ${url2}`);
    const res2 = await fetch(url2);
    console.log(`   Status: ${res2.status}`);
    if (res2.ok) {
        const data2 = await res2.json();
        console.log(`   Response: ${JSON.stringify(data2, null, 2).slice(0, 1000)}`);
    } else {
        console.log(`   Error: ${await res2.text()}`);
    }

    // 测试 markets 接口
    console.log('\n3. 测试 markets 接口...');
    const url3 = `${CLOB_BASE_URL}/markets?limit=2`;
    console.log(`   URL: ${url3}`);
    const res3 = await fetch(url3);
    console.log(`   Status: ${res3.status}`);
    const data3 = await res3.json() as any;
    console.log(`   Type: ${typeof data3}, isArray: ${Array.isArray(data3)}`);
    if (data3.data) {
        console.log(`   data.length: ${data3.data.length}`);
        if (data3.data[0]) {
            console.log(`   First market tokens: ${JSON.stringify(data3.data[0].tokens, null, 2)}`);
        }
    } else if (Array.isArray(data3)) {
        console.log(`   Array length: ${data3.length}`);
    } else {
        console.log(`   Keys: ${Object.keys(data3)}`);
        console.log(`   Response: ${JSON.stringify(data3, null, 2).slice(0, 500)}`);
    }

    // 测试订单簿
    console.log('\n4. 测试订单簿...');
    // 使用一个已知的 token_id
    const testTokenId = '21742633143463906290569050155826241533067272736897614950488156847949938836455';
    const url4 = `${CLOB_BASE_URL}/book?token_id=${testTokenId}`;
    console.log(`   URL: ${url4}`);
    const res4 = await fetch(url4);
    console.log(`   Status: ${res4.status}`);
    if (res4.ok) {
        const data4 = await res4.json() as any;
        console.log(`   Bids: ${data4.bids?.length || 0}`);
        console.log(`   Asks: ${data4.asks?.length || 0}`);
        if (data4.bids?.length > 0) {
            console.log(`   Best bid: ${data4.bids[0].price}`);
        }
    }
}

main().catch(console.error);
