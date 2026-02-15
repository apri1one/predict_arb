/**
 * 从 Predict 网站抓取市场 slug 映射
 *
 * 运行方式: npx tsx src/testing/slugs/fetch-predict-slugs.ts
 *
 * 输出: data/predict-slugs.json
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// 加载环境变量 (从项目根目录)
dotenv.config({ path: path.join(process.cwd(), '.env') });

interface SlugMapping {
    [marketId: string]: {
        slug: string;
        title: string;
        verified: boolean;
    };
}

const CACHE_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'predict-slugs.json');

/**
 * 从 Predict 网站获取市场列表 (HTML 抓取)
 */
async function fetchMarketsFromWeb(): Promise<{ slug: string; title: string }[]> {
    const results: { slug: string; title: string }[] = [];

    try {
        // 获取 markets 页面
        const res = await fetch('https://predict.fun/markets', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
                'Accept': 'text/html,application/xhtml+xml',
            }
        });

        if (!res.ok) {
            console.error(`Failed to fetch markets page: ${res.status}`);
            return results;
        }

        const html = await res.text();

        // 提取所有 /market/{slug} 链接
        const linkRegex = /href="\/market\/([^"?]+)"/g;
        let match;
        const slugs = new Set<string>();

        while ((match = linkRegex.exec(html)) !== null) {
            slugs.add(match[1]);
        }

        for (const slug of slugs) {
            results.push({ slug, title: '' });
        }

        console.log(`[FetchSlugs] Found ${results.length} market slugs from web`);

    } catch (error) {
        console.error('[FetchSlugs] Error fetching from web:', error);
    }

    return results;
}

/**
 * 从 Predict REST API 获取市场列表 (分页)
 */
async function fetchMarketsFromAPI(): Promise<{ id: number; title: string }[]> {
    const results: { id: number; title: string }[] = [];
    let cursor: string | null = null;
    const pageSize = 100;

    const apiKey = process.env.PREDICT_API_KEY;
    if (!apiKey) {
        console.error('[FetchSlugs] PREDICT_API_KEY not set');
        return results;
    }

    try {
        while (true) {
            const url = cursor
                ? `https://api.predict.fun/v1/markets?first=${pageSize}&after=${cursor}`
                : `https://api.predict.fun/v1/markets?first=${pageSize}`;

            const res = await fetch(url, {
                headers: { 'x-api-key': apiKey }
            });

            if (!res.ok) {
                console.error(`Failed to fetch from API: ${res.status}`);
                break;
            }

            const data = await res.json() as { success: boolean; data: { id: number; title: string }[]; cursor?: string };

            if (!data.success) {
                console.error('[FetchSlugs] API returned success=false');
                break;
            }

            const markets = data.data || [];
            if (markets.length === 0) break;

            for (const market of markets) {
                results.push({ id: market.id, title: market.title });
            }

            if (!data.cursor) break;
            cursor = data.cursor;

            // 避免请求过快
            await new Promise(r => setTimeout(r, 50));
        }

        console.log(`[FetchSlugs] Found ${results.length} markets from API`);

    } catch (error) {
        console.error('[FetchSlugs] Error fetching from API:', error);
    }

    return results;
}

/**
 * 生成可能的 slug 变体
 */
function generateSlugVariants(title: string, marketId: number): string[] {
    const base = title
        .toLowerCase()
        .replace(/@/g, 'at')
        .replace(/[^a-z0-9 -]/g, '')
        .replace(/ +/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    return [
        base,
        `${base}-${marketId}`,
        base.replace(/-the-/g, '-').replace(/^the-/, ''),
        base
            .replace(/january/g, 'jan')
            .replace(/february/g, 'feb')
            .replace(/march/g, 'mar')
            .replace(/april/g, 'apr')
            .replace(/june/g, 'jun')
            .replace(/july/g, 'jul')
            .replace(/august/g, 'aug')
            .replace(/september/g, 'sep')
            .replace(/october/g, 'oct')
            .replace(/november/g, 'nov')
            .replace(/december/g, 'dec'),
    ];
}

/**
 * 匹配 API 市场与网页 slug
 */
function matchMarketToSlug(
    market: { id: number; title: string },
    webSlugs: Set<string>
): string | null {
    const variants = generateSlugVariants(market.title, market.id);

    for (const variant of variants) {
        if (webSlugs.has(variant)) {
            return variant;
        }
    }

    // 模糊匹配：检查是否有slug包含市场标题的关键词
    const keywords = market.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    for (const slug of webSlugs) {
        const matchCount = keywords.filter(k => slug.includes(k)).length;
        if (matchCount >= Math.min(3, keywords.length)) {
            return slug;
        }
    }

    return null;
}

/**
 * 主函数：抓取并建立映射
 */
async function main() {
    console.log('[FetchSlugs] Starting...');

    // 并行获取数据
    const [webMarkets, apiMarkets] = await Promise.all([
        fetchMarketsFromWeb(),
        fetchMarketsFromAPI()
    ]);

    // 建立 slug 集合
    const webSlugs = new Set(webMarkets.map(m => m.slug));

    // 加载现有缓存
    let cache: SlugMapping = {};
    if (fs.existsSync(CACHE_FILE)) {
        try {
            cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
            console.log(`[FetchSlugs] Loaded ${Object.keys(cache).length} existing mappings`);
        } catch {
            // ignore
        }
    }

    // 匹配市场
    let matched = 0;
    let unmatched = 0;

    for (const market of apiMarkets) {
        // 跳过已验证的
        if (cache[market.id]?.verified) {
            continue;
        }

        const slug = matchMarketToSlug(market, webSlugs);

        if (slug) {
            cache[market.id] = {
                slug,
                title: market.title,
                verified: true
            };
            matched++;
        } else {
            // 使用生成的 slug (未验证)
            const generated = generateSlugVariants(market.title, market.id)[0];
            cache[market.id] = {
                slug: generated,
                title: market.title,
                verified: false
            };
            unmatched++;
        }
    }

    // 保存缓存
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

    console.log(`[FetchSlugs] Done: ${matched} matched, ${unmatched} unmatched`);
    console.log(`[FetchSlugs] Total: ${Object.keys(cache).length} mappings saved to ${CACHE_FILE}`);

    // 输出未匹配的市场
    const unmatchedMarkets = apiMarkets.filter(m => !cache[m.id]?.verified);
    if (unmatchedMarkets.length > 0) {
        console.log('\n[FetchSlugs] Unmatched markets:');
        for (const m of unmatchedMarkets.slice(0, 10)) {
            console.log(`  - ${m.id}: ${m.title}`);
        }
        if (unmatchedMarkets.length > 10) {
            console.log(`  ... and ${unmatchedMarkets.length - 10} more`);
        }
    }
}

main().catch(console.error);
