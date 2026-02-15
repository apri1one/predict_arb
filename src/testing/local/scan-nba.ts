import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env') });

import { PredictRestClient } from './src/predict/rest-client.js';

async function main() {
    const client = new PredictRestClient();
    const markets = await client.getActiveMarkets(500);

    console.log('Total markets:', markets.length);

    const nbaLike = markets.filter(m => {
        const slug = (m.categorySlug || '').toLowerCase();
        const title = (m.title || '').toLowerCase();
        return slug.includes('at-') ||
               slug.includes('phoenix') ||
               slug.includes('miami') ||
               title.includes('phoenix') ||
               title.includes('miami') ||
               title.includes('suns') ||
               title.includes('heat');
    });

    console.log('\nFound NBA-like markets:', nbaLike.length);

    for (const m of nbaLike) {
        console.log(`  [${m.id}] slug=${m.categorySlug} title=${m.title}`);
    }
}

main().catch(console.error);
