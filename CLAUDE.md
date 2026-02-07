# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Predict.fun 与 Polymarket 跨平台套利交易机器人。

## 常用命令

```bash
cd bot

# Dashboard (主入口)
npm run dashboard               # 启动 http://localhost:3010 (交互式选择账号)
npm run dashboard -- --env .env.account1 --port 3010 --account account1  # 指定账号
npm run dashboard:all           # 启动所有账号

# 类型检查 (修改代码后必须运行)
npx tsc --noEmit

# CLI 工具
npm run arb-monitor                      # 套利监控面板
npm run market-maker                     # Predict 做市引擎
npm run market-maker:scalp               # 做市 SCALP 策略
npm run scan-markets                     # 全量市场扫描
npx tsx src/terminal/linked-markets.ts   # 市场匹配扫描

# 测试脚本
npx tsx src/testing/test-onchain-balance.ts     # Predict 链上余额
npx tsx src/testing/test-polymarket-account.ts  # Polymarket 账户
npx tsx src/testing/test-telegram.ts            # Telegram 通知
npx tsx src/testing/test-predict-order.ts       # Predict 下单测试

# PM2 部署
pm2 start ecosystem.config.cjs           # 后台运行 Dashboard
```

SDK 构建 (仅在修改 `sdk/` 时需要):
```bash
cd sdk && yarn install && yarn build
```

## 项目结构

```
predict-engine/
├── bot/              # TypeScript 主程序 (ESM, tsx 运行)
│   ├── src/
│   │   ├── dashboard/    # Dashboard 后端 + React 前端 (Vite)
│   │   ├── arb/          # 套利检测引擎
│   │   ├── trading/      # 价格工具、深度计算
│   │   ├── market-maker/ # 做市引擎 (Ink.js CLI)
│   │   ├── services/     # BSC/WS 监控、缓存
│   │   ├── polymarket/   # Polymarket REST + WS 客户端
│   │   ├── predict/      # Predict REST 客户端
│   │   ├── notification/ # Telegram 通知
│   │   ├── terminal/     # CLI 工具脚本
│   │   └── testing/      # 测试脚本
│   └── data/             # 运行时数据 (slugs、任务日志)
├── front/            # 独立预览前端 (vanilla React, 非构建)
│   └── preview/          # components.jsx — 主 UI 组件
├── sdk/              # Predict SDK (git 子模块, Yarn + TypeChain)
└── docs/             # 架构文档、API 文档
```

**双前端架构**: `bot/src/dashboard/frontend/` 是 Vite + React 19 + Tailwind 构建的 SPA；`front/preview/` 是无构建的 vanilla JSX 预览层 (通过 `<script>` 加载 React)，Dashboard 后端同时服务两者。修改 UI 逻辑时通常改 `front/preview/components.jsx`。

## 高层架构

### 核心数据流

```
Predict API ──────┐
(markets, orderbook)
                   ├──→ start-dashboard.ts ──→ SSE ──→ 前端
Polymarket API ───┘
(CLOB, Gamma)

前端 ──→ POST /tasks ──→ task-service ──→ task-executor
                                              │
                              ┌────────────────┴────────────┐
                              ↓                             ↓
                      predict-trader.ts         polymarket-trader.ts
                      (SDK OrderBuilder)        (EIP-712 签名)
                              │                             │
                              └───────→ telegram.ts ←───────┘
```

### 关键模块职责

| 模块 | 路径 | 职责 |
|-----|------|------|
| Dashboard 后端 | `bot/src/dashboard/start-dashboard.ts` | SSE 推送、REST API、套利检测调度 |
| 任务执行 | `bot/src/dashboard/task-executor.ts` | 任务状态机、深度监控、并发控制 |
| TAKER 执行器 | `bot/src/dashboard/taker-mode/executor.ts` | 双边同时下单、对冲逻辑 |
| 任务日志 | `bot/src/dashboard/task-logger/` | 异步队列、JSONL 持久化、通知集成 |
| 体育服务 | `bot/src/dashboard/sports-service.ts` | 体育市场匹配、赔率对比 |
| 深度计算 | `bot/src/trading/depth-calculator.ts` | 订单簿分析、可执行数量计算 |
| 价格工具 | `bot/src/trading/price-utils.ts` | `roundToTick`、`alignPriceDown/Up`、手续费计算 |
| BSC 监控 | `bot/src/services/bsc-order-watcher.ts` | WebSocket 订阅链上 OrderFilled 事件 |
| 平仓服务 | `bot/src/dashboard/close-service.ts` | 持仓平仓、反向卖出 |
| 做市引擎 | `bot/src/market-maker/engine.ts` | 1000ms tick 循环、订单调整、风控 |
| 下单客户端 | `bot/src/trading/predict-order-client.ts` | Predict 订单构建/签名/提交封装 |

### 任务执行状态机

```
CREATED → PENDING → EXECUTING → FILL_COMPLETED → HEDGE_IN_PROGRESS
                                                   ↓
                                           HEDGE_COMPLETED / HEDGE_FAILED
                                                   ↓
                                             CLOSED / ERRORED
```

**两种策略**: MAKER (挂单等待成交后对冲) 和 TAKER (双边同时吃单，`taker-mode/executor.ts` 处理)。

### WebSocket 客户端

| 客户端 | 路径 | 连接地址 | 用途 |
|--------|------|---------|------|
| Polymarket Market WS | `polymarket/ws-client.ts` | `wss://ws-subscriptions-clob.polymarket.com` | 订单簿实时推送 |
| Polymarket User WS | `polymarket/user-ws-client.ts` | `wss://.../ws/user` | 用户订单/成交事件 |
| Predict WS | `services/predict-ws-client.ts` | `wss://ws.predict.fun/ws` | 钱包事件 (OrderFilled/Cancelled) |
| BSC WSS | `services/bsc-order-watcher.ts` | BSC 公共 WSS 节点 | 链上 OrderFilled 事件监听 |

### 实时通知系统

```
TaskLogger ─┬─→ SSE (taskEvent) ─→ 前端 Toast
            └─→ Telegram 推送

BscOrderWatcher ─→ orderFilled 事件 ─→ BscOrderNotifier ─→ Telegram
PredictWsClient ─→ wallet events ─→ WsOrderNotifier ─→ Telegram
```

## 套利原理

```
YES 端套利 (arbSide='YES'):
  Predict 买 YES + Polymarket 买 NO = 套利锁定
  条件: predict_ask + polymarket_ask + fee < 1.0

NO 端套利 (arbSide='NO'):
  Predict 买 NO + Polymarket 买 YES = 套利锁定
  条件: predict_ask + polymarket_ask + fee < 1.0
```

## 市场类型与 Exchange 地址

| 类型 | 说明 | Predict (BSC) | Polymarket (Polygon) |
|-----|------|--------------|---------------------|
| Binary | 二元市场 | `0x8BC070...` | `0x4bFb41...` |
| NegRisk | 多选市场 | `0x365fb8...` | `0xC5d563...` |

**negRisk 签名**: 多选市场必须使用 `NEG_RISK_CTF_EXCHANGE` 地址签名。

## 订单签名 (EIP-712)

### Predict
```typescript
const domain = {
    name: 'predict.fun CTF Exchange',
    version: '1',
    chainId: 56,  // BSC
    verifyingContract: isNegRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE
};
```

### Polymarket
```typescript
const domain = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: 137,  // Polygon
    verifyingContract: negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE
};
```

## 价格与金额计算

```typescript
// BUY: 支付 USDC，获得 tokens
makerAmount = price * quantity  // USDC
takerAmount = quantity          // tokens

// SELL: 支付 tokens，获得 USDC
makerAmount = quantity          // tokens
takerAmount = price * quantity  // USDC

// Predict 手续费
fee = feeRate * min(price, 1 - price) * quantity
// feeRate 通常为 2% (200 bps)
```

## 环境变量

```bash
# Predict (必需)
PREDICT_API_KEY=                    # API Key
PREDICT_SIGNER_PRIVATE_KEY=         # 签名私钥
PREDICT_SMART_WALLET_ADDRESS=       # 智能钱包地址

# Predict (可选 - 多 Key 轮换)
PREDICT_API_KEY_SCAN=               # 扫描专用
PREDICT_API_KEY_SCAN_2=
PREDICT_API_KEY_SCAN_3=

# Polymarket (必需)
POLYMARKET_PROXY_ADDRESS=           # 代理钱包 (资金所在)
POLYMARKET_API_KEY=                 # L2 API Key
POLYMARKET_API_SECRET=              # L2 Secret
POLYMARKET_PASSPHRASE=              # L2 Passphrase
POLYMARKET_TRADER_PRIVATE_KEY=      # 签名私钥

# Telegram (可选)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

## 开发规则

1. **禁止模拟数据** - 绝不生成 mock/fake 数据
2. **失败即中止** - API 失败时报错停止，不使用默认值
3. **简体中文** - 所有输出使用简体中文
4. **类型安全** - 修改后运行 `npx tsc --noEmit`

## 代码风格

- TypeScript ESM (`"type": "module"`)，导入路径带 `.js` 后缀
- 文件名 kebab-case，4 空格缩进
- camelCase 变量/函数，PascalCase 类型/类
- SDK 有独立 ESLint + Prettier；bot 端 ESLint 规则较宽松
- 双 ethers 版本: `ethers` (v6, 主要) + `ethers5` (v5, Polymarket SDK 兼容)

## 关键注意事项

| 项目 | 说明 |
|-----|------|
| 浮点精度 | 价格计算必须用 `roundToTick()` 或 `.toFixed()` 处理，`1.0 - 0.32` ≠ `0.68` |
| 结算时间 | 使用 Gamma API 事件级 `endDate`，非 CLOB 市场级 `end_date_iso` |
| 套利方向 | YES→NO = arbSide:'YES', NO→YES = arbSide:'NO' |
| Polymarket 最小订单 | $1 USD |
| Predict 精度 | 金额需对齐到 1e13 (amount % 1e13 === 0) |
| 钱包类型 | Predict 用智能钱包，Polymarket 用代理钱包 |
| tsconfig exclude | `bot/src/testing/` 和 `bot/src/dashboard/frontend/` 被排除在 bot 编译之外 |
