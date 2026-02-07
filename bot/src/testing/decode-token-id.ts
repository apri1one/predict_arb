/**
 * Token ID 解码工具 - 从链上 Token ID 识别对应的市场
 *
 * Predict.fun 使用 ERC1155 条件代币，每个市场有两个 Token ID:
 * - yesTokenId: YES 结果对应的代币
 * - noTokenId: NO 结果对应的代币
 *
 * Token ID 通过 API 获取市场详情时返回
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../..', '.env') });

const PREDICT_API_BASE = 'https://api.predict.fun';

interface MarketTokenInfo {
    marketId: number;
    title: string;
    yesTokenId: string;
    noTokenId: string;
    status: string;
}

// 缓存 Token ID → 市场映射
const tokenToMarketCache = new Map<string, MarketTokenInfo>();

/**
 * 从市场数据提取 Token ID 信息
 */
function extractTokenInfo(market: any): MarketTokenInfo | null {
    if (!market) return null;

    // 提取 Token ID (outcomes 数组中，字段名是 onChainId)
    const outcomes = market.outcomes || [];
    let yesTokenId = '';
    let noTokenId = '';

    for (const outcome of outcomes) {
        const name = (outcome.name || outcome.outcome || '').toLowerCase();
        const tokenId = outcome.onChainId || outcome.tokenId || outcome.token_id || '';

        if (name === 'yes' || name === 'up') {
            yesTokenId = tokenId;
        } else if (name === 'no' || name === 'down') {
            noTokenId = tokenId;
        }
    }

    // 有些 API 响应直接有 yesTokenId/noTokenId 字段
    if (!yesTokenId) yesTokenId = market.yesTokenId || '';
    if (!noTokenId) noTokenId = market.noTokenId || '';

    const info: MarketTokenInfo = {
        marketId: market.id,
        title: market.title || market.question || '',
        yesTokenId,
        noTokenId,
        status: market.status || '',
    };

    // 缓存
    if (yesTokenId) tokenToMarketCache.set(yesTokenId, info);
    if (noTokenId) tokenToMarketCache.set(noTokenId, info);

    return info;
}

/**
 * 获取市场的 Token ID 信息
 */
async function getMarketTokenIds(marketId: number): Promise<MarketTokenInfo | null> {
    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) throw new Error('PREDICT_API_KEY 未设置');

    try {
        const resp = await fetch(`${PREDICT_API_BASE}/v1/markets/${marketId}`, {
            headers: { 'x-api-key': apiKey },
        });

        if (!resp.ok) {
            if (resp.status === 404) return null;
            throw new Error(`获取市场失败: ${resp.status}`);
        }

        const data = await resp.json();
        // API 直接返回市场对象在 data 中
        const market = data.data;

        return extractTokenInfo(market);
    } catch (err) {
        console.error(`获取市场 ${marketId} 失败:`, err);
        return null;
    }
}

/**
 * 根据 Token ID 查找对应的市场
 */
async function findMarketByTokenId(tokenId: string): Promise<{ market: MarketTokenInfo; side: 'YES' | 'NO' } | null> {
    // 先查缓存
    const cached = tokenToMarketCache.get(tokenId);
    if (cached) {
        const side = cached.yesTokenId === tokenId ? 'YES' : 'NO';
        return { market: cached, side };
    }

    console.log(`\n[查找] Token ID: ${tokenId.substring(0, 20)}...`);
    console.log('正在扫描市场...');

    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) throw new Error('PREDICT_API_KEY 未设置');

    // 获取活跃市场 (API 直接返回数组在 data 中)
    const resp = await fetch(`${PREDICT_API_BASE}/v1/markets?status=ACTIVE&first=100`, {
        headers: { 'x-api-key': apiKey },
    });

    if (!resp.ok) {
        throw new Error(`获取市场列表失败: ${resp.status}`);
    }

    const data = await resp.json();
    // API 直接返回市场数组
    const markets = Array.isArray(data.data) ? data.data : (data.data?.markets || []);

    console.log(`检查 ${markets.length} 个活跃市场...`);

    for (const market of markets) {
        const info = extractTokenInfo(market);
        if (!info) continue;

        if (info.yesTokenId === tokenId) {
            return { market: info, side: 'YES' };
        }
        if (info.noTokenId === tokenId) {
            return { market: info, side: 'NO' };
        }
    }

    // 也检查已解决的市场
    console.log('检查已解决市场...');
    const resolvedResp = await fetch(`${PREDICT_API_BASE}/v1/markets?status=RESOLVED&first=100`, {
        headers: { 'x-api-key': apiKey },
    });

    if (resolvedResp.ok) {
        const resolvedData = await resolvedResp.json();
        const resolvedMarkets = Array.isArray(resolvedData.data) ? resolvedData.data : (resolvedData.data?.markets || []);

        console.log(`检查 ${resolvedMarkets.length} 个已解决市场...`);

        for (const market of resolvedMarkets) {
            const info = extractTokenInfo(market);
            if (!info) continue;

            if (info.yesTokenId === tokenId) {
                return { market: info, side: 'YES' };
            }
            if (info.noTokenId === tokenId) {
                return { market: info, side: 'NO' };
            }
        }
    }

    return null;
}

/**
 * 解析链上事件中的 Token ID
 */
async function decodeOnchainTokenIds(): Promise<void> {
    console.log('========================================');
    console.log('Token ID 解码工具');
    console.log('========================================\n');

    // 从之前分析的链上交易中提取的 Token ID
    const tokenIds = [
        '36028845999221240271450118837084888027824227596154284285118886630722340479387',
        '59045418691713517353182923643684965076913564088876932467524115560357710152403',
    ];

    for (const tokenId of tokenIds) {
        console.log(`\n--- Token ID: ${tokenId.substring(0, 30)}... ---`);

        const result = await findMarketByTokenId(tokenId);

        if (result) {
            console.log(`\n✅ 找到对应市场:`);
            console.log(`  市场 ID: ${result.market.marketId}`);
            console.log(`  标题: ${result.market.title.substring(0, 60)}...`);
            console.log(`  Token 类型: ${result.side}`);
            console.log(`  状态: ${result.market.status}`);
        } else {
            console.log(`❌ 未找到对应市场`);
        }
    }
}

/**
 * 构建 Token ID 索引 (从所有活跃市场)
 */
async function buildTokenIndex(): Promise<void> {
    console.log('========================================');
    console.log('构建 Token ID 索引');
    console.log('========================================\n');

    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) throw new Error('PREDICT_API_KEY 未设置');

    const resp = await fetch(`${PREDICT_API_BASE}/v1/markets?status=ACTIVE&first=100`, {
        headers: { 'x-api-key': apiKey },
    });

    if (!resp.ok) {
        throw new Error(`获取市场失败: ${resp.status}`);
    }

    const data = await resp.json();
    const markets = Array.isArray(data.data) ? data.data : (data.data?.markets || []);

    console.log(`扫描 ${markets.length} 个市场...\n`);

    const index: Array<{
        marketId: number;
        title: string;
        yesTokenId: string;
        noTokenId: string;
    }> = [];

    for (let i = 0; i < markets.length; i++) {
        const market = markets[i];
        process.stdout.write(`\r进度: ${i + 1}/${markets.length}`);

        const info = extractTokenInfo(market);
        if (info && (info.yesTokenId || info.noTokenId)) {
            index.push({
                marketId: info.marketId,
                title: info.title.substring(0, 50),
                yesTokenId: info.yesTokenId,
                noTokenId: info.noTokenId,
            });
        }
    }

    console.log('\n\n索引构建完成!');
    console.log(`共 ${index.length} 个市场有 Token ID\n`);

    // 打印前 10 个
    console.log('示例数据:');
    for (const item of index.slice(0, 10)) {
        console.log(`\n市场 #${item.marketId}: ${item.title}`);
        if (item.yesTokenId) {
            console.log(`  YES Token: ${item.yesTokenId.substring(0, 30)}...`);
        }
        if (item.noTokenId) {
            console.log(`  NO Token: ${item.noTokenId.substring(0, 30)}...`);
        }
    }
}

/**
 * 通过 conditionId 查询市场
 */
async function findMarketByConditionId(conditionId: string): Promise<void> {
    console.log('========================================');
    console.log('通过 conditionId 查找市场');
    console.log('========================================\n');

    console.log(`查找 conditionId: ${conditionId}\n`);

    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) throw new Error('PREDICT_API_KEY 未设置');

    // 尝试直接通过 conditionId 查询
    const resp = await fetch(`${PREDICT_API_BASE}/v1/markets?conditionId=${conditionId}&first=10`, {
        headers: { 'x-api-key': apiKey },
    });

    if (resp.ok) {
        const data = await resp.json();
        const markets = data.data?.markets || [];

        if (markets.length > 0) {
            console.log(`找到 ${markets.length} 个市场:\n`);
            for (const market of markets) {
                console.log(`  ID: ${market.id}`);
                console.log(`  标题: ${market.title}`);
                console.log(`  状态: ${market.status}`);
                console.log('');
            }
        } else {
            console.log('未找到对应市场');
        }
    } else {
        console.log(`查询失败: ${resp.status}`);
    }
}

// ============================================================================
// 入口
// ============================================================================

const args = process.argv.slice(2);

if (args.includes('--index')) {
    buildTokenIndex().catch(console.error);
} else if (args.includes('--condition') && args[args.indexOf('--condition') + 1]) {
    findMarketByConditionId(args[args.indexOf('--condition') + 1]).catch(console.error);
} else if (args.length > 0 && !args[0].startsWith('--')) {
    // 直接传入 Token ID
    findMarketByTokenId(args[0]).then(result => {
        if (result) {
            console.log(`\n✅ 市场 #${result.market.marketId}: ${result.market.title}`);
            console.log(`   Token 类型: ${result.side}`);
        } else {
            console.log('未找到对应市场');
        }
    }).catch(console.error);
} else {
    decodeOnchainTokenIds().catch(console.error);
}
