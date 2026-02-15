// Test script to match Predict and Polymarket sports markets
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PredictRestClient } from './src/predict/rest-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), '.env') });

// NBA 球队映射: 城市名 -> 缩写
const NBA_CITY_TO_ABBR: Record<string, string> = {
    'atlanta': 'atl',
    'boston': 'bos',
    'brooklyn': 'bkn',
    'charlotte': 'cha',
    'chicago': 'chi',
    'cleveland': 'cle',
    'dallas': 'dal',
    'denver': 'den',
    'detroit': 'det',
    'golden state': 'gsw',
    'golden-state': 'gsw',
    'houston': 'hou',
    'indiana': 'ind',
    'la clippers': 'lac',
    'los angeles clippers': 'lac',
    'la lakers': 'lal',
    'los angeles lakers': 'lal',
    'los angeles': 'lal',
    'memphis': 'mem',
    'miami': 'mia',
    'milwaukee': 'mil',
    'minnesota': 'min',
    'new orleans': 'nop',
    'new-orleans': 'nop',
    'new york': 'nyk',
    'new-york': 'nyk',
    'oklahoma city': 'okc',
    'oklahoma-city': 'okc',
    'orlando': 'orl',
    'philadelphia': 'phi',
    'phoenix': 'phx',
    'portland': 'por',
    'sacramento': 'sac',
    'san antonio': 'sas',
    'san-antonio': 'sas',
    'toronto': 'tor',
    'utah': 'uta',
    'washington': 'was',
};

// 缩写 -> 球队名
const NBA_ABBR_TO_TEAM: Record<string, string[]> = {
    'atl': ['hawks', 'atlanta'],
    'bos': ['celtics', 'boston'],
    'bkn': ['nets', 'brooklyn'],
    'cha': ['hornets', 'charlotte'],
    'chi': ['bulls', 'chicago'],
    'cle': ['cavaliers', 'cleveland'],
    'dal': ['mavericks', 'dallas'],
    'den': ['nuggets', 'denver'],
    'det': ['pistons', 'detroit'],
    'gsw': ['warriors', 'golden state'],
    'hou': ['rockets', 'houston'],
    'ind': ['pacers', 'indiana'],
    'lac': ['clippers', 'la clippers'],
    'lal': ['lakers', 'los angeles', 'la lakers'],
    'mem': ['grizzlies', 'memphis'],
    'mia': ['heat', 'miami'],
    'mil': ['bucks', 'milwaukee'],
    'min': ['timberwolves', 'minnesota'],
    'nop': ['pelicans', 'new orleans'],
    'nyk': ['knicks', 'new york'],
    'okc': ['thunder', 'oklahoma city'],
    'orl': ['magic', 'orlando'],
    'phi': ['76ers', 'philadelphia', 'sixers'],
    'phx': ['suns', 'phoenix'],
    'por': ['trail blazers', 'portland', 'blazers'],
    'sac': ['kings', 'sacramento'],
    'sas': ['spurs', 'san antonio'],
    'tor': ['raptors', 'toronto'],
    'uta': ['jazz', 'utah'],
    'was': ['wizards', 'washington'],
};

interface PolymarketSportsMarket {
    id: string;
    question: string;
    conditionId: string;
    slug: string;
    outcomes: string;
    outcomePrices: string;
    clobTokenIds: string;
    endDate: string;
    liquidity: string;
}

interface MatchResult {
    predictId: number;
    predictTitle: string;
    predictCategorySlug: string;
    polymarketId: string;
    polymarketQuestion: string;
    polymarketConditionId: string;
    polymarketSlug: string;
    polymarketLiquidity: number;
}

async function getPolymarketSportsMarkets(tagId: number, marketType?: string): Promise<PolymarketSportsMarket[]> {
    let url = `https://gamma-api.polymarket.com/markets?tag_id=${tagId}&active=true&closed=false&limit=100`;
    if (marketType) {
        url += `&sports_market_types=${marketType}`;
    }

    const res = await fetch(url);
    return res.json() as Promise<PolymarketSportsMarket[]>;
}

// 解析 Predict categorySlug: "chicago-at-houston" -> { away: "chi", home: "hou" }
function parsePredictSlug(slug: string): { away: string; home: string } | null {
    const match = slug.match(/^([a-z-]+)-at-([a-z-]+)$/i);
    if (!match) return null;

    const awayCity = match[1].toLowerCase();
    const homeCity = match[2].toLowerCase();

    const awayAbbr = NBA_CITY_TO_ABBR[awayCity];
    const homeAbbr = NBA_CITY_TO_ABBR[homeCity];

    if (!awayAbbr || !homeAbbr) return null;

    return { away: awayAbbr, home: homeAbbr };
}

// 解析 Polymarket slug: "nba-chi-hou-2026-01-13" -> { team1: "chi", team2: "hou", date: "2026-01-13" }
function parsePolySlug(slug: string): { team1: string; team2: string; date: string } | null {
    const match = slug.match(/^nba-([a-z]{3})-([a-z]{3})-(\d{4}-\d{2}-\d{2})$/i);
    if (!match) return null;

    return {
        team1: match[1].toLowerCase(),
        team2: match[2].toLowerCase(),
        date: match[3],
    };
}

async function main() {
    const client = new PredictRestClient();

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║       Sports Market Matcher - Predict ↔ Polymarket         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    // 1. 获取 Predict 活跃市场
    console.log('1. Fetching Predict active markets (via order matches)...');
    const activeMarkets = await client.getActiveMarkets(200);
    console.log(`   Total active: ${activeMarkets.length}`);

    // 2. 筛选 NBA "X-at-Y" 格式的市场
    const nbaMarkets = activeMarkets.filter(m => {
        const cat = (m.categorySlug || '').toLowerCase();
        return cat.includes('-at-') && parsePredictSlug(cat) !== null;
    });
    console.log(`   NBA "X at Y" markets: ${nbaMarkets.length}`);

    if (nbaMarkets.length > 0) {
        console.log('\n--- Predict NBA Markets ---');
        for (const m of nbaMarkets) {
            const parsed = parsePredictSlug(m.categorySlug);
            console.log(`   [${m.id}] ${m.title}`);
            console.log(`      Cat: ${m.categorySlug}`);
            console.log(`      Parsed: ${parsed?.away?.toUpperCase()} @ ${parsed?.home?.toUpperCase()}`);
        }
    }

    // 3. 获取 Polymarket NBA moneyline 市场
    console.log('\n2. Fetching Polymarket NBA markets (moneyline)...');
    const polyNbaMarkets = await getPolymarketSportsMarkets(745, 'moneyline');
    console.log(`   Found ${polyNbaMarkets.length} NBA moneyline markets`);

    // 4. 匹配市场
    console.log('\n3. Matching markets...\n');
    const matches: MatchResult[] = [];

    for (const polyM of polyNbaMarkets) {
        const polyParsed = parsePolySlug(polyM.slug);
        if (!polyParsed) continue;

        // 在 Predict 中查找匹配的市场
        for (const predM of nbaMarkets) {
            const predParsed = parsePredictSlug(predM.categorySlug);
            if (!predParsed) continue;

            // Polymarket: team1 vs team2 (通常是 away vs home)
            // Predict: away-at-home
            // 检查是否是同一场比赛（球队组合相同）
            const teamsMatch =
                (predParsed.away === polyParsed.team1 && predParsed.home === polyParsed.team2) ||
                (predParsed.away === polyParsed.team2 && predParsed.home === polyParsed.team1);

            if (teamsMatch) {
                matches.push({
                    predictId: predM.id,
                    predictTitle: predM.title,
                    predictCategorySlug: predM.categorySlug,
                    polymarketId: polyM.id,
                    polymarketQuestion: polyM.question,
                    polymarketConditionId: polyM.conditionId,
                    polymarketSlug: polyM.slug,
                    polymarketLiquidity: parseFloat(polyM.liquidity),
                });
            }
        }
    }

    // 5. 显示匹配结果
    console.log(`═══════════════════════════════════════════════════════════════`);
    console.log(`   MATCHED MARKETS: ${matches.length}`);
    console.log(`═══════════════════════════════════════════════════════════════\n`);

    if (matches.length > 0) {
        for (const m of matches) {
            console.log(`✓ MATCH FOUND:`);
            console.log(`   Predict:    [${m.predictId}] ${m.predictTitle}`);
            console.log(`               ${m.predictCategorySlug}`);
            console.log(`   Polymarket: [${m.polymarketId}] ${m.polymarketQuestion}`);
            console.log(`               ${m.polymarketSlug}`);
            console.log(`               ConditionId: ${m.polymarketConditionId}`);
            console.log(`               Liquidity: $${m.polymarketLiquidity.toFixed(0)}`);
            console.log('');
        }

        // 输出 JSON 格式方便后续使用
        console.log('\n--- JSON Output ---');
        console.log(JSON.stringify(matches, null, 2));
    } else {
        console.log('   No matches found.\n');
        console.log('   Possible reasons:');
        console.log('   - Different game dates between platforms');
        console.log('   - Markets not yet created on one platform');
        console.log('   - Team name parsing mismatch');

        // 显示详细的调试信息
        console.log('\n--- Debug: Predict NBA markets ---');
        for (const m of nbaMarkets) {
            const parsed = parsePredictSlug(m.categorySlug);
            console.log(`   ${m.categorySlug} -> ${parsed?.away} @ ${parsed?.home}`);
        }

        console.log('\n--- Debug: Polymarket NBA markets (first 10) ---');
        for (const m of polyNbaMarkets.slice(0, 10)) {
            const parsed = parsePolySlug(m.slug);
            console.log(`   ${m.slug} -> ${parsed?.team1} vs ${parsed?.team2} (${parsed?.date})`);
        }
    }

    // 6. 显示体育标签参考
    console.log('\n--- Polymarket Sports Tags Reference ---');
    const sportsRes = await fetch('https://gamma-api.polymarket.com/sports');
    const sportsData = await sportsRes.json() as any[];
    const mainSports = sportsData.filter(s => ['nba', 'nfl', 'nhl', 'mlb', 'epl', 'mma'].includes(s.sport));
    for (const s of mainSports) {
        console.log(`   ${s.sport.toUpperCase().padEnd(5)}: tag_id=${s.tags.split(',')[1] || s.tags.split(',')[0]}`);
    }
}

main().catch(console.error);
