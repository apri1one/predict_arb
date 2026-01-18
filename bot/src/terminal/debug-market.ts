/**
 * 调试单个市场的 API 响应
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
    const envPath = path.join(__dirname, '..', '..', '..', '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

const apiKey = process.env.PREDICT_API_KEY || '';

async function main() {
    // 测试已知有 Polymarket 链接的市场
    const testIds = [441, 521, 575, 690];

    console.log('=== 调试市场 API 响应 ===\n');

    for (const id of testIds) {
        console.log(`\n--- 市场 ${id} ---`);

        const res = await fetch(`https://api.predict.fun/v1/markets/${id}`, {
            headers: { 'x-api-key': apiKey }
        });

        const data = await res.json() as any;
        const m = data.data;

        if (m) {
            console.log(`  标题: ${m.title}`);
            console.log(`  状态: ${m.status}`);
            console.log(`  polymarketConditionIds: ${JSON.stringify(m.polymarketConditionIds)}`);

            // 检查这个市场是否在列表 API 中
            const listRes = await fetch(`https://api.predict.fun/v1/markets?limit=100`, {
                headers: { 'x-api-key': apiKey }
            });
            const listData = await listRes.json() as any;
            const found = listData.data?.find((x: any) => x.id === id);
            console.log(`  在列表 API 中: ${found ? '是' : '否'}`);
            if (found) {
                console.log(`  列表中的 polymarketConditionIds: ${JSON.stringify(found.polymarketConditionIds)}`);
            }
        } else {
            console.log(`  未找到`);
        }
    }

    // 检查列表 API 返回的市场 ID 范围
    console.log('\n\n=== 列表 API 返回的市场 ID 范围 ===');

    let cursor: string | null = null;
    const allIds: number[] = [];

    while (true) {
        let url = 'https://api.predict.fun/v1/markets?limit=100';
        if (cursor) url += `&cursor=${cursor}`;

        const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
        const data = await res.json() as any;

        if (!data.data || data.data.length === 0) break;

        for (const m of data.data) {
            allIds.push(m.id);
        }

        if (!data.cursor) break;
        cursor = data.cursor;
    }

    allIds.sort((a, b) => a - b);
    console.log(`  ID 范围: ${allIds[0]} - ${allIds[allIds.length - 1]}`);
    console.log(`  包含 441: ${allIds.includes(441)}`);
    console.log(`  包含 521: ${allIds.includes(521)}`);
    console.log(`  包含 575: ${allIds.includes(575)}`);
    console.log(`  包含 690: ${allIds.includes(690)}`);
}

main().catch(console.error);
