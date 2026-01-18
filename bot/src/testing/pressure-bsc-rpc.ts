/**
 * Simple BSC RPC load test.
 *
 * Usage:
 *   MODE=block DURATION_MS=30000 CONCURRENCY=4 TIMEOUT_MS=3000 npx tsx src/testing/pressure-bsc-rpc.ts
 *   MODE=balance TARGET_ADDRESS=0x... TOKEN_ADDRESS=0x55d398... npx tsx src/testing/pressure-bsc-rpc.ts
 *
 * Env:
 *   BSC_RPC_URLS=comma,separated,urls
 *   MODE=block|balance
 *   DURATION_MS=30000
 *   CONCURRENCY=4
 *   TIMEOUT_MS=3000
 *   TARGET_ADDRESS=0x...
 *   TOKEN_ADDRESS=0x55d398326f99059fF775485246999027B3197955
 */

type RpcStats = {
    total: number;
    success: number;
    httpError: number;
    rpcError: number;
    timeout: number;
    otherError: number;
    latencySumMs: number;
};

const DEFAULT_RPC_URLS = [
    'https://bsc-dataseed.bnbchain.org/',
    'https://bsc-dataseed1.binance.org/',
    'https://bsc-dataseed2.binance.org/',
    'https://bsc.publicnode.com',
    'https://bsc-rpc.publicnode.com',
];

const rpcUrls = (process.env.BSC_RPC_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

const RPC_URLS = rpcUrls.length > 0 ? rpcUrls : DEFAULT_RPC_URLS;
const DURATION_MS = Number(process.env.DURATION_MS || 30000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 3000);
const MODE = (process.env.MODE || 'block').toLowerCase();
const TOKEN_ADDRESS = (process.env.TOKEN_ADDRESS || '0x55d398326f99059fF775485246999027B3197955').toLowerCase();
const TARGET_ADDRESS = (process.env.TARGET_ADDRESS || '0x0000000000000000000000000000000000000000').toLowerCase();

function toHexDataForBalanceOf(address: string): string {
    const clean = address.replace(/^0x/, '').padStart(64, '0');
    return `0x70a08231${clean}`;
}

function buildPayload(id: number): Record<string, unknown> {
    if (MODE === 'balance') {
        return {
            jsonrpc: '2.0',
            id,
            method: 'eth_call',
            params: [
                { to: TOKEN_ADDRESS, data: toHexDataForBalanceOf(TARGET_ADDRESS) },
                'latest',
            ],
        };
    }

    return {
        jsonrpc: '2.0',
        id,
        method: 'eth_blockNumber',
        params: [],
    };
}

async function sendRpc(url: string, payload: Record<string, unknown>): Promise<{ ok: boolean; latencyMs: number; status?: number; timeout?: boolean; rpcError?: boolean; }> {
    const controller = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const latencyMs = Date.now() - started;

        if (!res.ok) {
            return { ok: false, latencyMs, status: res.status };
        }

        const data = await res.json() as { result?: unknown; error?: unknown };
        if (data.error) {
            return { ok: false, latencyMs, rpcError: true };
        }

        return { ok: true, latencyMs };
    } catch (err: any) {
        const latencyMs = Date.now() - started;
        if (err?.name === 'AbortError') {
            return { ok: false, latencyMs, timeout: true };
        }
        return { ok: false, latencyMs };
    } finally {
        clearTimeout(timer);
    }
}

async function run(): Promise<void> {
    console.log(`Mode: ${MODE}`);
    console.log(`RPC URLs: ${RPC_URLS.length}`);
    console.log(`Duration: ${DURATION_MS}ms, Concurrency: ${CONCURRENCY}, Timeout: ${TIMEOUT_MS}ms`);
    if (MODE === 'balance') {
        console.log(`Token: ${TOKEN_ADDRESS}, Address: ${TARGET_ADDRESS}`);
    }
    console.log('');

    const stats = new Map<string, RpcStats>();
    const endAt = Date.now() + DURATION_MS;
    let requestId = 1;

    for (const url of RPC_URLS) {
        stats.set(url, {
            total: 0,
            success: 0,
            httpError: 0,
            rpcError: 0,
            timeout: 0,
            otherError: 0,
            latencySumMs: 0,
        });
    }

    const workers: Promise<void>[] = [];

    for (const url of RPC_URLS) {
        for (let i = 0; i < CONCURRENCY; i++) {
            workers.push((async () => {
                while (Date.now() < endAt) {
                    const payload = buildPayload(requestId++);
                    const result = await sendRpc(url, payload);
                    const s = stats.get(url)!;
                    s.total += 1;
                    if (result.ok) {
                        s.success += 1;
                        s.latencySumMs += result.latencyMs;
                    } else if (result.timeout) {
                        s.timeout += 1;
                    } else if (result.rpcError) {
                        s.rpcError += 1;
                    } else if (result.status) {
                        s.httpError += 1;
                    } else {
                        s.otherError += 1;
                    }
                }
            })());
        }
    }

    await Promise.all(workers);

    console.log('Results:');
    for (const [url, s] of stats.entries()) {
        const avgLatency = s.success > 0 ? (s.latencySumMs / s.success).toFixed(1) : 'n/a';
        const rps = (s.total / (DURATION_MS / 1000)).toFixed(2);
        console.log(`- ${url}`);
        console.log(`  total=${s.total} success=${s.success} rps=${rps} avgLatencyMs=${avgLatency}`);
        console.log(`  httpError=${s.httpError} rpcError=${s.rpcError} timeout=${s.timeout} otherError=${s.otherError}`);
    }
}

run().catch((err) => {
    console.error('Load test failed:', err);
    process.exit(1);
});
