/**
 * 测试: Polymarket Gamma API 事件级 volume / liquidity 数据
 *
 * 目标: 获取活跃事件的 24h 成交量与流动性比值，排序 Top 20
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';

interface GammaMarket {
    conditionId: string;
    question: string;
    volume: string;
    volumeNum: number;
    liquidity: string;
    liquidityNum: number;
    volume24hr: number;
    active: boolean;
    closed: boolean;
}

interface GammaEvent {
    id: string;
    title: string;
    slug: string;
    volume: number;
    liquidity: number;
    volume24hr?: number;
    startDate?: string;
    endDate?: string;
    active: boolean;
    closed: boolean;
    negRisk: boolean;
    markets: GammaMarket[];
}

async function testEventData() {
    console.log('=== Polymarket Gamma API 事件级数据测试 ===\n');

    // 1. 获取活跃事件 (按 volume 降序)
    const url = `${GAMMA_API}/events?active=true&closed=false&limit=50&order=volume&ascending=false`;
    console.log(`请求: ${url}\n`);

    const res = await fetch(url);
    if (!res.ok) {
        console.error(`请求失败: ${res.status} ${res.statusText}`);
        return;
    }

    const events: GammaEvent[] = await res.json();
    console.log(`返回 ${events.length} 个事件\n`);

    // 2. 打印第一个事件的完整字段 (看有哪些可用)
    if (events.length > 0) {
        const sample = events[0];
        console.log('--- 样本事件字段 ---');
        const keys = Object.keys(sample).filter(k => k !== 'markets');
        for (const key of keys) {
            console.log(`  ${key}: ${JSON.stringify((sample as any)[key])}`);
        }
        console.log(`  markets: [${sample.markets?.length ?? 0} 个]`);

        if (sample.markets?.length > 0) {
            console.log('\n--- 样本 market 字段 ---');
            const mKeys = Object.keys(sample.markets[0]);
            for (const key of mKeys) {
                const val = (sample.markets[0] as any)[key];
                const display = typeof val === 'string' && val.length > 80
                    ? val.slice(0, 80) + '...'
                    : JSON.stringify(val);
                console.log(`  ${key}: ${display}`);
            }
        }
    }

    // 3. 计算事件级 volume24hr (从 markets 聚合)
    console.log('\n\n=== 事件级 24h Volume / Liquidity 比值 Top 20 ===\n');

    const ranked: Array<{
        title: string;
        eventVolume: number;
        eventLiquidity: number;
        volume24hr: number;
        ratio: number;
        marketCount: number;
    }> = [];

    for (const event of events) {
        // 事件级 volume/liquidity
        const eventVolume = event.volume ?? 0;
        const eventLiquidity = event.liquidity ?? 0;

        // 聚合 markets 的 volume24hr
        let volume24hr = (event as any).volume24hr ?? 0;
        if (!volume24hr && event.markets) {
            volume24hr = event.markets.reduce((sum, m) => sum + (m.volume24hr ?? 0), 0);
        }

        if (eventLiquidity > 0 && volume24hr > 0) {
            ranked.push({
                title: (event.title ?? '').slice(0, 50),
                eventVolume,
                eventLiquidity,
                volume24hr,
                ratio: volume24hr / eventLiquidity,
                marketCount: event.markets?.length ?? 0,
            });
        }
    }

    ranked.sort((a, b) => b.ratio - a.ratio);

    console.log(`${'#'.padStart(3)} | ${'Vol/Liq'.padStart(8)} | ${'24h Vol'.padStart(12)} | ${'Liquidity'.padStart(12)} | ${'Total Vol'.padStart(14)} | Mkts | Title`);
    console.log('-'.repeat(120));

    for (let i = 0; i < Math.min(20, ranked.length); i++) {
        const r = ranked[i];
        console.log(
            `${String(i + 1).padStart(3)} | ` +
            `${r.ratio.toFixed(2).padStart(8)} | ` +
            `$${formatNum(r.volume24hr).padStart(11)} | ` +
            `$${formatNum(r.eventLiquidity).padStart(11)} | ` +
            `$${formatNum(r.eventVolume).padStart(13)} | ` +
            `${String(r.marketCount).padStart(4)} | ` +
            `${r.title}`
        );
    }

    console.log(`\n共 ${ranked.length} 个事件有有效数据`);
}

function formatNum(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toFixed(0);
}

testEventData().catch(console.error);
