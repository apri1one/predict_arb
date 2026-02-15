/**
 * JWT 认证延迟基准测试
 *
 * 测量 Predict 端 JWT 认证全链路延迟:
 *   Test 1: 冷启动 JWT 认证 (首次，包含 init + auth)
 *   Test 2: 热缓存 getAuthHeaders (JWT 已缓存，无网络)
 *   Test 3: 强制刷新 JWT (模拟过期后重新认证)
 *   Test 4: JWT 认证分段测量 (getMessage vs submitAuth)
 *   Test 5: getAuthHeaders 在 placeOrder 链路中的占比
 *
 * 运行: cd bot && npx tsx src/testing/test-jwt-latency.ts
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

import { PredictTrader } from '../dashboard/predict-trader.js';

// ============================================================================
// 常量
// ============================================================================

const API_BASE_URL = 'https://api.predict.fun';
const ROUNDS = 5;

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    magenta: '\x1b[35m',
};

// ============================================================================
// 工具
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function stats(times: number[]): { median: number; p95: number; min: number; max: number; avg: number } {
    const sorted = [...times].sort((a, b) => a - b);
    return {
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    };
}

function formatMs(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function printStats(label: string, times: number[]): void {
    const s = stats(times);
    console.log(`  ${c.cyan}${label}${c.reset}: median=${c.bold}${formatMs(s.median)}${c.reset} avg=${formatMs(s.avg)} min=${formatMs(s.min)} max=${formatMs(s.max)} p95=${formatMs(s.p95)}`);
}

function header(title: string): void {
    console.log(`\n${c.bold}${c.magenta}═══ ${title} ═══${c.reset}`);
}

// ============================================================================
// Test 1: 冷启动 JWT (init + 首次认证)
// ============================================================================

async function testColdStart(): Promise<number> {
    header('Test 1: 冷启动 JWT 认证 (init + auth)');

    const t0 = Date.now();
    const trader = new PredictTrader();
    await trader.init();
    const elapsed = Date.now() - t0;

    console.log(`  冷启动耗时: ${c.bold}${formatMs(elapsed)}${c.reset} (含 OrderBuilder init + JWT 认证)`);

    // 验证 JWT 可用: 调用一次 getOrderStatus
    const t1 = Date.now();
    // @ts-ignore - 访问私有方法用于测试
    const headers = await trader.getAuthHeaders();
    const headerTime = Date.now() - t1;
    console.log(`  热缓存 getAuthHeaders: ${c.green}${formatMs(headerTime)}${c.reset}`);

    const hasJwt = !!headers['Authorization'];
    console.log(`  JWT 存在: ${hasJwt ? c.green + 'YES' : c.red + 'NO'}${c.reset}`);

    return elapsed;
}

// ============================================================================
// Test 2: 热缓存 getAuthHeaders
// ============================================================================

async function testWarmCache(trader: PredictTrader): Promise<void> {
    header(`Test 2: 热缓存 getAuthHeaders (${ROUNDS} 轮)`);

    const times: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
        const t0 = Date.now();
        // @ts-ignore
        await trader.getAuthHeaders();
        times.push(Date.now() - t0);
    }

    printStats('getAuthHeaders (cached)', times);
}

// ============================================================================
// Test 3: 强制刷新 JWT (模拟过期)
// ============================================================================

async function testForceRefresh(trader: PredictTrader): Promise<void> {
    header(`Test 3: 强制刷新 JWT (${ROUNDS} 轮)`);

    const times: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
        // 清除缓存，模拟过期
        // @ts-ignore
        trader.jwt = null;
        // @ts-ignore
        trader.jwtExpiresAt = null;

        const t0 = Date.now();
        // @ts-ignore
        await trader.getAuthHeaders();
        const elapsed = Date.now() - t0;
        times.push(elapsed);

        console.log(`  ${c.dim}轮 ${i + 1}: ${formatMs(elapsed)}${c.reset}`);
        await sleep(200);
    }

    printStats('JWT 刷新 (full auth)', times);
}

// ============================================================================
// Test 4: JWT 认证分段测量
// ============================================================================

async function testAuthSegments(trader: PredictTrader): Promise<void> {
    header(`Test 4: JWT 认证分段测量 (${ROUNDS} 轮)`);

    // @ts-ignore
    const apiKey = trader.apiKey;
    // @ts-ignore
    const orderBuilder = trader.orderBuilder;
    // @ts-ignore
    const smartWalletAddress = trader.smartWalletAddress;

    if (!orderBuilder) {
        console.log(`  ${c.red}OrderBuilder 未初始化，跳过${c.reset}`);
        return;
    }

    const msgTimes: number[] = [];
    const signTimes: number[] = [];
    const authTimes: number[] = [];
    const totalTimes: number[] = [];

    for (let i = 0; i < ROUNDS; i++) {
        const totalStart = Date.now();

        // Step 1: 获取认证消息
        const t1 = Date.now();
        const msgRes = await fetch(`${API_BASE_URL}/v1/auth/message`, {
            headers: { 'x-api-key': apiKey }
        });
        if (!msgRes.ok) {
            console.log(`  ${c.red}获取消息失败: ${msgRes.status}${c.reset}`);
            continue;
        }
        const msgData = await msgRes.json() as { data: { message: string } };
        const message = msgData.data.message;
        const msgTime = Date.now() - t1;
        msgTimes.push(msgTime);

        // Step 2: 签名
        const t2 = Date.now();
        const signature = await orderBuilder.signPredictAccountMessage(message);
        const signTime = Date.now() - t2;
        signTimes.push(signTime);

        // Step 3: 提交认证
        const t3 = Date.now();
        const authRes = await fetch(`${API_BASE_URL}/v1/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey
            },
            body: JSON.stringify({
                signer: smartWalletAddress,
                signature,
                message
            })
        });
        if (!authRes.ok) {
            const text = await authRes.text();
            console.log(`  ${c.red}认证失败: ${authRes.status} - ${text}${c.reset}`);
            continue;
        }
        const authTime = Date.now() - t3;
        authTimes.push(authTime);

        const totalTime = Date.now() - totalStart;
        totalTimes.push(totalTime);

        console.log(`  ${c.dim}轮 ${i + 1}: getMessage=${formatMs(msgTime)} sign=${formatMs(signTime)} submitAuth=${formatMs(authTime)} total=${formatMs(totalTime)}${c.reset}`);
        await sleep(200);
    }

    if (msgTimes.length > 0) {
        console.log();
        printStats('GET /v1/auth/message', msgTimes);
        printStats('签名 (signPredictAccountMessage)', signTimes);
        printStats('POST /v1/auth', authTimes);
        printStats('JWT 总链路', totalTimes);
    }
}

// ============================================================================
// Test 5: getAuthHeaders 在 placeOrder 中的占比 (dry-run)
// ============================================================================

async function testAuthInPlaceOrderPath(trader: PredictTrader): Promise<void> {
    header('Test 5: getAuthHeaders 在 placeOrder 链路中的时间占比');

    // 模拟 placeOrder 的 getAuthHeaders 调用，对比有缓存和无缓存
    // 有缓存
    const warmTimes: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
        const t0 = Date.now();
        // @ts-ignore
        await trader.getAuthHeaders();
        warmTimes.push(Date.now() - t0);
    }
    const warmAvg = Math.round(warmTimes.reduce((a, b) => a + b, 0) / warmTimes.length);

    // 无缓存 (模拟过期)
    const coldTimes: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
        // @ts-ignore
        trader.jwt = null;
        // @ts-ignore
        trader.jwtExpiresAt = null;

        const t0 = Date.now();
        // @ts-ignore
        await trader.getAuthHeaders();
        coldTimes.push(Date.now() - t0);
        await sleep(200);
    }
    const coldAvg = Math.round(coldTimes.reduce((a, b) => a + b, 0) / coldTimes.length);

    console.log(`  有缓存: avg=${c.green}${formatMs(warmAvg)}${c.reset} → placeOrder 中 getAuthHeaders 几乎零成本`);
    console.log(`  无缓存: avg=${c.red}${formatMs(coldAvg)}${c.reset} → 如果 JWT 过期，placeOrder 额外增加 ${formatMs(coldAvg)}`);
    console.log();
    console.log(`  ${c.yellow}结论${c.reset}: JWT 默认 24h 过期。如果进程持续运行超过 24h，`);
    console.log(`  第一次 placeOrder 会触发 JWT 刷新 (${formatMs(coldAvg)})，后续调用零成本。`);

    // 检查 JWT 过期时间
    // @ts-ignore
    const expiresAt = trader.jwtExpiresAt;
    if (expiresAt) {
        const remainingMs = expiresAt.getTime() - Date.now();
        const remainingHours = (remainingMs / 1000 / 60 / 60).toFixed(1);
        console.log(`  JWT 过期时间: ${expiresAt.toISOString()} (剩余 ${remainingHours}h)`);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log(`${c.bold}JWT 认证延迟基准测试${c.reset}`);
    console.log(`${c.dim}每项 ${ROUNDS} 轮${c.reset}`);

    // Test 1: 冷启动
    await testColdStart();
    await sleep(500);

    // 创建持久 trader 实例用于后续测试
    const trader = new PredictTrader();
    await trader.init();

    // Test 2: 热缓存
    await testWarmCache(trader);
    await sleep(500);

    // Test 3: 强制刷新
    await testForceRefresh(trader);
    await sleep(500);

    // Test 4: 分段
    await testAuthSegments(trader);
    await sleep(500);

    // Test 5: 占比分析
    await testAuthInPlaceOrderPath(trader);

    console.log(`\n${c.bold}${c.green}测试完成${c.reset}`);
    process.exit(0);
}

main().catch(err => {
    console.error('测试失败:', err);
    process.exit(1);
});
