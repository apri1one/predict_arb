import * as crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from parent directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const CLOB_BASE_URL = 'https://clob.polymarket.com';
const apiKey = process.env.POLYMARKET_API_KEY!;
const apiSecret = process.env.POLYMARKET_API_SECRET!;
const passphrase = process.env.POLYMARKET_PASSPHRASE!;
const traderAddress = process.env.POLYMARKET_TRADER_ADDRESS || process.env.POLYMARKET_PROXY_ADDRESS!;

function buildHeaders(method: string, path: string, body: string = ''): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method + path + body;
    const secretBuffer = Buffer.from(apiSecret, 'base64');
    const signature = crypto
        .createHmac('sha256', secretBuffer)
        .update(message, 'utf-8')
        .digest('base64');
    const urlSafeSignature = signature.replace(/\+/g, '-').replace(/\//g, '_');

    return {
        'POLY_API_KEY': apiKey,
        'POLY_SIGNATURE': urlSafeSignature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': passphrase,
        'POLY_ADDRESS': traderAddress,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}

async function getPositions() {
    console.log('=== 查询 Polymarket 持仓 ===\n');
    console.log(`Trader Address: ${traderAddress}\n`);

    // 尝试多个 API 路径
    const paths = [
        '/positions',
        '/data/positions',
        `/positions?address=${traderAddress}`,
        '/balance-allowance?asset_type=CONDITIONAL'
    ];

    let data: any[] = [];

    for (const apiPath of paths) {
        console.log(`尝试: ${apiPath}`);
        const headers = buildHeaders('GET', apiPath);

        const res = await fetch(CLOB_BASE_URL + apiPath, { headers });
        console.log(`  Status: ${res.status}`);

        if (res.ok) {
            const result = await res.json();
            console.log(`  Response: ${JSON.stringify(result).slice(0, 200)}...\n`);
            if (Array.isArray(result)) {
                data = result;
                break;
            }
        } else {
            const text = await res.text();
            console.log(`  Error: ${text.slice(0, 100)}\n`);
        }
    }

    if (data.length === 0) {
        // 尝试通过 Graph API 查询
        console.log('\n尝试通过 Graph Protocol 查询...');
        return;
    }

    if (Array.isArray(data) && data.length > 0) {
        console.log(`找到 ${data.length} 个持仓:\n`);
        for (const pos of data) {
            const tokenId = pos.asset || pos.tokenId || 'unknown';
            console.log(`Token ID: ${tokenId.slice(0, 30)}...${tokenId.slice(-10)}`);
            console.log(`  Size: ${pos.size}`);
            console.log(`  Avg Cost: ${pos.avgCost || pos.averageCost || 'N/A'}`);
            console.log(`  Realized PnL: ${pos.realizedPnl || 'N/A'}`);
            console.log(`  Cur Price: ${pos.curPrice || 'N/A'}`);
            console.log('');
        }

        // 输出原始 JSON 以便查看完整字段
        console.log('\n=== 原始数据 (第一个持仓) ===');
        console.log(JSON.stringify(data[0], null, 2));
    } else {
        console.log('No positions found or unexpected format:');
        console.log(JSON.stringify(data, null, 2));
    }
}

getPositions().catch(console.error);
