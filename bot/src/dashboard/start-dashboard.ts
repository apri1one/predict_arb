/**
 * Dashboard 启动脚本 - 真实数据模式
 *
 * 使用与 arb-monitor CLI 一致的深度计算逻辑
 * 支持 Maker 和 Taker 双策略套利检测
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { calculateDepth, calculateNoSideDepth, type DepthResult, type NoSideDepthResult } from '../trading/depth-calculator.js';
import { PolymarketWebSocketClient } from '../polymarket/ws-client.js';
import { destroyPolymarketUserWsClient } from '../polymarket/user-ws-client.js';
import { getAccountData, refreshAccountData, setMarketTitleResolver } from './account-service.js';
import { getTaskService, initTaskService } from './task-service.js';
import { getTaskExecutor } from './task-executor.js';
import { getTaskLogger, initTaskLogger } from './task-logger/index.js';
import { createTelegramNotifier, TelegramNotifier } from '../notification/telegram.js';
import { startWsOrderNotifierFromEnv, stopWsOrderNotifier } from '../notification/ws-order-notifier.js';
import { startBscOrderNotifierFromEnv, stopBscOrderNotifier } from '../notification/bsc-order-notifier.js';
import type { CreateTaskInput, TaskFilter, Task, ArbOpportunity, CloseOpportunity } from './types.js';
import { getLogQueryService } from './log-query-service.js';
import { calculateCloseOpportunities, getClosePositions, getPositionMarketIds, getUnmatchedPositions, refreshMarketMatches, setPolyOrderbookProvider, setPredictOrderbookProvider as setClosePredictOrderbookProvider } from './close-service.js';
import { setPolymarketWsOrderbookProvider } from './polymarket-trader.js';
import { setPredictOrderbookCacheProvider, setPredictOrderbookRestFallbackEnabled } from './predict-trader.js';
import { getSportsService, setSportsPredictOrderbookProvider } from './sports-service.js';
import { fetchBoostData, isMarketBoosted, getBoostCache } from './boost-cache.js';
import { initUrlMapper, getPredictSlug, getPolymarketSlug, cachePredictSlugs, generatePredictSlug } from './url-mapper.js';
import { getBscOrderWatcher, stopBscOrderWatcher, type OrderFilledEvent as BscOrderFilledEvent } from '../services/bsc-order-watcher.js';
import { getPredictOrderWatcher, stopPredictOrderWatcher } from '../services/predict-order-watcher.js';
import type { WalletEventData } from '../services/predict-ws-client.js';
import { getTokenMarketCache, stopTokenMarketCache } from '../services/token-market-cache.js';
import { getPredictOrderbookCache, initPredictOrderbookCache, stopPredictOrderbookCache, type CachedOrderbook } from '../services/predict-orderbook-cache.js';
import { runLiquidityScan } from '../scripts/market-liquidity-scan.js';

import * as readline from 'readline';
import { readdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const FRONT_DIR = resolve(__dirname, '..', '..', '..', 'front');
const FRONT_PREVIEW_PATH = join(FRONT_DIR, 'preview.html');
const HAS_FRONT_PREVIEW = existsSync(FRONT_PREVIEW_PATH);
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

// ============================================================================
// 命令行参数解析
// ============================================================================

interface CliArgs {
    envFile: string | null;  // null 表示未指定，需要交互选择
    port: number | null;
    accountName: string | null;
}

function parseCliArgs(): CliArgs {
    const args = process.argv.slice(2);
    const result: CliArgs = {
        envFile: null,  // 默认 null，后续判断是否需要交互
        port: null,
        accountName: null,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        // --env <path> 或 --env=<path>
        if (arg === '--env' && args[i + 1]) {
            result.envFile = resolve(args[++i]);
        } else if (arg.startsWith('--env=')) {
            result.envFile = resolve(arg.slice(6));
        }

        // --port <number> 或 --port=<number>
        else if (arg === '--port' && args[i + 1]) {
            result.port = parseInt(args[++i], 10);
        } else if (arg.startsWith('--port=')) {
            result.port = parseInt(arg.slice(7), 10);
        }

        // --account <name> 或 --account=<name> (用于日志标识)
        else if (arg === '--account' && args[i + 1]) {
            result.accountName = args[++i];
        } else if (arg.startsWith('--account=')) {
            result.accountName = arg.slice(10);
        }

        // --help
        else if (arg === '--help' || arg === '-h') {
            console.log(`
Dashboard 启动参数:
  --env <path>      指定配置文件路径 (默认: 交互选择或 .env)
  --port <number>   指定端口 (默认: 3010 或 DASHBOARD_PORT)
  --account <name>  账号名称标识 (用于日志区分)
  --help            显示帮助

示例:
  npm run dashboard                                              # 交互式选择账号
  npm run dashboard -- --env .env.account1 --port 3010 --account account1
  npm run dashboard -- --env .env.account2 --port 3006 --account account2
`);
            process.exit(0);
        }
    }

    return result;
}

// ============================================================================
// 账号配置扫描与交互选择
// ============================================================================

interface AccountConfig {
    name: string;       // 账号名称 (如 "account1")
    envFile: string;    // 配置文件路径
    displayName: string; // 显示名称
}

/**
 * 扫描项目根目录下的 .env.account* 配置文件
 */
function scanAccountConfigs(): AccountConfig[] {
    const configs: AccountConfig[] = [];

    try {
        const files = readdirSync(PROJECT_ROOT);
        for (const file of files) {
            // 匹配 .env.account* 格式（排除 .example 文件）
            const match = file.match(/^\.env\.([a-zA-Z0-9_-]+)$/);
            if (match && !file.endsWith('.example')) {
                const accountName = match[1];
                configs.push({
                    name: accountName,
                    envFile: join(PROJECT_ROOT, file),
                    displayName: `${accountName} (${file})`,
                });
            }
        }
    } catch (e) {
        // 忽略扫描错误
    }

    // 按名称排序
    configs.sort((a, b) => a.name.localeCompare(b.name));

    return configs;
}

/**
 * 交互式选择账号配置
 */
async function selectAccountInteractive(configs: AccountConfig[]): Promise<{ envFile: string; accountName: string }> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log('\n📋 选择账号配置:\n');

        // 显示选项
        configs.forEach((config, index) => {
            console.log(`  ${index + 1}. ${config.displayName}`);
        });
        console.log(`  ${configs.length + 1}. [默认] (.env)\n`);

        rl.question('请输入序号 (默认 1): ', (answer) => {
            rl.close();

            const choice = parseInt(answer.trim(), 10) || 1;

            if (choice > 0 && choice <= configs.length) {
                const selected = configs[choice - 1];
                resolve({
                    envFile: selected.envFile,
                    accountName: selected.name,
                });
            } else {
                // 默认 .env
                resolve({
                    envFile: join(PROJECT_ROOT, '.env'),
                    accountName: '',
                });
            }
        });
    });
}

// 加载 .env 文件
function loadEnv(envPath: string, accountName: string | null) {
    if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                if (!process.env[key]) {
                    process.env[key] = value;
                }
            }
        }
        const label = accountName ? ` [${accountName}]` : '';
        console.log(`✅ 已加载配置: ${envPath}${label}\n`);
    } else {
        console.error(`❌ 配置文件不存在: ${envPath}`);
        process.exit(1);
    }
}

// ============================================================================
// 初始化（异步）
// ============================================================================

let PORT: number = 3010;  // 默认值，会被 initConfig() 覆盖
let ACCOUNT_NAME: string = '';

async function initConfig(): Promise<void> {
    const cliArgs = parseCliArgs();

    let envFile: string;
    let accountName: string | null = cliArgs.accountName;

    if (cliArgs.envFile) {
        // 命令行指定了配置文件
        envFile = cliArgs.envFile;
    } else {
        // 扫描可用的账号配置
        const configs = scanAccountConfigs();

        if (configs.length > 0) {
            // 有多个账号配置，交互式选择
            const selected = await selectAccountInteractive(configs);
            envFile = selected.envFile;
            accountName = accountName || selected.accountName;
        } else {
            // 没有账号配置，使用默认 .env
            envFile = join(PROJECT_ROOT, '.env');
        }
    }

    // 加载配置
    loadEnv(envFile, accountName);

    // 设置全局变量
    PORT = cliArgs.port || parseInt(process.env.DASHBOARD_PORT || '3010', 10);
    ACCOUNT_NAME = accountName || process.env.ACCOUNT_NAME || '';

    // 初始化数据存储 (多账号使用独立目录)
    const dataDir = ACCOUNT_NAME ? `./data/${ACCOUNT_NAME}` : './data';
    initTaskLogger({ baseDir: `${dataDir}/logs/tasks` });
    initTaskService(`${dataDir}/tasks.json`);

    // 初始化 URL 映射 (加载缓存 + 获取 Polymarket slugs)
    await initUrlMapper();

    if (ACCOUNT_NAME) {
        console.log(`📁 数据目录: ${dataDir}`);
    }
}

// 执行初始化
await initConfig();

// ============================================================================
// 端口清理工具 (Windows)
// ============================================================================

/**
 * 杀掉占用指定端口的进程 (仅 Windows)
 */
function killProcessOnPort(port: number): boolean {
    if (process.platform !== 'win32') {
        console.log('⚠️  自动杀进程功能仅支持 Windows');
        return false;
    }

    try {
        const opportunities: ArbOpportunity[] = [];
        // 查找占用端口的进程 PID
        const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
        const lines = result.split('\n').filter(line => line.includes('LISTENING'));

        if (lines.length === 0) {
            return false;
        }

        // 提取 PID (最后一列)
        const pids = new Set<string>();
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && /^\d+$/.test(pid) && pid !== '0') {
                pids.add(pid);
            }
        }

        if (pids.size === 0) {
            return false;
        }

        // 杀掉进程
        for (const pid of pids) {
            try {
        const opportunities: ArbOpportunity[] = [];
                console.log(`🔪 正在杀掉占用端口 ${port} 的进程 (PID: ${pid})...`);
                execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf-8' });
                console.log(`✅ 进程 ${pid} 已终止`);
            } catch (e) {
                // 进程可能已经退出
            }
        }

        // 等待端口释放
        return true;
    } catch (e) {
        // 没有找到占用端口的进程
        return false;
    }
}

// ============================================================================
// API Key 轮换管理 (统一使用 SCAN_1, SCAN_2, SCAN_3 并发扫描)
// ============================================================================

type ApiKeyPurpose = 'scan' | 'trade';

class ApiKeyRotator {
    private keys: string[];
    private currentIndex: number = 0;
    private lastUsed: Map<string, number> = new Map();
    private cooldownMs: number = 1000;
    private purpose: ApiKeyPurpose;

    constructor(purpose: ApiKeyPurpose, keys?: string[]) {
        this.purpose = purpose;
        this.keys = keys || [];

        if (keys && keys.length > 0) {
            // 使用外部传入的 keys
        } else if (purpose === 'scan') {
            // 扫描用：加载 SCAN_1 到 SCAN_10 (支持多 key 轮换)
            // 支持两种命名：PREDICT_API_KEY_SCAN 或 PREDICT_API_KEY_SCAN_1
            const scan1 = process.env['PREDICT_API_KEY_SCAN_1'] || process.env['PREDICT_API_KEY_SCAN'];
            if (scan1) this.keys.push(scan1);
            for (let i = 2; i <= 10; i++) {
                const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
                if (key) this.keys.push(key);
            }

            // Fallback: 主 key
            if (this.keys.length === 0) {
                const fallbackKey = process.env['PREDICT_API_KEY'];
                if (fallbackKey) this.keys.push(fallbackKey);
            }
        } else {
            // trade: 交易专用 key
            const tradeKey = process.env['PREDICT_API_KEY_TRADE'];
            if (tradeKey) {
                this.keys.push(tradeKey);
            } else {
                const fallbackKey = process.env['PREDICT_API_KEY'];
                if (fallbackKey) this.keys.push(fallbackKey);
            }
        }

        console.log(`🔑 [${purpose.toUpperCase()}] 加载了 ${this.keys.length} 个 API Key\n`);
    }

    getNextKey(): string {
        if (this.keys.length === 0) return '';
        if (this.keys.length === 1) return this.keys[0];

        const now = Date.now();
        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.currentIndex + i) % this.keys.length;
            const key = this.keys[idx];
            const lastUse = this.lastUsed.get(key) || 0;

            if (now - lastUse >= this.cooldownMs) {
                this.currentIndex = (idx + 1) % this.keys.length;
                this.lastUsed.set(key, now);
                return key;
            }
        }

        const key = this.keys[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.keys.length;
        this.lastUsed.set(key, now);
        return key;
    }

    getKeyCount(): number {
        return this.keys.length;
    }

    getAllKeys(): string[] {
        return [...this.keys];
    }
}

// 统一扫描 key 池: SCAN_1, SCAN_2, SCAN_3 并发
const scanApiKeys = new ApiKeyRotator('scan');
// 兼容旧引用 (orderbookApiKeys 指向同一个 key 池)
const orderbookApiKeys = scanApiKeys;

// SCAN_4 备用 key (可选)
function getInactiveScanKey(): string | null {
    return process.env['PREDICT_API_KEY_SCAN_4'] || null;
}
const inactiveScanKey = getInactiveScanKey();

// 初始化阶段使用所有 SCAN keys 并行加速
function getAllScanKeys(): string[] {
    const keys: string[] = [];
    const primaryKey = process.env['PREDICT_API_KEY_SCAN'];
    if (primaryKey) keys.push(primaryKey);
    for (let i = 2; i <= 10; i++) {
        const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
        if (key) keys.push(key);
    }
    // Fallback: SCAN_4 -> 主 key (尽量避免用主 key 扫描)
    if (keys.length === 0) {
        const scan4Key = process.env['PREDICT_API_KEY_SCAN_4'];
        if (scan4Key) keys.push(scan4Key);
    }
    if (keys.length === 0) {
        const fallback = process.env['PREDICT_API_KEY'];
        if (fallback) keys.push(fallback);
    }
    return keys;
}
const apiKeyUsageCounts = new Map<string, number>();
let apiKeyUsageWindowStart = 0;
const API_KEY_LOG_INTERVAL_MS = 60000;

function maskApiKey(key: string): string {
    if (!key) return '';
    if (key.length <= 8) return key;
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function recordApiKeyUsage(apiKey: string): void {
    if (!apiKey) return;
    const now = Date.now();
    if (!apiKeyUsageWindowStart) apiKeyUsageWindowStart = now;
    apiKeyUsageCounts.set(apiKey, (apiKeyUsageCounts.get(apiKey) || 0) + 1);

    if (now - apiKeyUsageWindowStart >= API_KEY_LOG_INTERVAL_MS) {
        const entries = Array.from(apiKeyUsageCounts.entries())
            .map(([key, count]) => `${maskApiKey(key)}=${count}`)
            .join(', ');
        console.log(`[Predict API] Scan key usage (${Math.round((now - apiKeyUsageWindowStart) / 1000)}s): ${entries || 'no-keys'}`);
        apiKeyUsageCounts.clear();
        apiKeyUsageWindowStart = now;
    }
}

// Polymarket token ID 缓存
const polymarketTokenCache: Map<string, { tokenId: string; timestamp: number }> = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

// ArbOpportunity 从 types.ts 导入

// 与前端 types.ts 中的 SystemStats 保持一致
interface SystemStats {
    latency: {
        predict: number;      // ms
        polymarket: number;   // ms
    };
    connectionStatus: {
        polymarketWs: 'connected' | 'disconnected' | 'reconnecting';
        predictApi: 'ok' | 'rate_limited' | 'error';
    };
    lastFullUpdate: string;   // ISO string
    marketsMonitored: number;
    refreshInterval: number;  // ms
    arbStats: {
        makerCount: number;
        takerCount: number;
        avgProfit: number;
        maxProfit: number;
        totalDepth: number;
    };
    dataVersion: number;      // 递增版本号，用于一致性验证
}

interface MarketPair {
    predictId: number;
    predictTitle: string;
    predictQuestion: string;  // 完整事件标题
    categorySlug?: string;    // Predict event slug (用于 URL 导航)
    polymarketConditionId: string;
    polymarketSlug?: string;           // Polymarket market slug (用于 URL 导航)
    polymarketTokenId?: string;        // Legacy: 第一个 token (通常是 YES)
    polymarketNoTokenId?: string;      // NO token ID
    polymarketYesTokenId?: string;     // YES token ID
    tickSize: number;                   // 动态 tick size (0.01 或 0.001)
    feeRateBps: number;
    isInverted: boolean;
    endDate?: string;  // ISO 8601 结算时间 (从 Polymarket 获取)
    negRisk: boolean;  // Polymarket negRisk 市场标志
    predictVolume?: number;  // Predict 总成交量 (USD)
    polyVolume?: number;     // Polymarket 总成交量 (USD)
}

interface DashboardData {
    opportunities: ArbOpportunity[];
    stats: SystemStats;
}

// ============================================================================
// Data Store
// ============================================================================

let dashboardData: DashboardData = {
    opportunities: [],
    stats: {
        latency: {
            predict: 0,
            polymarket: 0,
        },
        connectionStatus: {
            polymarketWs: 'disconnected',
            predictApi: 'ok',
        },
        lastFullUpdate: new Date().toISOString(),
        marketsMonitored: 0,
        refreshInterval: 10000,
        arbStats: {
            makerCount: 0,
            takerCount: 0,
            avgProfit: 0,
            maxProfit: 0,
            totalDepth: 0,
        },
        dataVersion: 0,
    },
};

// 机会缓存：保留上次成功获取的机会数据，避免 API 限流时卡片消失
// key: `${marketId}-${side}-${strategy}`
const opportunityCache = new Map<string, ArbOpportunity>();
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5分钟后过期 (确保在全量扫描期间不丢失)

// 已知机会 ID 集合：用于判断是否是新发现的机会
// 只有首次发现时 isNew=true，后续轮询时 isNew=false
const knownOpportunityIds = new Set<string>();

function makeOpportunityKey(marketId: number, side: 'YES' | 'NO', strategy: 'MAKER' | 'TAKER'): string {
    return `${marketId}-${side}-${strategy}`;
}

// 双轨扫描：记录有套利机会的市场 ID
// - 活跃市场使用 ORDERBOOK keys 扫描
// - 非活跃市场使用 SCAN key 扫描
const activeMarketIds = new Set<number>();
const failedMarketIds = new Set<number>(); // API 失败的市场统计

// 首次扫描标志：启动后第一次扫描不发送 TG 通知，只填充缓存
let isFirstScan = true;

const startTime = Date.now();

// 平仓机会缓存（用于 SSE 推送）
let cachedCloseOpportunities: CloseOpportunity[] = [];
let lastCloseOpportunitiesUpdate = 0;

// 流动性扫描结果缓存
import type { LiquidityScanResult, MarketAnalysis } from '../scripts/market-liquidity-scan.js';
let cachedLiquidityData: LiquidityScanResult | null = null;
let lastLiquidityScanTime = 0;
let liquidityScanInProgress = false;

// SSE 客户端元数据（用于断开日志）
interface SSEClientMeta {
    ip: string;
    ua: string;
    connectedAt: number;
    initialized: boolean;  // 初始快照是否发送完毕（广播跳过未初始化客户端，避免事件交错）
    backpressured: boolean;  // 是否处于背压状态（write() 返回 false，正在等待 drain）
    drainTimeoutCount: number;  // 连续 drain 超时次数（超过阈值则断开）
    lastBackpressureLogTime: number;  // 上次背压日志时间（限流用）
    backpressureCycleCount: number;  // 本周期内背压循环次数（汇总日志用）
}
const sseClients: Map<ServerResponse, SSEClientMeta> = new Map();

// 背压配置
const BACKPRESSURE_DRAIN_TIMEOUT_MS = 3000;  // drain 等待超时时间
const BACKPRESSURE_MAX_TIMEOUT_COUNT = 3;    // 最大连续超时次数
const BACKPRESSURE_LOG_INTERVAL_MS = 10000;  // 背压日志限流间隔（10秒）

const marketPairs: MarketPair[] = [];
let polymarketWsClient: PolymarketWebSocketClient | null = null;
const POLY_WS_STALE_MS = 15000;

// Dashboard 运行资源（用于优雅关闭）
let httpServer: ReturnType<typeof createServer> | null = null;
let mainPollInterval: ReturnType<typeof setInterval> | null = null;
let polyRefreshInterval: ReturnType<typeof setInterval> | null = null;
let predictRefreshInterval: ReturnType<typeof setInterval> | null = null;
let boostRefreshInterval: ReturnType<typeof setInterval> | null = null;
const BOOST_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let wsDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsResumeTimer: ReturnType<typeof setTimeout> | null = null;
let wsPauseActive = false;
let wsPauseInProgress = false;
let lastWsHealthy: boolean | null = null;
const wsPausedTaskIds = new Set<string>();
const serialSchedulerStops: Array<() => void> = [];
let shutdownRequested = false;

/**
 * 获取 Polymarket WebSocket 客户端
 * 供其他模块获取实时订单簿
 */
export function getPolymarketWsClient(): PolymarketWebSocketClient | null {
    return polymarketWsClient;
}

function getPolymarketWsStatus(): SystemStats['connectionStatus']['polymarketWs'] {
    if (!polymarketWsClient) return 'disconnected';
    const state = polymarketWsClient.getState();
    if (state === 'connected') return 'connected';
    if (state === 'connecting' || state === 'reconnecting') return 'reconnecting';
    return 'disconnected';
}

function isWsHealthy(): boolean {
    const requirePredictWs = usePredictWsMode;
    const requirePolyWs = POLY_ORDERBOOK_SOURCE !== 'rest';
    const predictOk = !requirePredictWs || (getPredictOrderbookCache()?.isWsConnected() ?? false);
    const polyOk = !requirePolyWs || (polymarketWsClient?.isConnected() ?? false);
    return Boolean(predictOk && polyOk);
}

/**
 * 检查 WS 物理连接是否健康（双边判定）
 * 仅检查连接状态，不检查数据新鲜度
 * WS-only 模式下：Predict + Polymarket 都要在线
 */
function isWsConnectionHealthy(): boolean {
    if (!usePredictWsMode) return true;

    // Predict WS 连接检查
    const cache = getPredictOrderbookCache();
    const predictConnected = cache?.isWsConnected() ?? false;

    // Polymarket WS 连接检查
    const polyConnected = polymarketWsClient?.isConnected() ?? false;

    // 双边都要在线
    return predictConnected && polyConnected;
}

/**
 * 检查特定市场的 Predict 订单簿是否新鲜 (用于计算)
 * @param marketId 市场 ID
 * @param maxAgeMs 最大允许年龄 (默认 CALC_ORDERBOOK_STALE_MS = 10s)
 */
function isPredictOrderbookFreshForCalc(marketId: number, maxAgeMs: number = CALC_ORDERBOOK_STALE_MS): boolean {
    const lastUpdate = lastWsUpdateByMarket.get(marketId);
    if (!lastUpdate) return false;
    return (Date.now() - lastUpdate) < maxAgeMs;
}

/**
 * 检查特定 token 的 Polymarket 订单簿是否新鲜 (用于计算)
 * @param tokenId Token ID
 * @param maxAgeMs 最大允许年龄 (默认 CALC_ORDERBOOK_STALE_MS = 10s)
 */
function isPolymarketOrderbookFreshForCalc(tokenId: string, maxAgeMs: number = CALC_ORDERBOOK_STALE_MS): boolean {
    const lastUpdate = lastPolyWsUpdateByToken.get(tokenId);
    if (!lastUpdate) return false;
    return (Date.now() - lastUpdate) < maxAgeMs;
}

/**
 * 检查市场双边订单簿是否都新鲜 (用于计算/交易)
 * 严格 10s 过期，防止用过期数据计算利润
 */
function isMarketDataFreshForCalc(marketId: number, tokenId: string): boolean {
    return isPredictOrderbookFreshForCalc(marketId) && isPolymarketOrderbookFreshForCalc(tokenId);
}

// Hybrid 兜底轮询定时器
let hybridFallbackInterval: ReturnType<typeof setInterval> | null = null;

/**
 * 启动 Hybrid 兜底轮询
 * 当 WS 不健康时，用 REST 轮询 Predict 订单簿
 */
function startHybridFallback(): void {
    if (hybridFallbackInterval || !HYBRID_FALLBACK_ENABLED) return;
    hybridFallbackActive = true;
    console.warn(`[Hybrid] 启动 REST 兜底轮询 (间隔 ${HYBRID_FALLBACK_INTERVAL_MS}ms)`);

    hybridFallbackInterval = setInterval(async () => {
        if (!hybridFallbackActive || shutdownRequested) return;
        try {
            const cache = getPredictOrderbookCache();
            if (!cache) return;

            // 批量刷新活跃市场的订单簿
            const activeIds = Array.from(activeMarketIds).slice(0, 50);  // 限制数量
            const BATCH_SIZE = 5;
            for (let i = 0; i < activeIds.length; i += BATCH_SIZE) {
                const batch = activeIds.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(id => cache.getOrderbook(id).catch(() => null)));
            }
        } catch {
            // 静默失败
        }
    }, HYBRID_FALLBACK_INTERVAL_MS);
}

/**
 * 停止 Hybrid 兜底轮询
 */
function stopHybridFallback(): void {
    if (!hybridFallbackInterval) return;
    clearInterval(hybridFallbackInterval);
    hybridFallbackInterval = null;
    hybridFallbackActive = false;
    console.log(`[Hybrid] 停止 REST 兜底轮询 (WS 已恢复)`);
}

async function pauseTasksForWsDisconnect(): Promise<void> {
    if (wsPauseInProgress || wsPauseActive) return;
    wsPauseInProgress = true;
    try {
        const pausedIds = await taskExecutor.pauseTasks('WS disconnected', { concurrency: 4, timeoutMs: 60000 });
        for (const id of pausedIds) wsPausedTaskIds.add(id);
        if (pausedIds.length > 0) {
            wsPauseActive = true;
            console.warn(`[WS Health] 已暂停 ${pausedIds.length} 个任务 (WS 断连超过 ${WS_DISCONNECT_PAUSE_MS}ms)`);
        }
    } catch (error: any) {
        console.warn(`[WS Health] 暂停任务失败: ${error?.message || error}`);
    } finally {
        wsPauseInProgress = false;
    }
}

async function resumeTasksAfterWsReconnect(): Promise<void> {
    if (wsPauseInProgress || !wsPauseActive) return;
    wsPauseInProgress = true;
    try {
        const taskIds = Array.from(wsPausedTaskIds);
        if (taskIds.length === 0) {
            wsPausedTaskIds.clear();
            wsPauseActive = false;
            return;
        }

        // WS-only 激进模式：恢复时只看连接状态，不检查数据新鲜度
        // WS 重连后数据会自然通过 WS 推送更新，无需等待
        console.log(`[WS Health] WS 双边连接已恢复，恢复 ${taskIds.length} 个任务...`);

        const resumedIds: string[] = [];

        for (const taskId of taskIds) {
            try {
                const task = taskService.getTask(taskId);
                if (!task) {
                    wsPausedTaskIds.delete(taskId);
                    continue;
                }

                // 直接恢复任务，不检查数据新鲜度
                await taskExecutor.resumeTask(taskId);
                wsPausedTaskIds.delete(taskId);
                resumedIds.push(taskId);
            } catch (error: any) {
                console.warn(`[WS Health] 恢复任务 ${taskId} 失败: ${error?.message || error}`);
            }
        }

        if (resumedIds.length > 0) {
            console.log(`[WS Health] 已恢复 ${resumedIds.length} 个任务`);
        }

        // 清除标志
        wsPausedTaskIds.clear();
        wsPauseActive = false;
    } finally {
        wsPauseInProgress = false;
    }
}

async function handleWsHealthCheck(): Promise<void> {
    // 仅检查 WS 物理连接状态，不检查数据新鲜度
    // 数据新鲜度在计算入口单独检查，避免"市场静默"被误判为断连
    const connected = isWsConnectionHealthy();

    if (lastWsHealthy === null) {
        lastWsHealthy = connected;
    }

    // 更新连接状态变量
    predictWsConnected = connected;
    if (connected) {
        predictWsDisconnectedAt = 0;
    } else if (predictWsDisconnectedAt === 0) {
        predictWsDisconnectedAt = Date.now();
    }

    // Hybrid 兜底逻辑：WS 断连时启用 REST 轮询（仅用于保持缓存，不用于计算）
    if (!connected && HYBRID_FALLBACK_ENABLED && !hybridFallbackActive) {
        startHybridFallback();
    } else if (connected && hybridFallbackActive) {
        stopHybridFallback();
    }

    // 任务暂停/恢复逻辑（基于连接状态）
    if (connected) {
        // WS 连接正常
        if (wsDisconnectTimer) {
            clearTimeout(wsDisconnectTimer);
            wsDisconnectTimer = null;
        }
        if (wsPauseActive && !wsResumeTimer) {
            wsResumeTimer = setTimeout(() => {
                wsResumeTimer = null;
                resumeTasksAfterWsReconnect().catch(() => { /* ignore */ });
            }, WS_RECONNECT_RESUME_DELAY_MS);
        }
    } else {
        // WS 断连
        if (wsResumeTimer) {
            clearTimeout(wsResumeTimer);
            wsResumeTimer = null;
        }
        if (!wsDisconnectTimer) {
            wsDisconnectTimer = setTimeout(() => {
                wsDisconnectTimer = null;
                pauseTasksForWsDisconnect().catch(() => { /* ignore */ });
            }, WS_DISCONNECT_PAUSE_MS);
        }
    }

    // 状态变化时输出日志
    if (lastWsHealthy !== connected) {
        if (connected) {
            console.log(`[WS Health] ✅ WS 连接恢复`);
        } else {
            console.warn(`[WS Health] ⚠️ WS 连接断开`);
        }
    }

    lastWsHealthy = connected;
}

// Task Service 和 Executor 实例
const taskService = getTaskService();
const taskExecutor = getTaskExecutor();

// Telegram 通知实例 (懒加载)
let telegramNotifier: TelegramNotifier | null = null;
function getTelegramNotifier(): TelegramNotifier | null {
    if (telegramNotifier) return telegramNotifier;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
        telegramNotifier = createTelegramNotifier({
            botToken: token,
            chatId: chatId,
            enabled: true,
        });
    }
    return telegramNotifier;
}

// ============================================================================
// 全局敞口检测 (Exposure Alert)
// ============================================================================
let lastPinnedMessageId: number | null = null;
const EXPOSURE_CHECK_INTERVAL_MS = 30_000; // 每 30s 轮询一次
const EXPOSURE_THRESHOLD = 10; // shares 阈值

/**
 * 定时轮询全局敞口（每 30s 一次）
 * 避免在成交事件瞬间检测导致对冲尚未完成时误报
 */
function startExposureMonitor(): void {
    setInterval(() => {
        const activeTasks = taskService.getTasks(); // 默认过滤终态
        let totalExposure = 0;
        const exposedTasks: { id: string; title: string; exposure: number; predictFilled: number; hedged: number }[] = [];

        for (const t of activeTasks) {
            const exposure = (t.predictFilledQty || 0) - (t.hedgedQty || 0);
            if (exposure > 0) {
                totalExposure += exposure;
                exposedTasks.push({
                    id: t.id,
                    title: t.title,
                    exposure,
                    predictFilled: t.predictFilledQty || 0,
                    hedged: t.hedgedQty || 0,
                });
            }
        }

        if (totalExposure <= EXPOSURE_THRESHOLD) return;

        const now = Date.now();

        // 1. SSE 广播到前端
        broadcastSSEGlobal('exposureAlert', JSON.stringify({
            totalExposure,
            tasks: exposedTasks,
            timestamp: now,
        }));

        // 2. Telegram 置顶消息
        sendExposureTelegramAlert(totalExposure, exposedTasks);
    }, EXPOSURE_CHECK_INTERVAL_MS);

    console.log(`✅ 敞口监控已启动 (每 ${EXPOSURE_CHECK_INTERVAL_MS / 1000}s 轮询, 阈值 ${EXPOSURE_THRESHOLD} shares)\n`);
}

async function sendExposureTelegramAlert(
    totalExposure: number,
    exposedTasks: { id: string; title: string; exposure: number; predictFilled?: number; hedged?: number }[],
): Promise<void> {
    const tg = getTelegramNotifier();
    if (!tg) return;

    const lines = [
        `🚨 <b>敞口预警: ${totalExposure.toFixed(1)} shares 未对冲</b>`,
        ``,
        `时间: ${new Date().toLocaleString('zh-CN')}`,
        ``,
    ];
    for (const t of exposedTasks) {
        lines.push(`• <b>${t.title.slice(0, 30)}</b>: ${t.exposure.toFixed(1)} shares (成交${(t.predictFilled ?? 0).toFixed(0)}/对冲${(t.hedged ?? 0).toFixed(0)})`);
    }

    // 取消上一条置顶
    if (lastPinnedMessageId) {
        await tg.unpinMessage(lastPinnedMessageId);
    }
    lastPinnedMessageId = await tg.sendAndPin(lines.join('\n'));
}

// ============================================================================
// JSON Body 解析辅助函数
// ============================================================================

async function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
        const opportunities: ArbOpportunity[] = [];
                resolve(JSON.parse(body) as T);
            } catch (e) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

// ============================================================================
// SSE 安全写入 (模块级，处理背压)
// ============================================================================

/**
 * 等待 writable stream 的 drain 事件
 * @param stream 可写流
 * @param timeoutMs 超时时间（默认 30 秒）
 * @returns Promise<boolean> true 如果 drain 成功，false 如果超时或流关闭
 */
function waitForDrain(stream: ServerResponse, timeoutMs = 30000): Promise<boolean> {
    return new Promise((resolve) => {
        if (stream.writableEnded || stream.destroyed) {
            resolve(false);
            return;
        }

        const cleanup = () => {
            clearTimeout(timer);
            stream.removeListener('drain', onDrain);
            stream.removeListener('close', onClose);
            stream.removeListener('error', onClose);
        };

        const onDrain = () => {
            cleanup();
            resolve(true);
        };

        const onClose = () => {
            cleanup();
            resolve(false);
        };

        const timer = setTimeout(() => {
            cleanup();
            resolve(false);
        }, timeoutMs);

        stream.once('drain', onDrain);
        stream.once('close', onClose);
        stream.once('error', onClose);
    });
}

/**
 * 异步安全写入 SSE 数据（支持 drain 等待）
 * 用于初始快照发送，允许等待背压恢复
 * @param client SSE 客户端
 * @param message 完整的 SSE 消息
 * @param eventName 事件名（用于日志）
 * @returns Promise<boolean> true 如果写入成功
 */
async function safeSSEWriteAsync(client: ServerResponse, message: string, eventName: string): Promise<boolean> {
    const meta = sseClients.get(client);
    const msgSize = Buffer.byteLength(message, 'utf8');
    const connDuration = meta ? Math.round((Date.now() - meta.connectedAt) / 1000) : 0;
    const logPrefix = `[SSE] 客户端断开 - ip=${meta?.ip || 'unknown'}, ua=${meta?.ua || 'unknown'}, event=${eventName}, msgSize=${msgSize}B, connDuration=${connDuration}s`;

    try {
        if (client.writableEnded || client.destroyed) {
            console.warn(`${logPrefix}, reason=stream_closed`);
            sseClients.delete(client);
            return false;
        }

        const canContinue = client.write(message);
        if (!canContinue) {
            // 遇到背压，等待 drain 事件
            const drained = await waitForDrain(client);
            if (!drained) {
                console.warn(`${logPrefix}, reason=drain_timeout`);
                sseClients.delete(client);
                try { client.end(); } catch {}
                return false;
            }
        }
        return true;
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error && e.stack
            ? '\n' + e.stack.split('\n').slice(0, 3).join('\n')
            : '';
        console.warn(`${logPrefix}, reason=exception, error=${errMsg}${stack}`);
        sseClients.delete(client);
        try { client.end(); } catch {}
        return false;
    }
}

/**
 * 安全地向 SSE 客户端写入数据（模块级，同步版本）
 * 策略：遇到背压时标记客户端并启动异步 drain 等待，不立即断开
 * @param client SSE 客户端
 * @param message 完整的 SSE 消息（含 event: 和 data:）
 * @param eventName 事件名（用于日志）
 * @param precomputedMsgSize 预计算的消息大小（可选，仅限广播场景传入以避免重复计算）
 * @returns true 如果写入成功，false 如果客户端被移除或正在背压中
 */
function safeSSEWriteGlobal(client: ServerResponse, message: string, eventName: string, precomputedMsgSize?: number): boolean {
    const meta = sseClients.get(client);
    if (!meta) return false;

    const msgSize = precomputedMsgSize ?? Buffer.byteLength(message, 'utf8');
    const connDuration = Math.round((Date.now() - meta.connectedAt) / 1000);
    const logPrefix = `[SSE] ip=${meta.ip}, ua=${meta.ua}, event=${eventName}, msgSize=${msgSize}B, connDuration=${connDuration}s`;

    // 如果客户端正在背压等待中，跳过本次写入（避免缓冲区进一步堆积）
    if (meta.backpressured) {
        // 不打日志，避免刷屏（背压期间可能有多次广播被跳过）
        return false;
    }

    try {
        const canContinue = client.write(message);
        if (!canContinue) {
            // 遇到背压：标记状态并启动异步 drain 等待
            meta.backpressured = true;
            meta.backpressureCycleCount++;

            // 限流日志：每 10 秒打印一次汇总
            const now = Date.now();
            if (now - meta.lastBackpressureLogTime >= BACKPRESSURE_LOG_INTERVAL_MS) {
                if (meta.backpressureCycleCount > 1) {
                    console.log(`${logPrefix}, status=backpressure, cycles=${meta.backpressureCycleCount} in ${Math.round((now - meta.lastBackpressureLogTime) / 1000)}s`);
                } else {
                    console.log(`${logPrefix}, status=backpressure_start`);
                }
                meta.lastBackpressureLogTime = now;
                meta.backpressureCycleCount = 0;
            }

            // 启动异步 drain 等待（不阻塞当前调用）
            handleBackpressureDrain(client, meta, logPrefix);
            return false;
        }
        return true;
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error && e.stack
            ? '\n' + e.stack.split('\n').slice(0, 3).join('\n')
            : '';
        console.warn(`${logPrefix}, status=exception, error=${errMsg}${stack}`);
        sseClients.delete(client);
        try { client.end(); } catch {}
        return false;
    }
}

/**
 * 处理背压状态的 drain 等待（异步，不阻塞调用者）
 * @param client SSE 客户端
 * @param meta 客户端元数据
 * @param logPrefix 日志前缀
 */
function handleBackpressureDrain(client: ServerResponse, meta: SSEClientMeta, logPrefix: string): void {
    waitForDrain(client, BACKPRESSURE_DRAIN_TIMEOUT_MS).then((drained) => {
        // 检查客户端是否仍然存在（可能在等待期间被关闭）
        if (!sseClients.has(client)) return;

        if (drained) {
            // drain 成功：恢复正常状态（静默，仅在汇总日志中体现）
            meta.backpressured = false;
            meta.drainTimeoutCount = 0;
        } else {
            // drain 超时：累加超时计数
            meta.drainTimeoutCount++;
            console.warn(`${logPrefix}, status=drain_timeout, timeoutCount=${meta.drainTimeoutCount}/${BACKPRESSURE_MAX_TIMEOUT_COUNT}`);

            if (meta.drainTimeoutCount >= BACKPRESSURE_MAX_TIMEOUT_COUNT) {
                // 连续多次超时，断开连接
                console.warn(`${logPrefix}, status=disconnected, reason=max_drain_timeout_exceeded`);
                sseClients.delete(client);
                try { client.end(); } catch {}
            } else {
                // 未达到阈值，保持背压状态，等待下一次写入尝试时重新触发 drain 等待
                // 或者立即重新启动 drain 等待
                handleBackpressureDrain(client, meta, logPrefix);
            }
        }
    });
}

/**
 * 异步向单个 SSE 客户端发送事件（支持 drain 等待）
 * 用于初始快照推送，允许等待背压恢复
 * @param client SSE 客户端
 * @param eventName 事件名
 * @param data JSON 数据字符串
 * @returns Promise<boolean> true 如果写入成功
 */
async function sendSSEToClientAsync(client: ServerResponse, eventName: string, data: string): Promise<boolean> {
    const message = `event: ${eventName}\ndata: ${data}\n\n`;
    return safeSSEWriteAsync(client, message, eventName);
}

/**
 * 向单个 SSE 客户端发送事件（同步版本，带背压检测）
 * 用于广播场景
 * @param client SSE 客户端
 * @param eventName 事件名
 * @param data JSON 数据字符串
 * @returns true 如果写入成功，false 如果客户端被移除
 */
function sendSSEToClient(client: ServerResponse, eventName: string, data: string): boolean {
    const message = `event: ${eventName}\ndata: ${data}\n\n`;
    return safeSSEWriteGlobal(client, message, eventName);
}

/**
 * 检查 SSE 客户端是否仍可写入
 * 用于在昂贵计算（如 API 调用）之前快速判断是否需要继续
 * @param client SSE 客户端
 * @returns true 如果客户端仍可写入
 */
function isSSEClientAlive(client: ServerResponse): boolean {
    return !client.writableEnded && !client.destroyed && sseClients.has(client);
}

/**
 * 异步分片发送大数组数据到单个 SSE 客户端（支持 drain 等待）
 * 用于初始快照推送，允许等待背压恢复
 * @param client SSE 客户端
 * @param items 要发送的数组
 * @param batchSize 每批大小（默认 30）
 * @returns Promise<boolean> true 如果全部发送成功
 */
async function sendOpportunityBatchesAsync<T>(client: ServerResponse, items: T[], batchSize = 30): Promise<boolean> {
    const total = items.length;
    for (let offset = 0; offset < total; offset += batchSize) {
        const batch = items.slice(offset, offset + batchSize);
        const done = offset + batchSize >= total;
        const payload = JSON.stringify({ items: batch, offset, total, done });
        if (!await sendSSEToClientAsync(client, 'opportunity-batch', payload)) {
            return false;
        }
    }
    // 发送空数组时也要发一个 done 包
    if (total === 0) {
        const payload = JSON.stringify({ items: [], offset: 0, total: 0, done: true });
        if (!await sendSSEToClientAsync(client, 'opportunity-batch', payload)) {
            return false;
        }
    }
    return true;
}

/**
 * 分片发送大数组数据到单个 SSE 客户端（同步版本）
 * 将大数组拆分成多个小批次发送，用于广播场景
 * @param client SSE 客户端
 * @param items 要发送的数组
 * @param batchSize 每批大小（默认 30）
 * @returns true 如果全部发送成功，false 如果客户端被移除
 */
function sendOpportunityBatches<T>(client: ServerResponse, items: T[], batchSize = 30): boolean {
    const total = items.length;
    for (let offset = 0; offset < total; offset += batchSize) {
        const batch = items.slice(offset, offset + batchSize);
        const done = offset + batchSize >= total;
        const payload = JSON.stringify({ items: batch, offset, total, done });
        if (!sendSSEToClient(client, 'opportunity-batch', payload)) {
            return false;
        }
    }
    // 发送空数组时也要发一个 done 包
    if (total === 0) {
        const payload = JSON.stringify({ items: [], offset: 0, total: 0, done: true });
        if (!sendSSEToClient(client, 'opportunity-batch', payload)) {
            return false;
        }
    }
    return true;
}

/**
 * 广播 SSE 消息到所有客户端（模块级）
 * 预计算消息大小，避免每个客户端重复计算 Buffer.byteLength
 * 跳过尚未完成初始快照的客户端，确保"先完整快照、后增量广播"的事件顺序
 */
function broadcastSSEGlobal(eventName: string, data: string): void {
    const message = `event: ${eventName}\ndata: ${data}\n\n`;
    const msgSize = Buffer.byteLength(message, 'utf8');
    for (const [client, meta] of sseClients.entries()) {
        // 跳过尚未完成初始快照的客户端（避免事件交错）
        if (!meta.initialized) continue;
        safeSSEWriteGlobal(client, message, eventName, msgSize);
    }
}

// ============================================================================
// Task SSE 广播
// ============================================================================

function broadcastTaskUpdate(task: Task): void {
    const data = JSON.stringify(task);
    broadcastSSEGlobal('task', data);
}

function broadcastTaskDeleted(taskId: string): void {
    const data = JSON.stringify({ id: taskId, deleted: true });
    broadcastSSEGlobal('taskDeleted', data);
}

/**
 * 广播 BSC 链上订单成交事件（用于前端可观测性）
 */
function broadcastBscOrderFilled(payload: {
    type: 'bscOrderFilled';
    event: BscOrderFilledEvent;
    tokenId: string;
    marketId?: number;
    marketTitle?: string;
    side?: string;  // YES/NO 或多选市场的 outcome 名称
}): void {
    broadcastSSEGlobal('bscOrderFilled', JSON.stringify(payload));
}

/**
 * 广播 Predict 钱包事件（订单生命周期：created/accepted/filled/cancelled）
 */
function broadcastPredictWalletEvent(payload: {
    type: 'predictWalletEvent';
    event: WalletEventData;
    marketId?: number;
    marketTitle?: string;
}): void {
    broadcastSSEGlobal('predictWalletEvent', JSON.stringify(payload));
}

// ============================================================================
// 统一 SSE 广播调度器 (200ms 节流)
// 所有面板数据通过 markDirty() 标记，统一 flush 广播，避免乱序
// ============================================================================

type BroadcastChannel =
    | 'opportunity'
    | 'stats'
    | 'markets'
    | 'tasks'
    | 'sports'
    | 'closeOpportunities'
    | 'accounts';

const BROADCAST_THROTTLE_MS = 200;  // 200ms 节流间隔 (减少背压)
const SPORTS_RECOMPUTE_THROTTLE_MS = 200;  // 体育重算节流
const CLOSE_RECOMPUTE_THROTTLE_MS = 200;   // 平仓重算节流

const dirtyFlags = new Set<BroadcastChannel>();
const pendingPayloads = new Map<BroadcastChannel, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 标记通道为 dirty 并缓存 payload
 * 调度器会在 200ms 内批量 flush 所有 dirty 通道
 */
function markDirty(channel: BroadcastChannel, payload: string): void {
    pendingPayloads.set(channel, payload);
    dirtyFlags.add(channel);
    scheduleFlush();
}

/**
 * 调度 flush (200ms 节流)
 */
function scheduleFlush(): void {
    if (flushTimer) return;  // 已有定时器，等待 flush
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushBroadcast();
    }, BROADCAST_THROTTLE_MS);
}

/**
 * 批量 flush 所有 dirty 通道
 */
function flushBroadcast(): void {
    for (const channel of dirtyFlags) {
        const payload = pendingPayloads.get(channel);
        if (payload !== undefined) {
            broadcastSSEGlobal(channel, payload);
        }
    }
    dirtyFlags.clear();
}

// ============================================================================
// 节流重算工具 (Sports / Close)
// ============================================================================

let sportsRecomputeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 节流触发体育市场重算 (200ms 节流)
 * WS 更新时调用，实际触发 refreshPredictOrderbooks → rebuildMarketsFromCache
 */
function scheduleSportsRecompute(): void {
    if (sportsRecomputeTimer) return;
    sportsRecomputeTimer = setTimeout(async () => {
        sportsRecomputeTimer = null;
        try {
            const sportsService = getSportsService();
            if (sportsService) {
                // 触发实际重算（从 WS 缓存读取 → 重建机会）
                await sportsService.refreshPredictOrderbooks();
            }
            const sportsData = JSON.stringify(sportsService?.getSSEData() ?? { markets: [], opportunities: [] });
            markDirty('sports', sportsData);
        } catch {
            // 忽略错误
        }
    }, SPORTS_RECOMPUTE_THROTTLE_MS);
}

let closeRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
let closeRecomputeForce = false;

/**
 * 节流触发平仓机会重算 (200ms 节流)
 * WS 更新时调用，实际触发 calculateCloseOpportunities
 */
function scheduleCloseRecompute(forcePositionsRefresh: boolean = false): void {
    if (forcePositionsRefresh) closeRecomputeForce = true;
    if (closeRecomputeTimer) return;
    closeRecomputeTimer = setTimeout(async () => {
        closeRecomputeTimer = null;
        const shouldForce = closeRecomputeForce;
        closeRecomputeForce = false;
        try {
            cachedCloseOpportunities = await calculateCloseOpportunities(shouldForce);
            lastCloseOpportunitiesUpdate = Date.now();
            markDirty('closeOpportunities', JSON.stringify(cachedCloseOpportunities));
        } catch {
            markDirty('closeOpportunities', JSON.stringify(cachedCloseOpportunities));
        }
    }, CLOSE_RECOMPUTE_THROTTLE_MS);
}


// ============================================================================
// Polymarket WebSocket + 增量更新
// ============================================================================

// Predict 订单簿缓存（legacy 模式用于 REST 轮询）
const predictOrderbookCacheLegacy = new Map<number, { bids: OrderBookLevel[]; asks: OrderBookLevel[]; timestamp: number }>();
const PREDICT_CACHE_TTL_MS = 2000;  // 2秒缓存有效期（主轮询 1 秒，留 1 秒容错）

// 运行时模式标记（在 main() 中设置）
let usePredictWsMode = false;

/**
 * 获取 Predict 订单簿缓存（供 PredictTrader 使用）
 * 返回格式: { bids: [[price, size], ...], asks: [[price, size], ...] }
 *
 * WS 模式: 从统一 PredictOrderbookCache 读取
 * Legacy 模式: 从本地 Map 读取
 */
function getPredictOrderbookFromCache(marketId: number): { bids: [number, number][]; asks: [number, number][] } | null {
    // WS 模式: 使用统一缓存
    if (usePredictWsMode) {
        const unifiedCache = getPredictOrderbookCache();
        if (!unifiedCache) return null;

        const cached = unifiedCache.getOrderbookSync(marketId);
        if (!cached) return null;
        if (!isFirstScan && cached.source === 'rest') return null;

        // 转换为 [price, size] 元组格式
        const bids = cached.bids.map(l => [l.price, l.size] as [number, number]);
        const asks = cached.asks.map(l => [l.price, l.size] as [number, number]);
        return { bids, asks };
    }

    // Legacy 模式: 使用本地缓存
    const cached = predictOrderbookCacheLegacy.get(marketId);
    if (!cached) return null;

    // 检查缓存有效期
    if (Date.now() - cached.timestamp > PREDICT_CACHE_TTL_MS) {
        return null;
    }

    // 转换为 [price, size] 元组格式
    const bids = cached.bids.map(l => [l.price, l.size] as [number, number]);
    const asks = cached.asks.map(l => [l.price, l.size] as [number, number]);

    return { bids, asks };
}

/**
 * 获取 Predict 订单簿缓存（供 close-service 使用）
 * 返回格式: { bids: [{price, size}, ...], asks: [{price, size}, ...] }
 *
 * WS 模式: 从统一 PredictOrderbookCache 读取
 * Legacy 模式: 从本地 Map 读取
 */
function getPredictOrderbookForCloseService(marketId: number): { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null {
    // WS 模式: 使用统一缓存
    if (usePredictWsMode) {
        const unifiedCache = getPredictOrderbookCache();
        if (!unifiedCache) return null;

        const cached = unifiedCache.getOrderbookSync(marketId);
        if (!cached) return null;
        if (!isFirstScan && cached.source === 'rest') return null;

        // 转换为对象格式
        return {
            bids: cached.bids.map(l => ({ price: l.price, size: l.size })),
            asks: cached.asks.map(l => ({ price: l.price, size: l.size })),
        };
    }

    // Legacy 模式: 使用本地缓存
    const cached = predictOrderbookCacheLegacy.get(marketId);
    if (!cached) return null;

    // 检查缓存有效期
    if (Date.now() - cached.timestamp > PREDICT_CACHE_TTL_MS) {
        return null;
    }

    // 直接返回对象格式（与缓存格式相同）
    return { bids: cached.bids, asks: cached.asks };
}

// tokenId → marketPair 索引（启动时构建）
const tokenIdToMarketPair = new Map<string, MarketPair>();

function buildTokenIdIndex(): void {
    tokenIdToMarketPair.clear();
    for (const pair of marketPairs) {
        if (pair.polymarketTokenId) {
            tokenIdToMarketPair.set(pair.polymarketTokenId, pair);
        }
    }
}

// WS 订单簿更新节流：接近实时推送
let lastWsUpdateBroadcast = 0;
const WS_UPDATE_THROTTLE_MS = 50;  // 50ms 节流（接近实时）

/**
 * 获取 Predict 订单簿（用于 WS 增量更新）
 * 支持 WS 模式和 Legacy 模式
 */
function getPredictOrderbookForWsUpdate(marketId: number): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null {
    if (usePredictWsMode) {
        const unifiedCache = getPredictOrderbookCache();
        if (!unifiedCache) return null;

        const cached = unifiedCache.getOrderbookSync(marketId);
        if (!cached) return null;
        if (!isFirstScan && cached.source === 'rest') return null;

        return {
            bids: cached.bids.map(l => ({ price: l.price, size: l.size })),
            asks: cached.asks.map(l => ({ price: l.price, size: l.size })),
        };
    }

    // Legacy 模式
    const cached = predictOrderbookCacheLegacy.get(marketId);
    if (!cached || Date.now() - cached.timestamp > PREDICT_CACHE_TTL_MS) {
        return null;
    }
    return { bids: cached.bids, asks: cached.asks };
}

/**
 * 处理 Polymarket WS 订单簿更新，增量更新对应市场的套利机会
 * - 记录 Polymarket WS 更新时间戳
 * - profit > 0 时更新机会
 * - profit <= 0 时清除机会（避免残留"幽灵机会"）
 */
/**
 * 从 depth 计算结果构建 ArbOpportunity 对象
 * 用于 WS 更新时创建新机会（复用扫描构造逻辑）
 */
function buildOpportunityFromDepth(
    pair: MarketPair,
    depth: DepthResult | NoSideDepthResult,
    side: 'YES' | 'NO',
    strategy: 'MAKER' | 'TAKER',
    nowOverride?: number
): ArbOpportunity {
    const now = nowOverride ?? Date.now();
    const profitPercent = strategy === 'MAKER'
        ? (depth as DepthResult).makerProfit * 100
        : depth.takerProfit * 100;
    const riskLevel = profitPercent > 2 ? 'LOW' : profitPercent > 1 ? 'MEDIUM' : 'HIGH';
    const maxQuantity = strategy === 'MAKER'
        ? (depth as DepthResult).makerMaxQuantity
        : depth.takerMaxQuantity;
    const totalCost = strategy === 'MAKER'
        ? (depth as DepthResult).makerCost
        : depth.takerCost;

    // YES 端使用 DepthResult, NO 端使用 NoSideDepthResult
    const isYes = side === 'YES';
    const yesDepth = depth as DepthResult;
    const noDepth = depth as NoSideDepthResult;
    const predictPrice = isYes
        ? (strategy === 'MAKER' ? yesDepth.predictYesBid : yesDepth.predictYesAsk)
        : (strategy === 'MAKER' ? noDepth.predictNoBid : noDepth.predictNoAsk);

    return {
        marketId: pair.predictId,
        title: pair.predictQuestion,
        strategy,
        side,
        profitPercent,
        maxQuantity,
        estimatedProfit: (profitPercent / 100) * maxQuantity,
        predictPrice,
        predictBid: isYes ? yesDepth.predictYesBid : noDepth.predictNoBid,
        predictAsk: isYes ? yesDepth.predictYesAsk : noDepth.predictNoAsk,
        polymarketPrice: isYes ? yesDepth.polymarketNoAsk : noDepth.polymarketYesAsk,
        totalCost,
        makerCost: +((depth as DepthResult).makerCost * 100).toFixed(2),
        takerCost: +(depth.takerCost * 100).toFixed(2),
        depth: {
            predict: isYes
                ? (strategy === 'MAKER' ? yesDepth.predictYesBidDepth : yesDepth.predictYesAskDepth)
                : (depth as NoSideDepthResult).predictYesBidDepth,  // NO ask depth = YES bid depth
            polymarket: isYes ? yesDepth.polymarketNoAskDepth : (depth as NoSideDepthResult).polymarketNoBidDepth,  // YES ask depth = NO bid depth
            polymarketNoAskDepth: isYes ? yesDepth.polymarketNoAskDepth : (depth as NoSideDepthResult).polymarketNoBidDepth,
            predictAskDepth: isYes ? yesDepth.predictYesAskDepth : (depth as NoSideDepthResult).predictYesBidDepth,  // NO ask depth
            predictBidDepth: isYes ? yesDepth.predictYesBidDepth : (depth as NoSideDepthResult).predictYesAskDepth,  // NO bid depth
        },
        lastUpdate: now,
        isInverted: pair.isInverted,
        isNew: true,  // 标记为新机会

        // 执行必需字段
        polymarketConditionId: pair.polymarketConditionId,
        polymarketSlug: getPolymarketSlug(pair.polymarketConditionId) || pair.polymarketSlug,
        predictSlug: pair.categorySlug || getPredictSlug(pair.predictId) || generatePredictSlug(pair.predictQuestion),
        polymarketNoTokenId: pair.polymarketNoTokenId || '',
        polymarketYesTokenId: pair.polymarketYesTokenId || '',
        tickSize: pair.tickSize,
        feeRateBps: pair.feeRateBps,
        negRisk: pair.negRisk,

        // 风险和费用
        risk: {
            level: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
            slippage: 0.5,
        },
        fees: {
            predict: (depth as DepthResult).predictFee || 0,
            gas: 0.01,
        },
        costs: {
            total: totalCost,
        },
        endDate: pair.endDate,
        predictVolume: pair.predictVolume,
        polyVolume: pair.polyVolume,
    };
}

function removeOpportunityByKey(marketId: number, side: 'YES' | 'NO', strategy: 'MAKER' | 'TAKER'): void {
    const key = makeOpportunityKey(marketId, side, strategy);
    const index = dashboardData.opportunities.findIndex(o => o.marketId === marketId && o.side === side && o.strategy === strategy);
    if (index >= 0) {
        dashboardData.opportunities.splice(index, 1);
        opportunityCache.delete(key);
    }

    if (!dashboardData.opportunities.some(o => o.marketId === marketId)) {
        activeMarketIds.delete(marketId);
    }
}

function upsertOpportunityFromDepth(
    pair: MarketPair,
    depth: DepthResult | NoSideDepthResult,
    side: 'YES' | 'NO',
    strategy: 'MAKER' | 'TAKER',
    now: number
): void {
    const profit = strategy === 'MAKER'
        ? (depth as DepthResult).makerProfit
        : depth.takerProfit;

    if (!profit || profit <= 0) {
        removeOpportunityByKey(pair.predictId, side, strategy);
        return;
    }

    const key = makeOpportunityKey(pair.predictId, side, strategy);
    const newOpp = buildOpportunityFromDepth(pair, depth, side, strategy, now);
    const isNewOpportunity = !knownOpportunityIds.has(key);
    newOpp.isNew = isNewOpportunity;
    if (isNewOpportunity) {
        knownOpportunityIds.add(key);
    }

    const index = dashboardData.opportunities.findIndex(o => o.marketId === pair.predictId && o.side === side && o.strategy === strategy);
    if (index >= 0) {
        dashboardData.opportunities[index] = newOpp;
    } else {
        dashboardData.opportunities.push(newOpp);
    }

    opportunityCache.set(key, newOpp);
    activeMarketIds.add(pair.predictId);
}

async function handlePolymarketWsUpdate(tokenId: string): Promise<void> {
    const pair = tokenIdToMarketPair.get(tokenId);
    if (!pair) return;

    // Track Polymarket WS update time
    const now = Date.now();
    lastPolyWsUpdateByToken.set(tokenId, now);

    // Predict orderbook (WS cache)
    const predictCache = getPredictOrderbookForWsUpdate(pair.predictId);
    if (!predictCache) {
        return;  // No Predict cache, skip update
    }

    // Polymarket orderbook (WS cache)
    const polyBook = getPolymarketOrderbookFromWs(tokenId);
    if (!polyBook) return;

    try {
        // YES side (Predict YES + Polymarket hedge)
        let polyHedgeAsks = polyBook.asks;
        if (pair.isInverted) {
            // Inverted market: Predict YES + Polymarket YES = hedge
            // YES ask = 1 - NO bid
            polyHedgeAsks = polyBook.bids.map(level => ({
                price: 1 - level.price,
                size: level.size,
            }));
            polyHedgeAsks.sort((a, b) => a.price - b.price);
        }

        const yesDepth = calculateDepth(
            predictCache.bids,
            predictCache.asks,
            polyHedgeAsks,
            pair.feeRateBps
        );

        upsertOpportunityFromDepth(pair, yesDepth, 'YES', 'MAKER', now);
        upsertOpportunityFromDepth(pair, yesDepth, 'YES', 'TAKER', now);

        // NO side (Predict NO + Polymarket YES)
        if (!pair.isInverted) {
            const noDepth = calculateNoSideDepth(
                predictCache.bids,
                predictCache.asks,
                polyBook.bids,  // Polymarket NO bids
                pair.feeRateBps
            );

            upsertOpportunityFromDepth(pair, noDepth, 'NO', 'MAKER', now);
            upsertOpportunityFromDepth(pair, noDepth, 'NO', 'TAKER', now);
        } else {
            removeOpportunityByKey(pair.predictId, 'NO', 'MAKER');
            removeOpportunityByKey(pair.predictId, 'NO', 'TAKER');
        }

        // Broadcast updated opportunities
        markDirty('opportunity', JSON.stringify(dashboardData.opportunities));
        // Trigger downstream recompute
        scheduleSportsRecompute();
        scheduleCloseRecompute();
    } catch {
        // Ignore calculation failures
    }
}


let predictWsUpdateTimer: ReturnType<typeof setTimeout> | null = null;
const PREDICT_WS_UPDATE_THROTTLE_MS = 50;  // 50ms 节流
const pendingPredictWsUpdates = new Set<number>();

/**
 * 处理 Predict WS 订单簿更新，触发机会重算
 * - 与 Polymarket WS 保持一致的处理逻辑
 * - 节流 50ms 避免频繁计算
 */
function handlePredictWsUpdate(marketId: number): void {
    pendingPredictWsUpdates.add(marketId);

    if (predictWsUpdateTimer) return;  // 已有定时器，等待批量处理

    predictWsUpdateTimer = setTimeout(() => {
        predictWsUpdateTimer = null;
        const marketIds = Array.from(pendingPredictWsUpdates);
        pendingPredictWsUpdates.clear();

        for (const id of marketIds) {
            processPredictWsUpdate(id);
        }
    }, PREDICT_WS_UPDATE_THROTTLE_MS);
}

/**
 * 实际处理 Predict WS 更新
 * 找到对应的 Polymarket token，触发机会重算
 * WS-only 模式：支持创建新机会
 */
function processPredictWsUpdate(marketId: number): void {
    // Resolve Polymarket token
    const pair = marketPairs.find(p => p.predictId === marketId);
    if (!pair || !pair.polymarketTokenId) return;

    // Predict orderbook (WS cache)
    const predictCache = getPredictOrderbookForWsUpdate(marketId);
    if (!predictCache) return;

    // Polymarket orderbook (WS cache)
    const polyBook = getPolymarketOrderbookFromWs(pair.polymarketTokenId);
    if (!polyBook) return;

    try {
        const now = Date.now();

        // YES side (Predict YES + Polymarket hedge)
        let polyHedgeAsks = polyBook.asks;
        if (pair.isInverted) {
            // Inverted market: Predict YES + Polymarket YES = hedge
            // YES ask = 1 - NO bid
            polyHedgeAsks = polyBook.bids.map(level => ({
                price: 1 - level.price,
                size: level.size,
            }));
            polyHedgeAsks.sort((a, b) => a.price - b.price);
        }

        const yesDepth = calculateDepth(
            predictCache.bids,
            predictCache.asks,
            polyHedgeAsks,
            pair.feeRateBps
        );

        upsertOpportunityFromDepth(pair, yesDepth, 'YES', 'MAKER', now);
        upsertOpportunityFromDepth(pair, yesDepth, 'YES', 'TAKER', now);

        // NO side (Predict NO + Polymarket YES)
        if (!pair.isInverted) {
            const noDepth = calculateNoSideDepth(
                predictCache.bids,
                predictCache.asks,
                polyBook.bids,
                pair.feeRateBps
            );

            upsertOpportunityFromDepth(pair, noDepth, 'NO', 'MAKER', now);
            upsertOpportunityFromDepth(pair, noDepth, 'NO', 'TAKER', now);
        } else {
            removeOpportunityByKey(pair.predictId, 'NO', 'MAKER');
            removeOpportunityByKey(pair.predictId, 'NO', 'TAKER');
        }

        // Trigger downstream recompute
        markDirty('opportunity', JSON.stringify(dashboardData.opportunities));
        scheduleSportsRecompute();
        scheduleCloseRecompute();
    } catch {
        // Ignore calculation failures
    }
}


async function fetchMarketVolumes(): Promise<void> {
    if (marketPairs.length === 0) return;

    console.log('📊 获取 volume 数据...');

    // 1. 获取 Polymarket volume (从 Gamma API)
    try {
        const res = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500');
        if (res.ok) {
            const markets = await res.json() as Array<{ conditionId?: string; volumeNum?: number }>;
            const volumeMap = new Map<string, number>();
            for (const m of markets) {
                if (m.conditionId && m.volumeNum) {
                    volumeMap.set(m.conditionId, m.volumeNum);
                }
            }

            let polyUpdated = 0;
            for (const pair of marketPairs) {
                const vol = volumeMap.get(pair.polymarketConditionId);
                if (vol !== undefined && vol > 0) {
                    pair.polyVolume = vol;
                    polyUpdated++;
                }
            }
            console.log(`   Polymarket: ${polyUpdated}/${marketPairs.length} 个市场`);
        }
    } catch {
        console.log('   ⚠️ Polymarket volume 获取失败');
    }

    // 2. 获取 Predict volume (从 Stats API)
    const apiKeys = [
        process.env.PREDICT_API_KEY_SCAN,
        process.env.PREDICT_API_KEY_SCAN_2,
        process.env.PREDICT_API_KEY_SCAN_3,
        process.env.PREDICT_API_KEY,
    ].filter(Boolean) as string[];

    if (apiKeys.length === 0) {
        console.log('   ⚠️ 无可用 API Key，跳过 Predict volume');
        return;
    }

    try {
        const volumeMap = new Map<number, number>();
        const batchSize = Math.min(apiKeys.length * 3, 10);

        for (let i = 0; i < marketPairs.length; i += batchSize) {
            const batch = marketPairs.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(async (pair, idx) => {
                const apiKey = apiKeys[(i + idx) % apiKeys.length];
                try {
                    const res = await fetch(`https://api.predict.fun/v1/markets/${pair.predictId}/stats`, {
                        headers: { 'x-api-key': apiKey }
                    });
                    if (!res.ok) return { marketId: pair.predictId, volume: 0 };
                    const data = await res.json() as any;
                    return { marketId: pair.predictId, volume: data.data?.volumeTotalUsd || 0 };
                } catch {
                    return { marketId: pair.predictId, volume: 0 };
                }
            }));

            for (const r of results) {
                if (r.volume > 0) volumeMap.set(r.marketId, r.volume);
            }
        }

        let predictUpdated = 0;
        for (const pair of marketPairs) {
            const vol = volumeMap.get(pair.predictId);
            if (vol !== undefined && vol > 0) {
                pair.predictVolume = vol;
                predictUpdated++;
            }
        }
        console.log(`   Predict: ${predictUpdated}/${marketPairs.length} 个市场`);
    } catch {
        console.log('   ⚠️ Predict volume 获取失败');
    }
}

async function initPolymarketWs(): Promise<void> {
    try {
        const opportunities: ArbOpportunity[] = [];
        polymarketWsClient = new PolymarketWebSocketClient();
        polymarketWsClient.setHandlers({
            onConnect: () => {
                console.log('[WS] Polymarket connected');
            },
            onDisconnect: (code, reason) => {
                console.log(`[WS] Polymarket disconnected (${code} ${reason})`);
            },
            onError: (error) => {
                console.log(`[WS] Polymarket error: ${error.message}`);
            },
            // 订单簿更新触发增量推送
            onOrderBookUpdate: (book) => {
                const now = Date.now();
                if (now - lastWsUpdateBroadcast < WS_UPDATE_THROTTLE_MS) return;
                lastWsUpdateBroadcast = now;

                // 触发增量更新（非阻塞）
                handlePolymarketWsUpdate(book.assetId).catch(() => { /* ignore */ });
            },
        });

        await polymarketWsClient.connect();

        // 注入 WS 订单簿提供者（实时数据，减少 API 调用）
        setPolyOrderbookProvider(getPolymarketOrderbookFromWs);  // close-service 用
        setPolymarketWsOrderbookProvider(getPolymarketOrderbookFromWs);  // 任务执行用
        console.log('[WS] Polymarket WS 订单簿提供者已注入 (close-service + PolymarketTrader)');
    } catch {
        console.log('[WS] Polymarket connect failed, fallback to REST');
        polymarketWsClient = null;
    }
}

function subscribePolymarketTokens(additionalTokenIds: string[] = []): void {
    if (!polymarketWsClient) return;

    // 主市场 tokens（包含 YES 和 NO tokens，用于任务对冲）
    const mainTokenIds: string[] = [];
    for (const pair of marketPairs) {
        if (pair.polymarketTokenId) mainTokenIds.push(pair.polymarketTokenId);
        if (pair.polymarketYesTokenId) mainTokenIds.push(pair.polymarketYesTokenId);
        if (pair.polymarketNoTokenId) mainTokenIds.push(pair.polymarketNoTokenId);
    }

    // 合并主市场 + 体育市场 tokens
    const allTokenIds = [...mainTokenIds, ...additionalTokenIds];
    const uniqueTokenIds = Array.from(new Set(allTokenIds));

    if (uniqueTokenIds.length === 0) return;

    polymarketWsClient.subscribe(uniqueTokenIds);
    console.log(`[WS] Subscribed to ${uniqueTokenIds.length} Polymarket tokens (main markets: ${marketPairs.length}, sports: ${additionalTokenIds.length})`);
}

// ============================================================================
// Data Update Functions
// ============================================================================

async function broadcastUpdate(): Promise<void> {
    dashboardData.stats.lastFullUpdate = new Date().toISOString();

    // 发送带事件类型的 SSE 消息 (与前端 useSSE.ts 匹配)
    const opportunityData = JSON.stringify(dashboardData.opportunities);
    const statsData = JSON.stringify(dashboardData.stats);

    // 获取真实账户数据
    const accountsData = JSON.stringify(await getAccountData());

    // 市场列表 (按 predictTitle 分组,类似做市程序的事件列表)
    const marketsData = JSON.stringify(marketPairs.map(p => ({
        predictId: p.predictId,
        predictTitle: p.predictTitle,
        predictQuestion: p.predictQuestion,
        predictSlug: p.categorySlug || getPredictSlug(p.predictId) || generatePredictSlug(p.predictQuestion),  // 优先 categorySlug，其次缓存，最后由问题生成
        polymarketConditionId: p.polymarketConditionId,
        polymarketSlug: getPolymarketSlug(p.polymarketConditionId) || p.polymarketSlug,  // 优先从缓存获取
        feeRateBps: p.feeRateBps,
        isInverted: p.isInverted,
        endDate: p.endDate
    })));

    // 任务列表
    const tasksData = JSON.stringify(taskService.getTasks({ includeCompleted: true }));

    // 体育市场数据 (仅当启用时)
    const sportsData = ENABLE_SPORTS_SERVICE
        ? JSON.stringify(getSportsService().getSSEData())
        : JSON.stringify({ markets: [], opportunities: [], lastScan: null });

    // 使用节流广播调度器 (200ms 节流)
    // 前端监听 'opportunity', 'stats', 'accounts', 'markets', 'tasks', 'sports' 事件
    markDirty('opportunity', opportunityData);
    markDirty('stats', statsData);
    markDirty('accounts', accountsData);
    markDirty('markets', marketsData);
    markDirty('tasks', tasksData);
    markDirty('sports', sportsData);
}

// ============================================================================
// HTTP Server
// ============================================================================

function getMimeType(path: string): string {
    if (path.endsWith('.html')) return 'text/html';
    if (path.endsWith('.css')) return 'text/css';
    if (path.endsWith('.js')) return 'application/javascript';
    if (path.endsWith('.json')) return 'application/json';
    return 'text/plain';
}

// ============================================================================
// API 鉴权 (敏感端点保护)
// ============================================================================

const DASHBOARD_API_TOKEN = process.env.DASHBOARD_API_TOKEN || '';
const DASHBOARD_PORT = String(PORT);
const DEFAULT_ALLOWED_ORIGINS = [
    `http://localhost:${DASHBOARD_PORT}`,
    `http://127.0.0.1:${DASHBOARD_PORT}`,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
];
const ENV_ALLOWED_ORIGINS = (process.env.DASHBOARD_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const ALLOWED_ORIGINS = Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...ENV_ALLOWED_ORIGINS]));

function isLoopbackAddress(address?: string): boolean {
    if (!address) return false;
    if (address === '::1' || address === '127.0.0.1') return true;
    if (address.startsWith('127.')) return true;
    if (address.startsWith('::ffff:127.')) return true;
    return false;
}

/**
 * 检查是否是局域网私有 IP 地址
 * - 10.0.0.0 - 10.255.255.255
 * - 172.16.0.0 - 172.31.255.255
 * - 192.168.0.0 - 192.168.255.255
 */
function isPrivateAddress(address?: string): boolean {
    if (!address) return false;
    // 去除 IPv6 前缀
    const ip = address.replace(/^::ffff:/, '');
    // 10.x.x.x
    if (ip.startsWith('10.')) return true;
    // 192.168.x.x
    if (ip.startsWith('192.168.')) return true;
    // 172.16.x.x - 172.31.x.x
    if (ip.startsWith('172.')) {
        const second = parseInt(ip.split('.')[1], 10);
        if (second >= 16 && second <= 31) return true;
    }
    return false;
}

/**
 * 检查请求是否通过鉴权
 * - 如果配置了 DASHBOARD_API_TOKEN，需要 Bearer token 校验
 * - 如果未配置 token，只允许来自 localhost 的请求
 */
function isAuthorizedRequest(req: IncomingMessage): boolean {
    // 检查 Bearer token
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        if (DASHBOARD_API_TOKEN && token === DASHBOARD_API_TOKEN) {
            return true;
        }
    }

    // token 模式下允许通过 query 传入（兼容 EventSource 无法设置 header）
    if (DASHBOARD_API_TOKEN) {
        try {
            const url = new URL(req.url || '/', 'http://localhost');
            const token = url.searchParams.get('token');
            if (token && token === DASHBOARD_API_TOKEN) {
                return true;
            }
        } catch {
            // ignore
        }
        return false;
    }

    // 未配置 token，允许本机和局域网访问
    const remoteAddress = req.socket?.remoteAddress;

    // 检查 X-Forwarded-For (代理场景)
    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string') {
        const forwardedIp = forwardedFor.split(',')[0].trim();
        if (forwardedIp) {
            return isLoopbackAddress(forwardedIp) || isPrivateAddress(forwardedIp);
        }
    }

    return isLoopbackAddress(remoteAddress) || isPrivateAddress(remoteAddress);
}

/**
 * 检查 origin 是否来自局域网 IP
 */
function isPrivateOrigin(origin: string): boolean {
    try {
        const url = new URL(origin);
        const host = url.hostname;
        return isPrivateAddress(host) || isLoopbackAddress(host);
    } catch {
        return false;
    }
}

/**
 * 获取安全的 CORS 头
 */
function getSecureCorsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = req.headers['origin'] || '';
    // 允许白名单或局域网来源
    if (ALLOWED_ORIGINS.includes(origin) || isPrivateOrigin(origin)) {
        return {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Credentials': 'true',
        };
    }
    // 默认不允许跨域
    return {};
}

function requireAuth(req: IncomingMessage, res: ServerResponse): Record<string, string> | null {
    const corsHeaders = getSecureCorsHeaders(req);
    if (!isAuthorizedRequest(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return null;
    }
    return corsHeaders;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || '/';

    if (url === '/api/stream') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...corsHeaders,
        });

        // 先注册客户端元数据（发送初始数据前，确保背压日志能获取到 metadata）
        // initialized=false 表示初始快照尚未完成，广播会跳过此客户端
        const clientMeta: SSEClientMeta = {
            ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                || req.socket?.remoteAddress
                || 'unknown',
            ua: (req.headers['user-agent'] || 'unknown').slice(0, 50),  // 截断避免过长
            connectedAt: Date.now(),
            initialized: false,
            backpressured: false,
            drainTimeoutCount: 0,
            lastBackpressureLogTime: 0,
            backpressureCycleCount: 0,
        };
        sseClients.set(res, clientMeta);
        req.on('close', () => sseClients.delete(res));

        // 异步发送初始数据（使用异步写入函数，支持 drain 等待）
        (async () => {
            try {
                // 发送初始数据 (使用异步版本，支持背压等待)
                // opportunity 使用分片发送，避免大数据包触发背压
                if (!await sendOpportunityBatchesAsync(res, dashboardData.opportunities)) return;
                if (!await sendSSEToClientAsync(res, 'stats', JSON.stringify(dashboardData.stats))) return;

                // 昂贵计算前检查客户端是否仍存活（避免无效 API 调用）
                if (!isSSEClientAlive(res)) return;

                // 发送真实账户数据（涉及多个 API 调用）
                const accountsData = await getAccountData();
                if (!await sendSSEToClientAsync(res, 'accounts', JSON.stringify(accountsData))) return;

                // 市场列表构建前再检查一次（marketPairs 较大时可能有开销）
                if (!isSSEClientAlive(res)) return;

                // 发送市场列表
                const marketsData = marketPairs.map(p => ({
                    predictId: p.predictId,
                    predictTitle: p.predictTitle,
                    predictQuestion: p.predictQuestion,
                    predictSlug: p.categorySlug || getPredictSlug(p.predictId) || generatePredictSlug(p.predictQuestion),
                    polymarketConditionId: p.polymarketConditionId,
                    polymarketSlug: getPolymarketSlug(p.polymarketConditionId) || p.polymarketSlug,
                    feeRateBps: p.feeRateBps,
                    isInverted: p.isInverted,
                    endDate: p.endDate
                }));
                if (!await sendSSEToClientAsync(res, 'markets', JSON.stringify(marketsData))) return;

                // 发送任务列表
                const tasks = taskService.getTasks({ includeCompleted: true });
                if (!await sendSSEToClientAsync(res, 'tasks', JSON.stringify(tasks))) return;

                // 发送体育市场数据 (仅当启用时)
                const sportsData = ENABLE_SPORTS_SERVICE
                    ? getSportsService().getSSEData()
                    : { markets: [], opportunities: [], lastScan: null };
                if (!await sendSSEToClientAsync(res, 'sports', JSON.stringify(sportsData))) return;

                // 发送平仓机会数据（使用缓存，避免初始化时阻塞）
                if (!await sendSSEToClientAsync(res, 'closeOpportunities', JSON.stringify(cachedCloseOpportunities))) return;

                // 初始快照发送完毕，标记为已初始化（后续广播将包含此客户端）
                clientMeta.initialized = true;

                // 补偿同步：快照期间可能漏掉的增量更新
                // 数据源与 broadcastUpdate() 一致（都读 dashboardData 全局对象），确保一致性
                // 顺序与快照开头一致（opportunity → stats → tasks），减少前端渲染闪动
                if (!await sendOpportunityBatchesAsync(res, dashboardData.opportunities)) return;
                if (!await sendSSEToClientAsync(res, 'stats', JSON.stringify(dashboardData.stats))) return;
                const latestTasks = taskService.getTasks({ includeCompleted: true });
                if (!await sendSSEToClientAsync(res, 'tasks', JSON.stringify(latestTasks))) return;
            } catch (error) {
                console.error('[SSE] 初始化数据发送失败:', error);
                sseClients.delete(res);
                try { res.end(); } catch {}
            }
        })();
        return;
    }

    if (url === '/api/data') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'application/json',
            ...corsHeaders,
        });
        res.end(JSON.stringify(dashboardData));
        return;
    }

    if (url === '/api/rescan' && req.method === 'POST') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'application/json',
            ...corsHeaders,
        });

        // 异步执行扫描,不阻塞响应（windowsHide 防止弹出 cmd 窗口）
        console.log('\n🔍 收到扫描请求，正在后台执行...\n');

        import('child_process').then(({ exec }) => {
            exec('npx tsx src/terminal/scan-all-markets.ts', {
                cwd: join(__dirname, '..', '..'),
                windowsHide: true,
            }, (error, stdout, stderr) => {
                if (error) {
                    console.error('❌ 扫描失败:', error);
                    return;
                }
                console.log('✅ 扫描完成');
                console.log(stdout);

                // 扫描完成后,需要重启服务器以加载新的市场列表
                console.log('\n⚠️  新市场已扫描,请手动重启Dashboard以加载最新数据\n');
            });
        });

        res.end(JSON.stringify({
            success: true,
            message: '扫描已在后台启动，完成后请刷新页面'
        }));
        return;
    }

    // ========================================================================
    // Task API 端点
    // ========================================================================

    // CORS preflight
    if (req.method === 'OPTIONS') {
        const corsHeaders = getSecureCorsHeaders(req);
        res.writeHead(204, {
            ...corsHeaders,
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }

    // GET /api/tasks - 获取任务列表
    if (url === '/api/tasks' && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
        const opportunities: ArbOpportunity[] = [];
            const tasks = taskService.getTasks({ includeCompleted: true });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: tasks }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/tasks - 创建任务
    if (url === '/api/tasks' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
        const opportunities: ArbOpportunity[] = [];
            const input = await parseJsonBody<CreateTaskInput>(req);

            // 调试日志：检查前端传入的 negRisk 值
            console.log(`[negRisk] Task create input: marketId=${input.marketId}, negRisk=${input.negRisk}`);

            const task = taskService.createTask(input);

            // 动态订阅任务的 Polymarket token 到 WebSocket
            if (polymarketWsClient && polymarketWsClient.isConnected()) {
                const tokensToSubscribe: string[] = [];
                if (input.polymarketNoTokenId) tokensToSubscribe.push(input.polymarketNoTokenId);
                if (input.polymarketYesTokenId) tokensToSubscribe.push(input.polymarketYesTokenId);
                if (tokensToSubscribe.length > 0) {
                    polymarketWsClient.subscribe(tokensToSubscribe);
                    console.log(`[Task] 动态订阅 ${tokensToSubscribe.length} 个 token 到 WS`);
                }
            }

            broadcastTaskUpdate(task);
            res.writeHead(201, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: task }));
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/tasks/:id - 获取单个任务
    const taskGetMatch = url.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskGetMatch && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = taskGetMatch[1];
        const task = taskService.getTask(taskId);
        if (task) {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: task }));
        } else {
            res.writeHead(404, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: 'Task not found' }));
        }
        return;
    }

    // DELETE /api/tasks/:id - 取消/删除任务
    const taskDeleteMatch = url.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskDeleteMatch && req.method === 'DELETE') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = taskDeleteMatch[1];
        try {
        const opportunities: ArbOpportunity[] = [];
            const task = taskService.getTask(taskId);
            if (!task) {
                res.writeHead(404, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: false, error: 'Task not found' }));
                return;
            }

            // 根据状态决定操作
            if (['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'].includes(task.status)) {
                // 终态任务直接删除
                taskService.deleteTask(taskId);
                broadcastTaskDeleted(taskId);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: true, message: 'Task deleted' }));
            } else {
                // 活跃任务取消：使用 taskExecutor.cancelTask() 来取消订单
                // taskService.cancelTask() 只更新状态，不取消实际订单
                await taskExecutor.cancelTask(taskId);
                const cancelled = taskService.getTask(taskId);
                broadcastTaskUpdate(cancelled!);

                // 发送 TG 通知：任务取消（fire-and-forget，不阻塞响应）
                const tg = getTelegramNotifier();
                if (tg && cancelled) {
                    tg.sendText(`🛑 <b>任务已取消</b>\n\n<b>市场:</b> ${cancelled.title}\n<b>类型:</b> ${cancelled.type}\n<b>状态:</b> ${task.status} → CANCELLED\n<b>已成交:</b> ${cancelled.predictFilledQty}/${cancelled.quantity}`)
                        .catch(err => console.warn('[Dashboard] TG 通知发送失败:', err.message));
                }

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: true, data: cancelled }));
            }
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/tasks/:id/start - 开始执行任务
    const taskStartMatch = url.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/start$/);
    if (taskStartMatch && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = taskStartMatch[1];
        try {
        const opportunities: ArbOpportunity[] = [];
            const task = taskService.getTask(taskId);
            if (!task) {
                res.writeHead(404, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: false, error: 'Task not found' }));
                return;
            }

            if (task.status !== 'PENDING') {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({
                    success: false,
                    error: `Task cannot be started from status: ${task.status}`
                }));
                return;
            }

            // 启动 TaskExecutor 异步执行任务
            taskExecutor.startTask(taskId).catch(error => {
                console.error(`[Dashboard] Task ${taskId} execution error:`, error);
            });

            // 立即返回，任务状态更新通过 SSE 推送
            const updated = taskService.getTask(taskId);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: updated }));
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // PATCH /api/tasks/:id - 更新任务 (expiresAt)
    const taskPatchMatch = url.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskPatchMatch && req.method === 'PATCH') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = taskPatchMatch[1];
        try {
            const body = await parseJsonBody<{ expiresAt?: number | null }>(req);
            const { expiresAt } = body;

            const task = taskService.getTask(taskId);
            if (!task) {
                res.writeHead(404, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: false, error: 'Task not found' }));
                return;
            }

            // 更新 expiresAt (null 表示取消定时)
            const newExpiresAt = expiresAt === null ? undefined : expiresAt;
            const updated = taskService.updateTaskExpiry(taskId, newExpiresAt);

            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: updated }));
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // ========================================================================
    // 平仓 API (需鉴权)
    // ========================================================================

    // GET /api/close-opportunities - 获取平仓机会（使用缓存，支持 refresh 参数强制刷新）
    if (url?.startsWith('/api/close-opportunities') && req.method === 'GET') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            // 解析查询参数
            const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
            const forceRefresh = urlObj.searchParams.get('refresh') === 'true';

            let opportunities = cachedCloseOpportunities;

            // 强制刷新或缓存为空时重新计算
            const shouldForceRefresh = forceRefresh || cachedCloseOpportunities.length === 0;
            if (shouldForceRefresh) {
                opportunities = await calculateCloseOpportunities(shouldForceRefresh);
                cachedCloseOpportunities = opportunities;
                lastCloseOpportunitiesUpdate = Date.now();
            }

            // 同时获取未匹配的单腿持仓
            const unmatchedPositions = await getUnmatchedPositions();

            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({
                success: true,
                opportunities,
                unmatchedPositions,  // 未匹配的单腿持仓
                cached: !forceRefresh && cachedCloseOpportunities.length > 0,
                lastUpdate: lastCloseOpportunitiesUpdate,
            }));
        } catch (error: any) {
            console.error('[Dashboard] 获取平仓机会失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/close-positions - 获取可平仓持仓
    if (url === '/api/close-positions' && req.method === 'GET') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            const positions = await getClosePositions();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, positions }));
        } catch (error: any) {
            console.error('[Dashboard] 获取平仓持仓失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/close-refresh - 刷新市场映射缓存
    if (url === '/api/close-refresh' && req.method === 'POST') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            refreshMarketMatches();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, message: 'Market matches refreshed' }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // ========================================================================
    // 体育市场 API
    // ========================================================================

    // GET /api/sports - 获取体育市场套利数据
    if (url === '/api/sports' && req.method === 'GET') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!ENABLE_SPORTS_SERVICE) {
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, markets: [], opportunities: [], lastScan: null, disabled: true }));
            return;
        }
        try {
            const sportsService = getSportsService();
            const data = sportsService.getSSEData();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, ...data }));
        } catch (error: any) {
            console.error('[Dashboard] 获取体育市场失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/sports/scan - 手动触发体育市场扫描
    if (url === '/api/sports/scan' && req.method === 'POST') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!ENABLE_SPORTS_SERVICE) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Sports service is disabled' }));
            return;
        }
        try {
            const sportsService = getSportsService();
            const markets = await sportsService.scan();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, count: markets.length }));
        } catch (error: any) {
            console.error('[Dashboard] 体育市场扫描失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // ========================================================================
    // 流动性分析 API
    // ========================================================================

    // GET /api/liquidity - 获取市场流动性分析数据
    if (url === '/api/liquidity' && req.method === 'GET') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            if (!cachedLiquidityData) {
                res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({
                    success: true,
                    data: null,
                    scanning: liquidityScanInProgress,
                    message: liquidityScanInProgress ? '正在扫描中...' : '流动性扫描尚未完成'
                }));
                return;
            }
            // 为每个市场添加 predictSlug
            const enrichedTop20 = cachedLiquidityData.top20.map(item => ({
                ...item,
                predictSlug: item.categorySlug || getPredictSlug(item.marketId) || generatePredictSlug(item.title)
            }));
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({
                success: true,
                data: {
                    ...cachedLiquidityData,
                    top20: enrichedTop20
                },
                lastScanTime: lastLiquidityScanTime
            }));
        } catch (error: any) {
            console.error('[Dashboard] 获取流动性数据失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/liquidity/refresh - 手动刷新流动性扫描
    if (url === '/api/liquidity/refresh' && req.method === 'POST') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            const apiKeyRefresh = process.env.PREDICT_API_KEY;
            if (!apiKeyRefresh) {
                res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ success: false, error: '缺少 PREDICT_API_KEY' }));
                return;
            }
            // 如果已经在扫描中，直接返回
            if (liquidityScanInProgress) {
                res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ success: true, message: '扫描已在进行中' }));
                return;
            }

            // 异步执行，不阻塞响应
            liquidityScanInProgress = true;
            runLiquidityScan(apiKeyRefresh, { silent: true })
                .then(result => {
                    cachedLiquidityData = result;
                    lastLiquidityScanTime = Date.now();
                    liquidityScanInProgress = false;
                    console.log(`[Dashboard] 流动性扫描刷新完成: ${result.valid} 个市场`);
                })
                .catch(err => {
                    liquidityScanInProgress = false;
                    console.warn('[Dashboard] 流动性扫描刷新失败:', err.message);
                });

            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, message: '刷新已开始' }));
        } catch (error: any) {
            console.error('[Dashboard] 触发流动性扫描失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // ========================================================================
    // 日志查询 API
    // ========================================================================

    const logQueryService = getLogQueryService();

    // GET /api/logs/tasks - 获取任务日志列表
    if (url.startsWith('/api/logs/tasks') && req.method === 'GET' && !url.includes('/timeline') && !url.includes('/orderbook')) {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
        const opportunities: ArbOpportunity[] = [];
            const urlObj = new URL(url, `http://localhost`);
            const limit = parseInt(urlObj.searchParams.get('limit') || '50');
            const offset = parseInt(urlObj.searchParams.get('offset') || '0');
            const status = urlObj.searchParams.get('status') || undefined;
            const type = urlObj.searchParams.get('type') || undefined;

            const result = logQueryService.getTaskList({ limit, offset, status, type });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: result }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/logs/tasks/:id/timeline - 获取任务时间线
    const timelineMatch = url.match(/^\/api\/logs\/tasks\/([a-zA-Z0-9_-]+)\/timeline$/);
    if (timelineMatch && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = timelineMatch[1];
        try {
        const opportunities: ArbOpportunity[] = [];
            const timeline = logQueryService.getTaskTimeline(taskId);
            if (timeline) {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: true, data: timeline }));
            } else {
                res.writeHead(404, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: false, error: 'Task logs not found' }));
            }
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/logs/tasks/:id/orderbook - 获取订单簿快照
    const orderbookMatch = url.match(/^\/api\/logs\/tasks\/([a-zA-Z0-9_-]+)\/orderbook$/);
    if (orderbookMatch && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = orderbookMatch[1];
        try {
        const opportunities: ArbOpportunity[] = [];
            const urlObj = new URL(url, `http://localhost`);
            const sequence = urlObj.searchParams.get('sequence');
            const snapshots = logQueryService.getOrderBookSnapshot(
                taskId,
                sequence ? parseInt(sequence) : undefined
            );
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: snapshots }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/logs/stats - 获取统计数据
    if (url.startsWith('/api/logs/stats') && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
        const opportunities: ArbOpportunity[] = [];
            const urlObj = new URL(url, `http://localhost`);
            const days = parseInt(urlObj.searchParams.get('days') || '7');
            const stats = logQueryService.getStats(days);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: stats }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/logs/failures - 获取失败任务列表
    if (url.startsWith('/api/logs/failures') && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
        const opportunities: ArbOpportunity[] = [];
            const urlObj = new URL(url, `http://localhost`);
            const days = parseInt(urlObj.searchParams.get('days') || '7');
            const failures = logQueryService.getFailures(days);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: failures }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/account - 获取账户数据
    if (url === '/api/account' && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const accountData = await getAccountData();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: accountData }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/account/refresh - 强制刷新账户数据
    if (url === '/api/account/refresh' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const accountData = await refreshAccountData();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: accountData }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // ========================================================================
    // 静态文件服务
    // ========================================================================

    let filePath = url === '/' ? '/index.html' : url;
    let fullPath = '';

    // 优先从 front 目录提供文件
    if ((filePath === '/preview' || filePath === '/preview.html') && HAS_FRONT_PREVIEW) {
        fullPath = FRONT_PREVIEW_PATH;
        filePath = '/index.html';
    } else if (filePath === '/index.html' && HAS_FRONT_PREVIEW) {
        fullPath = FRONT_PREVIEW_PATH;
    } else if (filePath.startsWith('/preview/')) {
        // 提供 front/preview/ 目录下的文件
        fullPath = join(FRONT_DIR, filePath);
    } else {
        fullPath = join(PUBLIC_DIR, filePath);
    }

    if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8');
        res.writeHead(200, {
            'Content-Type': getMimeType(filePath),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
        });
        res.end(content);
    } else {
        res.writeHead(404, {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*'
        });
        res.end('Not Found');
    }
}

// ============================================================================
// 获取 Predict 订单簿
// ============================================================================

interface OrderBookLevel {
    price: number;
    size: number;
}

let predictErrorLogged = false;
let rateLimitBackoff = 0; // Rate limit 退避时间

const FETCH_TIMEOUT_MS = 10000; // 10秒 fetch 超时

async function fetchPredictOrderbook(
    marketId: number,
    options: { useOrderbookKeys?: boolean; apiKey?: string } = {}
): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
    // 如果在退避期，跳过请求
    if (rateLimitBackoff > Date.now()) {
        return null;
    }

    try {
        const opportunities: ArbOpportunity[] = [];
        // 优先使用传入的 apiKey，否则根据 useOrderbookKeys 选择
        const { useOrderbookKeys = true, apiKey: explicitKey } = options;
        const apiKey = explicitKey || (useOrderbookKeys ? orderbookApiKeys.getNextKey() : scanApiKeys.getNextKey());
        recordApiKeyUsage(apiKey);

        // 添加超时保护
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            // Rate limit 特殊处理
            if (res.status === 429) {
                rateLimitBackoff = Date.now() + 10000; // 退避 10 秒
                if (!predictErrorLogged) {
                    console.warn(`[Predict API] Rate limit, 退避 10 秒...`);
                    predictErrorLogged = true;
                }
                return null;
            }

            if (!predictErrorLogged) {
                const errorText = await res.text();
                console.error(`[Predict API] 订单簿获取失败: HTTP ${res.status} - ${errorText.substring(0, 200)}`);
                predictErrorLogged = true;
            }
            return null;
        }

        // 重置错误标志和退避
        predictErrorLogged = false;
        rateLimitBackoff = 0;

        const data = await res.json() as { data: { bids: [number, number][]; asks: [number, number][] } };
        const orderbook = data.data;

        if (!orderbook) return null;

        // 转换格式: [[price, size], ...] -> [{ price, size }, ...]
        const bids = (orderbook.bids || []).map(([price, size]: [number, number]) => ({ price, size }));
        const asks = (orderbook.asks || []).map(([price, size]: [number, number]) => ({ price, size }));

        return { bids, asks };
    } catch (error) {
        if (!predictErrorLogged) {
            console.error(`[Predict API] 订单簿获取异常:`, error);
            predictErrorLogged = true;
        }
        return null;
    }
}

// ============================================================================
// 获取 Polymarket 订单簿
// ============================================================================

function getPolymarketOrderbookFromWs(tokenId: string): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null {
    // WS-only 模式：不检查连接状态，只检查缓存是否存在
    // 连接状态由 isWsConnectionHealthy() 统一判定
    if (!polymarketWsClient) return null;

    const cached = polymarketWsClient.getOrderBook(tokenId);
    if (!cached) return null;

    // WS-only 激进模式：移除 POLY_WS_STALE_MS 过滤
    // 只要 WS 连接在线，缓存数据就是有效的（WS 会实时推送更新）
    // 新鲜度过滤改为仅用于监控/日志，不参与计算决策

    const bids = cached.bids.map(([price, size]) => ({ price, size }));
    const asks = cached.asks.map(([price, size]) => ({ price, size }));

    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    return { bids, asks };
}

async function fetchPolymarketOrderbookRest(tokenId: string): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
    try {
        const opportunities: ArbOpportunity[] = [];
        // 添加超时保护
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!res.ok) return null;

        const book = await res.json() as { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };

        // 转换为数值格式
        const bids = (book.bids || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
        const asks = (book.asks || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));

        // 排序: bids 降序, asks 升序
        bids.sort((a, b) => b.price - a.price);
        asks.sort((a, b) => a.price - b.price);

        return { bids, asks };
    } catch {
        return null;
    }
}

async function fetchPolymarketOrderbook(tokenId: string): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
    const wsBook = getPolymarketOrderbookFromWs(tokenId);
    if (wsBook) return wsBook;

    // WS-only 激进模式：非首轮不回退到 REST
    // 首轮扫描允许 REST 作为种子数据
    if (!isFirstScan && usePredictWsMode) {
        return null;  // WS miss 直接返回 null，不调用 REST
    }

    return fetchPolymarketOrderbookRest(tokenId);
}

// ============================================================================
// Polymarket 市场信息
// ============================================================================

interface PolymarketMarketInfo {
    tokenId: string | null;        // Legacy: 第一个 token (NO)
    yesTokenId: string | null;     // YES token ID
    noTokenId: string | null;      // NO token ID
    tickSize: number;               // 动态 tick size
    negRisk: boolean;
    slug: string | null;           // Market slug (用于 URL 导航)
}

const polymarketMarketInfoCache = new Map<string, { info: PolymarketMarketInfo; timestamp: number }>();

async function getPolymarketMarketInfo(conditionId: string): Promise<PolymarketMarketInfo | null> {
    // 检查缓存
    const cached = polymarketMarketInfoCache.get(conditionId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        // 调试日志：缓存命中
        console.log(`[negRisk] Cache hit: ${conditionId.slice(0, 20)}... negRisk=${cached.info.negRisk}`);
        return cached.info;
    }

    try {
        const opportunities: ArbOpportunity[] = [];
        const res = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
        if (!res.ok) return null;

        const data = await res.json() as {
            tokens?: { token_id: string; outcome: string }[];
            closed?: boolean;
            accepting_orders?: boolean;
            minimum_tick_size?: string;
            neg_risk?: boolean;
            market_slug?: string;
        };

        // 跳过已关闭的市场
        if (data.closed || data.accepting_orders === false) {
            return null;
        }

        // 解析 tokens - 根据 outcome 区分 YES/NO
        let yesTokenId: string | null = null;
        let noTokenId: string | null = null;

        if (data.tokens && data.tokens.length > 0) {
            for (const token of data.tokens) {
                if (token.outcome.toLowerCase() === 'yes') {
                    yesTokenId = token.token_id;
                } else if (token.outcome.toLowerCase() === 'no') {
                    noTokenId = token.token_id;
                }
            }
            // 如果没有明确标记，使用位置：第一个是 YES，第二个是 NO
            if (!yesTokenId && data.tokens.length > 0) {
                yesTokenId = data.tokens[0].token_id;
            }
            if (!noTokenId && data.tokens.length > 1) {
                noTokenId = data.tokens[1].token_id;
            }
        }

        const info: PolymarketMarketInfo = {
            tokenId: noTokenId || yesTokenId,  // Legacy: 用于订单簿查询
            yesTokenId,
            noTokenId,
            tickSize: parseFloat(data.minimum_tick_size || '0.01'),
            negRisk: data.neg_risk === true,
            slug: data.market_slug || null,
        };

        // 调试日志：追踪 negRisk 值
        if (data.neg_risk !== undefined) {
            console.log(`[negRisk] Market ${conditionId.slice(0, 20)}... neg_risk=${data.neg_risk} → negRisk=${info.negRisk}`);
        }

        polymarketMarketInfoCache.set(conditionId, { info, timestamp: Date.now() });

        return info;
    } catch {
        return null;
    }
}

// Legacy wrapper
async function getPolymarketTokenId(conditionId: string): Promise<string | null> {
    const info = await getPolymarketMarketInfo(conditionId);
    return info?.tokenId || null;
}

// ============================================================================
// 获取 Polymarket 市场结算时间 (使用事件级别的 endDate)
// ============================================================================

// conditionId → 事件 endDate 映射缓存 (Polymarket Gamma API)
const conditionIdToEventEndDate = new Map<string, string>();

// categorySlug → endsAt 映射缓存 (Predict Categories API)
const categorySlugToEndsAt = new Map<string, string>();

// 检查 endDate 是否有效（未过期，给 1 天缓冲避免时区问题）
function isEndDateValid(endDateStr: string | null | undefined): boolean {
    if (!endDateStr) return false;
    try {
        const endDate = new Date(endDateStr);
        if (isNaN(endDate.getTime())) return false;
        const now = new Date();
        // 给 1 天缓冲，避免时区问题
        const bufferMs = 24 * 60 * 60 * 1000;
        return endDate.getTime() + bufferMs >= now.getTime();
    } catch {
        return false;
    }
}

// 构建 conditionId → 事件 endDate 映射（缓存所有，包括过期的，在使用时判断有效性）
async function buildEventEndDateMapping(): Promise<void> {
    try {
        console.log('[endDate] 正在从 Gamma API 获取事件级别的结算时间...');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);  // 10秒超时

        const res = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=500', {
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!res.ok) {
            console.log('[endDate] Gamma API 请求失败:', res.status);
            return;
        }
        const events = await res.json() as Array<{
            endDate?: string;
            markets?: Array<{ conditionId?: string }>;
        }>;

        let count = 0;
        let expiredCount = 0;
        for (const event of events) {
            if (event.endDate && event.markets) {
                const isExpired = !isEndDateValid(event.endDate);
                if (isExpired) expiredCount += event.markets.length;
                for (const market of event.markets) {
                    if (market.conditionId) {
                        conditionIdToEventEndDate.set(market.conditionId, event.endDate);
                        count++;
                    }
                }
            }
        }
        console.log(`[endDate] Polymarket: ${count} 个 conditionId → endDate 映射 (${expiredCount} 个已过期)`);
    } catch (e: any) {
        if (e.name === 'AbortError') {
            console.log('[endDate] Gamma API 请求超时，跳过');
        } else {
            console.log('[endDate] 构建映射失败:', e.message);
        }
    }
}

function getPolymarketEndDate(conditionId: string): string | null {
    // 直接从缓存获取事件级别的 endDate（启动时已批量加载）
    // 有效性判断在使用时进行（见 marketPairs 构建逻辑）
    return conditionIdToEventEndDate.get(conditionId) || null;
}

// 从 Predict Categories API 批量获取 endsAt
async function buildPredictEndsAtMapping(categorySlugs: string[]): Promise<void> {
    if (categorySlugs.length === 0) return;

    // 去重
    const uniqueSlugs = [...new Set(categorySlugs)];
    console.log(`[endDate] 正在从 Predict API 获取 ${uniqueSlugs.length} 个 category 的 endsAt...`);

    const apiKey = process.env.PREDICT_API_KEY || scanApiKeys.getNextKey();
    let successCount = 0;
    let failCount = 0;

    // 批量并发获取，每批 10 个
    const BATCH_SIZE = 10;
    for (let i = 0; i < uniqueSlugs.length; i += BATCH_SIZE) {
        const batch = uniqueSlugs.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (slug) => {
            try {
                const res = await fetch(`https://api.predict.fun/v1/categories/${slug}`, {
                    headers: { 'x-api-key': apiKey }
                });

                if (res.ok) {
                    const data = await res.json() as { data?: { endsAt?: string } };
                    if (data.data?.endsAt) {
                        categorySlugToEndsAt.set(slug, data.data.endsAt);
                        successCount++;
                    }
                } else {
                    failCount++;
                }
            } catch {
                failCount++;
            }
        }));

        // 避免 rate limit
        if (i + BATCH_SIZE < uniqueSlugs.length) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    console.log(`[endDate] 已建立 ${successCount} 个 categorySlug → endsAt 映射 (${failCount} 个失败)`);
}

function getPredictEndsAt(categorySlug: string | undefined): string | null {
    if (!categorySlug) return null;
    return categorySlugToEndsAt.get(categorySlug) || null;
}

// ============================================================================
// 套利检测 (使用 depth-calculator)
// ============================================================================

let updateCount = 0;
let scanInProgress = false;
let lastScanInProgressLogTime = 0;

async function detectArbitrageOpportunities(): Promise<void> {
    if (scanInProgress) {
        const now = Date.now();
        if (now - lastScanInProgressLogTime > 15000) {
            console.log('[智能轮询] 上一轮扫描未结束，跳过本轮');
            lastScanInProgressLogTime = now;
        }
        return;
    }

    scanInProgress = true;
    try {
        const opportunities: ArbOpportunity[] = [];
        let predictLatencySum = 0;
        let predictCount = 0;
        let polyLatencySum = 0;
        let polyCount = 0;
        let predictSuccess = 0;
        let polymarketSuccess = 0;
        let totalDepth = 0;

    // ========== 双轨扫描：活跃市场 + 非活跃市场并行 ==========
    // - 活跃市场：使用 ORDERBOOK keys（高优先级，有套利机会的市场）
    // - 非活跃市场：使用 SCAN key（发现新机会）
    const now = Date.now();

    // 保存扫描前的活跃市场快照（用于检测新激活的市场）
    const previousActiveMarketIds = new Set(activeMarketIds);

    // 统一扫描：所有市场使用 SCAN_1, SCAN_2, SCAN_3 并发
    const allMarkets = marketPairs.filter(p => p.polymarketTokenId);
    const activeCount = allMarkets.filter(p => activeMarketIds.has(p.predictId)).length;
    const inactiveCount = allMarkets.length - activeCount;

    if (isFirstScan) {
        console.log(`[扫描] 首次全量扫描: ${allMarkets.length} 个市场 (活跃: ${activeCount}, 非活跃: ${inactiveCount})`);
    } else {
        console.log(`[扫描] 全量扫描: ${allMarkets.length} 个市场 (活跃: ${activeCount}, 非活跃: ${inactiveCount})`);
    }

    // 本轮扫描中成功和失败的市场 ID
    const thisRoundSucceeded = new Set<number>();
    const thisRoundFailed = new Set<number>();

    // 存储订单簿结果
    const predictBooks = new Map<number, { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null>();
    const polyBooks = new Map<string, { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null>();

    let allScanKeys = scanApiKeys.getAllKeys();

    // 保护：如果没有 SCAN keys，回退到主 API key
    if (allScanKeys.length === 0) {
        const fallbackKey = process.env['PREDICT_API_KEY'];
        if (fallbackKey) {
            console.warn('[扫描] 警告: 没有 SCAN keys，使用主 API key');
            allScanKeys = [fallbackKey];
        } else {
            console.error('[扫描] 错误: 没有可用的 API key');
            return;
        }
    }

    // ========== WS-only 激进模式：非首轮跳过订单簿拉取 ==========
    // 首轮扫描：使用 REST/WS 获取种子数据并计算机会
    // 后续扫描：完全跳过订单簿拉取，机会由 WS 更新驱动维护
    const wsSkipOrderbookFetch = WS_DRIVEN_CALCULATION && usePredictWsMode && !isFirstScan;

    if (wsSkipOrderbookFetch) {
        // WS-only 模式非首轮：跳过订单簿拉取
        // 只维护市场列表，机会由 WS 回调维护
        console.log(`[扫描] WS-only 模式，跳过订单簿拉取 (机会由 WS 更新维护)`);
        dashboardData.stats.lastFullUpdate = new Date().toISOString();
        dashboardData.stats.connectionStatus.polymarketWs = getPolymarketWsStatus();
        dashboardData.stats.dataVersion++;
        updateCount++;
        await broadcastUpdate();
        return;
    } else {
        // 首轮扫描或 Legacy 模式：执行订单簿拉取

        // 均匀分布扫描：将请求分散到轮询间隔内
        const SCAN_INTERVAL_SECONDS = Math.max(1, Math.floor(POLL_INTERVAL_MS / 1000));
        const marketsPerSecond = Math.ceil(allMarkets.length / SCAN_INTERVAL_SECONDS);

        // 统一并发扫描（分时均匀）
        const scanStart = Date.now();

        for (let sec = 0; sec < SCAN_INTERVAL_SECONDS; sec++) {
            const startIdx = sec * marketsPerSecond;
            const endIdx = Math.min(startIdx + marketsPerSecond, allMarkets.length);
            if (startIdx >= allMarkets.length) break;

            const batch = allMarkets.slice(startIdx, endIdx);

            // 本秒的请求并发发出，按 key 轮换
            await Promise.all(batch.map(async (pair, idx) => {
                const apiKey = allScanKeys[idx % allScanKeys.length];

                // WS 模式: Predict 订单簿从统一缓存读取，只拉取 Polymarket
                // Legacy 模式: 两边都用 REST
                let predictBook: { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null = null;

                if (usePredictWsMode) {
                    // WS 模式: 从统一缓存读取
                    const unifiedCache = getPredictOrderbookCache();
                    if (unifiedCache) {
                        const cached = unifiedCache.getOrderbookSync(pair.predictId);
                        if (cached) {
                            predictBook = {
                                bids: cached.bids.map(l => ({ price: l.price, size: l.size })),
                                asks: cached.asks.map(l => ({ price: l.price, size: l.size })),
                            };
                        }
                    }
                } else {
                    // Legacy 模式: REST 拉取
                    predictBook = await fetchPredictOrderbook(pair.predictId, { apiKey });
                    // 更新本地缓存
                    if (predictBook) {
                        predictOrderbookCacheLegacy.set(pair.predictId, {
                            bids: predictBook.bids,
                            asks: predictBook.asks,
                            timestamp: Date.now()
                        });
                    }
                }

                // Polymarket 订单簿: WS 缓存优先，REST 兜底（首轮允许 REST）
                let polyBook = getPolymarketOrderbookFromWs(pair.polymarketTokenId!);
                if (!polyBook) {
                    // WS 缓存不可用，fallback to REST（fetchPolymarketOrderbook 内部会检查 isFirstScan）
                    polyBook = await fetchPolymarketOrderbook(pair.polymarketTokenId!);
                }
                predictBooks.set(pair.predictId, predictBook);
                polyBooks.set(pair.polymarketTokenId!, polyBook);
            }));

            // 非最后一秒时等待，确保请求均匀分布
            if (sec < SCAN_INTERVAL_SECONDS - 1 && endIdx < allMarkets.length) {
                const elapsed = Date.now() - scanStart;
                const targetTime = (sec + 1) * 1000;
                const waitTime = Math.max(0, targetTime - elapsed);
                if (waitTime > 0) {
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            }
        }

        const scanLatency = Date.now() - scanStart;
        predictLatencySum += scanLatency;
        polyLatencySum += scanLatency;
        predictCount += allMarkets.length;
        polyCount += allMarkets.length;
    }

    // 所有要处理的市场
    const validPairs = allMarkets;

    // 统计成功/失败
    for (const pair of validPairs) {
        const predictBook = predictBooks.get(pair.predictId);
        const polyBook = polyBooks.get(pair.polymarketTokenId!);

        if (predictBook) {
            predictSuccess++;
            thisRoundSucceeded.add(pair.predictId);
        } else {
            thisRoundFailed.add(pair.predictId);
        }
        if (polyBook) polymarketSuccess++;
    }

    // ========== 套利计算（使用缓存的订单簿） ==========
    // WS 驱动计算模式：
    //   - 首次扫描：计算所有机会（发现新机会）
    //   - 后续扫描：跳过计算，由 WS 更新驱动重算
    //   - WS 断连时：回退到主扫描计算（兜底）
    const wsSkipAllCalculation = WS_DRIVEN_CALCULATION && usePredictWsMode && predictWsConnected && !isFirstScan;
    let wsSkippedCount = 0;

    // WS 驱动模式下跳过所有计算，机会由 WS 更新维护
    if (wsSkipAllCalculation) {
        wsSkippedCount = validPairs.length;
    }

    for (const pair of validPairs) {
        // WS 驱动模式：跳过所有计算，机会由 WS 更新维护
        if (wsSkipAllCalculation) {
            continue;
        }

        const predictBook = predictBooks.get(pair.predictId);
        const polyBook = polyBooks.get(pair.polymarketTokenId!);

        // 计算套利深度
        if (predictBook && polyBook) {
            // 调试:检查订单簿是否有数据
            if (predictBook.bids.length === 0 || predictBook.asks.length === 0 || polyBook.bids.length === 0 || polyBook.asks.length === 0) {
                console.log(`[DEBUG] 市场 ${pair.predictId} 订单簿为空: Predict bids=${predictBook.bids.length}, asks=${predictBook.asks.length}, Poly bids=${polyBook.bids.length}, asks=${polyBook.asks.length}`);
                continue;
            }

            // 计算 Polymarket 对冲价格
            // polymarketTokenId 优先使用 NO token，所以 polyBook 是 NO 的订单簿
            let polyHedgeAsks: OrderBookLevel[];

            if (pair.isInverted) {
                // Inverted 市场: Predict YES + Polymarket YES = 对冲
                // 需要从 NO 订单簿转换：YES Ask = 1 - NO Bid
                polyHedgeAsks = polyBook.bids.map(level => ({
                    price: 1 - level.price,
                    size: level.size
                }));
                polyHedgeAsks.sort((a, b) => a.price - b.price);
            } else {
                // 正常市场: Predict YES + Polymarket NO = 对冲
                // polyBook 已经是 NO 的订单簿，直接使用 NO 的 asks
                polyHedgeAsks = polyBook.asks;
            }

            // 使用 depth-calculator 计算
            const depth = calculateDepth(
                predictBook.bids,
                predictBook.asks,
                polyHedgeAsks,
                pair.feeRateBps || 200
            );

            // ================================================================
            // YES 端套利检测 (predict_yes + polymarket_no < 1)
            // ================================================================

            // YES 端 Maker 机会
            if (depth.makerCost < 1 && depth.makerProfit > 0) {
                const profitPercent = depth.makerProfit * 100;
                const riskLevel = profitPercent > 2 ? 'LOW' : profitPercent > 1 ? 'MEDIUM' : 'HIGH';
                opportunities.push({
                    marketId: pair.predictId,
                    title: pair.predictQuestion,
                    strategy: 'MAKER',
                    side: 'YES',
                    profitPercent,
                    maxQuantity: depth.makerMaxQuantity,
                    estimatedProfit: depth.makerProfit * depth.makerMaxQuantity,
                    predictPrice: depth.predictYesBid,
                    predictBid: depth.predictYesBid,
                    predictAsk: depth.predictYesAsk,
                    polymarketPrice: depth.polymarketNoAsk,
                    totalCost: depth.makerCost,
                    // 前端显示用 (美分单位)
                    makerCost: +(depth.makerCost * 100).toFixed(2),
                    takerCost: +(depth.takerCost * 100).toFixed(2),
                    depth: {
                        predict: depth.predictYesBidDepth,
                        polymarket: depth.polymarketNoAskDepth,
                        polymarketNoAskDepth: depth.polymarketNoAskDepth,
                        predictAskDepth: depth.predictYesAskDepth,
                        predictBidDepth: depth.predictYesBidDepth,
                    },
                    lastUpdate: Date.now(),
                    isInverted: pair.isInverted,

                    // 执行必需字段
                    polymarketConditionId: pair.polymarketConditionId,
                    polymarketSlug: getPolymarketSlug(pair.polymarketConditionId) || pair.polymarketSlug,
                    predictSlug: pair.categorySlug || getPredictSlug(pair.predictId) || generatePredictSlug(pair.predictQuestion),
                    polymarketNoTokenId: pair.polymarketNoTokenId || '',
                    polymarketYesTokenId: pair.polymarketYesTokenId || '',
                    tickSize: pair.tickSize,
                    feeRateBps: pair.feeRateBps,
                    negRisk: pair.negRisk,

                    // 风险和费用
                    risk: {
                        level: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
                        slippage: 0.5,
                    },
                    fees: {
                        predict: depth.predictFee,
                        gas: 0.01,
                    },
                    costs: {
                        total: depth.makerCost,
                    },
                    endDate: pair.endDate,
                    predictVolume: pair.predictVolume,
                    polyVolume: pair.polyVolume,
                });
                totalDepth += depth.makerMaxQuantity;
            }

            // YES 端 Taker 机会
            if (depth.takerCost < 1 && depth.takerProfit > 0) {
                const profitPercent = depth.takerProfit * 100;
                const riskLevel = profitPercent > 2 ? 'LOW' : profitPercent > 1 ? 'MEDIUM' : 'HIGH';
                opportunities.push({
                    marketId: pair.predictId,
                    title: pair.predictQuestion,
                    strategy: 'TAKER',
                    side: 'YES',
                    profitPercent,
                    maxQuantity: depth.takerMaxQuantity,
                    estimatedProfit: depth.takerProfit * depth.takerMaxQuantity,
                    predictPrice: depth.predictYesAsk,
                    predictBid: depth.predictYesBid,
                    predictAsk: depth.predictYesAsk,
                    polymarketPrice: depth.polymarketNoAsk,
                    totalCost: depth.takerCost,
                    // 前端显示用 (美分单位)
                    makerCost: +(depth.makerCost * 100).toFixed(2),
                    takerCost: +(depth.takerCost * 100).toFixed(2),
                    depth: {
                        predict: depth.predictYesAskDepth,
                        polymarket: depth.polymarketNoAskDepth,
                        polymarketNoAskDepth: depth.polymarketNoAskDepth,
                        predictAskDepth: depth.predictYesAskDepth,
                        predictBidDepth: depth.predictYesBidDepth,
                    },
                    lastUpdate: Date.now(),
                    isInverted: pair.isInverted,

                    // 执行必需字段
                    polymarketConditionId: pair.polymarketConditionId,
                    polymarketSlug: getPolymarketSlug(pair.polymarketConditionId) || pair.polymarketSlug,
                    predictSlug: pair.categorySlug || getPredictSlug(pair.predictId) || generatePredictSlug(pair.predictQuestion),
                    polymarketNoTokenId: pair.polymarketNoTokenId || '',
                    polymarketYesTokenId: pair.polymarketYesTokenId || '',
                    tickSize: pair.tickSize,
                    feeRateBps: pair.feeRateBps,
                    negRisk: pair.negRisk,

                    // 风险和费用
                    risk: {
                        level: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
                        slippage: 0.5,
                    },
                    fees: {
                        predict: depth.predictFee,
                        gas: 0.01,
                    },
                    costs: {
                        total: depth.takerCost,
                    },
                    endDate: pair.endDate,
                    predictVolume: pair.predictVolume,
                    polyVolume: pair.polyVolume,
                });
                totalDepth += depth.takerMaxQuantity;
            }

            // ================================================================
            // NO 端套利检测 (predict_no + polymarket_yes < 1)
            // 使用 polyBook.bids 反演 polymarket_yes_ask = 1 - polymarket_no_bid
            // ================================================================

            // 只对非 inverted 市场检测 NO 端（inverted 市场的逻辑更复杂）
            if (!pair.isInverted && polyBook.bids.length > 0) {
                const noDepth = calculateNoSideDepth(
                    predictBook.bids,
                    predictBook.asks,
                    polyBook.bids,  // NO 的 bids，用于反演 YES ask
                    pair.feeRateBps || 200
                );

                // NO 端 Maker 机会
                if (noDepth.makerCost < 1 && noDepth.makerProfit > 0) {
                    const profitPercent = noDepth.makerProfit * 100;
                    const riskLevel = profitPercent > 2 ? 'LOW' : profitPercent > 1 ? 'MEDIUM' : 'HIGH';
                    opportunities.push({
                        marketId: pair.predictId,
                        title: pair.predictQuestion,
                        strategy: 'MAKER',
                        side: 'NO',
                        profitPercent,
                        maxQuantity: noDepth.makerMaxQuantity,
                        estimatedProfit: noDepth.makerProfit * noDepth.makerMaxQuantity,
                        predictPrice: noDepth.predictNoBid,
                        predictBid: noDepth.predictNoBid,
                        predictAsk: noDepth.predictNoAsk,
                        polymarketPrice: noDepth.polymarketYesAsk,
                        totalCost: noDepth.makerCost,
                        // 前端显示用 (美分单位)
                        makerCost: +(noDepth.makerCost * 100).toFixed(2),
                        takerCost: +(noDepth.takerCost * 100).toFixed(2),
                        depth: {
                            predict: noDepth.predictYesAskDepth,
                            polymarket: noDepth.polymarketNoBidDepth,
                            polymarketNoAskDepth: noDepth.polymarketNoBidDepth,
                            predictAskDepth: noDepth.predictYesBidDepth,
                            predictBidDepth: noDepth.predictYesAskDepth,
                        },
                        lastUpdate: Date.now(),
                        isInverted: pair.isInverted,

                        // 执行必需字段
                        polymarketConditionId: pair.polymarketConditionId,
                        polymarketSlug: getPolymarketSlug(pair.polymarketConditionId) || pair.polymarketSlug,
                        predictSlug: pair.categorySlug || getPredictSlug(pair.predictId) || generatePredictSlug(pair.predictQuestion),
                        polymarketNoTokenId: pair.polymarketNoTokenId || '',
                        polymarketYesTokenId: pair.polymarketYesTokenId || '',
                        tickSize: pair.tickSize,
                        feeRateBps: pair.feeRateBps,
                        negRisk: pair.negRisk,

                        // 风险和费用
                        risk: {
                            level: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
                            slippage: 0.5,
                        },
                        fees: {
                            predict: noDepth.predictFee,
                            gas: 0.01,
                        },
                        costs: {
                            total: noDepth.makerCost,
                        },
                        endDate: pair.endDate,
                        predictVolume: pair.predictVolume,
                        polyVolume: pair.polyVolume,
                    });
                    totalDepth += noDepth.makerMaxQuantity;
                }

                // NO 端 Taker 机会
                if (noDepth.takerCost < 1 && noDepth.takerProfit > 0) {
                    const profitPercent = noDepth.takerProfit * 100;
                    const riskLevel = profitPercent > 2 ? 'LOW' : profitPercent > 1 ? 'MEDIUM' : 'HIGH';
                    opportunities.push({
                        marketId: pair.predictId,
                        title: pair.predictQuestion,
                        strategy: 'TAKER',
                        side: 'NO',
                        profitPercent,
                        maxQuantity: noDepth.takerMaxQuantity,
                        estimatedProfit: noDepth.takerProfit * noDepth.takerMaxQuantity,
                        predictPrice: noDepth.predictNoAsk,
                        predictBid: noDepth.predictNoBid,
                        predictAsk: noDepth.predictNoAsk,
                        polymarketPrice: noDepth.polymarketYesAsk,
                        totalCost: noDepth.takerCost,
                        // 前端显示用 (美分单位)
                        makerCost: +(noDepth.makerCost * 100).toFixed(2),
                        takerCost: +(noDepth.takerCost * 100).toFixed(2),
                        depth: {
                            predict: noDepth.predictYesBidDepth,
                            polymarket: noDepth.polymarketNoBidDepth,
                            polymarketNoAskDepth: noDepth.polymarketNoBidDepth,
                            predictAskDepth: noDepth.predictYesBidDepth,
                            predictBidDepth: noDepth.predictYesAskDepth,
                        },
                        lastUpdate: Date.now(),
                        isInverted: pair.isInverted,

                        // 执行必需字段
                        polymarketConditionId: pair.polymarketConditionId,
                        polymarketSlug: getPolymarketSlug(pair.polymarketConditionId) || pair.polymarketSlug,
                        predictSlug: pair.categorySlug || getPredictSlug(pair.predictId) || generatePredictSlug(pair.predictQuestion),
                        polymarketNoTokenId: pair.polymarketNoTokenId || '',
                        polymarketYesTokenId: pair.polymarketYesTokenId || '',
                        tickSize: pair.tickSize,
                        feeRateBps: pair.feeRateBps,
                        negRisk: pair.negRisk,

                        // 风险和费用
                        risk: {
                            level: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
                            slippage: 0.5,
                        },
                        fees: {
                            predict: noDepth.predictFee,
                            gas: 0.01,
                        },
                        costs: {
                            total: noDepth.takerCost,
                        },
                        endDate: pair.endDate,
                        predictVolume: pair.predictVolume,
                        polyVolume: pair.polyVolume,
                    });
                    totalDepth += noDepth.takerMaxQuantity;
                }
            }
        }
    }

    // 更新缓存和标记新机会
    const cacheNow = Date.now();
    const fetchedIds = new Set<string>();
    const newActiveMarkets = new Set<number>();

    // Inject boost flags
    for (const opp of opportunities) {
        const boost = isMarketBoosted(opp.marketId);
        if (boost.boosted) {
            opp.boosted = true;
            opp.boostStartTime = boost.boostStartTime;
            opp.boostEndTime = boost.boostEndTime;
        }
    }

    for (const opp of opportunities) {
        const key = makeOpportunityKey(opp.marketId, opp.side, opp.strategy);
        fetchedIds.add(key);

        // 标记是否是新发现的机会
        const isNewOpportunity = !knownOpportunityIds.has(key);
        opp.isNew = isNewOpportunity;

        if (isNewOpportunity) {
            knownOpportunityIds.add(key);
            console.log(`[新机会] ${opp.title} | ${opp.side} ${opp.strategy} | ${opp.profitPercent.toFixed(2)}%`);
        }

        // 记录有套利机会的市场 ID
        newActiveMarkets.add(opp.marketId);
        opportunityCache.set(key, opp);
    }

    // TG 通知：当非活跃市场变成活跃市场时发送通知
    // 首次扫描时不发送通知，只填充缓存（避免启动时发送大量历史机会通知）
    // 可通过 ENABLE_ARB_TG_NOTIFICATION 开关控制
    const tg = getTelegramNotifier();
    if (tg && !isFirstScan && ENABLE_ARB_TG_NOTIFICATION) {
        // 找出新激活的市场（之前没有机会，现在有了）
        const newlyActivatedMarketIds = new Set<number>();
        for (const marketId of newActiveMarkets) {
            if (!previousActiveMarketIds.has(marketId)) {
                newlyActivatedMarketIds.add(marketId);
            }
        }

        if (newlyActivatedMarketIds.size > 0) {
            console.log(`[TG] 发现 ${newlyActivatedMarketIds.size} 个新激活的市场: ${[...newlyActivatedMarketIds].join(', ')}`);

            // 为每个新激活的市场发送通知（选择该市场最好的机会）
            // 使用 fire-and-forget 模式，不阻塞扫描循环
            for (const marketId of newlyActivatedMarketIds) {
                // 找到该市场的所有机会，选择利润率最高的
                const marketOpps = opportunities.filter(o => o.marketId === marketId);
                if (marketOpps.length === 0) continue;

                const bestOpp = marketOpps.reduce((best, curr) =>
                    curr.profitPercent > best.profitPercent ? curr : best
                );

                // 异步发送，不等待完成
                tg.alertArbitrage({
                    marketName: bestOpp.title,
                    predictMarketId: bestOpp.marketId,
                    mode: bestOpp.strategy,
                    side: bestOpp.side,
                    predictYesPrice: bestOpp.predictPrice,
                    polymarketNoPrice: bestOpp.polymarketPrice,
                    totalCost: bestOpp.totalCost,
                    profitPercent: bestOpp.profitPercent,
                    maxQuantity: bestOpp.maxQuantity,
                    endDate: bestOpp.endDate,
                }).catch(err => console.warn(`[TG] 发送失败: ${err.message}`));
            }
        }
    }

    // 首次扫描完成后清除标志
    if (isFirstScan) {
        console.log(`📢 首次扫描完成，已静默加载 ${opportunities.length} 个机会到缓存，后续新机会将发送 TG 通知`);
        isFirstScan = false;
    }

    // 更新活跃市场列表
    activeMarketIds.clear();
    for (const id of newActiveMarkets) {
        activeMarketIds.add(id);
    }

    // 更新失败市场列表：移除成功的，添加新失败的（非活跃市场）
    for (const id of thisRoundSucceeded) {
        failedMarketIds.delete(id);
    }
    for (const id of thisRoundFailed) {
        // 只添加非活跃市场到失败列表（活跃市场会在下次增量扫描中重试）
        if (!activeMarketIds.has(id)) {
            failedMarketIds.add(id);
        }
    }

    // 合并缓存：对于本次未获取到的市场，使用缓存数据（如果未过期）
    for (const [key, cachedOpp] of opportunityCache) {
        if (!fetchedIds.has(key)) {
            // 检查是否过期
            if (cacheNow - cachedOpp.lastUpdate < CACHE_EXPIRY_MS) {
                // 缓存的机会不是新的
                cachedOpp.isNew = false;
                opportunities.push(cachedOpp);
                // 保留缓存市场在活跃列表中
                activeMarketIds.add(cachedOpp.marketId);
            } else {
                // 过期则从缓存和已知集合中移除
                opportunityCache.delete(key);
                knownOpportunityIds.delete(key);
            }
        }
    }

    // 按 marketId 稳定排序（避免卡片跳动）
    opportunities.sort((a, b) => a.marketId - b.marketId);

    // 更新统计
    const makerOpps = opportunities.filter(o => o.strategy === 'MAKER');
    const takerOpps = opportunities.filter(o => o.strategy === 'TAKER');
    const avgProfit = opportunities.length > 0
        ? opportunities.reduce((sum, o) => sum + o.profitPercent, 0) / opportunities.length
        : 0;
    const maxProfit = opportunities.length > 0
        ? Math.max(...opportunities.map(o => o.profitPercent))
        : 0;

    dashboardData.opportunities = opportunities;
    dashboardData.stats.latency.predict = predictCount > 0 ? Math.round(predictLatencySum / predictCount) : 0;
    dashboardData.stats.latency.polymarket = polyCount > 0 ? Math.round(polyLatencySum / polyCount) : 0;
    dashboardData.stats.connectionStatus.predictApi = predictSuccess > 0 ? 'ok' : 'error';
    dashboardData.stats.connectionStatus.polymarketWs = getPolymarketWsStatus();
    dashboardData.stats.arbStats.makerCount = makerOpps.length;
    dashboardData.stats.arbStats.takerCount = takerOpps.length;
    dashboardData.stats.arbStats.avgProfit = avgProfit;
    dashboardData.stats.arbStats.maxProfit = maxProfit;
    dashboardData.stats.arbStats.totalDepth = totalDepth;
    dashboardData.stats.dataVersion++;  // 原子递增，与 opportunities 同一 tick 更新

    updateCount++;

    // 广播更新
    await broadcastUpdate();

    const time = new Date().toLocaleTimeString();
    const scannedCount = predictCount;
    // WS 驱动模式显示跳过计数
    const wsSkipInfo = wsSkippedCount > 0 ? ` | WS跳过: ${wsSkippedCount}` : '';
        console.log(`[${time}] #${updateCount} | 扫描: ${scannedCount}/${marketPairs.length} | 成功: P${predictSuccess}/M${polymarketSuccess} | Maker: ${makerOpps.length} | Taker: ${takerOpps.length} | 活跃: ${activeMarketIds.size}${wsSkipInfo}`);
    } finally {
        scanInProgress = false;
    }
}

// ============================================================================
// 统一配置清单 (WS 模式相关)
// ============================================================================

// --- 基础轮询 ---
const POLL_INTERVAL_MS = 2000;  // 主轮询间隔 (兜底用)
const ENABLE_SPORTS_SERVICE = true;  // 体育市场开关
const ENABLE_ARB_TG_NOTIFICATION = false;  // 套利机会 TG 通知开关

// --- 数据源模式 ---
// DASHBOARD_PREDICT_ORDERBOOK_MODE: ws | legacy
//   ws: WS 订阅 + 统一缓存 (实时，推荐)
//   legacy: REST 轮询 (兼容模式)
const DASHBOARD_PREDICT_ORDERBOOK_MODE = (process.env.DASHBOARD_PREDICT_ORDERBOOK_MODE || 'ws') as 'ws' | 'legacy';
const POLY_ORDERBOOK_SOURCE = (process.env.POLY_ORDERBOOK_SOURCE || 'ws').toLowerCase();

// --- 缓存与过期 ---
// UI 展示用 (允许 30s 过期，保持连续性)
const PREDICT_ORDERBOOK_STALE_MS = Number(process.env.PREDICT_ORDERBOOK_STALE_MS) || 30000;
// 计算/交易用 (严格 10s 过期，防止用过期数据计算利润)
const CALC_ORDERBOOK_STALE_MS = Number(process.env.CALC_ORDERBOOK_STALE_MS) || 10000;
const PREDICT_ORDERBOOK_WARM_ON_SUBSCRIBE = process.env.PREDICT_ORDERBOOK_WARM_ON_SUBSCRIBE !== 'false';

// --- WS 健康与断连处理 ---
// 注意：健康检查分为"连接健康"和"数据新鲜度"两层
//   - 连接健康：WS 物理连接是否存活 (用于任务暂停/恢复)
//   - 数据新鲜度：订单簿数据是否在阈值内 (用于计算是否参与)
const WS_HEALTH_CHECK_MS = Number(process.env.DASHBOARD_WS_HEALTH_CHECK_MS) || 5000;
const WS_DISCONNECT_PAUSE_MS = Number(process.env.DASHBOARD_WS_DISCONNECT_PAUSE_MS) || 30000;
const WS_RECONNECT_RESUME_DELAY_MS = Number(process.env.DASHBOARD_WS_RECONNECT_RESUME_DELAY_MS) || 3000;

// --- Hybrid 兜底轮询 ---
// 注意：Hybrid 仅用于"订阅预热/连接断开时保持缓存"，不用于计算数据源
// 计算数据源严格遵循 WS-only 或 legacy 模式
const HYBRID_FALLBACK_ENABLED = process.env.HYBRID_FALLBACK_ENABLED !== 'false';
const HYBRID_FALLBACK_INTERVAL_MS = Number(process.env.HYBRID_FALLBACK_INTERVAL_MS) || 5000;

// --- WS 驱动计算 ---
// true: 主扫描只更新市场列表，计算完全由 WS 触发
// false: 主扫描也参与计算 (兼容模式)
const WS_DRIVEN_CALCULATION = process.env.WS_DRIVEN_CALCULATION !== 'false';

// --- WS 健康状态 ---
let predictWsConnected = true;     // Predict WS 物理连接状态
let predictWsLastUpdate = 0;       // 最后一次 WS 更新时间
let predictWsDisconnectedAt = 0;   // WS 断连时间点
let tasksPausedDueToWs = false;    // 任务是否因 WS 断连而暂停
let hybridFallbackActive = false;  // Hybrid 兜底是否激活

// --- WS 驱动计算跟踪 ---
// 记录每个市场最后一次被 WS 更新的时间戳
// 用于机会管理和新鲜度检查
const lastWsUpdateByMarket = new Map<number, number>();
const lastPolyWsUpdateByToken = new Map<string, number>();

// ============================================================================
// 获取 Predict 市场详情 (包含 feeRateBps)
// ============================================================================

async function fetchPredictMarketDetail(marketId: number, apiKey?: string): Promise<{ feeRateBps: number; endDate?: string } | null> {
    try {
        const key = apiKey || scanApiKeys.getNextKey();
        recordApiKeyUsage(key);
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}`, {
            headers: { 'x-api-key': key }
        });

        if (!res.ok) return null;

        const data = await res.json() as { data?: { feeRateBps?: number; endDate?: string } };
        return {
            feeRateBps: data.data?.feeRateBps ?? 200,
            endDate: data.data?.endDate
        };
    } catch {
        return null;
    }
}

// ============================================================================
// 主入口
// ============================================================================

const polymarketEventMarketsCache = new Map<string, Array<{ conditionId: string; question?: string; slug?: string }>>();

function normalizeQuestionForMatch(text: string): string {
    return String(text || '')
        .toLowerCase()
        .replace(/[’']/g, "'")
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\bany other\b/g, 'another');
}

async function tryFixPolymarketConditionIdForAnyOther(
    predictQuestion: string,
    currentPolymarketQuestion: string,
    currentMarketSlug: string | null
): Promise<{ conditionId: string; question?: string; slug?: string } | null> {
    if (!/\bany other\b/i.test(predictQuestion)) return null;
    if (/\b(any other|another)\b/i.test(currentPolymarketQuestion)) return null;
    if (!currentMarketSlug) return null;

    // 通过 /market/{slug} 的 307 Location 解析 event slug
    let eventSlug: string | null = null;
    try {
        const res = await fetch(`https://polymarket.com/market/${currentMarketSlug}`, {
            method: 'HEAD',
            redirect: 'manual',
        });
        const location = res.headers.get('location') || '';
        const m = location.match(/^\/event\/([^/]+)\/[^/]+/);
        if (m?.[1]) eventSlug = m[1];
    } catch {
        return null;
    }
    if (!eventSlug) return null;

    let markets = polymarketEventMarketsCache.get(eventSlug);
    if (!markets) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(eventSlug)}`, {
                signal: controller.signal,
            }).finally(() => clearTimeout(timeoutId));
            if (!res.ok) return null;
            const events = await res.json() as Array<{ markets?: Array<{ conditionId: string; question?: string; slug?: string }> }>;
            markets = events[0]?.markets || [];
            polymarketEventMarketsCache.set(eventSlug, markets);
        } catch {
            return null;
        }
    }

    const target = normalizeQuestionForMatch(predictQuestion);
    const hit = markets.find(m => normalizeQuestionForMatch(m.question || '') === target);
    if (!hit?.conditionId) return null;
    return hit;
}

async function main(): Promise<void> {
    console.log('🚀 启动 Dashboard（深度计算模式）\n');

    // 尽早注册优雅关闭处理，避免启动阶段 Ctrl+C 直接杀进程导致取消请求发不出去
    setupGracefulShutdown();

    // 初始化 TaskService
    await taskService.init();
    console.log('✅ TaskService 已初始化\n');

    // 初始化 TaskExecutor
    try {
        const opportunities: ArbOpportunity[] = [];
        await taskExecutor.init();
        console.log('✅ TaskExecutor 已初始化\n');
    } catch (error: any) {
        console.warn('⚠️  TaskExecutor 初始化失败 (交易功能不可用):', error.message);
        console.log('   请检查环境变量: PREDICT_SIGNER_PRIVATE_KEY, POLYMARKET_* 配置\n');
    }

    // 初始化 BSC WSS 订单监听（必需；用于加速 Predict 成交确认）
    // BSC WSS 连接失败将终止 dashboard
    if (process.env.PREDICT_SMART_WALLET_ADDRESS) {
        const bscWatcher = getBscOrderWatcher();

        // 先注册事件监听器（不依赖连接状态）
        bscWatcher.on('orderFilled', (event: BscOrderFilledEvent) => {
            // 仅广播"自己的订单"，避免全网 OrderFilled 触发 SSE 刷屏/背压断开
            const smartWallet = process.env.PREDICT_SMART_WALLET_ADDRESS?.toLowerCase();
            if (smartWallet) {
                const maker = event.maker.toLowerCase();
                const taker = event.taker.toLowerCase();
                const isMine = maker === smartWallet || taker === smartWallet;
                if (!isMine) return;
            }

            const tokenId = event.makerAssetId === '0' ? event.takerAssetId : event.makerAssetId;
            const marketInfo = bscWatcher.parseMarketFromEvent(event);
            broadcastBscOrderFilled({
                type: 'bscOrderFilled',
                event,
                tokenId,
                marketId: marketInfo?.market.marketId,
                marketTitle: marketInfo?.market.title,
                side: marketInfo?.side,
            });
            scheduleCloseRecompute(true);
        });

        // 注册 error 监听器，记录运行时错误（不终止进程，让重连机制处理）
        bscWatcher.on('error', (err) => {
            console.error(`[BSC WSS] 运行时错误: ${err?.message || err}`);
        });

        // 注册断开事件监听器
        bscWatcher.on('disconnected', () => {
            console.warn('[BSC WSS] 连接断开，正在重连...');
        });

        bscWatcher.once('connected', () => {
            console.log('✅ BSC Order Watcher 已连接 (实时监控链上订单)\n');
        });

        // 阻塞启动 - BSC WSS 是必需的，连接失败则终止 dashboard
        console.log('⏳ BSC Order Watcher 正在连接...');
        try {
            await bscWatcher.start();
        } catch (err: any) {
            console.error('\n❌ BSC Order Watcher 启动失败:', err?.message || err);
            console.error('   BSC WSS 连接是必需的，无法继续启动 dashboard');
            console.error('   请检查网络连接或设置 BSC_WSS_URLS 环境变量\n');
            process.exit(1);
        }

        // TokenMarketCache 也阻塞启动
        if (process.env.PREDICT_API_KEY) {
            const tokenCache = getTokenMarketCache(process.env.PREDICT_API_KEY);

            tokenCache.on('refreshed', () => {
                bscWatcher.setTokenMarketMappings(tokenCache.exportTokenMappings());
            });

            try {
                await tokenCache.start();
                bscWatcher.setTokenMarketMappings(tokenCache.exportTokenMappings());
                console.log('✅ TokenMarketCache 已就绪\n');
            } catch (err: any) {
                console.warn('⚠️  TokenMarketCache 启动失败:', err?.message || err);
                // TokenMarketCache 失败不终止，只是没有市场名称映射
            }
        }

        // 初始化 Predict WS 钱包事件监听（API 级别订单状态推送）
        // 补充 BSC 链上事件，提供完整订单生命周期通知
        try {
            const predictWatcher = getPredictOrderWatcher();

            // 监听所有钱包事件（包括未成交的订单状态）
            // 监听所有钱包事件（包括订单创建、接受、取消等）
            predictWatcher.on('walletEvent', (walletEvent: WalletEventData) => {
                // 从事件中提取 tokenId 用于市场匹配
                const rawData = walletEvent.rawData as any;
                const tokenId = String(rawData?.makerAssetId || rawData?.order?.makerAssetId || rawData?.tokenId || '');
                const tokenCache = getTokenMarketCache();
                const marketInfo = tokenId && tokenCache.isReady() ? tokenCache.getMarketByTokenId(tokenId) : null;

                broadcastPredictWalletEvent({
                    type: 'predictWalletEvent',
                    event: walletEvent,
                    marketId: marketInfo?.market.marketId,
                    marketTitle: marketInfo?.market.title,
                });
            });

            predictWatcher.on('subscriptionLost', (info: { reason: string }) => {
                console.warn(`[PredictOrderWatcher] 订阅断开: ${info.reason}`);
            });

            predictWatcher.on('subscriptionRestored', () => {
                console.log('[PredictOrderWatcher] 订阅已恢复');
            });

            await predictWatcher.start();
            console.log('✅ Predict WS 钱包事件监听已启动 (订单生命周期推送)\n');
        } catch (err: any) {
            console.warn('⚠️  Predict WS 钱包事件监听启动失败:', err?.message || err);
            console.warn('   手动下单状态推送将不可用，但链上成交通知正常');
        }
    } else {
        console.log('ℹ️  未配置 PREDICT_SMART_WALLET_ADDRESS，跳过 BSC WSS 订单监听\n');
    }

    // 监听任务事件并广播给 SSE 客户端
    taskService.on('task:created', (task: Task) => broadcastTaskUpdate(task));
    taskService.on('task:updated', (task: Task) => broadcastTaskUpdate(task));
    taskService.on('task:deleted', (taskId: string) => broadcastTaskDeleted(taskId));

    // 监听 TaskExecutor 事件
    taskExecutor.on('task:updated', (task: Task) => broadcastTaskUpdate(task));

    // 连接 TaskLogger SSE 通知 (独立于 Telegram，用于前端浮窗通知)
    {
        const taskLogger = getTaskLogger();
        taskLogger.connectNotifier(({ taskId, event }) => {
            // 广播任务事件到前端 (用于订单状态浮窗通知)
            const ssePayload = {
                taskId,
                type: event.type,
                timestamp: event.timestamp,
                platform: (event.payload as any)?.platform,
                side: (event.payload as any)?.side,
                price: (event.payload as any)?.price,
                quantity: (event.payload as any)?.quantity,
                filledQty: (event.payload as any)?.filledQty,
                avgPrice: (event.payload as any)?.avgPrice,
                error: (event.payload as any)?.error,
                reason: (event.payload as any)?.reason,
            };
            broadcastSSEGlobal('taskEvent', JSON.stringify(ssePayload));
        });
        console.log('✅ TaskLogger SSE 通知已连接 (前端浮窗)\n');
    }

    // 连接 Telegram 通知 (如果配置了)
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    if (telegramToken && telegramChatId) {
        const telegram = createTelegramNotifier({
            botToken: telegramToken,
            chatId: telegramChatId,
            enabled: true,
        });
        const taskLogger = getTaskLogger();
        taskLogger.connectNotifier(({ taskId, event }) => {
            const text = taskLogger.formatEventForNotification(taskId, event);
            // fire-and-forget，不阻塞任务执行
            telegram.sendText(text).catch(err =>
                console.warn(`[TaskLogger TG] 发送失败: ${err.message}`)
            );
        });
        console.log('✅ Telegram 通知已连接\n');

        // Polymarket User WS 订单通知已禁用
        // （TaskLogger 已经报告 CLOB 成交，WS 的链上确认通知有延迟且重复）
        // startWsOrderNotifierFromEnv()
        //     .then(() => console.log('✅ WS 订单通知服务已启动 (实时推送 Polymarket 订单状态到 Telegram)'))
        //     .catch((e: any) => console.warn(`⚠️  WS 订单通知服务启动失败: ${e?.message || e}`));

        // 启动 BSC 订单通知（只通知自己的订单；需配置 PREDICT_SMART_WALLET_ADDRESS）
        // 非阻塞启动，避免卡住 dashboard
        startBscOrderNotifierFromEnv()
            .then((started) => {
                if (started) console.log('✅ BSC 订单通知服务已启动 (实时推送 Predict 链上订单到 Telegram)');
            })
            .catch((e: any) => console.warn(`⚠️  BSC 订单通知服务启动失败: ${e?.message || e}`));
    } else {
        console.log('⚠️  Telegram 未配置 (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)\n');
    }

    // 启动全局敞口定时检测
    startExposureMonitor();

    // 构建 conditionId → 事件 endDate 映射 (用于显示与 Polymarket 前端一致的结算时间)
    // 非阻塞启动，映射完成后市场列表会自动获取到 endDate
    console.log('🔄 正在后台构建 endDate 映射...');
    buildEventEndDateMapping()
        .then(() => console.log('✅ endDate 映射完成'))
        .catch((e: any) => console.warn(`⚠️  endDate 映射失败: ${e?.message || e}`));

    // 加载已匹配的市场对
    const matchResultPath = join(__dirname, '..', '..', 'polymarket-match-result.json');

    // 默认启动时刷新市场，除非指定 --use-cache
    const useCache = process.argv.includes('--use-cache') || process.argv.includes('--cache');
    const backgroundRescan = process.argv.includes('--rescan') || process.argv.includes('--scan');

    // 检查缓存时间
    let cacheAge = 0;
    if (existsSync(matchResultPath)) {
        const { statSync } = await import('fs');
        const stats = statSync(matchResultPath);
        cacheAge = Math.floor((Date.now() - stats.mtimeMs) / 1000 / 60); // 分钟
    }

    if (!useCache || !existsSync(matchResultPath)) {
        if (!existsSync(matchResultPath)) {
            console.log('🔍 未找到缓存文件，正在扫描市场...\n');
        } else {
            console.log('🔍 启动时刷新市场列表...\n');
        }

        // 执行扫描（windowsHide 防止弹出 cmd 窗口）
        const { execSync } = await import('child_process');
        try {
            const opportunities: ArbOpportunity[] = [];
            const output = execSync('npx tsx src/terminal/scan-all-markets.ts', {
                cwd: join(__dirname, '..', '..'),
                stdio: 'pipe',
                windowsHide: true,
                encoding: 'utf-8',
            });
            if (output) console.log(output);
            console.log('\n✅ 市场扫描完成\n');
        } catch (error: any) {
            // execSync 失败时 stdout/stderr 在 error 对象中
            if (error.stdout) console.log(error.stdout);
            if (error.stderr) console.error(error.stderr);
            console.error('❌ 扫描失败');
            if (!existsSync(matchResultPath)) {
                console.error('   没有可用的市场数据，退出\n');
                process.exit(1);
            }
            console.log('   使用现有缓存继续...\n');
        }
    } else if (backgroundRescan) {
        console.log('🔍 检测到 --rescan 参数，将在后台更新市场列表\n');
        // 后台异步扫描（windowsHide 防止弹出 cmd 窗口）
        import('child_process').then(({ exec }) => {
            exec('npx tsx src/terminal/scan-all-markets.ts', {
                cwd: join(__dirname, '..', '..'),
                windowsHide: true,
            }, (error) => {
                if (error) {
                    console.error('❌ 后台扫描失败:', error);
                } else {
                    console.log('\n✅ 后台扫描完成，重启 Dashboard 以加载新数据\n');
                }
            });
        });
    } else {
        console.log(`📂 使用缓存 (--use-cache)，缓存时间: ${cacheAge}分钟前\n`);
    }

    if (existsSync(matchResultPath)) {
        // 重新读取缓存时间
        const { statSync } = await import('fs');
        const stats = statSync(matchResultPath);
        const fileAge = Math.floor((Date.now() - stats.mtimeMs) / 1000 / 60); // 分钟
        console.log(`📂 加载市场数据... (缓存: ${fileAge}分钟前)\n`);

        const matchResult = JSON.parse(readFileSync(matchResultPath, 'utf-8'));
        const activeMatches = (matchResult.matches || []).filter((m: any) =>
            m.polymarket.active && !m.polymarket.closed && m.polymarket.acceptingOrders
        );

        console.log(`  共 ${activeMatches.length} 个活跃市场，正在获取详情...\n`);

        // 提取所有 categorySlug 并构建 Predict endsAt 缓存
        const categorySlugs = activeMatches
            .map((m: any) => m.predict?.categorySlug)
            .filter(Boolean) as string[];
        if (categorySlugs.length > 0) {
            await buildPredictEndsAtMapping(categorySlugs);
        }

        // 使用所有 3 个 key 并发批量获取
        const allKeys = getAllScanKeys();
        const BATCH_SIZE = allKeys.length * 3;  // 每批 3*3=9 个并发
        console.log(`  使用 ${allKeys.length} 个 API key 并发获取\n`);

        let processed = 0;
        for (let i = 0; i < activeMatches.length; i += BATCH_SIZE) {
            const batch = activeMatches.slice(i, i + BATCH_SIZE);

            const results = await Promise.all(batch.map(async (match: any, idx: number) => {
                let conditionId = match.polymarket.conditionId;
                const apiKey = allKeys[idx % allKeys.length];
                const predictQuestion = match.predict.question || match.predict.title || '';

                let [marketInfo, marketDetail] = await Promise.all([
                    getPolymarketMarketInfo(conditionId),
                    fetchPredictMarketDetail(match.predict.id, apiKey),
                ]);
                let endDate = getPolymarketEndDate(conditionId);

                // 修复少量 “any other” 市场被错误绑定到具体选手/标的的情况
                const fixed = await tryFixPolymarketConditionIdForAnyOther(
                    predictQuestion,
                    match.polymarket.question || '',
                    marketInfo?.slug || null
                );
                if (fixed?.conditionId && fixed.conditionId !== conditionId) {
                    const fixedConditionId = fixed.conditionId;
                    const fixedMarketInfo = await getPolymarketMarketInfo(fixedConditionId);
                    if (fixedMarketInfo?.tokenId) {
                        console.log(`\n  🔧 [FixLink] Predict#${match.predict.id} conditionId override: ${conditionId.slice(0, 10)}… -> ${fixedConditionId.slice(0, 10)}…`);
                        conditionId = fixedConditionId;
                        marketInfo = fixedMarketInfo;
                        endDate = getPolymarketEndDate(fixedConditionId);
                    }
                }

                if (marketInfo && marketInfo.tokenId) {
                    // 优先使用 Polymarket endDate，如果过期则使用 Predict endsAt 作为备选
                    const predictEndsAt = getPredictEndsAt(match.predict?.categorySlug);
                    const finalEndDate = isEndDateValid(endDate)
                        ? endDate
                        : (predictEndsAt || undefined);
                    return {
                        predictId: match.predict.id,
                        predictTitle: match.predict.title,
                        predictQuestion,
                        categorySlug: match.predict.categorySlug,
                        polymarketConditionId: conditionId,
                        polymarketSlug: marketInfo.slug || undefined,
                        polymarketTokenId: marketInfo.tokenId,
                        polymarketNoTokenId: marketInfo.noTokenId || undefined,
                        polymarketYesTokenId: marketInfo.yesTokenId || undefined,
                        tickSize: marketInfo.tickSize,
                        feeRateBps: marketDetail?.feeRateBps ?? 200,
                        isInverted: match.inverted === true,
                        endDate: finalEndDate,
                        negRisk: marketInfo.negRisk,
                    };
                }
                return null;
            }));

            for (const result of results) {
                if (result) marketPairs.push(result);
            }

            processed += batch.length;
            process.stdout.write(`\r  已处理 ${processed}/${activeMatches.length} 个市场`);
        }

        console.log('\n');
        dashboardData.stats.marketsMonitored = marketPairs.length;

        // 显示费率统计
        const feeStats = new Map<number, number>();
        for (const pair of marketPairs) {
            feeStats.set(pair.feeRateBps, (feeStats.get(pair.feeRateBps) || 0) + 1);
        }
        console.log('📊 费率分布:');
        for (const [fee, count] of Array.from(feeStats.entries()).sort((a, b) => a[0] - b[0])) {
            console.log(`   ${fee / 100}%: ${count} 个市场`);
        }

        console.log(`\n✅ 加载了 ${marketPairs.length} 个市场对\n`);

        // 获取 volume 数据
        await fetchMarketVolumes();

        // 自动缓存 Predict slugs (用于 View 导航 URL)
        // 使用 predictQuestion (完整市场标题) 匹配 browser-slugs.json，而非 predictTitle (选项名)
        cachePredictSlugs(marketPairs.map(p => ({ id: p.predictId, title: p.predictQuestion })));

        // 注入市场标题查找器到 account-service (使用 predictQuestion 完整标题)
        const marketTitleMap = new Map(marketPairs.map(p => [p.predictId, p.predictQuestion]));
        setMarketTitleResolver((predictId: number) => marketTitleMap.get(predictId));
    } else {
        console.log('❌ 未找到匹配结果文件: polymarket-match-result.json');
        console.log('   请先运行: npm run scan-markets\n');
        process.exit(1);
    }

    if (marketPairs.length === 0) {
        console.log('❌ 没有可用的市场对\n');
        process.exit(1);
    }

    // 初始化体育市场服务 (可通过 ENABLE_SPORTS_SERVICE 开关控制)
    let sportsService: ReturnType<typeof getSportsService> | null = null;
    if (ENABLE_SPORTS_SERVICE) {
        console.log('🔄 正在初始化体育市场服务...');
        sportsService = getSportsService();
        console.log('✅ SportsService 已初始化\n');
    } else {
        console.log('⏸️  体育市场服务已禁用 (ENABLE_SPORTS_SERVICE=false)\n');
    }

    // 连接 Polymarket WebSocket (只订阅主市场 tokens，体育市场通过 REST 轮询)
    console.log('🔄 正在连接 Polymarket WebSocket...');
    await initPolymarketWs();
    console.log('✅ Polymarket WebSocket 已连接\n');

    // 初始化 Predict 订单簿数据源
    if (DASHBOARD_PREDICT_ORDERBOOK_MODE === 'ws') {
        console.log('🔄 正在初始化 Predict WebSocket 订单簿缓存...');
        usePredictWsMode = true;

        const apiKey = process.env.PREDICT_API_KEY;
        if (!apiKey) {
            console.error('❌ 缺少 PREDICT_API_KEY，无法初始化 WS 模式');
            process.exit(1);
        }

        // 初始化统一缓存（WS 优先，允许 stale 数据避免频繁缺失）
        // 注意：Predict WS 仅推增量，无初始快照，必须 allowStale 或 warm
        await initPredictOrderbookCache({
            apiKey,
            wsEnabled: true,
            restEnabled: true,  // 允许 REST 作为兜底和 warm
            ttlMs: PREDICT_ORDERBOOK_STALE_MS,
            allowStale: true,   // 允许使用过期数据（WS 无快照时避免大量 null）
        });

        // 先订阅主市场 ID（体育市场在 scan() 后补订阅）
        const marketIds = marketPairs.map(p => p.predictId);

        // 批量订阅主市场
        const unifiedCache = getPredictOrderbookCache();
        if (unifiedCache) {
            await unifiedCache.subscribeMarkets(marketIds);
            console.log(`✅ Predict WebSocket 已连接，订阅 ${marketIds.length} 个主市场`);

            // 心跳快照: WS 订阅后用 REST warm 缓存（Predict WS 无初始快照）
            if (PREDICT_ORDERBOOK_WARM_ON_SUBSCRIBE) {
                console.log(`🔥 正在用 REST 预热订单簿缓存 (${marketIds.length} 个市场)...`);
                const warmStart = Date.now();
                const WARM_BATCH_SIZE = 10;
                const WARM_BATCH_DELAY_MS = 200;
                let warmedCount = 0;

                for (let i = 0; i < marketIds.length; i += WARM_BATCH_SIZE) {
                    const batch = marketIds.slice(i, i + WARM_BATCH_SIZE);
                    await Promise.all(batch.map(async (marketId) => {
                        try {
                            const book = await unifiedCache.getOrderbook(marketId);
                            if (book) warmedCount++;
                        } catch {
                            // 静默失败
                        }
                    }));
                    if (i + WARM_BATCH_SIZE < marketIds.length) {
                        await new Promise(r => setTimeout(r, WARM_BATCH_DELAY_MS));
                    }
                }
                console.log(`✅ 预热完成: ${warmedCount}/${marketIds.length} 个市场，耗时 ${Date.now() - warmStart}ms`);
            }

            console.log(`   ⏳ 体育市场将在 scan() 完成后补订阅\n`);

            // 注入 Sports Service 的 Predict 订单簿 provider
            setSportsPredictOrderbookProvider((marketId: number) => {
                const cached = unifiedCache.getOrderbookSync(marketId);
                if (!cached) return null;
                return {
                    bids: cached.bids.map(l => [l.price, l.size] as [number, number]),
                    asks: cached.asks.map(l => [l.price, l.size] as [number, number]),
                };
            });

            // 注册 Predict WS 更新回调，触发机会重算
            // 与 Polymarket WS 保持一致的处理逻辑
            unifiedCache.onUpdate((marketId: number, _book: CachedOrderbook) => {
                if (_book.source !== 'ws') return;
                // 记录 Predict WS 更新时间戳
                lastWsUpdateByMarket.set(marketId, Date.now());

                // 触发机会重算（节流）
                handlePredictWsUpdate(marketId);
            });
            console.log(`✅ Predict WS 更新回调已注册`);
        }
    } else {
        console.log('ℹ️  Predict 订单簿使用 Legacy 模式 (REST 轮询)\n');
        usePredictWsMode = false;
        // Legacy 模式下不注入 provider，sports-service 使用 REST
        setSportsPredictOrderbookProvider(null);
    }

    // 构建 tokenId → marketPair 索引（用于 WS 增量更新）
    buildTokenIdIndex();

    // 订阅主市场 tokens (体育市场通过 REST API 轮询)
    subscribePolymarketTokens();

    // 注入 Polymarket WS 客户端给交易执行器（仅主市场 WS，体育仍走 REST）
    taskExecutor.setPolymarketWsClient(getPolymarketWsClient());

    // 动态订阅需要恢复的任务使用的 tokens（可能不在当前 marketPairs 中）
    const recoverableStatuses: Task['status'][] = [
        'PREDICT_SUBMITTED', 'PARTIALLY_FILLED', 'HEDGING', 'HEDGE_PENDING',
        'HEDGE_RETRY', 'UNWINDING', 'UNWIND_PENDING', 'PAUSED',
    ];
    const tasksToRecover = taskService.getTasks({ status: recoverableStatuses });
    if (tasksToRecover.length > 0 && polymarketWsClient?.isConnected()) {
        const taskTokens: string[] = [];
        for (const task of tasksToRecover) {
            if (task.polymarketYesTokenId) taskTokens.push(task.polymarketYesTokenId);
            if (task.polymarketNoTokenId) taskTokens.push(task.polymarketNoTokenId);
        }
        if (taskTokens.length > 0) {
            polymarketWsClient.subscribe(taskTokens);
            console.log(`[WS] 动态订阅 ${taskTokens.length} 个任务 token (${tasksToRecover.length} 个待恢复任务)`);
        }
    }

    // 等待 WS 初始快照返回（订阅后服务器异步推送，通常 1-2 秒内完成）
    // 避免 triggerAutoRecovery 时快照还没到导致 REST fallback
    await new Promise(r => setTimeout(r, 2000));

    // 在 WS 客户端注入后触发任务自动恢复
    await taskExecutor.triggerAutoRecovery();

    // 启动 HTTP 服务器 (固定端口,自动清理占用进程)
    const targetPort = Number(PORT);

    // 前置检查：如果端口被占用，先清理
    killProcessOnPort(targetPort);
    await new Promise(r => setTimeout(r, 500)); // 等待端口释放

    const server = createServer(handleRequest);
    httpServer = server;
    await new Promise<void>((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`\n❌ 端口 ${targetPort} 仍被占用，启动失败`);
                console.error(`   请手动运行: taskkill /F /PID <PID>\n`);
            }
            reject(err);
        });
        // 监听所有接口 (0.0.0.0)，允许局域网访问
        server.listen(targetPort, '0.0.0.0', () => resolve());
    });

    // 获取局域网 IP (ESM 环境不可用 require，使用 dynamic import)
    const getLocalIP = async (): Promise<string> => {
        try {
            const { networkInterfaces } = await import('os');
            const nets = networkInterfaces();
            for (const name of Object.keys(nets)) {
                for (const net of nets[name] || []) {
                    if (net.family === 'IPv4' && !net.internal) {
                        return net.address;
                    }
                }
            }
            return 'localhost';
        } catch {
            return 'localhost';
        }
    };
    const localIP = await getLocalIP();

    console.log(`📊 Dashboard 运行在 http://localhost:${targetPort}`);
    console.log(`🌐 局域网访问: http://${localIP}:${targetPort}\n`);
    console.log(`📡 SSE 端点: http://localhost:${targetPort}/api/stream`);
    console.log(`📋 数据端点: http://localhost:${targetPort}/api/data\n`);

    // 首次扫描 (并行执行: Live 套利 + 体育市场 + 账户数据预加载)
    console.log(`🚀 并行扫描: Live 套利${sportsService ? '、体育市场' : ''}、账户数据...`);
    const startScanTime = Date.now();

    // 带超时的包装函数
    const withTimeout = <T>(promise: Promise<T>, ms: number, name: string): Promise<T> =>
        Promise.race([
            promise,
            new Promise<T>((_, reject) =>
                setTimeout(() => reject(new Error(`${name} 超时 (${ms / 1000}s)`)), ms)
            )
        ]);

    const scanTasks: Promise<void>[] = [
        // 1. Live 套利扫描 (60秒超时)
        withTimeout(detectArbitrageOpportunities(), 60000, 'Live套利扫描')
            .then(() => console.log('  ✓ Live 套利扫描完成'))
            .catch(err => console.warn('  ✗ Live 套利扫描失败:', err.message)),
        // 2. 账户数据预加载 (10秒超时)
        withTimeout(getAccountData(), 10000, '账户数据')
            .then(() => console.log('  ✓ 账户数据预加载完成'))
            .catch(err => console.warn('  ✗ 账户数据预加载失败:', err.message)),
        // 3. Boost data fetch (15s timeout)
        withTimeout(fetchBoostData(), 15000, 'BoostData')
            .then(() => console.log(`  OK Boost data fetched (${getBoostCache().size} boosted markets)`))
            .catch(err => console.warn('  WARN Boost data fetch failed:', err.message)),
    ];

    // 3. 体育市场扫描 (仅当启用时)
    if (sportsService) {
        scanTasks.push(
            withTimeout(sportsService.scan(), 60000, '体育市场扫描')
                .then(() => console.log(`  ✓ 体育市场扫描完成 (${sportsService!.getMarkets().length} 场比赛)`))
                .catch(err => console.warn('  ✗ 体育市场扫描失败:', err.message))
        );
    }

    // 4. 流动性扫描 (后台，120秒超时)
    const apiKeyForLiquidity = process.env.PREDICT_API_KEY;
    if (apiKeyForLiquidity) {
        scanTasks.push(
            withTimeout(runLiquidityScan(apiKeyForLiquidity, { silent: true }), 120000, '流动性扫描')
                .then(result => {
                    cachedLiquidityData = result;
                    lastLiquidityScanTime = Date.now();
                    console.log(`  ✓ 流动性扫描完成 (${result.valid} 个市场, CSV: ${result.csvPath})`);
                })
                .catch(err => console.warn('  ✗ 流动性扫描失败:', err.message))
        );
    }

    await Promise.all(scanTasks);
    console.log(`✅ 并行扫描完成，耗时 ${((Date.now() - startScanTime) / 1000).toFixed(1)}s\n`);

    // 体育市场订单簿补订阅 (scan 完成后才有 marketId/tokenId)
    if (sportsService) {
        // 1. Predict 订单簿补订阅
        if (usePredictWsMode) {
            const sportsMarketIds = sportsService.getMarkets().map(m => m.predictMarketId).filter(Boolean);
            if (sportsMarketIds.length > 0) {
                const unifiedCache = getPredictOrderbookCache();
                if (unifiedCache) {
                    await unifiedCache.subscribeMarkets(sportsMarketIds);
                    console.log(`✅ 体育市场 Predict 订单簿已补订阅: ${sportsMarketIds.length} 个市场`);
                }
            }
        }

        // 体育市场 Polymarket 使用 REST API，无需 WS 订阅
        console.log('');  // 空行分隔
    }

    // 主轮询 (LIVE 标签页套利机会)
    console.log(`⏱️  主轮询间隔: ${POLL_INTERVAL_MS / 1000} 秒\n`);

    // 带超时保护的轮询 (防止卡死)
    const POLL_TIMEOUT_MS = 60000; // 60秒轮询超时
    let lastPollStart = 0;
    mainPollInterval = setInterval(async () => {
        if (shutdownRequested) return;
        // 超时保护：如果上一轮超过60秒未完成，强制重置状态
        if (scanInProgress && lastPollStart > 0 && Date.now() - lastPollStart > POLL_TIMEOUT_MS) {
            console.warn(`[超时保护] 轮询超时 ${Math.round((Date.now() - lastPollStart) / 1000)}s，强制重置状态`);
            scanInProgress = false;
        }

        if (!scanInProgress) {
            lastPollStart = Date.now();
            await detectArbitrageOpportunities();
        }
    }, POLL_INTERVAL_MS);

    // 注入 Predict 订单簿缓存提供者（任务执行时复用缓存，减少 API 调用）
    // Boost data refresh (5 minutes)
    boostRefreshInterval = setInterval(async () => {
        if (shutdownRequested) return;
        await fetchBoostData();
    }, BOOST_REFRESH_INTERVAL_MS);

    setPredictOrderbookCacheProvider(getPredictOrderbookFromCache);  // PredictTrader 用
    setPredictOrderbookRestFallbackEnabled(!usePredictWsMode);
    setClosePredictOrderbookProvider(getPredictOrderbookForCloseService);  // close-service 用
    console.log('[Cache] Predict 订单簿缓存提供者已注入 (PredictTrader + close-service)');

    // 体育市场订单簿刷新 (仅当启用时)
    if (sportsService) {
        // Polymarket: 0.1 秒 (无限流)
        // Predict: 0.5 秒 (有限流)
        const POLY_REFRESH_MS = 100;
        const PREDICT_REFRESH_MS = 500;

        polyRefreshInterval = setInterval(async () => {
            if (shutdownRequested) return;
            try {
                await sportsService!.refreshPolymarketOrderbooks();
            } catch (error: any) {
                // 静默
            }
        }, POLY_REFRESH_MS);

        predictRefreshInterval = setInterval(async () => {
            if (shutdownRequested) return;
            try {
                await sportsService!.refreshPredictOrderbooks();
            } catch (error: any) {
                // 静默
            }
        }, PREDICT_REFRESH_MS);
    }

    // ========================================================================
    // 持仓市场 WS 订阅同步 (确保 close-service 能获取持仓市场的订单簿)
    // ========================================================================
    const POSITION_MARKETS_SYNC_MS = 15000;  // 15秒同步一次
    let positionMarketsSyncInFlight = false;

    const syncPositionMarketsToWs = async () => {
        if (shutdownRequested || positionMarketsSyncInFlight) return;
        positionMarketsSyncInFlight = true;

        try {
            const { predictMarketIds, polymarketTokenIds } = await getPositionMarketIds();

            // 订阅 Predict 持仓市场
            if (predictMarketIds.length > 0 && usePredictWsMode) {
                const unifiedCache = getPredictOrderbookCache();
                if (unifiedCache) {
                    await unifiedCache.subscribeMarkets(predictMarketIds);
                }
            }

            // 订阅 Polymarket 持仓市场
            if (polymarketTokenIds.length > 0 && polymarketWsClient && polymarketWsClient.isConnected()) {
                polymarketWsClient.subscribe(polymarketTokenIds);
            }

            if (predictMarketIds.length > 0 || polymarketTokenIds.length > 0) {
                console.log(`[持仓WS订阅] Predict: ${predictMarketIds.length} 市场, Polymarket: ${polymarketTokenIds.length} tokens`);
            }
        } catch (error: any) {
            // 静默失败
        } finally {
            positionMarketsSyncInFlight = false;
        }
    };

    // 首次同步 (延迟 5 秒等待持仓缓存加载)
    setTimeout(syncPositionMarketsToWs, 5000);

    // 定期同步 (清理在 gracefulShutdown 中通过 shutdownRequested 标志自动停止)
    setInterval(syncPositionMarketsToWs, POSITION_MARKETS_SYNC_MS);

    // ========================================================================
    // 串行调度器 (防止 async setInterval 重入堆积)
    // ========================================================================
    interface SerialSchedulerOptions {
        warnThresholdMs?: number;    // 耗时警告阈值，默认 intervalMs * 2
        runImmediately?: boolean;    // 是否立即执行首次，默认 false
        errorLogIntervalMs?: number; // 错误日志限频间隔，默认 30000ms
    }

    function createSerialScheduler(
        name: string,
        intervalMs: number,
        task: () => Promise<void>,
        options: SerialSchedulerOptions = {}
    ): () => void {
        const {
            warnThresholdMs = intervalMs * 2,
            runImmediately = false,
            errorLogIntervalMs = 30000,  // 默认 30s 限频
        } = options;
        let inFlight = false;
        let lastErrorLogTime = 0;
        let errorCount = 0;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const scheduleNext = () => {
            if (stopped || shutdownRequested) return;
            timer = setTimeout(run, intervalMs);
        };

        const run = async () => {
            if (stopped || shutdownRequested) return;
            if (inFlight) {
                console.warn(`[${name}] 跳过：上一轮未完成`);
                scheduleNext();
                return;
            }

            inFlight = true;
            const startTime = Date.now();

            try {
                await task();
                // 成功后重置错误计数
                if (errorCount > 0) {
                    console.log(`[${name}] 恢复正常 (之前连续 ${errorCount} 次失败)`);
                    errorCount = 0;
                }
            } catch (error: any) {
                errorCount++;
                // 限频错误日志：避免刷屏，但不完全静默
                const now = Date.now();
                if (now - lastErrorLogTime >= errorLogIntervalMs) {
                    const errorMsg = error.message || String(error);
                    const errorStack = error.stack ? `\n${error.stack}` : '';
                    console.error(`[${name}] 任务失败 (连续 ${errorCount} 次): ${errorMsg}${errorStack}`);
                    lastErrorLogTime = now;
                }
            } finally {
                const elapsed = Date.now() - startTime;
                if (elapsed > warnThresholdMs) {
                    console.warn(`[${name}] 耗时过长: ${elapsed}ms (阈值 ${warnThresholdMs}ms)`);
                }
                inFlight = false;
                scheduleNext();
            }
        };

        // 启动调度：runImmediately=true 时立即执行首次，减少"刚开面板没数据"的窗口
        if (runImmediately) {
            run();  // 立即执行
        } else {
            scheduleNext();
        }

        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        };
    }

    // ========================================================================
    // 体育市场 SSE 广播 (仅当启用时) - 使用统一节流广播
    // ========================================================================
    if (sportsService) {
        const SPORTS_BROADCAST_MS = 100;
        serialSchedulerStops.push(createSerialScheduler('SportsBroadcast', SPORTS_BROADCAST_MS, async () => {
            const sportsData = JSON.stringify(sportsService!.getSSEData());
            markDirty('sports', sportsData);
        }, { warnThresholdMs: SPORTS_BROADCAST_MS * 5, runImmediately: true }));
    }

    // Sports incremental scan (5 minutes)
    if (sportsService) {
        const SPORTS_INCREMENTAL_SCAN_MS = 5 * 60 * 1000;
        serialSchedulerStops.push(createSerialScheduler('SportsIncrementalScan', SPORTS_INCREMENTAL_SCAN_MS, async () => {
            await sportsService!.scanIncremental();
        }, { warnThresholdMs: SPORTS_INCREMENTAL_SCAN_MS * 0.5, runImmediately: false }));
    }

    // ========================================================================
    // Predict WS 健康日志 (30秒，WS 模式下输出统计)
    // ========================================================================
    if (usePredictWsMode) {
        const WS_HEALTH_LOG_MS = 30000;
        serialSchedulerStops.push(createSerialScheduler('PredictWsHealth', WS_HEALTH_LOG_MS, async () => {
            const cache = getPredictOrderbookCache();
            if (cache) {
                const stats = cache.getStats();
                console.log(`[PredictWS] 健康: connected=${stats.wsConnected}, subscriptions=${stats.wsSubscriptions}, cache=${stats.cacheSize}, wsUpdates=${stats.wsUpdates}, restFetches=${stats.restFetches}`);
            }
        }, { runImmediately: false }));
    }

    if (DASHBOARD_PREDICT_ORDERBOOK_MODE === 'ws' || POLY_ORDERBOOK_SOURCE !== 'rest') {
        serialSchedulerStops.push(createSerialScheduler('WsHealthMonitor', WS_HEALTH_CHECK_MS, handleWsHealthCheck, {
            warnThresholdMs: WS_HEALTH_CHECK_MS * 3,
            runImmediately: true,
        }));
    }

    // ========================================================================
    // 账户数据 SSE 广播 (5秒，串行调度，立即首发) - 使用统一节流广播
    // ========================================================================
    const ACCOUNT_BROADCAST_MS = 5000;
    serialSchedulerStops.push(createSerialScheduler('AccountBroadcast', ACCOUNT_BROADCAST_MS, async () => {
        const accountsData = JSON.stringify(await getAccountData());
        markDirty('accounts', accountsData);
    }, { warnThresholdMs: ACCOUNT_BROADCAST_MS * 2, runImmediately: true }));

    // ========================================================================
    // 平仓机会 SSE 广播 (1秒，串行调度，立即首发) - 使用统一节流广播
    // 注意：calculateCloseOpportunities 需要多次 API 调用，较慢
    // ========================================================================
    const CLOSE_BROADCAST_MS = 10000;
    const subscribedCloseTokenIds = new Set<string>();  // 已订阅的平仓 tokenIds
    serialSchedulerStops.push(createSerialScheduler('CloseBroadcast', CLOSE_BROADCAST_MS, async () => {
        try {
            cachedCloseOpportunities = await calculateCloseOpportunities();
            lastCloseOpportunitiesUpdate = Date.now();
            markDirty('closeOpportunities', JSON.stringify(cachedCloseOpportunities));

            // 订阅平仓 tokenIds 到 WS（确保实时数据）
            if (polymarketWsClient && cachedCloseOpportunities.length > 0) {
                const newTokenIds: string[] = [];
                for (const opp of cachedCloseOpportunities) {
                    // 订阅 YES 和 NO tokenId（平仓需要卖出，需要看 bids）
                    if (opp.polymarketYesTokenId && !subscribedCloseTokenIds.has(opp.polymarketYesTokenId)) {
                        newTokenIds.push(opp.polymarketYesTokenId);
                        subscribedCloseTokenIds.add(opp.polymarketYesTokenId);
                    }
                    if (opp.polymarketNoTokenId && !subscribedCloseTokenIds.has(opp.polymarketNoTokenId)) {
                        newTokenIds.push(opp.polymarketNoTokenId);
                        subscribedCloseTokenIds.add(opp.polymarketNoTokenId);
                    }
                }
                if (newTokenIds.length > 0) {
                    polymarketWsClient.subscribe(newTokenIds);
                    console.log(`[CloseService] 订阅 ${newTokenIds.length} 个平仓 tokenIds 到 WS`);
                }
            }
        } catch (error) {
            console.warn('[CloseService] 计算平仓机会失败:', error);
        }
    }, { warnThresholdMs: CLOSE_BROADCAST_MS * 3, runImmediately: true }));

    if (sportsService) {
        console.log(`⏱️  体育市场刷新: Polymarket 100ms, Predict 500ms, SSE广播 500ms`);
    }
    console.log(`⏱️  账户数据 SSE 广播: ${ACCOUNT_BROADCAST_MS}ms`);
    console.log(`⏱️  平仓机会 SSE 广播: ${CLOSE_BROADCAST_MS}ms`);
    console.log(`✅ SSE 广播使用统一节流调度器 (${BROADCAST_THROTTLE_MS}ms) + 背压处理\n`);
}

/**
 * 设置优雅关闭处理程序
 * 在 SIGINT (Ctrl+C) 或 SIGTERM 时暂停所有任务
 */
function setupGracefulShutdown(): void {
    let isShuttingDown = false;
    const SHUTDOWN_TIMEOUT_MS = 60000;  // 60 秒整体超时（可能需要取消挂单）

    const gracefulShutdown = async (signal: string) => {
        if (isShuttingDown) {
            console.log('\n⚠️  已在关闭中，请稍候...');
            return;
        }
        isShuttingDown = true;
        shutdownRequested = true;

        console.log(`\n🛑 收到 ${signal} 信号，开始优雅关闭...`);
        console.log(`[Shutdown] 当前时间: ${new Date().toISOString()}`);

        // 保持事件循环活跃，避免异步关停链条中途“自然退出”
        const keepAlive = setInterval(() => { /* noop */ }, 250);

        // 设置整体超时保护
        const forceExitTimeout = setTimeout(() => {
            console.error(`\n⚠️  关闭超时 (${SHUTDOWN_TIMEOUT_MS / 1000}s)，强制退出...`);
            clearInterval(keepAlive);
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);

        try {
            // 1) 停止后台定时器，避免关停期间继续触发扫描/刷新/广播
            console.log('[Shutdown] 停止轮询/刷新/广播定时器...');
            if (mainPollInterval) clearInterval(mainPollInterval);
            if (polyRefreshInterval) clearInterval(polyRefreshInterval);
            if (predictRefreshInterval) clearInterval(predictRefreshInterval);
            if (boostRefreshInterval) clearInterval(boostRefreshInterval);
            mainPollInterval = null;
            polyRefreshInterval = null;
            predictRefreshInterval = null;
            boostRefreshInterval = null;
            if (wsDisconnectTimer) clearTimeout(wsDisconnectTimer);
            if (wsResumeTimer) clearTimeout(wsResumeTimer);
            wsDisconnectTimer = null;
            wsResumeTimer = null;
            wsPausedTaskIds.clear();
            wsPauseActive = false;
            wsPauseInProgress = false;
            lastWsHealthy = null;

            for (const stop of serialSchedulerStops.splice(0)) {
                try { stop(); } catch { /* ignore */ }
            }

            // 2) 关闭 SSE 客户端，避免 server.close 被长连接阻塞
            for (const client of sseClients.keys()) {
                try { client.end(); } catch { /* ignore */ }
            }
            sseClients.clear();

            // 3) 停止接受新请求
            if (httpServer) {
                console.log('[Shutdown] 关闭 HTTP 服务器...');
                await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
                httpServer = null;
            }

            // 4) 断开 WS（防止重连/后台心跳保活）
            if (polymarketWsClient) {
                try {
                    polymarketWsClient.disconnect({ clearListeners: true });
                } catch { /* ignore */ }
                polymarketWsClient = null;
            }

            // 4.1) 停止 WS 订单通知服务
            try {
                stopWsOrderNotifier();
            } catch { /* ignore */ }

            // 4.1.1) 停止 Polymarket User WS (订单状态监听)
            try {
                destroyPolymarketUserWsClient();
            } catch { /* ignore */ }

            // 4.2) 停止 BSC 通知/服务（避免后台重连/心跳保活）
            try { stopBscOrderNotifier(); } catch { /* ignore */ }
            try { stopBscOrderWatcher(); } catch { /* ignore */ }
            try { stopPredictOrderWatcher(); } catch { /* ignore */ }
            try { stopTokenMarketCache(); } catch { /* ignore */ }

            // 4.3) 停止 Predict 订单簿 WS 缓存
            try { stopPredictOrderbookCache(); } catch { /* ignore */ }

            // 5) 暂停所有运行中的任务并取消挂单（确保取消请求已发送/超时返回）
            console.log('[Shutdown] 开始暂停任务并取消挂单...');
            await taskExecutor.shutdown({ concurrency: 4, timeoutMs: SHUTDOWN_TIMEOUT_MS - 5000 });
            console.log('[Shutdown] taskExecutor.shutdown() 完成');

            // 6) 刷新并关闭 TaskLogger，确保关停期间的取消/暂停日志落盘
            try {
                await getTaskLogger().close();
            } catch { /* ignore */ }

            // 7) 给 stdout 刷新一个短窗口
            await new Promise(resolve => setTimeout(resolve, 200));

            clearTimeout(forceExitTimeout);
            clearInterval(keepAlive);
            console.log('✅ Dashboard 已安全关闭');

            // 不要用 process.exit() 立即硬退出，否则可能中断尚未完全刷新的 I/O。
            // 让 Node 自然退出：清理所有 handle 后事件循环会自动结束。
            process.exitCode = 0;
            return;
        } catch (error: any) {
            clearTimeout(forceExitTimeout);
            clearInterval(keepAlive);
            console.error('\n❌ 关闭过程出错:', error.message);
            process.exitCode = 1;
            return;
        }
    };

    // Windows 上 SIGTERM 可能不可用，主要依赖 SIGINT (Ctrl+C)
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Windows 特殊处理
    if (process.platform === 'win32') {
        // readline 接口用于捕获 Windows 上的 Ctrl+C
        import('readline').then(readline => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            rl.on('SIGINT', () => process.emit('SIGINT' as any));
        }).catch(() => { /* ignore */ });
    }

    console.log('📌 已注册优雅关闭处理 (Ctrl+C 暂停所有任务)\n');
}

main().catch(console.error);
