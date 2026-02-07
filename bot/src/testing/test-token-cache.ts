import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import { TokenMarketCache } from '../services/token-market-cache.js';

async function main() {
    const cache = new TokenMarketCache();
    console.log('Loading cache...');
    await cache.start();
    const stats = cache.getStats();
    console.log('Cache stats:', JSON.stringify(stats));

    // Market 1560 - Manchester City EPL
    const yesId = '54702350866572416264712564955556146529210718988962219809578569901544133306879';
    const noId = '23055592570967944124156656338107265392525986409903420454417771282429902375626';

    const yesLookup = cache.getMarketByTokenId(yesId);
    const noLookup = cache.getMarketByTokenId(noId);

    console.log('YES lookup:', yesLookup ? `${yesLookup.market.title} / ${yesLookup.side}` : 'NOT FOUND');
    console.log('NO lookup:', noLookup ? `${noLookup.market.title} / ${noLookup.side}` : 'NOT FOUND');

    // Dump all markets to check total count
    const all = cache.exportTokenMappings();
    console.log(`Total markets in cache: ${all.length}`);

    // Check if any market has "Manchester" or "Man City" in title
    const mancity = all.filter(m => m.title.toLowerCase().includes('man city') || m.title.toLowerCase().includes('manchester'));
    console.log(`Markets matching "man city/manchester": ${mancity.length}`);
    for (const m of mancity.slice(0, 5)) {
        console.log(`  [${m.marketId}] ${m.title} yesToken=${m.yesTokenId?.slice(0,20)}... noToken=${m.noTokenId?.slice(0,20)}...`);
    }

    cache.stop();
}
main().catch(e => console.error(e));
