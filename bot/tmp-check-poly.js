import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const OUTPUT = 'tmp-check-poly-output.txt';
fs.writeFileSync(OUTPUT, 'Script started\n');

const addr = process.env.POLYMARKET_PROXY_ADDRESS;
fs.appendFileSync(OUTPUT, `Address: ${addr ? addr.slice(0, 10) + '...' : 'NOT SET'}\n`);

if (!addr) {
    fs.appendFileSync(OUTPUT, 'ERROR: POLYMARKET_PROXY_ADDRESS not set\n');
    process.exit(1);
}

fs.appendFileSync(OUTPUT, 'About to fetch positions...\n');

fetch(`https://data-api.polymarket.com/positions?user=${addr}&sizeThreshold=0.01`)
    .then(r => r.json())
    .then(data => {
        fs.appendFileSync(OUTPUT, `Got ${data.length} positions\n`);

        for (const p of data) {
            const size = parseFloat(p.size || '0');
            if (size <= 0 || p.redeemable) continue;

            fs.appendFileSync(OUTPUT, `---\n`);
            fs.appendFileSync(OUTPUT, `Title: ${p.title}\n`);
            fs.appendFileSync(OUTPUT, `Side: ${p.outcome}, Size: ${size.toFixed(2)}\n`);
            fs.appendFileSync(OUTPUT, `ConditionId: ${p.conditionId}\n`);
            fs.appendFileSync(OUTPUT, `Asset: ${p.asset}\n`);
        }

        fs.appendFileSync(OUTPUT, '\nDone!\n');
    })
    .catch(e => {
        fs.appendFileSync(OUTPUT, `Error: ${e.message}\n`);
    });
