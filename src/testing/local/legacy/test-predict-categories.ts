// Test Predict API categories and sports markets
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PredictRestClient } from './src/predict/rest-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), '.env') });

const API_KEY = process.env.PREDICT_API_KEY;

async function main() {
    const client = new PredictRestClient();

    console.log('=== Testing Predict API Categories ===\n');

    // 1. 获取所有类别
    console.log('1. Getting categories...');
    try {
        const categories = await client.getCategories();
        console.log('   Categories found:', categories.length);
        for (const cat of categories) {
            console.log(`   - ${cat.slug}: ${cat.name} (${cat.count} markets)`);
        }
    } catch (e: any) {
        console.log('   Error:', e.message);
    }

    // 2. 尝试通过 category=sports 获取市场
    console.log('\n2. Testing category=sports...');
    try {
        const markets = await client.getMarkets({ category: 'sports', limit: 50 });
        console.log(`   Found ${markets.length} sports markets`);
        for (const m of markets.slice(0, 10)) {
            console.log(`   [${m.id}] ${m.title} | ${m.categorySlug} | ${m.status}`);
        }
    } catch (e: any) {
        console.log('   Error:', e.message);
    }

    // 3. 直接调用 API 尝试不同参数
    console.log('\n3. Testing direct API calls...');

    const testUrls = [
        '/v1/markets?category=sports&limit=20',
        '/v1/markets?categorySlug=sports&limit=20',
        '/v1/markets?search=NBA&limit=20',
        '/v1/markets?search=basketball&limit=20',
    ];

    for (const path of testUrls) {
        console.log(`\n   Testing: ${path}`);
        const res = await fetch(`https://api.predict.fun${path}`, {
            headers: { 'X-API-Key': API_KEY! }
        });
        const data = await res.json() as any;
        if (data.data) {
            console.log(`   Found ${data.data.length} markets`);
            for (const m of data.data.slice(0, 3)) {
                console.log(`     - [${m.id}] ${m.title}`);
            }
        } else {
            console.log(`   Response: ${JSON.stringify(data).slice(0, 200)}`);
        }
    }
}

main().catch(console.error);
