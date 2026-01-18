/**
 * 从浏览器控制台脚本的输出导入 Predict slug 映射
 *
 * 使用方法：
 * 1. 在 Predict 网站 (https://predict.fun/markets) 打开 DevTools Console
 * 2. 运行 BROWSER_SCRIPT (见下方) 获取 title -> URL 映射
 * 3. 复制输出的 JSON
 * 4. 将 JSON 粘贴到 bot/data/browser-slugs.json
 * 5. 运行: npx tsx src/testing/slugs/import-slugs.ts
 *
 * 浏览器脚本 (复制到 DevTools Console 运行):
 * -------------------------------------------
 *
 * // 自动滚动加载全部卡片
 * async function autoScroll({ step = 900, wait = 250, stableRounds = 8 } = {}) {
 *   let last = 0, stable = 0;
 *   while (stable < stableRounds) {
 *     window.scrollBy(0, step);
 *     await new Promise(r => setTimeout(r, wait));
 *     const h = document.documentElement.scrollHeight;
 *     if (h === last) stable++;
 *     else stable = 0;
 *     last = h;
 *   }
 *   window.scrollTo(0, 0);
 * }
 *
 * await autoScroll();
 *
 * // 提取 URL 映射
 * const anchors = [...document.querySelectorAll('a[href*="/market/"]')]
 *   .map(a => ({ a, url: a.getAttribute('href') }))
 *   .filter(x => x.url && x.url.startsWith('/market/'));
 *
 * const seenUrl = new Set();
 * const result = anchors
 *   .filter(x => (seenUrl.has(x.url) ? false : (seenUrl.add(x.url), true)))
 *   .map(({ a, url }) => {
 *     const slug = url.replace('/market/', '');
 *     const card = a.closest('article, [class*="card"], li, div');
 *     const title =
 *       card?.querySelector('h1,h2,h3,[class*="title"]')?.innerText?.trim() ||
 *       a.getAttribute('aria-label')?.trim() ||
 *       a.innerText?.split('\n')?.[0]?.trim();
 *     return { title, slug, url };
 *   })
 *   .filter(x => x.title && x.slug);
 *
 * copy(JSON.stringify(result, null, 2));
 * console.log('Copied', result.length, 'mappings to clipboard');
 *
 * -------------------------------------------
 */

import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'predict-slugs.json');
const BROWSER_FILE = path.join(CACHE_DIR, 'browser-slugs.json');

interface SlugEntry {
    slug: string;
    title: string;
    verified: boolean;
}

interface BrowserEntry {
    title: string;
    slug: string;
    url?: string;
}

async function main() {
    console.log('[ImportSlugs] Starting...');

    // 检查浏览器输出文件是否存在
    if (!fs.existsSync(BROWSER_FILE)) {
        console.error(`[ImportSlugs] File not found: ${BROWSER_FILE}`);
        console.log('\n请按以下步骤操作:');
        console.log('1. 在 Predict 网站打开 DevTools Console');
        console.log('2. 运行上述浏览器脚本');
        console.log('3. 将复制的 JSON 粘贴到:', BROWSER_FILE);
        console.log('4. 重新运行此脚本');
        return;
    }

    // 加载浏览器输出
    let browserData: BrowserEntry[];
    try {
        browserData = JSON.parse(fs.readFileSync(BROWSER_FILE, 'utf-8'));
        console.log(`[ImportSlugs] Loaded ${browserData.length} entries from browser output`);
    } catch (e) {
        console.error('[ImportSlugs] Failed to parse browser output:', e);
        return;
    }

    // 加载现有缓存
    let cache: Record<string, SlugEntry> = {};
    if (fs.existsSync(CACHE_FILE)) {
        try {
            cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
            console.log(`[ImportSlugs] Loaded ${Object.keys(cache).length} existing entries`);
        } catch {
            // ignore
        }
    }

    // 建立浏览器 slug 集合 (用于快速查找)
    const browserSlugSet = new Set(browserData.map(e => e.slug));
    const browserSlugMap = new Map(browserData.map(e => [e.slug, e.title]));

    // 匹配浏览器数据到缓存
    let matched = 0;
    let updated = 0;

    for (const [id, cached] of Object.entries(cache)) {
        if (cached.verified) continue;

        // 方法1: 精确 slug 匹配
        if (browserSlugSet.has(cached.slug)) {
            cache[id].verified = true;
            matched++;
            continue;
        }

        // 方法2: 标题匹配
        for (const entry of browserData) {
            if (cached.title === entry.title) {
                cache[id] = {
                    slug: entry.slug,
                    title: cached.title,
                    verified: true,
                };
                matched++;
                updated++;
                break;
            }
        }
    }

    // 额外: 将浏览器数据中未匹配的 slug 也添加到缓存 (作为新条目)
    let added = 0;
    for (const entry of browserData) {
        // 检查是否已存在
        const exists = Object.values(cache).some(c => c.slug === entry.slug);
        if (!exists) {
            // 生成一个临时 ID (负数表示未知 market ID)
            const tempId = `browser_${entry.slug}`;
            cache[tempId] = {
                slug: entry.slug,
                title: entry.title,
                verified: true,
            };
            added++;
        }
    }

    // 保存更新后的缓存
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

    console.log(`[ImportSlugs] Done:`);
    console.log(`  - Browser entries: ${browserData.length}`);
    console.log(`  - Matched (slug/title): ${matched}`);
    console.log(`  - Updated slugs: ${updated}`);
    console.log(`  - Added new: ${added}`);
    console.log(`  - Total verified: ${Object.values(cache).filter(e => e.verified).length}`);
}

main().catch(console.error);
