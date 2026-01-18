import { config } from 'dotenv';
config({ path: '../.env' });
import { PredictRestClient } from '../predict/rest-client.js';

const client = new PredictRestClient({ apiKey: process.env.PREDICT_API_KEY });

async function main() {
    const markets = await client.getMarkets({ limit: 200 });
    const fedMarkets = markets.filter(m =>
        m.title?.toLowerCase().includes('fed') ||
        m.title?.toLowerCase().includes('interest rate') ||
        m.title?.toLowerCase().includes('fomc') ||
        m.title?.toLowerCase().includes('rate cut')
    );

    console.log('FED/FOMC 相关市场:');
    for (const m of fedMarkets) {
        console.log(`  ID: ${m.id} - ${m.title?.slice(0, 70)}`);
    }
}

main();
