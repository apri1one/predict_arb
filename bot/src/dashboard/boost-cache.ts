/**
 * Boost 市场缓存
 *
 * 从 predict.fun 网页 RSC 载荷抓取 feeMultiplier 数据，
 * 标记当前处于 boost 状态的市场。
 *
 * 独立模块避免 start-dashboard ↔ sports-service 循环导入。
 */

/** 市场 ID → boost 时间范围 */
const boostCache = new Map<number, { startTime: string; endTime: string }>();

/** 抓取 predict.fun RSC 载荷获取 boost 数据 */
export async function fetchBoostData(): Promise<void> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const res = await fetch('https://predict.fun', {
            headers: {
                'RSC': '1',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            },
            signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));

        if (!res.ok) {
            console.warn(`[Boost] Failed to fetch: HTTP ${res.status}`);
            return;
        }

        const text = await res.text();
        // 解析 RSC 载荷中的 feeMultiplier 数据
        // 格式: "id":"6214","decimalPrecision":2,"feeMultiplier":true,"feeMultiplierStartTime":"2026-02-01T08:00:00.000Z","feeMultiplierEndTime":"2026-02-01T08:14:59.000Z"
        const regex = /"id":"(\d+)","decimalPrecision":\d+,"feeMultiplier":true,"feeMultiplierStartTime":"([^"]+)","feeMultiplierEndTime":"([^"]+)"/g;
        const newCache = new Map<number, { startTime: string; endTime: string }>();
        let match;
        while ((match = regex.exec(text)) !== null) {
            const marketId = parseInt(match[1], 10);
            newCache.set(marketId, { startTime: match[2], endTime: match[3] });
        }

        // 替换缓存
        boostCache.clear();
        for (const [id, data] of newCache) {
            boostCache.set(id, data);
        }

        console.log(`[Boost] Refreshed: ${boostCache.size} boosted markets`);
    } catch (err: any) {
        if (err.name === 'AbortError') {
            console.warn('[Boost] Fetch timeout');
        } else {
            console.warn(`[Boost] Fetch error: ${err.message}`);
        }
    }
}

/** 检查市场是否当前处于 boost 状态 */
export function isMarketBoosted(marketId: number): { boosted: boolean; boostStartTime?: string; boostEndTime?: string } {
    const data = boostCache.get(marketId);
    if (!data) return { boosted: false };
    // predict.fun 对所有在 RSC 载荷中出现的 boost 市场都显示标记
    // 只要 endTime 尚未过期就视为 boosted（包括尚未开始的）
    const end = new Date(data.endTime).getTime();
    if (Date.now() <= end) {
        return { boosted: true, boostStartTime: data.startTime, boostEndTime: data.endTime };
    }
    return { boosted: false };
}

/** 获取 boostCache (只读访问) */
export function getBoostCache(): ReadonlyMap<number, { startTime: string; endTime: string }> {
    return boostCache;
}
