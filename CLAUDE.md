# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Predict.fun 与 Polymarket 跨平台套利交易机器人。

## 常用命令

```bash
cd bot

# Dashboard (主入口)
npm run dashboard               # 启动 http://localhost:3010

# 类型检查 (修改代码后必须运行)
npx tsc --noEmit

# CLI 工具
npm run arb-monitor                      # 套利监控面板
npm run market-maker                     # Predict 做市引擎
npm run scan-markets                     # 全量市场扫描
npx tsx src/terminal/linked-markets.ts   # 市场匹配扫描

# 测试脚本
npx tsx src/testing/test-onchain-balance.ts     # Predict 链上余额
npx tsx src/testing/test-polymarket-account.ts  # Polymarket 账户
npx tsx src/testing/test-telegram.ts            # Telegram 通知
npx tsx src/testing/test-predict-order.ts       # Predict 下单测试
```

## 高层架构

### 核心数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│  Predict API ──────┐                                                │
│  (markets, orderbook)                                               │
│                     ├──→ start-dashboard.ts ──→ SSE ──→ 前端        │
│  Polymarket API ───┘                                                │
│  (CLOB, Gamma)                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  前端 ──→ POST /tasks ──→ task-service ──→ task-executor            │
│                                                  │                  │
│                              ┌───────────────────┴──────────────┐   │
│                              ↓                                  ↓   │
│                      predict-trader.ts              polymarket-trader│
│                      (SDK OrderBuilder)             (EIP-712 签名)   │
│                              │                                  │   │
│                              └──────────→ telegram.ts ←─────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 关键模块职责

| 模块 | 路径 | 职责 |
|-----|------|------|
| Dashboard 后端 | `bot/src/dashboard/start-dashboard.ts` | SSE 推送、REST API、套利检测调度 |
| 任务执行 | `bot/src/dashboard/task-executor.ts` | 任务状态机、并发控制 |
| TAKER 执行器 | `bot/src/dashboard/taker-mode/executor.ts` | 双边下单、对冲逻辑 |
| 任务日志 | `bot/src/dashboard/task-logger/` | 异步队列、JSONL 持久化、通知集成 |
| 深度计算 | `bot/src/trading/depth-calculator.ts` | 订单簿分析、可执行数量计算 |
| BSC 监控 | `bot/src/services/bsc-order-watcher.ts` | WebSocket 订阅链上 OrderFilled 事件 |
| 做市引擎 | `bot/src/market-maker/engine.ts` | 1000ms tick 循环、订单调整、风控 |
| 前端 | `bot/src/dashboard/frontend/` | React + Vite Dashboard UI |

### 任务执行状态机

```
CREATED → PENDING → EXECUTING → FILL_COMPLETED → HEDGE_IN_PROGRESS
                                                   ↓
                                           HEDGE_COMPLETED / HEDGE_FAILED
                                                   ↓
                                             CLOSED / ERRORED
```

### 实时通知系统

```
TaskLogger ─┬─→ SSE (taskEvent) ─→ 前端 Toast
            └─→ Telegram 推送

BscOrderWatcher ─→ orderFilled 事件 ─→ BscOrderNotifier ─→ Telegram
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

## 关键注意事项

| 项目 | 说明 |
|-----|------|
| 结算时间 | 使用 Gamma API 事件级 `endDate`，非 CLOB 市场级 `end_date_iso` |
| 套利方向 | YES→NO = arbSide:'YES', NO→YES = arbSide:'NO' |
| Polymarket 最小订单 | $1 USD |
| Predict 精度 | 金额需对齐到 1e13 (amount % 1e13 === 0) |
| 钱包类型 | Predict 用智能钱包，Polymarket 用代理钱包 |

## SDK 模块

`sdk/` 目录包含 Predict SDK (git 子模块)，提供 OrderBuilder 和合约 ABI。

```bash
cd sdk
yarn install
yarn build
```
