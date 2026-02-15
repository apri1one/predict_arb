/**
 * Full API Scan Script (English output to avoid encoding issues)
 * Scans all active markets on both platforms
 */

import * as fs from 'fs';
import * as path from 'path';

// Load .env file manually
function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const match = trimmed.match(/^([^=]+)=(.*)$/);
                if (match) {
                    process.env[match[1].trim()] = match[2].trim();
                }
            }
        }
    }
}

loadEnv();

interface PredictMarket {
    id: number;
    title: string;
    status: string;
    volume?: number;
    outcomes?: { title: string; price?: number }[];
    polymarketConditionIds?: string[];
}

interface PolymarketMarket {
    question: string;
    slug: string;
    volumeNum?: number;
    clobTokenIds?: string;
    bestBid?: number;
    bestAsk?: number;
    active?: boolean;
}

async function scanPredictMarkets() {
    console.log('\n' + '='.repeat(70));
    console.log('[Predict.fun] Market Scan');
    console.log('='.repeat(70));

    const apiKey = process.env.PREDICT_API_KEY;
    const baseUrl = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';

    if (!apiKey) {
        console.log('[ERROR] PREDICT_API_KEY not configured');
        return [];
    }

    // Try different statuses
    const statuses = ['ACTIVE', 'PENDING', 'TRADING'];
    const allMarkets: PredictMarket[] = [];

    for (const status of statuses) {
        try {
            const res = await fetch(`${baseUrl}/v1/markets?first=100&status=${status}`, {
                headers: { 'x-api-key': apiKey }
            });
            if (res.ok) {
                const data = await res.json() as { data?: PredictMarket[] };
                if (data.data && data.data.length > 0) {
                    console.log(`\nStatus ${status}: Found ${data.data.length} markets`);
                    allMarkets.push(...data.data);
                }
            }
        } catch (e) {
            console.log(`Status ${status}: Failed`);
        }
    }

    // Also try without status filter
    try {
        const res = await fetch(`${baseUrl}/v1/markets?first=100`, {
            headers: { 'x-api-key': apiKey }
        });
        if (res.ok) {
            const data = await res.json() as { data?: PredictMarket[] };
            if (data.data) {
                console.log(`\nNo status filter: Found ${data.data.length} markets`);
                for (const m of data.data) {
                    if (!allMarkets.find(existing => existing.id === m.id)) {
                        allMarkets.push(m);
                    }
                }
            }
        }
    } catch (e) {
        console.log('No status filter: Failed');
    }

    // Deduplicate and count by status
    const uniqueMarkets = new Map<number, PredictMarket>();
    for (const m of allMarkets) {
        uniqueMarkets.set(m.id, m);
    }

    const marketsByStatus: { [key: string]: PredictMarket[] } = {};
    for (const m of uniqueMarkets.values()) {
        if (!marketsByStatus[m.status]) {
            marketsByStatus[m.status] = [];
        }
        marketsByStatus[m.status].push(m);
    }

    console.log(`\nTotal: ${uniqueMarkets.size} unique markets`);
    console.log('\nBy status:');
    for (const [status, markets] of Object.entries(marketsByStatus)) {
        console.log(`  ${status}: ${markets.length}`);
    }

    // Test orderbook availability
    console.log('\n[Test] Checking orderbook availability...');
    const workingMarkets: { market: PredictMarket; hasOrderbook: boolean }[] = [];

    const testMarkets = Array.from(uniqueMarkets.values())
        .filter(m => m.status !== 'RESOLVED')
        .slice(0, 20);

    for (const market of testMarkets) {
        try {
            const res = await fetch(`${baseUrl}/v1/markets/${market.id}/orderbook`, {
                headers: { 'x-api-key': apiKey }
            });
            if (res.ok) {
                const book = await res.json() as { bids?: any[]; asks?: any[] };
                const hasBids = book.bids && book.bids.length > 0;
                const hasAsks = book.asks && book.asks.length > 0;
                if (hasBids || hasAsks) {
                    workingMarkets.push({ market, hasOrderbook: true });
                    console.log(`  [OK] ID ${market.id}: ${market.title?.slice(0, 40)}... (Bids: ${book.bids?.length || 0}, Asks: ${book.asks?.length || 0})`);
                }
            }
        } catch (e) {
            // Ignore errors
        }
    }

    if (workingMarkets.length === 0) {
        console.log('  [WARN] No markets with active orderbooks found');
    }

    // Check Polymarket associations (this comes directly from Predict API!)
    const marketsWithPolymarket = Array.from(uniqueMarkets.values())
        .filter(m => m.polymarketConditionIds && m.polymarketConditionIds.length > 0);

    if (marketsWithPolymarket.length > 0) {
        console.log(`\n[Link] ${marketsWithPolymarket.length} markets have Polymarket association (from API field: polymarketConditionIds)`);
        for (const m of marketsWithPolymarket.slice(0, 10)) {
            console.log(`  - ID ${m.id}: ${m.title?.slice(0, 50)}`);
            console.log(`    Status: ${m.status}`);
            console.log(`    Polymarket IDs: ${JSON.stringify(m.polymarketConditionIds)}`);
        }
    }

    return Array.from(uniqueMarkets.values());
}

async function scanPolymarketMarkets() {
    console.log('\n' + '='.repeat(70));
    console.log('[Polymarket] Market Scan');
    console.log('='.repeat(70));

    const gammaUrl = process.env.POLYMARKET_GAMMA_API_BASE_URL || 'https://gamma-api.polymarket.com';
    const clobUrl = process.env.POLYMARKET_CLOB_BASE_URL || 'https://clob.polymarket.com';

    let markets: PolymarketMarket[] = [];
    try {
        const res = await fetch(`${gammaUrl}/markets?active=true&closed=false&limit=100`);
        if (res.ok) {
            markets = await res.json() as PolymarketMarket[];
            console.log(`\n[OK] Fetched ${markets.length} active markets`);
        }
    } catch (e) {
        console.log('[ERROR] Failed to fetch markets');
        return [];
    }

    const validMarkets = markets.filter(m =>
        m.clobTokenIds && m.clobTokenIds !== '[]' && m.clobTokenIds !== 'null'
    );
    console.log(`[OK] ${validMarkets.length} markets have valid CLOB Token IDs`);

    const sortedMarkets = validMarkets.sort((a, b) => (b.volumeNum || 0) - (a.volumeNum || 0));

    console.log('\n[Top 15] High volume markets:');
    console.log('-'.repeat(70));

    for (let i = 0; i < Math.min(15, sortedMarkets.length); i++) {
        const m = sortedMarkets[i];
        const volumeM = ((m.volumeNum || 0) / 1_000_000).toFixed(2);
        console.log(`[${i + 1}] ${m.question?.slice(0, 55)}...`);
        console.log(`    Volume: $${volumeM}M | Slug: ${m.slug}`);
    }

    console.log('\n[Test] Checking orderbooks for high volume markets...');

    for (let i = 0; i < Math.min(5, sortedMarkets.length); i++) {
        const market = sortedMarkets[i];
        try {
            const tokenIds = JSON.parse(market.clobTokenIds || '[]');
            if (tokenIds.length >= 2) {
                const yesToken = tokenIds[0];
                const noToken = tokenIds[1];

                const yesRes = await fetch(`${clobUrl}/book?token_id=${yesToken}`);
                const noRes = await fetch(`${clobUrl}/book?token_id=${noToken}`);

                if (yesRes.ok && noRes.ok) {
                    const yesBook = await yesRes.json() as { bids?: any[]; asks?: any[] };
                    const noBook = await noRes.json() as { bids?: any[]; asks?: any[] };

                    console.log(`\n  [${i + 1}] ${market.question?.slice(0, 50)}...`);
                    console.log(`      YES: Bids ${yesBook.bids?.length || 0} | Asks ${yesBook.asks?.length || 0}`);
                    console.log(`      NO:  Bids ${noBook.bids?.length || 0} | Asks ${noBook.asks?.length || 0}`);

                    if (yesBook.bids?.length && yesBook.asks?.length) {
                        const bestBid = parseFloat((yesBook.bids[0] as any).price);
                        const bestAsk = parseFloat((yesBook.asks[0] as any).price);
                        console.log(`      YES Price: Bid ${bestBid.toFixed(3)} | Ask ${bestAsk.toFixed(3)} | Spread ${((bestAsk - bestBid) * 100).toFixed(2)}%`);
                    }
                }
            }
        } catch (e) {
            console.log(`  [${i + 1}] Orderbook fetch failed`);
        }
    }

    return sortedMarkets;
}

async function main() {
    console.log('='.repeat(70));
    console.log('                    Full API Scan Test');
    console.log('                    ' + new Date().toISOString());
    console.log('='.repeat(70));

    await scanPredictMarkets();
    await scanPolymarketMarkets();

    console.log('\n' + '='.repeat(70));
    console.log('Scan Complete');
    console.log('='.repeat(70));
}

main().catch(console.error);
