import * as fs from 'fs';
import * as path from 'path';
import { Interface, JsonRpcProvider, formatUnits } from 'ethers';
import { getBscRpcEndpoints } from '../config/bsc-rpc.js';

// ============================================================================
// 环境变量 / 启动参数
// ============================================================================
// 用法示例:
//   ADDRESSES=0xabc...,0xdef... START_DAYS_AGO=7 npx tsx src/testing/analyze-predict-leaderboard.ts
//
// 可选:
//   START_BLOCK=xxxx END_BLOCK=latest BLOCK_STEP=5000
//   BSC_RPC_URLS=https://...,https://...
//   OUT_JSON=artifacts/predict-leaderboard-analysis.json
//   RESUME=1                    # 若 OUT_JSON 已存在，则从断点续跑
//   CHECKPOINT_EVERY_RANGES=10  # 每处理 N 个区块段落盘一次（默认 10）
//
// 注意:
// - 该脚本仅基于链上 OrderFilled 事件做统计，无法看到“挂单未成交/撤单”带来的潜在积分权重。
// - 若要拟合“积分权重”，还需要你提供：同一时间点的积分/排名快照（至少 top 地址的 points 值）。

function loadEnv(): void {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
        const match = line.trim().match(/^([^#=]+)=(.*)$/);
        if (match) process.env[match[1].trim()] = match[2].trim();
    }
}

loadEnv();

// ============================================================================
// Predict Exchange 合约地址 (BSC Mainnet)
// ============================================================================

const PREDICT_EXCHANGES = [
    '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689', // CTF_EXCHANGE
    '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A', // NEG_RISK_CTF_EXCHANGE
    '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5', // YIELD_BEARING_CTF_EXCHANGE
    '0x8A289d458f5a134bA40015085A8F50Ffb681B41d', // YIELD_BEARING_NEG_RISK_CTF_EXCHANGE
].map(a => a.toLowerCase());

const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const ORDER_FILLED_ABI = [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];
const orderFilledInterface = new Interface(ORDER_FILLED_ABI);

// ============================================================================
// 工具
// ============================================================================

function normalizeAddress(address: string): string {
    const a = address.trim();
    if (!a.startsWith('0x') || a.length !== 42) {
        throw new Error(`地址格式无效: ${address}`);
    }
    return a.toLowerCase();
}

function padAddressToTopic(address: string): string {
    // topic 里是 32 bytes 的 address（左侧补 0）
    return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function formatNumber(n: number, digits: number = 2): string {
    if (!Number.isFinite(n)) return '0';
    return n.toFixed(digits);
}

class RpcPool {
    private readonly providers: JsonRpcProvider[];
    private index = 0;

    constructor(urls: string[]) {
        if (urls.length === 0) throw new Error('没有可用的 BSC RPC URL');
        // 禁用 batch，降低公共节点触发“batch rate limit”的概率
        this.providers = urls.map(u => new JsonRpcProvider(u, undefined, { batchMaxCount: 1 }));
    }

    async call<T>(fn: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < this.providers.length * 3; attempt++) {
            const p = this.providers[this.index];
            try {
                return await fn(p);
            } catch (e) {
                lastErr = e;
                if (isRateLimitError(e)) {
                    const waitMs = Math.min(5000, 500 + attempt * 250);
                    await new Promise(r => setTimeout(r, waitMs));
                }
                this.index = (this.index + 1) % this.providers.length;
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
}

function isRateLimitError(err: unknown): boolean {
    const msg = (err as any)?.message ? String((err as any).message) : String(err);
    const code = (err as any)?.code;
    const nestedCode = (err as any)?.error?.code;
    const m = msg.toLowerCase();
    return m.includes('limit exceeded')
        || m.includes('rate limit')
        || code === -32005
        || nestedCode === -32005;
}

async function getLogsWithAutoSplit(
    pool: RpcPool,
    params: { address: string; topics: any[]; fromBlock: number; toBlock: number },
    minRange: number = 250
): Promise<any[]> {
    const throttleMs = Number(process.env.RPC_THROTTLE_MS || 150);
    const maxRetries = Number(process.env.RPC_RETRIES || 6);
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (throttleMs > 0) {
                await new Promise(r => setTimeout(r, throttleMs));
            }
            return await pool.call(p => p.getLogs({
                address: params.address,
                topics: params.topics,
                fromBlock: params.fromBlock,
                toBlock: params.toBlock,
            }));
        } catch (e) {
            lastErr = e;
            if (isRateLimitError(e)) {
                const waitMs = Math.min(10_000, 800 + attempt * 500);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }
            break;
        }
    }

    const range = params.toBlock - params.fromBlock;
    if (range <= minRange) {
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
    const mid = params.fromBlock + Math.floor(range / 2);
    const left = await getLogsWithAutoSplit(pool, { ...params, toBlock: mid }, minRange);
    const right = await getLogsWithAutoSplit(pool, { ...params, fromBlock: mid + 1 }, minRange);
    return [...left, ...right];
}

async function findBlockByTimestamp(pool: RpcPool, targetTimestampSec: number, endBlock: number): Promise<number> {
    let lo = 1;
    let hi = endBlock;
    while (lo + 1 < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const b = await pool.call(p => p.getBlock(mid));
        if (!b) throw new Error(`无法获取区块: ${mid}`);
        if (Number(b.timestamp) >= targetTimestampSec) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return hi;
}

// ============================================================================
// 统计模型
// ============================================================================

type FillRole = 'Maker' | 'Taker';
type FillDirection = 'BUY' | 'SELL';

interface FillEvent {
    orderHash: string;
    maker: string;
    taker: string;
    makerAssetId: string;
    takerAssetId: string;
    makerAmountFilled: number;
    takerAmountFilled: number;
    fee: number;
    blockNumber: number;
    txHash: string;
    logIndex: number;
    timestampSec: number;
    exchange: string;
}

function getTokenId(event: FillEvent): string {
    return event.makerAssetId === '0' ? event.takerAssetId : event.makerAssetId;
}

function getShares(event: FillEvent): number {
    // shares 数量 = tokens 对应的 amount（与 maker/taker、买卖无关）
    return event.takerAssetId !== '0' ? event.takerAmountFilled : event.makerAmountFilled;
}

function getUsdcAmount(event: FillEvent): number {
    // 另一边就是 USDC amount
    return event.takerAssetId !== '0' ? event.makerAmountFilled : event.takerAmountFilled;
}

function getDirection(event: FillEvent, address: string, role: FillRole): FillDirection {
    // tokens 减少（给出 tokens）→ 卖出成交；tokens 增加（收到 tokens）→ 买入成交
    if (role === 'Maker') {
        return event.makerAssetId !== '0' ? 'SELL' : 'BUY';
    }
    return event.takerAssetId !== '0' ? 'SELL' : 'BUY';
}

interface Lot {
    shares: number;
    tsSec: number;
    costPerShare: number;
}

interface AddressStats {
    address: string;
    fills: number;
    makerFills: number;
    takerFills: number;
    makerShares: number;
    takerShares: number;
    buyShares: number;
    sellShares: number;
    buyUsdc: number;
    sellUsdc: number;
    feesPaidUsdc: number;
    realizedPnlUsdc: number;
    holdingShareSeconds: number;
    holdingSharesClosed: number;
    tokens: Map<string, {
        shares: number;
        fills: number;
        makerFills: number;
        takerFills: number;
        buyShares: number;
        sellShares: number;
        buyUsdc: number;
        sellUsdc: number;
    }>;
    lotsByToken: Map<string, Lot[]>;
}

function newAddressStats(address: string): AddressStats {
    return {
        address,
        fills: 0,
        makerFills: 0,
        takerFills: 0,
        makerShares: 0,
        takerShares: 0,
        buyShares: 0,
        sellShares: 0,
        buyUsdc: 0,
        sellUsdc: 0,
        feesPaidUsdc: 0,
        realizedPnlUsdc: 0,
        holdingShareSeconds: 0,
        holdingSharesClosed: 0,
        tokens: new Map(),
        lotsByToken: new Map(),
    };
}

function statsToJson(stats: AddressStats) {
    return {
        address: stats.address,
        fills: stats.fills,
        makerFills: stats.makerFills,
        takerFills: stats.takerFills,
        makerShares: stats.makerShares,
        takerShares: stats.takerShares,
        buyShares: stats.buyShares,
        sellShares: stats.sellShares,
        buyUsdc: stats.buyUsdc,
        sellUsdc: stats.sellUsdc,
        feesPaidUsdc: stats.feesPaidUsdc,
        realizedPnlUsdc: stats.realizedPnlUsdc,
        holdingShareSeconds: stats.holdingShareSeconds,
        holdingSharesClosed: stats.holdingSharesClosed,
        tokens: Array.from(stats.tokens.entries()),
        lotsByToken: Array.from(stats.lotsByToken.entries()),
    };
}

function statsFromJson(obj: any): AddressStats {
    const stats = newAddressStats(String(obj.address));
    stats.fills = Number(obj.fills || 0);
    stats.makerFills = Number(obj.makerFills || 0);
    stats.takerFills = Number(obj.takerFills || 0);
    stats.makerShares = Number(obj.makerShares || 0);
    stats.takerShares = Number(obj.takerShares || 0);
    stats.buyShares = Number(obj.buyShares || 0);
    stats.sellShares = Number(obj.sellShares || 0);
    stats.buyUsdc = Number(obj.buyUsdc || 0);
    stats.sellUsdc = Number(obj.sellUsdc || 0);
    stats.feesPaidUsdc = Number(obj.feesPaidUsdc || 0);
    stats.realizedPnlUsdc = Number(obj.realizedPnlUsdc || 0);
    stats.holdingShareSeconds = Number(obj.holdingShareSeconds || 0);
    stats.holdingSharesClosed = Number(obj.holdingSharesClosed || 0);

    if (Array.isArray(obj.tokens)) {
        stats.tokens = new Map(obj.tokens);
    }
    if (Array.isArray(obj.lotsByToken)) {
        stats.lotsByToken = new Map(obj.lotsByToken);
    }
    return stats;
}

function getOrInitTokenStats(stats: AddressStats, tokenId: string) {
    let t = stats.tokens.get(tokenId);
    if (!t) {
        t = { shares: 0, fills: 0, makerFills: 0, takerFills: 0, buyShares: 0, sellShares: 0, buyUsdc: 0, sellUsdc: 0 };
        stats.tokens.set(tokenId, t);
    }
    return t;
}

function pushLot(stats: AddressStats, tokenId: string, lot: Lot): void {
    const lots = stats.lotsByToken.get(tokenId) ?? [];
    lots.push(lot);
    stats.lotsByToken.set(tokenId, lots);
}

function popLotsForSell(stats: AddressStats, tokenId: string, sellShares: number, sellTsSec: number, sellPricePerShare: number): void {
    const lots = stats.lotsByToken.get(tokenId) ?? [];
    let remaining = sellShares;
    while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const matched = Math.min(remaining, lot.shares);

        const pnl = matched * (sellPricePerShare - lot.costPerShare);
        stats.realizedPnlUsdc += pnl;

        const dt = Math.max(0, sellTsSec - lot.tsSec);
        stats.holdingShareSeconds += matched * dt;
        stats.holdingSharesClosed += matched;

        lot.shares -= matched;
        remaining -= matched;
        if (lot.shares <= 1e-12) lots.shift();
    }
    stats.lotsByToken.set(tokenId, lots);
}

// ============================================================================
// 主流程
// ============================================================================

async function main(): Promise<void> {
    const addressesEnv = process.env.ADDRESSES || process.env.ADDRESS || '';
    const addresses = addressesEnv
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(normalizeAddress);

    if (addresses.length === 0) {
        throw new Error('请设置 ADDRESSES=0x...,0x... (至少 1 个地址)');
    }

    const rpcUrls = (process.env.BSC_RPC_URLS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    const pool = new RpcPool(rpcUrls.length > 0 ? rpcUrls : getBscRpcEndpoints());

    const latestBlock = await pool.call(p => p.getBlockNumber());
    const endBlockRaw = (process.env.END_BLOCK || 'latest').trim().toLowerCase();
    const endBlock = endBlockRaw === 'latest' ? latestBlock : Number(endBlockRaw);
    if (!Number.isFinite(endBlock) || endBlock <= 0) throw new Error(`END_BLOCK 无效: ${process.env.END_BLOCK}`);

    let startBlock: number | null = null;
    if (process.env.START_BLOCK) {
        startBlock = Number(process.env.START_BLOCK);
        if (!Number.isFinite(startBlock) || startBlock <= 0) throw new Error(`START_BLOCK 无效: ${process.env.START_BLOCK}`);
    } else if (process.env.START_DAYS_AGO) {
        const days = Number(process.env.START_DAYS_AGO);
        if (!Number.isFinite(days) || days <= 0) throw new Error(`START_DAYS_AGO 无效: ${process.env.START_DAYS_AGO}`);
        const targetTsSec = Math.floor(Date.now() / 1000) - Math.floor(days * 86400);
        startBlock = await findBlockByTimestamp(pool, targetTsSec, endBlock);
    } else if (process.env.START_TIMESTAMP_SEC) {
        const targetTsSec = Number(process.env.START_TIMESTAMP_SEC);
        if (!Number.isFinite(targetTsSec) || targetTsSec <= 0) throw new Error(`START_TIMESTAMP_SEC 无效: ${process.env.START_TIMESTAMP_SEC}`);
        startBlock = await findBlockByTimestamp(pool, targetTsSec, endBlock);
    } else {
        // 默认：近 7 天
        const targetTsSec = Math.floor(Date.now() / 1000) - 7 * 86400;
        startBlock = await findBlockByTimestamp(pool, targetTsSec, endBlock);
    }

    if (!startBlock || startBlock > endBlock) throw new Error(`起止区块无效: start=${startBlock} end=${endBlock}`);

    const blockStep = Number(process.env.BLOCK_STEP || 5000);
    if (!Number.isFinite(blockStep) || blockStep <= 0) throw new Error(`BLOCK_STEP 无效: ${process.env.BLOCK_STEP}`);

    const paddedAddresses = addresses.map(padAddressToTopic);
    const addressSet = new Set(addresses);

    const outJson = process.env.OUT_JSON?.trim();
    const resumeEnabled = (process.env.RESUME || '').trim() === '1';
    const statsByAddress = new Map<string, AddressStats>();
    for (const a of addresses) statsByAddress.set(a, newAddressStats(a));

    // 断点续跑：从 OUT_JSON 恢复 lastProcessedToBlock / stats / seenKeys
    let resumeFromBlock = startBlock;
    if (outJson) {
        const outPath = path.isAbsolute(outJson) ? outJson : path.join(process.cwd(), '..', outJson);
        if (resumeEnabled && fs.existsSync(outPath)) {
            try {
                const prev = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
                const ck = prev?.checkpoint;
                if (ck?.lastProcessedToBlock && Number.isFinite(Number(ck.lastProcessedToBlock))) {
                    const last = Number(ck.lastProcessedToBlock);
                    resumeFromBlock = Math.max(startBlock, Math.min(endBlock, last + 1));
                }
                if (Array.isArray(ck?.statsByAddress)) {
                    for (const item of ck.statsByAddress) {
                        const st = statsFromJson(item);
                        if (addressSet.has(st.address.toLowerCase())) {
                            statsByAddress.set(st.address.toLowerCase(), st);
                        }
                    }
                }
            } catch {
                // ignore
            }
        }
    }

    const blockTsCache = new Map<number, number>();
    const getBlockTs = async (blockNumber: number): Promise<number> => {
        const cached = blockTsCache.get(blockNumber);
        if (cached !== undefined) return cached;
        const b = await pool.call(p => p.getBlock(blockNumber));
        if (!b) throw new Error(`无法获取区块: ${blockNumber}`);
        const ts = Number(b.timestamp);
        blockTsCache.set(blockNumber, ts);
        return ts;
    };

    console.log('============================================================');
    console.log('   Predict Top 地址链上行为分析 (OrderFilled)');
    console.log('============================================================');
    console.log(`- 地址数: ${addresses.length}`);
    console.log(`- 区块范围: ${startBlock} -> ${endBlock} (latest=${latestBlock})`);
    if (resumeFromBlock !== startBlock) {
        console.log(`- 断点续跑: 从区块 ${resumeFromBlock} 开始`);
    }
    console.log(`- 合约数: ${PREDICT_EXCHANGES.length}`);
    console.log(`- 扫描步长: ${blockStep}`);
    console.log('');

    const checkpointEveryRanges = Number(process.env.CHECKPOINT_EVERY_RANGES || 10);
    let processedRanges = 0;

    const writeCheckpoint = (lastProcessedToBlock: number, complete: boolean) => {
        if (!outJson) return;
        const outPath = path.isAbsolute(outJson) ? outJson : path.join(process.cwd(), '..', outJson);
        const payload = {
            meta: {
                scannedAt: new Date().toISOString(),
                startBlock,
                endBlock,
                latestBlock,
                addresses,
                exchanges: PREDICT_EXCHANGES,
                complete,
            },
            checkpoint: {
                lastProcessedToBlock,
                statsByAddress: Array.from(statsByAddress.values()).map(statsToJson),
            },
        };
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
    };

    for (let from = resumeFromBlock; from <= endBlock; from += blockStep) {
        const to = Math.min(endBlock, from + blockStep - 1);
        const progress = (((to - startBlock) / Math.max(1, endBlock - startBlock)) * 100);
        process.stdout.write(`\r扫描区块 ${from}-${to} (${formatNumber(progress, 1)}%)...`);

        const logs: any[] = [];
        const rangeSeenTxLogKeys = new Set<string>();
        for (const exchange of PREDICT_EXCHANGES) {
            const makerLogs = await getLogsWithAutoSplit(pool, {
                address: exchange,
                topics: [ORDER_FILLED_TOPIC, null, paddedAddresses],
                fromBlock: from,
                toBlock: to,
            }, 200);
            const takerLogs = await getLogsWithAutoSplit(pool, {
                address: exchange,
                topics: [ORDER_FILLED_TOPIC, null, null, paddedAddresses],
                fromBlock: from,
                toBlock: to,
            }, 200);
            logs.push(...makerLogs, ...takerLogs);
        }
        for (const log of logs) {
            let decoded: any;
            try {
                decoded = orderFilledInterface.parseLog({ topics: log.topics as string[], data: log.data });
            } catch {
                continue;
            }
            if (!decoded) continue;

            const blockNumber = Number(log.blockNumber);
            const tsSec = await getBlockTs(blockNumber);

            const ev: FillEvent = {
                orderHash: decoded.args[0],
                maker: String(decoded.args[1]).toLowerCase(),
                taker: String(decoded.args[2]).toLowerCase(),
                makerAssetId: decoded.args[3].toString(),
                takerAssetId: decoded.args[4].toString(),
                makerAmountFilled: Number(formatUnits(decoded.args[5], 18)),
                takerAmountFilled: Number(formatUnits(decoded.args[6], 18)),
                fee: Number(formatUnits(decoded.args[7], 18)),
                blockNumber,
                txHash: String(log.transactionHash),
                logIndex: Number(log.index ?? log.logIndex ?? 0),
                timestampSec: tsSec,
                exchange: String(log.address).toLowerCase(),
            };
            const dedupKey = `${ev.txHash.toLowerCase()}:${ev.logIndex}`;
            if (rangeSeenTxLogKeys.has(dedupKey)) continue;
            rangeSeenTxLogKeys.add(dedupKey);

        const tokenId = getTokenId(ev);
        const shares = getShares(ev);
        const usdc = getUsdcAmount(ev);
        const price = shares > 0 ? usdc / shares : 0;

        // 对每个相关地址分别计入（如果一笔成交发生在 top 地址之间，会分别计入双方）
        const participants: Array<{ address: string; role: FillRole }> = [];
        if (addressSet.has(ev.maker)) participants.push({ address: ev.maker, role: 'Maker' });
        if (addressSet.has(ev.taker)) participants.push({ address: ev.taker, role: 'Taker' });
        if (participants.length === 0) continue;

        for (const p of participants) {
            const st = statsByAddress.get(p.address) ?? newAddressStats(p.address);
            statsByAddress.set(p.address, st);

            st.fills++;
            if (p.role === 'Maker') {
                st.makerFills++;
                st.makerShares += shares;
            } else {
                st.takerFills++;
                st.takerShares += shares;
            }

            const dir = getDirection(ev, p.address, p.role);
            const feePaid = p.role === 'Maker' ? 0 : ev.fee;
            st.feesPaidUsdc += feePaid;

            const tokenSt = getOrInitTokenStats(st, tokenId);
            tokenSt.fills++;
            tokenSt.shares += shares;
            if (p.role === 'Maker') tokenSt.makerFills++; else tokenSt.takerFills++;

            if (dir === 'BUY') {
                st.buyShares += shares;
                st.buyUsdc += (usdc + feePaid);
                tokenSt.buyShares += shares;
                tokenSt.buyUsdc += (usdc + feePaid);
                if (shares > 0) {
                    pushLot(st, tokenId, { shares, tsSec: ev.timestampSec, costPerShare: (usdc + feePaid) / shares });
                }
            } else {
                st.sellShares += shares;
                st.sellUsdc += (usdc - feePaid);
                tokenSt.sellShares += shares;
                tokenSt.sellUsdc += (usdc - feePaid);
                if (shares > 0) {
                    popLotsForSell(st, tokenId, shares, ev.timestampSec, usdc / shares);
                }
            }
        }
        }

        processedRanges++;
        if (checkpointEveryRanges > 0 && processedRanges % checkpointEveryRanges === 0) {
            writeCheckpoint(to, false);
        }
    }
    process.stdout.write('\n');

    const results = Array.from(statsByAddress.values()).map(s => {
        const distinctTokens = s.tokens.size;
        const makerShareRatio = (s.makerShares + s.takerShares) > 0 ? (s.makerShares / (s.makerShares + s.takerShares)) : 0;
        const avgHoldingSec = s.holdingSharesClosed > 0 ? (s.holdingShareSeconds / s.holdingSharesClosed) : 0;
        const totalShares = s.makerShares + s.takerShares;
        const totalNotionalUsdc = s.buyUsdc + s.sellUsdc;

        const topTokens = Array.from(s.tokens.entries())
            .sort((a, b) => b[1].shares - a[1].shares)
            .slice(0, 10)
            .map(([tokenId, t]) => ({
                tokenId,
                shares: t.shares,
                fills: t.fills,
                makerFills: t.makerFills,
                takerFills: t.takerFills,
                buyShares: t.buyShares,
                sellShares: t.sellShares,
            }));

        return {
            address: s.address,
            fills: s.fills,
            makerFills: s.makerFills,
            takerFills: s.takerFills,
            totalShares,
            makerShares: s.makerShares,
            takerShares: s.takerShares,
            makerShareRatio,
            buyShares: s.buyShares,
            sellShares: s.sellShares,
            buyUsdc: s.buyUsdc,
            sellUsdc: s.sellUsdc,
            totalNotionalUsdc,
            feesPaidUsdc: s.feesPaidUsdc,
            realizedPnlUsdc: s.realizedPnlUsdc,
            avgHoldingMinutes: avgHoldingSec / 60,
            distinctTokens,
            topTokens,
        };
    }).sort((a, b) => b.totalShares - a.totalShares);

    console.log('');
    console.log('--- 汇总 (按 totalShares 排序) ---');
    for (const r of results) {
        console.log('');
        console.log(`地址: ${r.address}`);
        console.log(`- 成交次数: ${r.fills} (Maker=${r.makerFills}, Taker=${r.takerFills})`);
        console.log(`- 成交股数: ${formatNumber(r.totalShares, 2)} (Maker=${formatNumber(r.makerShares, 2)}, Taker=${formatNumber(r.takerShares, 2)}, Maker占比=${formatNumber(r.makerShareRatio * 100, 1)}%)`);
        console.log(`- 买/卖股数: BUY=${formatNumber(r.buyShares, 2)} SELL=${formatNumber(r.sellShares, 2)}`);
        console.log(`- 名义金额(USDC): 买入成本=${formatNumber(r.buyUsdc, 2)} 卖出回收=${formatNumber(r.sellUsdc, 2)} (合计流水=${formatNumber(r.totalNotionalUsdc, 2)})`);
        console.log(`- 支付手续费(USDC): ${formatNumber(r.feesPaidUsdc, 4)} (仅统计 Taker 侧)`);
        console.log(`- 已实现PnL(USDC): ${formatNumber(r.realizedPnlUsdc, 2)} (基于成交价+FIFO，仅参考)`);
        console.log(`- 平均持仓时间: ${formatNumber(r.avgHoldingMinutes, 1)} 分钟 (仅对已平仓部分估算)`);
        console.log(`- 参与 token 数: ${r.distinctTokens}`);
        console.log(`- Top token(按 shares): ${r.topTokens.slice(0, 5).map(t => `${t.tokenId}:${formatNumber(t.shares, 1)}`).join(' | ')}`);
    }

    if (outJson) {
        const outPath = path.isAbsolute(outJson) ? outJson : path.join(process.cwd(), '..', outJson);
        const payload = {
            meta: {
                scannedAt: new Date().toISOString(),
                startBlock,
                endBlock,
                latestBlock,
                addresses,
                exchanges: PREDICT_EXCHANGES,
                complete: true,
            },
            results,
        };
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
        console.log(`\n已写入: ${outPath}`);
    }
}

main().catch((e) => {
    console.error('\n脚本失败:', e?.message || e);
    process.exitCode = 1;
});
