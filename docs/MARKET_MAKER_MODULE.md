# Market-Maker 模块技术文档

> 本文档详细拆解 `bot/src/market-maker/` 模块的架构与实现，可作为构建其他预测市场套利机器人的参考。

## 目录

1. [模块概览](#1-模块概览)
2. [架构设计](#2-架构设计)
3. [核心类型定义](#3-核心类型定义)
4. [配置系统](#4-配置系统)
5. [TradingClient - 交易客户端](#5-tradingclient---交易客户端)
6. [MarketMakerEngine - 单市场引擎](#6-marketmakerengine---单市场引擎)
7. [MultiMarketMaker - 多市场管理器](#7-multimarketmaker---多市场管理器)
8. [订单生命周期](#8-订单生命周期)
9. [仓位管理](#9-仓位管理)
10. [事件系统](#10-事件系统)
11. [关键算法](#11-关键算法)
12. [适配其他市场的指南](#12-适配其他市场的指南)

---

## 1. 模块概览

### 1.1 模块职责

Market-Maker 模块实现了 Predict.fun 平台的自动做市策略，核心功能包括：

- **自动报价**: 根据策略在买卖两侧挂单
- **仓位管理**: 跟踪持仓，遵守不做空/不超卖约束
- **订单同步**: 检测成交并更新状态
- **多市场并行**: 同时在多个市场做市

### 1.2 文件结构

```
bot/src/market-maker/
├── index.ts              # 模块导出
├── types.ts              # 类型定义 (接口、枚举)
├── config.ts             # 配置管理 (默认值、验证、合并)
├── trading-client.ts     # 交易客户端 (认证、下单、查询)
├── engine.ts             # 单市场做市引擎 (核心逻辑)
├── multi-engine.ts       # 多市场管理器
└── market-selector.ts    # 市场选择工具 (CLI 交互)
```

### 1.3 依赖关系

```
                    ┌─────────────────┐
                    │ MultiMarketMaker │
                    └────────┬────────┘
                             │ 管理多个
                             ▼
                    ┌─────────────────┐
                    │ MarketMakerEngine│ ←─── EngineDependencies
                    └────────┬────────┘
                             │ 依赖
                             ▼
                    ┌─────────────────┐
                    │  TradingClient   │
                    └────────┬────────┘
                             │ 调用
                             ▼
              ┌──────────────┴──────────────┐
              │                             │
        ┌─────▼─────┐                 ┌─────▼─────┐
        │ Predict   │                 │ BSC RPC   │
        │   API     │                 │ (余额查询) │
        └───────────┘                 └───────────┘
```

---

## 2. 架构设计

### 2.1 分层架构

```
┌─────────────────────────────────────────────────────────┐
│                    应用层 (Application)                  │
│  - multi-engine.ts: 多市场协调                           │
│  - market-selector.ts: CLI 交互                         │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    策略层 (Strategy)                     │
│  - engine.ts: 做市逻辑、价格计算、订单决策                  │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    执行层 (Execution)                    │
│  - trading-client.ts: 订单执行、认证、仓位查询              │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    基础设施层 (Infrastructure)            │
│  - Predict REST API                                     │
│  - BSC JSON-RPC (ERC-1155 余额)                         │
└─────────────────────────────────────────────────────────┘
```

### 2.2 依赖注入模式

Engine 通过 `EngineDependencies` 接口实现依赖注入，便于测试和替换：

```typescript
interface EngineDependencies {
    // 市场数据
    fetchOrderbook: () => Promise<{ bids: Level[], asks: Level[] }>;

    // 仓位查询
    getPosition: (marketId: string) => Promise<bigint>;

    // 订单操作
    placeOrder: (params: OrderParams) => Promise<OrderResponse>;
    cancelOrder: (orderHash: string) => Promise<boolean>;
    getActiveOrders: (marketId: string) => Promise<ActiveOrder[]>;

    // 可选: 订单簿 WebSocket
    subscribeOrderbook?: (callback: (book: Orderbook) => void) => () => void;
}
```

### 2.3 Tick 驱动模型

引擎采用 **Tick 驱动** 而非事件驱动：

```
每 TICK_INTERVAL_MS (默认 2000ms):
  1. 获取最新订单簿
  2. 获取当前仓位
  3. 获取活跃订单
  4. 计算目标订单
  5. 执行订单变更 (PLACE / CANCEL / REPLACE)
```

优点：
- 逻辑简单，易于调试
- 状态一致性好
- 避免竞态条件

缺点：
- 响应延迟 (最大 TICK_INTERVAL_MS)
- API 调用频繁

---

## 3. 核心类型定义

### 3.1 配置类型

```typescript
// 单市场配置
interface MarketMakerConfig {
    marketId: string;           // 市场 ID
    tokenId: string;            // ERC-1155 Token ID (YES 端)

    // 价格策略
    priceStrategy: 'FOLLOW' | 'SCALP';

    // 买单参数
    buyEnabled: boolean;
    buySize: number;            // USDC 数量
    buyPriceTick: number;       // 价格步进 (0.01 = 1 cent)
    buyMaxPrice: number;        // 最高买入价

    // 卖单参数
    sellEnabled: boolean;
    sellSize: number;
    sellPriceTick: number;
    sellMinPrice: number;       // 最低卖出价

    // 约束
    maxPosition: number;        // 最大持仓数量
    minSpread: number;          // 最小价差 (0.02 = 2%)
}

// 全局配置
interface GlobalConfig {
    tickIntervalMs: number;     // Tick 间隔
    maxConcurrentOrders: number;// 最大并发订单
    rpcUrls: string[];          // BSC RPC 节点列表
}
```

### 3.2 状态类型

```typescript
// 市场状态
interface MarketState {
    // 订单簿快照
    bestBid: number | null;
    bestAsk: number | null;

    // 仓位
    position: bigint;           // 当前持仓 (精度 1e6)

    // 活跃订单
    activeBuyOrder: ActiveOrder | null;
    activeSellOrder: ActiveOrder | null;

    // 统计
    stats: TradingStats;
}

// 活跃订单
interface ActiveOrder {
    orderHash: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    filledSize: number;
    status: 'PENDING' | 'OPEN' | 'PARTIALLY_FILLED';
    createdAt: number;
}

// 交易统计
interface TradingStats {
    totalBought: number;        // 累计买入数量
    totalSold: number;          // 累计卖出数量
    totalBuyCost: number;       // 累计买入成本
    totalSellRevenue: number;   // 累计卖出收入
    realizedPnL: number;        // 已实现盈亏
    fillCount: number;          // 成交次数
}
```

### 3.3 订单变更类型

```typescript
// 订单变更指令
interface OrderDelta {
    action: 'PLACE' | 'CANCEL' | 'REPLACE' | 'HOLD';
    side: 'BUY' | 'SELL';

    // PLACE / REPLACE 时需要
    newPrice?: number;
    newSize?: number;

    // CANCEL / REPLACE 时需要
    existingOrderHash?: string;

    reason: string;             // 变更原因 (用于日志)
}
```

---

## 4. 配置系统

### 4.1 默认配置

```typescript
// config.ts

export const DEFAULT_MARKET_CONFIG: Partial<MarketMakerConfig> = {
    priceStrategy: 'FOLLOW',

    buyEnabled: true,
    buySize: 10,                // $10 USDC
    buyPriceTick: 0.01,
    buyMaxPrice: 0.95,

    sellEnabled: true,
    sellSize: 10,
    sellPriceTick: 0.01,
    sellMinPrice: 0.05,

    maxPosition: 1000,
    minSpread: 0.02,
};

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
    tickIntervalMs: 2000,
    maxConcurrentOrders: 10,
    rpcUrls: [
        'https://bsc-dataseed1.binance.org/',
        'https://bsc-dataseed2.binance.org/',
    ],
};
```

### 4.2 配置验证

```typescript
export function validateMarketConfig(config: MarketMakerConfig): void {
    if (!config.marketId) {
        throw new Error('marketId is required');
    }
    if (!config.tokenId) {
        throw new Error('tokenId is required');
    }
    if (config.buyMaxPrice >= config.sellMinPrice) {
        throw new Error('buyMaxPrice must be less than sellMinPrice');
    }
    if (config.minSpread < 0 || config.minSpread > 1) {
        throw new Error('minSpread must be between 0 and 1');
    }
    // ... 更多验证
}
```

### 4.3 配置合并

```typescript
export function mergeMarketConfig(
    partial: Partial<MarketMakerConfig>
): MarketMakerConfig {
    const merged = { ...DEFAULT_MARKET_CONFIG, ...partial };
    validateMarketConfig(merged as MarketMakerConfig);
    return merged as MarketMakerConfig;
}
```

---

## 5. TradingClient - 交易客户端

### 5.1 类结构

```typescript
class TradingClient {
    private jwt: string | null = null;
    private jwtExpiry: number = 0;

    private readonly apiKey: string;
    private readonly signerPrivateKey: string;
    private readonly smartWalletAddress: string;

    constructor(options: TradingClientOptions) {
        this.apiKey = options.apiKey;
        this.signerPrivateKey = options.signerPrivateKey;
        this.smartWalletAddress = options.smartWalletAddress;
    }
}
```

### 5.2 JWT 认证流程

```typescript
async getJwt(): Promise<string> {
    // 1. 检查缓存
    if (this.jwt && Date.now() < this.jwtExpiry - 60000) {
        return this.jwt;
    }

    // 2. 请求 nonce
    const { nonce } = await this.fetchJson('/auth/nonce', {
        method: 'POST',
        body: JSON.stringify({ address: this.smartWalletAddress }),
    });

    // 3. 签名 nonce
    const wallet = new ethers.Wallet(this.signerPrivateKey);
    const signature = await wallet.signMessage(nonce);

    // 4. 换取 JWT
    const { token, expiresAt } = await this.fetchJson('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
            address: this.smartWalletAddress,
            signature,
            nonce,
        }),
    });

    this.jwt = token;
    this.jwtExpiry = expiresAt;
    return token;
}
```

### 5.3 订单操作

#### 下单

```typescript
async placeOrder(params: {
    marketId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
}): Promise<PredictOrderResponse> {
    const jwt = await this.getJwt();

    // 使用 SDK 的 OrderBuilder 构建签名订单
    const orderBuilder = new OrderBuilder({
        signer: this.signerPrivateKey,
        smartWalletAddress: this.smartWalletAddress,
    });

    const signedOrder = await orderBuilder.buildLimitOrder({
        marketId: params.marketId,
        side: params.side,
        price: params.price,
        size: params.size,
    });

    // 提交订单
    const response = await this.fetchJson('/orders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(signedOrder),
    });

    return response;
}
```

#### 取消订单

```typescript
async cancelOrder(orderHash: string): Promise<boolean> {
    const jwt = await this.getJwt();

    try {
        await this.fetchJson(`/orders/${orderHash}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${jwt}` },
        });
        return true;
    } catch (e) {
        // 订单可能已成交或已取消
        console.warn(`Cancel failed: ${e.message}`);
        return false;
    }
}
```

### 5.4 仓位查询

通过 ERC-1155 合约的 `balanceOf` 方法查询：

```typescript
async getPosition(tokenId: string): Promise<bigint> {
    const contract = new ethers.Contract(
        PREDICT_CTF_ADDRESS,
        ['function balanceOf(address, uint256) view returns (uint256)'],
        this.provider
    );

    const balance = await contract.balanceOf(
        this.smartWalletAddress,
        tokenId
    );

    return balance; // 精度 1e6
}
```

### 5.5 RPC 故障转移

```typescript
private async callWithFallback<T>(
    fn: (provider: ethers.Provider) => Promise<T>
): Promise<T> {
    for (const url of this.rpcUrls) {
        try {
            const provider = new ethers.JsonRpcProvider(url);
            return await fn(provider);
        } catch (e) {
            console.warn(`RPC ${url} failed, trying next...`);
        }
    }
    throw new Error('All RPC nodes failed');
}
```

---

## 6. MarketMakerEngine - 单市场引擎

### 6.1 类结构

```typescript
class MarketMakerEngine extends EventEmitter {
    private config: MarketMakerConfig;
    private deps: EngineDependencies;
    private state: MarketState;

    private tickTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;

    constructor(config: MarketMakerConfig, deps: EngineDependencies) {
        super();
        this.config = mergeMarketConfig(config);
        this.deps = deps;
        this.state = this.createInitialState();
    }
}
```

### 6.2 主循环

```typescript
async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[Engine] Starting for market ${this.config.marketId}`);

    // 立即执行一次
    await this.tick();

    // 定时执行
    this.tickTimer = setInterval(
        () => this.tick(),
        this.config.tickIntervalMs
    );
}

async stop(): Promise<void> {
    this.isRunning = false;
    if (this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
    }

    // 取消所有活跃订单
    await this.cancelAllOrders();
}
```

### 6.3 Tick 逻辑

```typescript
private async tick(): Promise<void> {
    try {
        // 1. 获取市场数据
        const [orderbook, position, activeOrders] = await Promise.all([
            this.deps.fetchOrderbook(),
            this.deps.getPosition(this.config.tokenId),
            this.deps.getActiveOrders(this.config.marketId),
        ]);

        // 2. 更新状态
        this.updateState(orderbook, position, activeOrders);

        // 3. 检测成交
        this.detectFills(activeOrders);

        // 4. 计算订单变更
        const buyDelta = this.calculateBuyDelta();
        const sellDelta = this.calculateSellDelta();

        // 5. 执行变更
        await this.executeDelta(buyDelta);
        await this.executeDelta(sellDelta);

        // 6. 发射事件
        this.emit('tick', this.state);

    } catch (e) {
        console.error(`[Engine] Tick error:`, e);
        this.emit('error', e);
    }
}
```

### 6.4 买单策略计算

```typescript
private calculateBuyDelta(): OrderDelta {
    const { config, state } = this;

    // 检查是否启用买单
    if (!config.buyEnabled) {
        return { action: 'HOLD', side: 'BUY', reason: 'Buy disabled' };
    }

    // 检查仓位上限
    const positionQty = Number(state.position) / 1e6;
    if (positionQty >= config.maxPosition) {
        // 需要取消现有买单
        if (state.activeBuyOrder) {
            return {
                action: 'CANCEL',
                side: 'BUY',
                existingOrderHash: state.activeBuyOrder.orderHash,
                reason: 'Max position reached',
            };
        }
        return { action: 'HOLD', side: 'BUY', reason: 'Max position reached' };
    }

    // 计算目标价格
    const targetPrice = this.calculateBuyPrice();

    if (targetPrice === null) {
        // 无法计算价格 (无 ask)
        if (state.activeBuyOrder) {
            return {
                action: 'CANCEL',
                side: 'BUY',
                existingOrderHash: state.activeBuyOrder.orderHash,
                reason: 'No ask price available',
            };
        }
        return { action: 'HOLD', side: 'BUY', reason: 'No ask price' };
    }

    // 检查价格上限
    if (targetPrice > config.buyMaxPrice) {
        if (state.activeBuyOrder) {
            return {
                action: 'CANCEL',
                side: 'BUY',
                existingOrderHash: state.activeBuyOrder.orderHash,
                reason: `Price ${targetPrice} > max ${config.buyMaxPrice}`,
            };
        }
        return { action: 'HOLD', side: 'BUY', reason: 'Price above max' };
    }

    // 检查最小价差
    if (state.bestAsk && targetPrice >= state.bestAsk - config.minSpread) {
        return { action: 'HOLD', side: 'BUY', reason: 'Spread too tight' };
    }

    // 计算目标数量
    const targetSize = config.buySize / targetPrice;

    // 决定动作
    if (!state.activeBuyOrder) {
        return {
            action: 'PLACE',
            side: 'BUY',
            newPrice: targetPrice,
            newSize: targetSize,
            reason: 'No active buy order',
        };
    }

    // 检查是否需要更新
    const priceDiff = Math.abs(state.activeBuyOrder.price - targetPrice);
    if (priceDiff >= config.buyPriceTick) {
        return {
            action: 'REPLACE',
            side: 'BUY',
            existingOrderHash: state.activeBuyOrder.orderHash,
            newPrice: targetPrice,
            newSize: targetSize,
            reason: `Price changed: ${state.activeBuyOrder.price} -> ${targetPrice}`,
        };
    }

    return { action: 'HOLD', side: 'BUY', reason: 'Order is current' };
}
```

### 6.5 价格计算策略

```typescript
private calculateBuyPrice(): number | null {
    const { config, state } = this;

    if (config.priceStrategy === 'FOLLOW') {
        // FOLLOW: 跟随最佳 ask，减去一个 tick
        if (state.bestAsk === null) return null;
        return Math.max(
            state.bestAsk - config.buyPriceTick,
            config.buyPriceTick  // 最低价
        );
    }

    if (config.priceStrategy === 'SCALP') {
        // SCALP: 在最佳 bid 上加一个 tick
        if (state.bestBid === null) {
            // 无 bid，使用 ask - spread
            if (state.bestAsk === null) return null;
            return state.bestAsk - config.minSpread;
        }
        return state.bestBid + config.buyPriceTick;
    }

    return null;
}
```

### 6.6 成交检测

```typescript
private detectFills(currentOrders: ActiveOrder[]): void {
    const previousOrders = this.state.previousActiveOrders || [];

    for (const prev of previousOrders) {
        const current = currentOrders.find(o => o.orderHash === prev.orderHash);

        if (!current) {
            // 订单消失 - 可能完全成交或被取消
            if (prev.filledSize > 0) {
                this.recordFill(prev, prev.size - prev.filledSize);
            }
        } else if (current.filledSize > prev.filledSize) {
            // 部分成交
            const fillQty = current.filledSize - prev.filledSize;
            this.recordFill(prev, fillQty);
        }
    }
}

private recordFill(order: ActiveOrder, fillQty: number): void {
    const fillValue = fillQty * order.price;

    if (order.side === 'BUY') {
        this.state.stats.totalBought += fillQty;
        this.state.stats.totalBuyCost += fillValue;
    } else {
        this.state.stats.totalSold += fillQty;
        this.state.stats.totalSellRevenue += fillValue;
    }

    this.state.stats.fillCount++;
    this.state.stats.realizedPnL =
        this.state.stats.totalSellRevenue - this.state.stats.totalBuyCost;

    this.emit('fill', { order, fillQty, fillValue });
}
```

---

## 7. MultiMarketMaker - 多市场管理器

### 7.1 类结构

```typescript
class MultiMarketMaker extends EventEmitter {
    private engines: Map<string, MarketMakerEngine> = new Map();
    private tradingClient: TradingClient;
    private globalConfig: GlobalConfig;

    constructor(
        tradingClient: TradingClient,
        globalConfig: Partial<GlobalConfig> = {}
    ) {
        super();
        this.tradingClient = tradingClient;
        this.globalConfig = mergeGlobalConfig(globalConfig);
    }
}
```

### 7.2 添加/移除市场

```typescript
addMarket(config: MarketMakerConfig): MarketMakerEngine {
    if (this.engines.has(config.marketId)) {
        throw new Error(`Market ${config.marketId} already exists`);
    }

    // 创建依赖
    const deps = this.createDependencies(config);

    // 创建引擎
    const engine = new MarketMakerEngine(config, deps);

    // 转发事件
    engine.on('fill', (data) => this.emit('fill', { marketId: config.marketId, ...data }));
    engine.on('error', (err) => this.emit('error', { marketId: config.marketId, error: err }));

    this.engines.set(config.marketId, engine);
    return engine;
}

async removeMarket(marketId: string): Promise<void> {
    const engine = this.engines.get(marketId);
    if (engine) {
        await engine.stop();
        this.engines.delete(marketId);
    }
}
```

### 7.3 批量操作

```typescript
async startAll(): Promise<void> {
    const promises = Array.from(this.engines.values()).map(e => e.start());
    await Promise.all(promises);
}

async stopAll(): Promise<void> {
    const promises = Array.from(this.engines.values()).map(e => e.stop());
    await Promise.all(promises);
}

// 紧急停止 - 取消所有订单
async emergencyStop(): Promise<void> {
    console.log('[MultiMM] Emergency stop triggered!');

    for (const engine of this.engines.values()) {
        await engine.stop();
    }

    this.emit('emergencyStop');
}
```

### 7.4 全局统计

```typescript
getGlobalStats(): GlobalStats {
    let totalBought = 0;
    let totalSold = 0;
    let totalBuyCost = 0;
    let totalSellRevenue = 0;
    let totalFills = 0;

    for (const engine of this.engines.values()) {
        const stats = engine.getStats();
        totalBought += stats.totalBought;
        totalSold += stats.totalSold;
        totalBuyCost += stats.totalBuyCost;
        totalSellRevenue += stats.totalSellRevenue;
        totalFills += stats.fillCount;
    }

    return {
        marketCount: this.engines.size,
        totalBought,
        totalSold,
        totalBuyCost,
        totalSellRevenue,
        realizedPnL: totalSellRevenue - totalBuyCost,
        totalFills,
    };
}
```

---

## 8. 订单生命周期

### 8.1 状态转换图

```
                        ┌─────────┐
                        │  INIT   │
                        └────┬────┘
                             │ placeOrder()
                             ▼
                        ┌─────────┐
              ┌─────────│ PENDING │─────────┐
              │         └────┬────┘         │
              │              │ confirmed    │ rejected
              │              ▼              │
              │         ┌─────────┐         │
              │    ┌────│  OPEN   │────┐    │
              │    │    └────┬────┘    │    │
              │    │         │ fill    │    │
              │    │         ▼         │    │
              │    │    ┌─────────┐    │    │
              │    │    │PARTIALLY│    │    │
              │    │    │ FILLED  │    │    │
              │    │    └────┬────┘    │    │
              │    │         │         │    │
              │    │  cancel │ full    │    │
              │    │         │ fill    │    │
              │    ▼         ▼         │    │
              │ ┌─────────────────────┐│    │
              │ │     CANCELLED       ││    │
              │ └─────────────────────┘│    │
              │                        ▼    │
              │              ┌─────────────┐│
              └──────────────│   FILLED    │◄┘
                             └─────────────┘
```

### 8.2 订单操作

| 操作 | 条件 | 结果 |
|------|------|------|
| PLACE | 无活跃订单 | 创建新订单 |
| CANCEL | 有活跃订单 | 取消订单 |
| REPLACE | 价格变化 > tick | 取消旧单 + 创建新单 |
| HOLD | 无需变更 | 保持现状 |

### 8.3 Replace 实现

```typescript
private async executeReplace(delta: OrderDelta): Promise<void> {
    // 1. 先取消旧订单
    const cancelled = await this.deps.cancelOrder(delta.existingOrderHash!);

    if (!cancelled) {
        console.warn('Cancel failed, order may have filled');
        return;
    }

    // 2. 等待取消确认 (避免 nonce 冲突)
    await this.delay(100);

    // 3. 下新订单
    await this.deps.placeOrder({
        marketId: this.config.marketId,
        side: delta.side,
        price: delta.newPrice!,
        size: delta.newSize!,
    });
}
```

---

## 9. 仓位管理

### 9.1 不变量约束

```typescript
// 核心约束
const invariants = {
    // 不做空: 卖出数量 ≤ 当前持仓
    noShorting: sellQuantity <= position,

    // 不超买: 买入后持仓 ≤ 最大持仓
    noOverBuying: position + buyQuantity <= maxPosition,

    // 价格边界: buyPrice ≤ buyMaxPrice
    priceInRange: price <= config.buyMaxPrice && price >= config.sellMinPrice,
};
```

### 9.2 卖单数量计算

```typescript
private calculateSellSize(): number {
    const position = Number(this.state.position) / 1e6;
    const pendingSellQty = this.state.activeSellOrder?.size || 0;

    // 可卖数量 = 持仓 - 已挂卖单
    const availableToSell = position - pendingSellQty;

    // 不超过配置的卖单大小
    return Math.min(availableToSell, this.config.sellSize);
}
```

### 9.3 持仓成本追踪

```typescript
// 简化的 FIFO 成本计算
private calculateAverageCost(): number {
    if (this.state.stats.totalBought === 0) return 0;
    return this.state.stats.totalBuyCost / this.state.stats.totalBought;
}

// 未实现盈亏
private calculateUnrealizedPnL(): number {
    const position = Number(this.state.position) / 1e6;
    const avgCost = this.calculateAverageCost();
    const markPrice = this.state.bestBid || 0;

    return position * (markPrice - avgCost);
}
```

---

## 10. 事件系统

### 10.1 事件类型

```typescript
interface MarketMakerEvents {
    // 每个 Tick 完成
    tick: (state: MarketState) => void;

    // 订单成交
    fill: (data: {
        order: ActiveOrder;
        fillQty: number;
        fillValue: number;
    }) => void;

    // 订单操作
    orderPlaced: (order: ActiveOrder) => void;
    orderCancelled: (orderHash: string) => void;

    // 错误
    error: (error: Error) => void;

    // 状态变化
    started: () => void;
    stopped: () => void;
}
```

### 10.2 使用示例

```typescript
const engine = new MarketMakerEngine(config, deps);

engine.on('fill', ({ order, fillQty, fillValue }) => {
    console.log(`Fill: ${order.side} ${fillQty} @ ${order.price}`);
    // 发送通知
    telegram.sendMessage(`✅ 成交: ${order.side} ${fillQty} @ ${order.price}`);
});

engine.on('error', (err) => {
    console.error('Engine error:', err);
    // 报警
    telegram.sendMessage(`⚠️ 引擎错误: ${err.message}`);
});

await engine.start();
```

---

## 11. 关键算法

### 11.1 价差检查

```typescript
private isSpreadSufficient(): boolean {
    const { bestBid, bestAsk } = this.state;

    if (bestBid === null || bestAsk === null) {
        return true; // 单边市场，允许挂单
    }

    const spread = bestAsk - bestBid;
    return spread >= this.config.minSpread;
}
```

### 11.2 订单大小调整

```typescript
private adjustOrderSize(baseSize: number, price: number): number {
    // 1. 转换为数量
    let quantity = baseSize / price;

    // 2. 向下取整到最小单位
    const minUnit = 0.01; // 最小 0.01 股
    quantity = Math.floor(quantity / minUnit) * minUnit;

    // 3. 确保满足最小订单要求
    const minOrderValue = 1; // $1 最小订单
    if (quantity * price < minOrderValue) {
        quantity = minOrderValue / price;
    }

    return quantity;
}
```

### 11.3 价格舍入

```typescript
private roundPrice(price: number, tick: number): number {
    // 向下舍入到 tick 的整数倍
    return Math.floor(price / tick) * tick;
}
```

---

## 12. 适配其他市场的指南

### 12.1 需要实现的接口

要适配 Probalbe 或其他预测市场，需要实现以下接口：

```typescript
interface MarketAdapter {
    // 1. 认证
    authenticate(): Promise<void>;

    // 2. 市场数据
    getOrderbook(marketId: string): Promise<{
        bids: Array<{ price: number; size: number }>;
        asks: Array<{ price: number; size: number }>;
    }>;

    // 3. 订单操作
    placeOrder(params: {
        marketId: string;
        side: 'BUY' | 'SELL';
        price: number;
        size: number;
    }): Promise<{ orderId: string }>;

    cancelOrder(orderId: string): Promise<boolean>;

    getActiveOrders(marketId: string): Promise<ActiveOrder[]>;

    // 4. 仓位查询
    getPosition(marketId: string): Promise<number>;

    // 5. 账户余额
    getBalance(): Promise<{ available: number; locked: number }>;
}
```

### 12.2 适配步骤

1. **创建 Trading Client**
   ```typescript
   // probalbe/trading-client.ts
   class ProbalbleTradingClient implements MarketAdapter {
       // 实现认证逻辑
       // 实现 API 调用
   }
   ```

2. **配置映射**
   ```typescript
   // probalbe/config.ts
   interface ProbalbleMarketConfig extends MarketMakerConfig {
       // 添加 Probalbe 特有配置
       marketSlug: string;  // Probalbe 使用 slug
   }
   ```

3. **创建 Dependencies**
   ```typescript
   function createProbalbleDeps(
       client: ProbalbleTradingClient,
       config: ProbalbleMarketConfig
   ): EngineDependencies {
       return {
           fetchOrderbook: () => client.getOrderbook(config.marketSlug),
           getPosition: () => client.getPosition(config.marketSlug),
           placeOrder: (params) => client.placeOrder(params),
           cancelOrder: (id) => client.cancelOrder(id),
           getActiveOrders: () => client.getActiveOrders(config.marketSlug),
       };
   }
   ```

4. **复用 Engine**
   ```typescript
   // Engine 逻辑无需修改，直接复用
   const engine = new MarketMakerEngine(config, deps);
   ```

### 12.3 关键差异点

| 组件 | Predict | Probalbe (示例) |
|------|---------|-----------------|
| 认证 | JWT + 签名 | API Key? OAuth? |
| 市场 ID | 数字 ID | Slug 字符串 |
| 仓位查询 | ERC-1155 balanceOf | API 查询 |
| 价格精度 | 0.01 (1 cent) | 可能不同 |
| 最小订单 | $1 | 可能不同 |
| 手续费 | feeRate * min(p, 1-p) | 需要查询 |

### 12.4 套利模式适配

如果要做跨平台套利 (如 Predict ↔ Probalbe)，可以复用 `dashboard/taker-mode/` 的架构：

```typescript
// 套利检测
interface ArbOpportunity {
    predictAsk: number;
    probalbeAsk: number;  // 替换 polymarketAsk
    spread: number;
    profitable: boolean;
}

// 套利执行
interface ArbExecutor {
    executePredictLeg(params: OrderParams): Promise<void>;
    executeProbableLeg(params: OrderParams): Promise<void>;  // 新增
}
```

---

## 附录 A: API 参考

### Predict API

| 端点 | 方法 | 用途 |
|------|------|------|
| `/auth/nonce` | POST | 获取签名 nonce |
| `/auth/login` | POST | 换取 JWT |
| `/markets` | GET | 市场列表 |
| `/markets/{id}/orderbook` | GET | 订单簿 |
| `/orders` | POST | 下单 |
| `/orders/{hash}` | DELETE | 取消订单 |
| `/orders?marketId=` | GET | 活跃订单 |

### BSC 合约

| 合约 | 地址 | 用途 |
|------|------|------|
| CTF (ERC-1155) | `0x...` | 持仓查询 |
| USDC | `0x...` | 余额查询 |

---

## 附录 B: 错误处理

### 常见错误

| 错误码 | 含义 | 处理方式 |
|--------|------|----------|
| `INSUFFICIENT_BALANCE` | 余额不足 | 减少订单大小 |
| `INVALID_PRICE` | 价格无效 | 检查价格精度 |
| `ORDER_NOT_FOUND` | 订单不存在 | 可能已成交 |
| `RATE_LIMITED` | 请求过频 | 增加 Tick 间隔 |
| `JWT_EXPIRED` | Token 过期 | 重新认证 |

### 重试策略

```typescript
async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 1000
): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (e) {
            if (i === maxRetries - 1) throw e;
            await delay(delayMs * Math.pow(2, i)); // 指数退避
        }
    }
    throw new Error('Unreachable');
}
```

---

## 附录 C: 监控指标

### 推荐监控项

```typescript
interface Metrics {
    // 性能
    tickLatencyMs: number;      // Tick 执行耗时
    apiLatencyMs: number;       // API 响应时间

    // 业务
    fillRate: number;           // 成交率
    spreadCapture: number;      // 价差捕获
    inventorySkew: number;      // 库存偏移

    // 风险
    positionExposure: number;   // 仓位敞口
    unrealizedPnL: number;      // 未实现盈亏
    maxDrawdown: number;        // 最大回撤
}
```

---

*文档版本: 1.0*
*最后更新: 2026-01-07*
