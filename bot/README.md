# Predict-Polymarket Arbitrage Trading Bot

跨平台套利交易机器人，整合 Predict.fun 和 Polymarket 的订单簿数据。

## 📁 项目结构

```
bot/src/
├── index.ts                  # 主入口点
├── order-book-manager.ts     # 统一订单簿管理器
├── polymarket/               # Polymarket 客户端
│   ├── index.ts              # Polymarket 统一入口
│   ├── types.ts              # 类型定义
│   ├── rest-client.ts        # REST API 客户端
│   ├── ws-client.ts          # WebSocket 客户端 (实时)
│   └── test-polymarket.ts    # 测试脚本
└── predict/                  # Predict 客户端
    ├── index.ts              # Predict 统一入口
    ├── types.ts              # 类型定义
    ├── rest-client.ts        # REST API 客户端
    └── test-predict.ts       # 测试脚本
```

## 🚀 快速开始

### 安装依赖

```bash
cd bot
npm install
```

### 运行测试

```bash
# 测试 Polymarket 客户端 (无需 API Key)
npm run test:polymarket

# 测试 Predict 客户端 (需要 API Key)
npm run test:predict

# 运行所有测试
npm run test:all
```

### 配置环境变量

```bash
# Predict API Key (从 https://predict.fun/settings/api 获取)
export PREDICT_API_KEY=your_api_key_here
```

## 📊 API 对比

| 功能 | Polymarket | Predict |
|------|------------|---------|
| 实时订单簿 | ✅ WebSocket | ❌ 轮询 |
| REST API | ✅ | ✅ |
| 最小延迟 | ~50ms | ~100-200ms |
| 需要 API Key | 否 | 是 |

## 💡 使用示例

### Polymarket 客户端

```typescript
import { PolymarketClient } from './polymarket/index.js';

const client = new PolymarketClient();

// 设置实时更新回调
client.setHandlers({
  onOrderBookUpdate: (book) => {
    console.log(`订单簿更新: ${book.assetId}`);
    console.log(`  Best Bid: ${book.bids[0]?.[0]}`);
    console.log(`  Best Ask: ${book.asks[0]?.[0]}`);
  },
});

// 连接 WebSocket
await client.connect();

// 加载和订阅市场
const markets = await client.loadMarkets({ active: true, limit: 10 });
const tokenIds = markets.flatMap(m => {
  const ids = client.rest.parseTokenIds(m);
  return ids ? [ids.yes, ids.no] : [];
});
client.subscribeToTokens(tokenIds);

// ... 处理实时更新 ...

// 断开连接
client.disconnect();
```

### Predict 客户端

```typescript
import { PredictClient } from './predict/index.js';

const client = new PredictClient({
  apiKey: process.env.PREDICT_API_KEY,
  pollingInterval: 100, // 100ms 轮询间隔
});

// 设置回调
client.onOrderBook((book) => {
  console.log(`订单簿更新: ${book.marketId}`);
});

// 获取市场并订阅
const markets = await client.rest.getMarkets({ status: 'ACTIVE', limit: 5 });
const marketIds = markets.map(m => m.id);
client.subscribe(marketIds); // 自动开始轮询

// ... 处理更新 ...

// 停止轮询
client.stopPolling();
```

### 统一订单簿管理器

```typescript
import { OrderBookManager, type MarketPair } from './order-book-manager.js';

const manager = new OrderBookManager({
  predictApiKey: process.env.PREDICT_API_KEY,
  predictPollingInterval: 100,
  minProfitThreshold: 0.005, // 0.5% 最小套利阈值
});

// 注册市场对
const pairs: MarketPair[] = [
  {
    polymarketTokenId: 'polymarket_yes_token_id',
    predictMarketId: 123,
    description: 'Will X happen?',
  },
];
manager.registerMarketPairs(pairs);

// 设置回调
manager.setOnOrderBookUpdate((book) => {
  console.log(`[${book.platform}] 更新: ${book.marketId}`);
  console.log(`  YES: Bid=${book.bestYesBid}, Ask=${book.bestYesAsk}`);
  console.log(`  NO:  Bid=${book.bestNoBid}, Ask=${book.bestNoAsk}`);
});

manager.setOnArbitrage((opportunity) => {
  console.log(`🎯 套利机会发现!`);
  console.log(`  类型: ${opportunity.type}`);
  console.log(`  买入: ${opportunity.buyPlatform} @ ${opportunity.buyPrice}`);
  console.log(`  卖出: ${opportunity.sellPlatform} @ ${opportunity.sellPrice}`);
  console.log(`  利润: ${(opportunity.profit * 100).toFixed(2)}%`);
});

// 开始监控
await manager.start();

// ... 监控运行中 ...

// 停止
manager.stop();
```

## 📈 延迟预算

| 环节 | Polymarket | Predict |
|------|------------|---------|
| 数据获取 | <50ms (WebSocket) | ~100-150ms (轮询) |
| 内部处理 | <5ms | <5ms |
| 订单构建 | <10ms | <10ms |
| 订单提交 | ~100ms | ~100ms |
| **总端到端** | **~200ms** | **~300ms** |

## ⚠️ 重要限制

1. **Predict 没有 WebSocket API** - 只能通过轮询获取数据
2. **Predict 需要 API Key** - 从 https://predict.fun/settings/api 获取
3. **订单簿价格仅包含 YES** - NO 价格需要计算: `NO = 1 - YES`

## 🔧 开发

```bash
# 类型检查
npm run typecheck

# 构建
npm run build

# 开发模式
npm run dev
```
