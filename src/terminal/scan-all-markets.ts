/**
 * 扫描所有 Predict 市场，找出有 Polymarket 链接的市场
 * 优先使用列表 API (/v1/markets)，仅在需要时才扫描 ID 范围
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// 使用多个 API Key 轮换 (支持 SCAN_1 到 SCAN_10)
const apiKeys: string[] = [];
const scan1 = process.env.PREDICT_API_KEY_SCAN_1 || process.env.PREDICT_API_KEY_SCAN;
if (scan1) apiKeys.push(scan1);
for (let i = 2; i <= 10; i++) {
    const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
    if (key) apiKeys.push(key);
}
// Fallback: 主 key
if (apiKeys.length === 0) {
    const fallback = process.env.PREDICT_API_KEY;
    if (fallback) apiKeys.push(fallback);
}

let keyIndex = 0;
function getNextApiKey(): string {
    const key = apiKeys[keyIndex % apiKeys.length];
    keyIndex++;
    return key;
}

interface MarketMatch {
    predict: {
        id: number;
        title: string;
        question: string;
        conditionId: string;
        feeRateBps?: number;
        categorySlug?: string;
    };
    polymarket: {
        question: string;
        conditionId: string;
        active: boolean;
        closed: boolean;
        acceptingOrders: boolean;
    };
}

async function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

async function checkMarketForPolymarket(id: number): Promise<MarketMatch | null> {
    try {
        const res = await fetch(`https://api.predict.fun/v1/markets/${id}`, {
            headers: { 'x-api-key': getNextApiKey() }
        });

        if (!res.ok) return null;

        const data = await res.json() as any;
        const m = data.data;

        // 跳过不存在或已解决的市场
        if (!m || m.status !== 'REGISTERED') {
            return null;
        }

        if (!m.polymarketConditionIds || m.polymarketConditionIds.length === 0) {
            return null;
        }

        const conditionId = m.polymarketConditionIds[0];
        if (!conditionId || conditionId === '') return null;

        // 验证 Polymarket 市场是否存在且活跃
        const pmRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
        if (!pmRes.ok) return null;

        const pmData = await pmRes.json() as any;

        // 跳过已关闭或不接受订单的市场
        const isClosed = pmData.closed === true;
        const acceptingOrders = pmData.accepting_orders !== false;
        if (isClosed || !acceptingOrders) {
            return null;
        }

        // 检测 inverted 市场（问题方向相反）
        const predictQuestion = (m.question || m.title).toLowerCase();
        const pmQuestion = (pmData.question || '').toLowerCase();
        let inverted = false;
        let invertedReason = '';

        // FED 利率市场: Predict 问"会变吗", PM 问"不会变吗"
        if (predictQuestion.includes('change') && pmQuestion.includes('no change')) {
            inverted = true;
            invertedReason = "Predict问'会变吗'，Polymarket问'不会变吗'，方向相反";
        }

        const result: MarketMatch & { inverted?: boolean; invertedReason?: string } = {
            predict: {
                id: m.id,
                title: m.title,
                question: m.question || m.title,
                conditionId: conditionId,
                feeRateBps: m.feeRateBps || 200,  // 从 API 获取费率
                categorySlug: m.categorySlug      // 用于获取 Predict endsAt
            },
            polymarket: {
                question: pmData.question || m.title,
                conditionId: conditionId,
                active: true,
                closed: false,
                acceptingOrders: true
            }
        };

        if (inverted) {
            result.inverted = true;
            result.invertedReason = invertedReason;
        }

        return result;
    } catch {
        return null;
    }
}

async function fetchAllMarkets(): Promise<any[]> {
    const allMarkets: any[] = [];
    let cursor: string | null = null;
    let page = 1;
    const pageSize = 100;

    console.log('📋 从列表 API 获取市场...\n');

    while (true) {
        try {
            const url = cursor
                ? `https://api.predict.fun/v1/markets?first=${pageSize}&after=${cursor}`
                : `https://api.predict.fun/v1/markets?first=${pageSize}`;

            const res = await fetch(url, {
                headers: { 'x-api-key': getNextApiKey() }
            });

            if (!res.ok) {
                console.error(`  ❌ API 错误: ${res.status} ${res.statusText}`);
                break;
            }

            const data = await res.json() as any;

            if (!data.success) {
                console.error(`  ❌ API 返回失败`);
                break;
            }

            const markets = data.data || [];

            if (markets.length === 0) break;

            allMarkets.push(...markets);
            console.log(`  页 ${page}: ${markets.length} 个市场 (总计: ${allMarkets.length})`);

            // 检查是否有下一页
            if (!data.cursor) break;

            cursor = data.cursor;
            page++;
            await sleep(100);
        } catch (error) {
            console.error(`  ❌ 获取第 ${page} 页失败:`, error);
            break;
        }
    }

    console.log(`\n✅ 共获取 ${allMarkets.length} 个市场\n`);
    return allMarkets;
}

async function main() {
    console.log('=== 扫描所有 Predict 市场的 Polymarket 链接 ===\n');
    console.log(`使用 ${apiKeys.length} 个 API Key 轮换\n`);

    // 先从列表 API 获取所有市场
    const allMarkets = await fetchAllMarkets();

    console.log('🔍 筛选有 Polymarket 链接的市场...\n');

    // 预筛选：只处理有 polymarketConditionIds 且活跃的市场
    const marketsToCheck = allMarkets.filter(m =>
        m.polymarketConditionIds?.length > 0 && m.status === 'REGISTERED'
    );
    console.log(`  预筛选后需检查: ${marketsToCheck.length} 个市场\n`);

    const matches: MarketMatch[] = [];
    let checked = 0;

    // 并发扫描：每个 API key 同时发请求
    const CONCURRENT_PER_KEY = 3;  // 每个 key 同时发 3 个请求
    const BATCH_SIZE = apiKeys.length * CONCURRENT_PER_KEY;  // 总并发数

    for (let i = 0; i < marketsToCheck.length; i += BATCH_SIZE) {
        const batch = marketsToCheck.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(batch.map(async (market, idx) => {
            // 轮流使用不同的 API key
            const apiKey = apiKeys[idx % apiKeys.length];

            try {
                // 直接调用带指定 key 的检查
                const res = await fetch(`https://api.predict.fun/v1/markets/${market.id}`, {
                    headers: { 'x-api-key': apiKey }
                });
                if (!res.ok) return null;

                const data = await res.json() as any;
                const m = data.data;
                if (!m || m.status !== 'REGISTERED') return null;

                const conditionId = m.polymarketConditionIds?.[0];
                if (!conditionId) return null;

                // 验证 Polymarket
                const pmRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
                if (!pmRes.ok) return null;

                const pmData = await pmRes.json() as any;
                if (pmData.closed === true || pmData.accepting_orders === false) return null;

                // 检测 inverted 市场（问题方向相反）
                const predictQuestion = (m.question || m.title || '').toLowerCase();
                const pmQuestion = (pmData.question || '').toLowerCase();
                let inverted = false;
                let invertedReason = '';

                // FED 利率市场: Predict 问"会变吗", PM 问"不会变吗" (或反过来)
                if (predictQuestion.includes('change') && pmQuestion.includes('no change')) {
                    inverted = true;
                    invertedReason = "Predict问'会变吗'，Polymarket问'不会变吗'，方向相反";
                } else if (predictQuestion.includes('no change') && pmQuestion.includes('change') && !pmQuestion.includes('no change')) {
                    inverted = true;
                    invertedReason = "Predict问'不会变吗'，Polymarket问'会变吗'，方向相反";
                }

                const result: MarketMatch & { inverted?: boolean; invertedReason?: string } = {
                    predict: {
                        id: market.id,
                        title: m.title || m.question,
                        question: m.question,
                        conditionId: m.conditionId,
                        feeRateBps: m.feeRateBps,
                        categorySlug: m.categorySlug,  // 用于获取 Predict endsAt
                    },
                    polymarket: {
                        question: pmData.question || '',
                        conditionId,
                        active: pmData.active !== false,
                        closed: pmData.closed === true,
                        acceptingOrders: pmData.accepting_orders !== false,
                    }
                };

                if (inverted) {
                    result.inverted = true;
                    result.invertedReason = invertedReason;
                }

                return result as MarketMatch;
            } catch {
                return null;
            }
        }));

        // 收集结果
        for (const match of results) {
            if (match) {
                matches.push(match);
                console.log(`    ✓ [${match.predict.id}] ${match.predict.title.substring(0, 50)}`);
            }
        }

        checked += batch.length;
        process.stdout.write(`\r  进度: ${checked}/${marketsToCheck.length} | 已找到: ${matches.length}   `);

        // 批次间短暂延迟避免限流
        if (i + BATCH_SIZE < marketsToCheck.length) {
            await sleep(100);
        }
    }

    console.log('\n');

    // 保存结果
    const outputPath = path.join(__dirname, '..', '..', 'polymarket-match-result.json');
    const result = {
        timestamp: new Date().toISOString(),
        summary: {
            total: checked,
            matched: matches.length,
            failed: 0
        },
        matches: matches
    };

    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`结果已保存到: ${outputPath}`);
    console.log(`\n=== 扫描完成 ===`);
    console.log(`  扫描 ID 数: ${checked}`);
    console.log(`  有 Polymarket 链接且活跃: ${matches.length}`);

    // 显示找到的市场
    console.log('\n=== 找到的市场 ===\n');
    for (const m of matches) {
        const status = m.polymarket.active && !m.polymarket.closed ? '活跃' : '已关闭';
        console.log(`  [${m.predict.id}] ${m.predict.title.substring(0, 50)} (${status})`);
    }
}

main().catch(console.error);
