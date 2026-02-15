/**
 * 保存所有 REGISTERED 事件列表到文件
 */

import * as fs from 'fs';
import * as path from 'path';

// 加载 .env
function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

const PREDICT_API_KEY = process.env.PREDICT_API_KEY!;
const PREDICT_BASE_URL = 'https://api.predict.fun';

async function saveEventList() {
    // 获取所有市场
    const allMarkets: any[] = [];
    let cursor: string | null = null;
    let page = 0;

    do {
        const url = cursor
            ? `${PREDICT_BASE_URL}/v1/markets?first=50&after=${cursor}`
            : `${PREDICT_BASE_URL}/v1/markets?first=50`;

        const res = await fetch(url, {
            headers: { 'x-api-key': PREDICT_API_KEY }
        });

        const data = await res.json() as any;

        if (data.data && Array.isArray(data.data)) {
            allMarkets.push(...data.data);
            page++;
        }

        cursor = data.cursor || null;
        if (page >= 10) break;
    } while (cursor);

    // 筛选 REGISTERED 状态的市场
    const registeredMarkets = allMarkets.filter(m => m.status === 'REGISTERED');

    // 按事件分组
    const eventGroups = new Map<string, any[]>();
    for (const market of registeredMarkets) {
        const eventKey = market.question || `market-${market.id}`;
        if (!eventGroups.has(eventKey)) {
            eventGroups.set(eventKey, []);
        }
        eventGroups.get(eventKey)!.push(market);
    }

    // 生成输出内容
    const lines: string[] = [];
    lines.push(`Predict 所有 REGISTERED 事件列表`);
    lines.push(`生成时间: ${new Date().toLocaleString('zh-CN')}`);
    lines.push(`总计: ${eventGroups.size} 个事件`);
    lines.push(`[P] = 有 Polymarket 关联`);
    lines.push(`[多选×N] = 多选事件（N个选项）`);
    lines.push('');
    lines.push('='.repeat(80));
    lines.push('');

    let index = 0;
    for (const [question, markets] of eventGroups) {
        index++;
        const hasPolymarket = markets.some(m => m.polymarketConditionIds?.length > 0);
        const polyMark = hasPolymarket ? ' [P]' : '';
        const multiMark = markets.length > 1 ? ` [多选×${markets.length}]` : '';

        lines.push(`${index}. ${question}${polyMark}${multiMark}`);

        // 添加市场ID信息
        if (markets.length === 1) {
            lines.push(`   市场 ID: ${markets[0].id}`);
        } else {
            lines.push(`   市场 IDs: ${markets.map((m: any) => m.id).join(', ')}`);
        }

        // 添加 Polymarket Condition ID
        if (hasPolymarket) {
            const conditionId = markets.find(m => m.polymarketConditionIds?.length > 0)?.polymarketConditionIds[0];
            lines.push(`   Polymarket ID: ${conditionId}`);
        }

        lines.push('');
    }

    lines.push('='.repeat(80));
    lines.push('');
    lines.push('统计:');

    const binaryEvents = Array.from(eventGroups.values()).filter(g => g.length === 1);
    const multiChoiceEvents = Array.from(eventGroups.values()).filter(g => g.length > 1);
    const polymarketLinked = Array.from(eventGroups.values()).filter(g =>
        g.some(m => m.polymarketConditionIds?.length > 0)
    );

    lines.push(`  总事件数: ${eventGroups.size}`);
    lines.push(`  - 二元事件: ${binaryEvents.length}`);
    lines.push(`  - 多选事件: ${multiChoiceEvents.length}`);
    lines.push(`  - 有 Polymarket 关联: ${polymarketLinked.length}`);

    // 写入文件
    const outputPath = path.join(process.cwd(), 'registered-events-list.txt');
    fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');

    console.log(`✅ 事件列表已保存到: ${outputPath}`);
    console.log(`总计 ${eventGroups.size} 个事件`);
}

saveEventList().catch(console.error);
