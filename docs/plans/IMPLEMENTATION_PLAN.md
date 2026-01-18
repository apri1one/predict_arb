# Predict-Polymarket 套利机器人实施计划

> **最后更新**: 2026-01-01
> **当前阶段**: Phase 2.6 - Web Dashboard 已上线（账户集成完成）

---

## 📊 项目概述

构建一个自动化套利交易机器人，通过在 Predict.fun 和 Polymarket 之间进行跨平台套利获利。

**核心策略**:
- 当 `Predict YES 价格 + Polymarket NO 价格 < 100%` 时，存在套利机会
- Maker 策略：在 Predict 低价挂单买入 YES，成交后立即在 Polymarket 买入 NO

---

## ✅ Phase 1: 基础设施（已完成）

### 1.1 API 客户端 ✅
- [x] **Predict REST Client** (`bot/src/predict/rest-client.ts`)
  - 市场数据、订单簿查询
  - JWT 认证流程
  - 订单查询和持仓查询
  - **智能钱包余额查询** (链上查询 BSC)
  - **Exchange 授权状态查询**

- [x] **Polymarket Client** (`bot/src/polymarket/`)
  - REST API 客户端
  - WebSocket 实时订单簿订阅
  - 订单簿规范化处理

### 1.2 市场关联 ✅
- [x] **关联市场发现** (`bot/src/terminal/linked-markets.ts`)
  - 通过 Predict API 获取 `polymarketConditionId`
  - 自动匹配 Predict ↔ Polymarket 同一事件的市场

- [x] **订单簿价格推导**
  - Polymarket NO 价格 = 1 - YES 价格
  - 从 YES token 订单簿推导 NO token 价格

### 1.3 Telegram 通知 ✅
- [x] **TelegramNotifier** (`bot/src/notification/telegram.ts`)
  - 套利机会提醒
  - 订单状态通知（已挂单、已成交、已取消）
  - 错误警报
  - 统计报告
  - **所有消息已翻译为中文**

### 1.4 交易配置 ✅
- [x] **TradingConfig** (`bot/src/trading/config.ts`)
  - 余额配置
  - 利润阈值设置
  - 风险管理参数
  - Telegram 集成配置

### 1.5 套利扫描监控 ✅
- [x] **CLI 套利监控面板** (`bot/src/terminal/arb-monitor.ts`)
  - 自动扫描所有 Predict 市场
  - 匹配对应 Polymarket 市场
  - 实时获取双边订单簿
  - 深度穿透计算（集成 depth-calculator）
  - 每 3 秒刷新
  - 显示 TAKER/MAKER 套利机会
  - **Polymarket WebSocket 模式** - 实时订单簿推送，REST 作为备用
  - **多 API Key 轮换** - 支持 PREDICT_API_KEY_2/3 提高请求频率
  - **已结算市场过滤** - 自动隐藏已结束的市场
  - **活跃市场过滤** - 只显示有订单簿数据的市场
  - 运行命令: `npm run arb-monitor`

- [x] **套利计算器** (`bot/src/arb/calculator.ts`)
  - 深度穿透计算 (calculateAverageFillPrice)
  - Predict 手续费计算 (BaseFee × min(price, 1-price))
  - 跨平台套利计算 (calculateCrossPlatformBinaryArb)
  - 滑点估算
  - 风险评估
  - Kelly 仓位计算

- [x] **深度计算器** (`bot/src/trading/depth-calculator.ts`)
  - 订单簿深度分析
  - 最大可交易数量计算
  - 成本和利润估算

### 1.6 Web Dashboard ✅
- [x] **Dashboard 后端** (`bot/src/dashboard/start-dashboard.ts`)
  - SSE 实时数据推送 (3 个事件: opportunity, stats, accounts)
  - API Key 轮换机制（支持多个扫描 Key）
  - Polymarket Token ID 缓存
  - **3 秒轮询间隔** (与 CLI arb-monitor 一致)
  - 运行命令: `npm run dashboard` (端口 3005)

- [x] **Dashboard 前端** (`front/preview.html`)
  - React 单页面应用
  - 实时 SSE 连接和状态更新
  - 套利机会列表 (支持策略/利润率过滤)
  - **账户余额实时显示** (Predict + Polymarket)
  - 订单簿卡片 (实时更新)
  - 套利通知 (阈值 0.5%, 5 分钟去重)

- [x] **账户服务** (`bot/src/dashboard/account-service.ts`)
  - **Predict 账户查询**:
    - JWT Token 认证 (signMessage + /v1/auth)
    - OrderBuilder.balanceOf('USDT') 查询 BSC 链上余额
    - /v1/account 查询持仓信息
    - 计算可用余额 (total - locked)
  - **Polymarket 账户查询**:
    - HMAC-SHA256 签名 (L2 API 认证)
    - ethers Contract 查询 Polygon 链上 USDC.e 余额 (代理钱包)
    - /data/orders 查询订单锁定金额
    - 计算可用余额 (total - locked)
  - Token 缓存机制 (5 分钟提前过期)

- [x] **SSE 测试页面** (`front/test-sse.html`)
  - 简单的 SSE 连接测试工具
  - 显示原始 JSON 数据更新
  - 更新计数器和时间戳

### 1.7 API Key 管理 ✅
- [x] **多 Key 轮换** - 支持多个扫描 API Key 轮换使用
- [x] **用途分离** - 扫描 Key 和交易 Key 分开
- [x] **冷却机制** - 每个 Key 使用后 1 秒冷却

---

## 🔄 Phase 2: 真实下单集成（进行中）

### 2.1 Predict 下单 ✅
- [x] **认证流程** - JWT Token 获取成功
- [x] **SDK 集成** - 安装并配置 `@predictdotfun/sdk`
- [x] **TokenId 计算**
  - 标准市场: `ConditionalTokens.getPositionId()`
  - NegRisk 市场: `NegRiskAdapter.getPositionId()`
- [x] **订单签名** - EIP-712 签名实现
- [x] **订单提交** - API 调用格式正确
- [x] **下单客户端** (`bot/src/trading/predict-order-client.ts`)

#### ✅ 账户余额确认
```
智能钱包地址: 0xbD58EDACc3358FC2A841a291014380b55F6a6E2f
可用余额: 111.21 USDT
授权状态: 已授权给所有 Predict Exchange 合约
准备状态: ✅ 可以开始交易
```

### 2.2 Polymarket 下单 ⏳
- [ ] CLOB API 集成
- [ ] 订单签名
- [ ] Market Taker 订单提交

### 2.3 订单状态监控 ⏳
- [ ] Predict 订单状态轮询
- [ ] 成交检测
- [ ] Polymarket 对冲触发

---

## ✅ Phase 2.5: Predict 做市模块（已完成）

> **技术文档**: `docs/MARKET_MAKER.md`

### 2.5.1 交易客户端 ✅
- [x] **TradingClient** (`bot/src/market-maker/trading-client.ts`)
  - 智能钱包 JWT 认证 (signPredictAccountMessage)
  - Token ID 从 API 获取 (outcomes[].onChainId)
  - OrderBuilder 订单签名 (EIP-712)
  - isYieldBearing 正确处理 (影响 verifyingContract)
  - API 取消订单 (POST /v1/orders/remove，无需 gas)
  - 批量取消支持

### 2.5.2 做市引擎 ✅
- [x] **MarketMakerEngine** (`bot/src/market-maker/engine.ts`)
  - 对账式同步策略
  - 买卖双边独立订单管理
  - 不变量约束（不做空、不超卖、不超仓、不交叉）
  - 独立频率控制 (lastBuyAdjustTime / lastSellAdjustTime)
  - 成交检测与统计

### 2.5.3 多市场管理 ✅
- [x] **MultiMarketMaker** (`bot/src/market-maker/multi-engine.ts`)
  - 多市场并发管理
  - 全局统计汇总
  - 市场间 100ms 间隔（避免 API 限流）
  - 暂停/恢复控制

### 2.5.4 市场选择器 ✅
- [x] **market-selector.ts**
  - 分页扫描所有活跃市场
  - 交互式市场选择
  - 按事件分组显示（二元/多选）
  - 自动获取 Token ID

### 2.5.5 CLI 监控面板 ✅
- [x] **cli.ts**
  - 实时状态显示（持仓、订单、价格）
  - 成交记录展示
  - 全局统计（总成交、盈亏）
  - 1 秒刷新

### 2.5.6 已解决的问题
| 问题 | 原因 | 解决方案 |
|------|------|----------|
| Order hash mismatch | isYieldBearing 值错误 | 从 API 获取正确值 |
| 最小订单金额 0.9 USD | API 限制 | 动态计算最小数量 |
| 成交后只有一边订单 | 共用 lastAdjustTime | 分离买卖调整时间 |
| 取消需要 BNB | 使用链上取消 | 改用 API 取消 |

### 2.5.7 运行命令
```bash
# 测试交易客户端
npx tsx src/market-maker/test-trading-client.ts

# 测试下单/取消
npx tsx src/market-maker/test-order.ts

# 启动做市 CLI
npm run market-maker
```

---

## 📋 Phase 3: Maker 策略完善（部分完成）

### 3.1 核心逻辑
- [x] **MakerStrategy** (`bot/src/trading/maker-strategy.ts`) - 基础框架
- [ ] 真实订单放置替换模拟逻辑（集成 predict-order-client）
- [ ] 动态价格调整
- [ ] 自动取消过期订单

### 3.2 深度计算 ✅
- [x] **DepthCalculator** (`bot/src/trading/depth-calculator.ts`)
  - 订单簿深度分析
  - 最大可交易数量计算
  - 成本和利润估算

### 3.3 风险管理
- [ ] 紧急止损
- [ ] 单笔最大金额限制
- [ ] 每日最大损失限制

---

## 📋 Phase 4: Taker 策略（待开始）

- [ ] 实时价差监控
- [ ] 快速执行逻辑
- [ ] 双边同时下单

---

## ✅ Phase 2.6: Web Dashboard 账户集成（已完成）

> **更新日期**: 2026-01-01

### 2.6.1 账户余额集成 ✅
- [x] **Predict 账户余额查询**
  - 使用 OrderBuilder SDK 查询 BSC 链上 USDT 余额
  - JWT Token 认证流程实现
  - 智能钱包地址余额: **99.30 USDT**
  - 测试脚本: `bot/src/testing/test-onchain-balance.ts`

- [x] **Polymarket 账户余额查询**
  - 使用 ethers Contract 查询 Polygon 链上 USDC.e 余额
  - HMAC-SHA256 签名认证实现
  - 代理钱包地址余额: **51.22 USDC**
  - L2 API 订单查询集成
  - 测试脚本: `bot/src/testing/test-polymarket-account.ts`

### 2.6.2 Dashboard 前端优化 ✅
- [x] **通知系统优化**
  - 降低通知阈值: 2% → 0.5%
  - 修复通知去重逻辑: 使用 `opp.id` 而非 `opp.marketId`
  - 增加去重时间窗口: 30 秒 → 5 分钟

- [x] **轮询频率优化**
  - 后端轮询间隔: 10 秒 → 3 秒
  - 与 CLI arb-monitor 保持一致

- [x] **SSE 实时更新**
  - 3 个事件流: opportunity, stats, accounts
  - React 状态自动更新
  - 前端 useEffect 自动连接和重连

### 2.6.3 已解决的问题
| 问题 | 原因 | 解决方案 |
|------|------|----------|
| /v1/account 无余额字段 | API 不返回余额 | 使用 OrderBuilder.balanceOf() 查询链上 |
| OrderBuilder init 报错 | SDK 改用静态工厂方法 | 使用 OrderBuilder.make() |
| ChainId.BSC 不存在 | SDK 使用 BnbMainnet | 改用 ChainId.BnbMainnet |
| require in ESM | 模块化导入错误 | 改用 import { createHmac } from 'crypto' |
| Polymarket 余额为 0 | 查询 EOA 而非代理钱包 | 查询 POLYMARKET_PROXY_ADDRESS |
| 环境变量 undefined | 导入时 .env 未加载 | 将变量读取移到函数内部 |

---

## 🗂️ 项目文件结构

```
predict-tradingbot/
├── .env                          # 环境变量配置
├── docs/
│   └── MARKET_MAKER.md           ✅ 做市模块技术文档
├── bot/
│   └── src/
│       ├── arb/
│       │   ├── calculator.ts     ✅ 套利计算器（深度、手续费、风险）
│       │   ├── detector.ts       ✅ 套利检测
│       │   └── types.ts          ✅ 类型定义
│       ├── dashboard/
│       │   ├── start-dashboard.ts ✅ Dashboard 后端（SSE + 轮询）
│       │   ├── account-service.ts ✅ 账户余额服务 ★
│       │   ├── arb-service.ts     ✅ 套利检测服务
│       │   └── types.ts           ✅ 类型定义
│       ├── market-maker/          ✅ Predict 做市模块
│       │   ├── cli.ts            ✅ CLI 入口与监控面板
│       │   ├── trading-client.ts ✅ 交易客户端（认证、签名、API）
│       │   ├── engine.ts         ✅ 单市场做市引擎
│       │   ├── multi-engine.ts   ✅ 多市场管理器
│       │   ├── market-selector.ts ✅ 市场扫描与选择
│       │   ├── config.ts         ✅ 配置管理
│       │   ├── types.ts          ✅ 类型定义
│       │   ├── test-trading-client.ts ✅ 客户端测试
│       │   └── test-order.ts     ✅ 下单/取消测试
│       ├── predict/
│       │   ├── rest-client.ts    ✅ Predict API 客户端
│       │   └── types.ts          ✅ 类型定义
│       ├── polymarket/
│       │   ├── rest-client.ts    ✅ Polymarket REST 客户端
│       │   └── ws-client.ts      ✅ Polymarket WebSocket 客户端
│       ├── notification/
│       │   ├── telegram.ts       ✅ Telegram 通知 (中文)
│       │   └── index.ts          ✅ 导出
│       ├── trading/
│       │   ├── config.ts         ✅ 交易配置
│       │   ├── depth-calculator.ts ✅ 深度计算
│       │   ├── maker-strategy.ts ✅ Maker 策略 (待集成真实下单)
│       │   ├── predict-order-client.ts ✅ Predict 下单客户端
│       │   └── index.ts          ✅ 导出
│       ├── terminal/
│       │   ├── arb-monitor.ts    ✅ CLI 套利监控面板
│       │   └── linked-markets.ts ✅ 关联市场展示
│       └── testing/
│           ├── test-telegram.ts           ✅ Telegram 测试
│           ├── test-account.ts            ✅ 账户 API 测试
│           ├── test-predict-order.ts      ✅ 下单测试
│           ├── test-maker-live.ts         ✅ Maker 策略测试
│           ├── test-onchain-balance.ts    ✅ Predict 链上余额测试 ★
│           ├── test-polymarket-account.ts ✅ Polymarket 账户测试 ★
│           └── debug-market.ts            🔧 调试工具
├── front/                        # Dashboard 前端
│   ├── preview.html              ✅ React 主页面 (SSE 实时更新) ★
│   └── test-sse.html             ✅ SSE 连接测试页面
└── sdk/                          ✅ Predict SDK (本地副本)
```

---

## 🔧 环境变量配置

```env
# Predict (必需)
PREDICT_API_KEY=xxx                    # Predict API 密钥
PREDICT_SIGNER_PRIVATE_KEY=xxx         # 签名钱包私钥 (用于 JWT 认证和订单签署)
PREDICT_SMART_WALLET_ADDRESS=xxx       # 智能钱包地址 (余额查询)

# 额外 API Key（可选，arb-monitor 轮换使用以提高请求频率）
# API 限制: 240 次/分钟/Key，使用 2 个 Key 可达 480 次/分钟
PREDICT_API_KEY_2=xxx
PREDICT_API_KEY_3=xxx

# 扫描专用 API Key（可选，Dashboard 使用）
PREDICT_API_KEY_SCAN=xxx
PREDICT_API_KEY_SCAN_2=xxx
PREDICT_API_KEY_SCAN_3=xxx

# 交易专用 API Key（可选）
PREDICT_API_KEY_TRADE=xxx

# Polymarket (账户余额查询)
POLYMARKET_PROXY_ADDRESS=xxx           # 代理钱包地址 (余额在这里!) ★
POLYMARKET_TRADER_ADDRESS=xxx          # EOA 地址 (用于签名)
POLYMARKET_API_KEY=xxx                 # L2 API Key
POLYMARKET_API_SECRET=xxx              # L2 API Secret (base64)
POLYMARKET_PASSPHRASE=xxx              # L2 API Passphrase

# Telegram (可选但推荐)
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_CHAT_ID=xxx
```

**重要说明**:
- Predict 余额在 **智能钱包** (PREDICT_SMART_WALLET_ADDRESS) 而非 EOA
- Polymarket 余额在 **代理钱包** (POLYMARKET_PROXY_ADDRESS) 而非 EOA
- POLYMARKET_API_SECRET 是 base64 编码的字符串

---

## 📝 下一步操作

### 立即可用 ✅
1. **CLI 套利监控** - `npm run arb-monitor`
2. **Web Dashboard** - `npm run dashboard` → http://localhost:3005
3. **Predict 做市模块** - `npm run market-maker`

### 待开发
1. **Polymarket 下单集成**
   - CLOB API 认证
   - 订单签名和提交
   - Market Taker 订单执行

2. **跨平台套利执行**
   - 将 Predict 做市模块与 Polymarket 对冲集成
   - Predict 成交后自动在 Polymarket 买入 NO
   - 双边持仓监控

### 后续优化
3. Dashboard 前端持仓显示 (当前后端已返回但前端未展示)
4. 添加风险管理模块（止损、最大损失限制）
5. 完善 Taker 策略（实时价差监控、快速执行）
6. 做市策略优化（动态价差、库存管理）

---

## 📊 测试记录

| 测试项 | 状态 | 备注 |
|--------|------|------|
| Predict API 连接 | ✅ | 正常 |
| JWT 认证 | ✅ | 正常 |
| Polymarket API | ✅ | 正常 |
| Polymarket WebSocket | ✅ | arb-monitor 已集成 |
| Telegram 通知 | ✅ | 中文消息发送成功 |
| TokenId 计算 | ✅ | 合约调用成功 |
| 订单签名 | ✅ | EIP-712 签名成功 |
| 订单提交 | ✅ | 钱包已配置 |
| Maker 策略 (模拟) | ✅ | 检测到套利机会 |
| CLI 套利监控 | ✅ | WebSocket 模式 + 多 Key 轮换 |
| Web Dashboard | ✅ | 正常运行 |
| API Key 轮换 | ✅ | arb-monitor + Dashboard 均支持 |
| 已结算市场过滤 | ✅ | 自动隐藏已结束市场 |
| 活跃市场检测 | ✅ | 只显示有订单簿的市场 |
| 市场匹配扫描 | ✅ | 1000 个市场中找到 20 个匹配 |
| **做市模块** | ✅ | 完整功能测试通过 |
| 智能钱包认证 | ✅ | signPredictAccountMessage |
| 订单下单/取消 | ✅ | API 取消无需 gas |
| 多市场做市 | ✅ | CLI 监控正常运行 |
| **Dashboard 账户集成** | ✅ | 真实余额显示 ★ |
| Predict 链上余额 | ✅ | OrderBuilder.balanceOf() 查询 BSC |
| Polymarket 链上余额 | ✅ | ethers Contract 查询 Polygon |
| JWT Token 认证 | ✅ | signMessage + /v1/auth |
| HMAC-SHA256 签名 | ✅ | Polymarket L2 API 认证 |
| SSE 实时推送 | ✅ | 3 个事件流 (opportunity/stats/accounts) |
| React 状态更新 | ✅ | useEffect + useState |
| 通知去重优化 | ✅ | 5 分钟窗口 |

---

## 🚀 快速启动

```bash
# CLI 套利监控 (自动使用 WebSocket，支持多 API Key)
cd bot && npm run arb-monitor

# Predict 做市 CLI
cd bot && npm run market-maker

# Web Dashboard (默认端口 3005)
cd bot && npm run dashboard
# 前端: 浏览器打开 e:\predict-tradingbot\front\preview.html
# 后端: http://localhost:3005

# 指定端口
DASHBOARD_PORT=3001 npm run dashboard

# 测试 SSE 连接
# 浏览器打开 e:\predict-tradingbot\front\test-sse.html

# 测试账户余额
cd bot && npx tsx src/testing/test-onchain-balance.ts        # Predict
cd bot && npx tsx src/testing/test-polymarket-account.ts     # Polymarket
```

**CLI 状态指示器说明**:
- `PM:WS` - Polymarket 使用 WebSocket 模式（实时）
- `PM:REST` - Polymarket 使用 REST 轮询（备用）
- `活跃: X/Y` - X 个有订单簿数据的市场 / Y 个总匹配市场

**做市 CLI 状态**:
- `★运行` - 市场正在做市
- `⏸暂停` - 市场已暂停
- `✗错误` - 市场出错

---

## 📞 联系方式 & 资源

- Predict API 文档: https://dev.predict.fun/
- Predict SDK: https://github.com/PredictDotFun/sdk
- Polymarket API: https://docs.polymarket.com/

