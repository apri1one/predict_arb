import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const OUTPUT = 'tmp-verify-clob-output.txt';
fs.writeFileSync(OUTPUT, 'Script started\n');

// Condition IDs to check
const conditionIds = [
    // One Battle After Another
    '0x66af911f31ceabb5f9a3ef9203a73f0b23d18aa81bbba7888dec440c622c2528',
    // US government shutdown
    '0x43ec78527bd98a0588dd9455685b2cc82f5743140cb3a154603dc03c02b57de5'
];

async function main() {
    for (const conditionId of conditionIds) {
        fs.appendFileSync(OUTPUT, `\n=== ${conditionId} ===\n`);

        // Fetch from CLOB API
        const res = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
        const data = await res.json();

        fs.appendFileSync(OUTPUT, `Question: ${data.question}\n`);
        fs.appendFileSync(OUTPUT, `neg_risk: ${data.neg_risk}\n`);
        fs.appendFileSync(OUTPUT, `\nTokens from CLOB API:\n`);

        for (const t of data.tokens || []) {
            fs.appendFileSync(OUTPUT, `  ${t.outcome}: ${t.token_id}\n`);
        }

        // Fetch orderbook for each token
        fs.appendFileSync(OUTPUT, `\nOrderbook prices:\n`);
        for (const t of data.tokens || []) {
            const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${t.token_id}`);
            const book = await bookRes.json();
            const bestBid = book.bids?.[0]?.price || 'N/A';
            const bestAsk = book.asks?.[0]?.price || 'N/A';
            fs.appendFileSync(OUTPUT, `  ${t.outcome}: bid=${bestBid}, ask=${bestAsk}\n`);
        }
    }

    fs.appendFileSync(OUTPUT, '\nDone!\n');
}

main().catch(e => {
    fs.appendFileSync(OUTPUT, `Error: ${e.message}\n`);
});
