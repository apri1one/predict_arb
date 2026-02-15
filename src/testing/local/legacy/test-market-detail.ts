import * as fs from 'fs';
import * as path from 'path';

function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

const apiKey = process.env.PREDICT_API_KEY || '';

async function main() {
    const res = await fetch('https://api.predict.fun/v1/markets/785', {
        headers: { 'x-api-key': apiKey }
    });

    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
