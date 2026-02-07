# Predict 做市模块技术文档

## 概述

做市模块为 Predict.fun 预测市场提供自动化做市功能。采用**对账式同步**策略，持续维护买卖双边订单，通过捕获买卖价差获利。

## 架构图

```
┌──────────────────────────────────────────────────────────────────────┐
│                              CLI 入口                                 │
│                            (cli.ts)                                  │
│   ┌─────────────┐     ┌──────────────┐     ┌──────────────────────┐ │
│   │ 市场扫描     │ ──▶ │  交互式选择   │ ──▶ │   配置生成           │ │
│   │ scanMarkets │     │ selectMarkets│     │ convertToConfigs     │ │
│   └─────────────┘     └──────────────┘     └──────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         多市场管理器                                   │
│                      (MultiMarketMaker)                              │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────────┐ │
│   │                        主循环 (1s 间隔)                         │ │
│   │                                                                │ │
│   │   for each market:                                             │ │
│   │       engine.tick()                                            │ │
│   │       await sleep(100ms)  // 避免 API 限流                     │ │
│   └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│   │ Engine #1    │  │ Engine #2    │  │ Engine #N    │             │
│   │ Market 690   │  │ Market 709   │  │ Market ...   │             │
│   └──────────────┘  └──────────────┘  └──────────────┘             │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          交易客户端                                   │
│                       (TradingClient)                                │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                      EngineDependencies                     │   │
│   │                                                             │   │
│   │  fetchOrderBook()  fetchOrders()  fetchPosition(tokenId)   │   │
│   │  placeOrder()      cancelOrder()     cancelOrders()         │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   ┌───────────────┐   ┌───────────────┐   ┌────────────────────┐   │
│   │ JWT 认证       │   │ OrderBuilder  │   │   合约调用          │   │
│   │ (智能钱包模式) │   │ (订单签名)    │   │ (Token ID 查询)    │   │
│   └───────────────┘   └───────────────┘   └────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Predict API                                  │
│                                                                      │
│  GET  /v1/markets                    市场列表                        │
│  GET  /v1/markets/{id}/orderbook     订单簿                          │
│  GET  /v1/orders?marketId=           活跃订单                        │
│  链上 ERC-1155 balanceOf(tokenId)    真实持仓查询 (用于 SELL 可用量)  │
│  POST /v1/orders                     下单                            │
│  POST /v1/orders/remove              取消订单 (无需 gas)              │
└──────────────────────────────────────────────────────────────────────┘
```

## 模块结构

```
bot/src/market-maker/
├── cli.ts                  # CLI 入口，启动流程
├── trading-client.ts       # 交易客户端（认证、签名、API 调用）
├── engine.ts               # 单市场做市引擎
├── multi-engine.ts         # 多市场管理器
├── market-selector.ts      # 市场扫描与选择
├── config.ts               # 配置管理
├── types.ts                # 类型定义
├── test-trading-client.ts  # 交易客户端测试
└── test-order.ts           # 下单/取消测试
```

## 核心组件

### 1. TradingClient（交易客户端）

**文件**: `trading-client.ts`

负责与 Predict API 的所有交互，包括认证、订单操作和数据查询。

#### 认证机制

```typescript
// 智能钱包 JWT 认证流程
1. GET /v1/auth/message              // 获取签名消息
2. orderBuilder.signPredictAccountMessage(message)  // 使用 SDK 签名
3. POST /v1/auth { signer: smartWalletAddress, signature, message }
4. 返回 JWT Token (24小时有效)
```

**关键点**:
- 使用 `@predictdotfun/sdk` 的 `OrderBuilder`
- 认证地址是智能钱包地址，但签名使用 Privy 私钥
- `signPredictAccountMessage` 方法处理智能钱包签名逻辑

#### Token ID 获取

```typescript
// 直接从 API 获取，不需要链上计算
const res = await fetch(`/v1/markets/${marketId}`);
const tokenId = res.data.outcomes.find(o => o.name === 'Yes').onChainId;
```

#### 订单签名

```typescript
// 关键：isYieldBearing 影响 EIP-712 签名的 verifyingContract
const typedData = orderBuilder.buildTypedData(order, {
    isNegRisk: market.isNegRisk,
    isYieldBearing: market.isYieldBearing  // 必须正确！
});
const signedOrder = await orderBuilder.signTypedDataOrder(typedData);
```

**签名参数影响**:
- `isYieldBearing: true` → 使用 YieldBearing 合约地址
- `isYieldBearing: false` → 使用标准 Exchange 合约地址
- 地址不匹配会导致 "Order hash mismatch" 错误

#### 取消订单

```typescript
// API 取消（无需 gas，推荐）
POST /v1/orders/remove
{
    "data": { "ids": ["orderId1", "orderId2"] }
}

// 返回
{ "data": { "removed": [...], "noop": [...] } }
```

### 2. MarketMakerEngine（做市引擎）

**文件**: `engine.ts`

单市场做市逻辑核心。

#### 不变量约束

```
1. 不做空：0 <= position
2. 不超卖：openSellRemaining <= position
3. 不超最大持仓：position + openBuyRemaining <= maxPosition
4. 不交叉报价：buyPrice < sellPrice（避免自成交）
```

#### 对账式同步策略

每个 tick 周期执行：

```
1. syncState()           // 同步订单和持仓状态
2. fetchOrderBook()      // 获取最新价格
3. calculateBuyDelta()   // 计算买单调整
4. calculateSellDelta()  // 计算卖单调整
5. executeDelta()        // 执行调整（独立频率控制）
```

#### 买单计算逻辑

```typescript
// 目标买单量 = 最大持仓 - 当前持仓 - 未成交买单量
const desiredBuy = maxShares - position - openBuyRemaining;

// 动作判断
if (!current && desiredBuy > 0) → PLACE
if (priceChanged || desiredBuy > 0) → REPLACE
if (position + openBuy > maxShares) → CANCEL (不变量违反)
```

#### 卖单计算逻辑

```typescript
// 目标卖单量 = 当前持仓 - 未成交卖单量
const desiredSell = position - openSellRemaining;

// 动作判断
if (!current && desiredSell > 0) → PLACE
if (priceChanged || desiredSell > 0) → REPLACE
if (position <= 0) → CANCEL
```

#### 频率控制

```typescript
// 买卖双边独立的调整时间戳（避免同一 tick 只能调整一边）
private lastBuyAdjustTime = 0;
private lastSellAdjustTime = 0;

// 每边最小间隔 500ms
if (now - lastTime < minAdjustIntervalMs) return;
```

### 3. MultiMarketMaker（多市场管理器）

**文件**: `multi-engine.ts`

管理多个 `MarketMakerEngine` 实例。

```typescript
class MultiMarketMaker {
    private engines: Map<number, MarketMakerEngine>;

    // 主循环
    async start() {
        this.tickInterval = setInterval(async () => {
            for (const engine of engines) {
                await engine.tick();
                await sleep(100);  // 市场间隔，避免限流
            }
        }, pollIntervalMs);
    }
}
```

#### 全局统计

```typescript
interface GlobalStats {
    totalMarkets: number;      // 总市场数
    runningMarkets: number;    // 运行中市场数
    totalFills: number;        // 总成交次数
    totalVolume: number;       // 总成交额
    totalRealizedPnL: number;  // 总已实现盈亏
    startTime: Date | null;
}
```

### 4. 市场选择器

**文件**: `market-selector.ts`

#### 市场扫描

```typescript
async function scanMarkets(apiKey: string): Promise<MarketInfo[]> {
    // 分页获取所有活跃市场
    // 过滤: status !== 'RESOLVED' && status !== 'CANCELLED'
}
```

#### 交互式选择

```
命令:
  <市场ID>     选择指定ID的市场
  <关键词>     搜索市场
  list         显示已选择的市场
  done         完成选择
  help         显示帮助
```

## 类型定义

### 核心配置

```typescript
interface MarketMakerConfig {
    marketId: number;
    title: string;
    tokenId: string;           // YES token ID
    feeRateBps: number;        // 手续费基点 (200 = 2%)
    isNegRisk: boolean;
    isYieldBearing: boolean;   // 关键：影响签名合约地址
    maxShares: number;         // 最大持仓
    minOrderSize: number;      // 最小订单量
}

interface GlobalConfig {
    pollIntervalMs: number;       // 轮询间隔 (默认 1000ms)
    minAdjustIntervalMs: number;  // 最小调整间隔 (默认 500ms)
    maxRetries: number;
    retryDelayMs: number;
}
```

### 市场状态

```typescript
interface MarketState {
    marketId: number;
    title: string;
    position: number;                    // 当前持仓
    activeBuyOrder: ActiveOrder | null;
    activeSellOrder: ActiveOrder | null;
    lastBestBid: number;
    lastBestAsk: number;
    lastSpread: number;
    lastUpdateMs: number;
    status: 'idle' | 'initializing' | 'running' | 'paused' | 'error';
}
```

### 订单增量

```typescript
interface OrderDelta {
    action: 'PLACE' | 'CANCEL' | 'REPLACE' | 'NONE';
    side: 'BUY' | 'SELL';
    currentOrder: ActiveOrder | null;
    targetPrice: number;
    targetQuantity: number;
    reason?: string;
}
```

## 启动流程

```
1. 初始化交易客户端 (TradingClient)
   - 创建 Wallet 和 Provider
   - 初始化 OrderBuilder (智能钱包模式)
   - 获取 JWT 认证

2. 扫描市场 (scanMarkets)
   - 分页获取所有活跃市场
   - 过滤已结算市场

3. 交互式选择 (selectMarkets)
   - 用户输入市场ID或搜索
   - 设置每个市场的最大持仓

4. 生成配置 (convertToConfigs)
   - 为每个市场获取 Token ID
   - 合并默认配置

5. 创建多市场管理器 (MultiMarketMaker)
   - 注入交易客户端依赖
   - 添加所有市场配置

6. 启动做市 (start)
   - 初始化所有引擎 (同步持仓/订单)
   - 启动主循环

7. 监控面板 (renderDashboard)
   - 每秒刷新显示状态
```

## 环境变量

```bash
# 必需
PREDICT_API_KEY=<API 密钥>
PREDICT_SIGNER_PRIVATE_KEY=<Privy 钱包私钥>
PREDICT_SMART_WALLET_ADDRESS=<Predict 智能钱包地址>

# 可选
PREDICT_API_KEY_SCAN=<扫描专用 API Key>
PREDICT_API_BASE_URL=https://api.predict.fun
```

## 运行命令

```bash
# 测试交易客户端
npx tsx src/market-maker/test-trading-client.ts

# 测试下单/取消
npx tsx src/market-maker/test-order.ts

# 启动做市 CLI
npm run market-maker
```

## 日志与排错

- 监控面板会在底部展示“最近错误”，避免被每秒刷新清屏覆盖。
- 同时会追加写入 `bot/market-maker.log`（从 `bot/` 目录运行时）用于留存排错。
- 如需关闭清屏（保留终端滚动输出），可设置环境变量：`MM_NO_CLEAR=1`

## 监控面板

```
╔════════════════════════════════════════════════════════════════════════════════════════╗
║  PREDICT 做市监控  │  21:55:40  │  运行: 5m 30s                                        ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║  市场: 1/1  │  成交: 1  │  盈亏: -$2.97                                                 ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ #  │ 市场                          │ 状态  │ 持仓 │ 买单 │ 卖单 │ 买一   │ 卖一          ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║  1 │ João Cotrim Figueiredo (IL)  │ ★运行 │   30 │   70 │   30 │   9.9¢ │  10.0¢        ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ 最近成交                                                                                ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║  21:55:40 │ 买入 │ 30 @   9.9¢                                                          ║
╚════════════════════════════════════════════════════════════════════════════════════════╝

[Ctrl+C] 退出  │  刷新: 1s
```

## 已知问题与解决方案

### 1. Order hash mismatch

**原因**: `isYieldBearing` 值错误，导致 EIP-712 签名使用错误的合约地址。

**解决**: 始终从 `/v1/markets/{id}` API 获取正确的 `isYieldBearing` 值。

### 2. Order must have a value of at least 0.9 USD

**原因**: 订单金额低于最小值限制。

**解决**: 动态计算最小数量：`minQuantity = Math.ceil(0.9 / price)`

### 3. 成交后只有一边订单

**原因**: 买卖共用 `lastAdjustTime`，导致同一 tick 只能调整一边。

**解决**: 分离为 `lastBuyAdjustTime` 和 `lastSellAdjustTime`。

### 4. 取消订单需要 BNB

**原因**: 使用了 SDK 的链上取消方法。

**解决**: 使用 `POST /v1/orders/remove` API 取消，无需 gas。

## 盈亏计算

```typescript
// 简单估算：卖出总价值 - 买入总价值
realizedPnL = totalSellValue - totalBuyValue;

// 平均价格跟踪
avgBuyPrice = totalBuyValue / totalBuyVolume;
avgSellPrice = totalSellValue / totalSellVolume;
```

## 风险控制

1. **持仓限制**: `maxShares` 限制单市场最大持仓
2. **不做空**: 卖单量不超过当前持仓
3. **自成交保护**: 买价必须低于卖价
4. **频率限制**: 每边订单调整最小间隔 500ms
5. **市场间隔**: 多市场轮询时每个市场间隔 100ms

## 依赖

```json
{
    "@predictdotfun/sdk": "订单构建与签名",
    "ethers": "链上合约调用",
    "dotenv": "环境变量加载"
}
```
