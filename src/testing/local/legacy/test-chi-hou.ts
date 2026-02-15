import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(process.cwd(), '.env') });

import { PredictRestClient } from './src/predict/rest-client.js';

async function test() {
    const client = new PredictRestClient();

    // 获取更多市场
    const markets = await client.getActiveMarkets(500);

    console.log('=== All markets with chicago-at-houston slug ===\n');

    const chiHouMarkets = markets.filter(m =>
        m.categorySlug?.toLowerCase() === 'chicago-at-houston'
    );

    console.log('Found', chiHouMarkets.length, 'markets:\n');

    for (const m of chiHouMarkets) {
        console.log('Market ID:', m.id);
        console.log('  Title:', m.title);
        console.log('  categorySlug:', m.categorySlug);
        console.log('  status:', m.status);
        console.log('  outcomes:', JSON.stringify(m.outcomes));
        console.log('');
    }

    // 也搜索包含 chicago 或 bulls 的市场
    console.log('=== Markets containing "chicago" or "bulls" ===\n');
    const chicagoMarkets = markets.filter(m =>
        m.title?.toLowerCase().includes('chicago') ||
        m.title?.toLowerCase().includes('bulls') ||
        m.categorySlug?.toLowerCase().includes('chicago')
    );

    for (const m of chicagoMarkets) {
        console.log('Market ID:', m.id, '| Title:', m.title, '| Slug:', m.categorySlug);
    }
}

test().catch(console.error);
