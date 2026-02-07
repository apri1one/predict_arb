/**
 * Test Predict Account APIs with JWT Authentication
 * 
 * Steps:
 * 1. Get auth message from API
 * 2. Sign message with private key
 * 3. Get JWT token
 * 4. Use JWT to access account APIs
 */

import * as fs from 'fs';
import * as path from 'path';
import { Wallet } from 'ethers';

// Load env
function loadEnv() {
    const envPath = path.join(process.cwd(), '..', '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

const API_KEY = process.env.PREDICT_API_KEY!;
const PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY;
const BASE_URL = 'https://api.predict.fun';

async function getJwtToken(signer: Wallet): Promise<string | null> {
    // Step 1: Get auth message
    console.log('    Getting auth message...');
    const msgRes = await fetch(`${BASE_URL}/v1/auth/message`, {
        headers: { 'x-api-key': API_KEY }
    });

    if (!msgRes.ok) {
        console.log(`    ❌ Failed to get auth message: ${msgRes.status}`);
        return null;
    }

    const msgData = await msgRes.json() as { data: { message: string } };
    const message = msgData.data.message;
    console.log(`    Message: ${message.slice(0, 50)}...`);

    // Step 2: Sign message
    console.log('    Signing message...');
    const signature = await signer.signMessage(message);
    console.log(`    Signature: ${signature.slice(0, 30)}...`);

    // Step 3: Get JWT
    console.log('    Getting JWT token...');
    const authRes = await fetch(`${BASE_URL}/v1/auth`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
        },
        body: JSON.stringify({
            signer: signer.address,
            signature,
            message,
        }),
    });

    if (!authRes.ok) {
        const errText = await authRes.text();
        console.log(`    ❌ Auth failed: ${authRes.status} - ${errText}`);
        return null;
    }

    const authData = await authRes.json() as { data: { token: string } };
    console.log(`    ✓ JWT obtained`);
    return authData.data.token;
}

async function main() {
    console.log('='.repeat(60));
    console.log('        PREDICT ACCOUNT API TEST (WITH JWT)');
    console.log('='.repeat(60));

    if (!API_KEY) {
        console.log('\n❌ PREDICT_API_KEY not found');
        return;
    }

    if (!PRIVATE_KEY) {
        console.log('\n❌ PREDICT_SIGNER_PRIVATE_KEY not found');
        console.log('Add to .env: PREDICT_SIGNER_PRIVATE_KEY=0x...');
        return;
    }

    console.log(`\n✓ API Key: ${API_KEY.slice(0, 10)}...`);

    const signer = new Wallet(PRIVATE_KEY);
    console.log(`✓ Signer: ${signer.address}`);

    // Get JWT Token
    console.log('\n[1] Authenticating...');
    const jwt = await getJwtToken(signer);

    if (!jwt) {
        console.log('    Failed to authenticate. Check your private key.');
        return;
    }

    const authHeaders = {
        'x-api-key': API_KEY,
        'Authorization': `Bearer ${jwt}`,
    };

    // Test 2: Get account info
    console.log('\n[2] Fetching account info...');
    try {
        const res = await fetch(`${BASE_URL}/v1/account`, {
            headers: authHeaders
        });

        if (res.ok) {
            const data = await res.json() as any;
            console.log(`    ✓ Account:`, JSON.stringify(data.data, null, 2).slice(0, 500));
        } else {
            console.log(`    ⚠️ Status: ${res.status}`);
            console.log(`    Response: ${await res.text()}`);
        }
    } catch (e) {
        console.log(`    ❌ Error: ${e}`);
    }

    // Test 3: Get positions
    console.log('\n[3] Fetching positions...');
    try {
        const res = await fetch(`${BASE_URL}/v1/positions`, {
            headers: authHeaders
        });

        if (res.ok) {
            const data = await res.json() as any;
            const positions = data.data || [];
            console.log(`    ✓ Found ${positions.length} positions`);

            if (positions.length > 0) {
                console.log('    Positions:');
                for (const pos of positions.slice(0, 5)) {
                    console.log(`      - Market ${pos.marketId}: ${pos.quantity} @ ${pos.averagePrice}`);
                }
            }
        } else {
            console.log(`    ⚠️ Status: ${res.status}`);
            console.log(`    Response: ${await res.text()}`);
        }
    } catch (e) {
        console.log(`    ❌ Error: ${e}`);
    }

    // Test 4: Get open orders
    console.log('\n[4] Fetching open orders...');
    try {
        const res = await fetch(`${BASE_URL}/v1/orders?status=OPEN`, {
            headers: authHeaders
        });

        if (res.ok) {
            const data = await res.json() as any;
            const orders = data.data || [];
            console.log(`    ✓ Found ${orders.length} open orders`);

            if (orders.length > 0) {
                for (const order of orders.slice(0, 5)) {
                    console.log(`      - ${order.side} ${order.quantity} @ ${order.price}`);
                }
            }
        } else {
            console.log(`    ⚠️ Status: ${res.status}`);
        }
    } catch (e) {
        console.log(`    ❌ Error: ${e}`);
    }

    // Test 5: Get market with full details
    console.log('\n[5] Fetching Jake Paul market...');
    try {
        const res = await fetch(`${BASE_URL}/v1/markets/539`, {
            headers: { 'x-api-key': API_KEY }
        });

        if (res.ok) {
            const data = await res.json() as any;
            const m = data.data;
            console.log(`    ✓ Market: ${m.title}`);
            console.log(`    Fee: ${m.feeRateBps}bps, NegRisk: ${m.isNegRisk}`);

            // Find token IDs
            if (m.conditionId) {
                console.log(`    ConditionId: ${m.conditionId}`);
            }
            if (m.collateralToken) {
                console.log(`    Collateral: ${m.collateralToken}`);
            }
        }
    } catch (e) {
        console.log(`    ❌ Error: ${e}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('        TEST COMPLETE');
    console.log('='.repeat(60));
}

main().catch(console.error);
