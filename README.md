# Predict-Polymarket 套利交易机器人

> **最后更新**: 2026-01-01
> **当前版本**: v0.6 - Web Dashboard 已上线

Predict.fun 与 Polymarket 跨平台套利交易机器人。实时监控双平台订单簿，自动识别并执行套利机会。

---

## 🎯 核心功能

### ✅ 已完成
- **实时套利监控**: CLI 面板 + Web Dashboard 双模式
- **跨平台市场匹配**: 自动识别 Predict ↔ Polymarket 关联市场
- **深度感知计算**: 订单簿深度分析，精确计算可执行数量
- **账户余额集成**:
  - Predict: 99.30 USDT (BSC 智能钱包)
  - Polymarket: 51.22 USDC (Polygon 代理钱包)
- **Predict 做市模块**: 全自动挂单、成交监控、库存管理
- **Telegram 通知**: 实时套利机会推送

### 🔄 开发中
- Polymarket 下单集成
- 跨平台自动对冲
- Taker 策略优化

---

## 📊 套利策略

### MAKER 策略
在 Predict 低价挂单买入 YES，成交后立即在 Polymarket 买入 NO 对冲。

**条件**: `predict_yes_bid + polymarket_no_ask < 1.0`

**优势**: 无 Predict Maker 手续费，利润更高

### TAKER 策略
同时吃单双边订单簿最优价格。

**条件**: `predict_yes_ask + polymarket_no_ask + predict_fee < 1.0`

**优势**: 执行速度快，适合高频交易

---

## 🚀 快速开始

### 1. 安装依赖

```bash
# Bot 模块
cd bot
npm install

# SDK 模块
cd ../sdk
yarn install
```

### 2. 配置环境变量

复制 `.env.example` 到 `.env` 并填写:

```env
# Predict (必需)
PREDICT_API_KEY=<从 https://predict.fun/settings/api 获取>
PREDICT_SIGNER_PRIVATE_KEY=<签名钱包私钥>
PREDICT_SMART_WALLET_ADDRESS=<智能钱包地址>

# Polymarket (账户余额查询)
POLYMARKET_PROXY_ADDRESS=<代理钱包地址>
POLYMARKET_TRADER_ADDRESS=<EOA 地址>
POLYMARKET_API_KEY=<L2 API Key>
POLYMARKET_API_SECRET=<L2 API Secret>
POLYMARKET_PASSPHRASE=<L2 API Passphrase>
```

**重要提示**:
- Predict 余额在 **智能钱包** 而非 EOA
- Polymarket 余额在 **代理钱包** 而非 EOA

### 3. 运行

#### CLI 套利监控 (推荐)
```bash
cd bot
npm run arb-monitor
```

实时显示:
- ✅ 当前套利机会 (MAKER/TAKER)
- 📊 订单簿深度分析
- 💰 预期利润率
- ⚡ Polymarket WebSocket 实时更新

#### Web Dashboard
```bash
# 启动后端 (端口 3005)
cd bot
npm run dashboard

# 前端访问方式 (任选其一):
# 方式1: 直接访问后端提供的页面 (推荐)
#   浏览器打开: http://localhost:3005
#
# 方式2: 本地打开 HTML 文件
#   浏览器打开: e:\predict-tradingbot\front\preview.html

# 启动选项:
# --force-rescan  强制重新扫描市场 (忽略缓存)
# --rescan        后台异步扫描市场
DASHBOARD_PORT=3005 npm run dashboard           # 默认
npm run dashboard -- --force-rescan             # 强制扫描
```

Dashboard 功能:
- 📈 实时套利机会列表
- 💳 账户余额显示 (Predict + Polymarket)
- 📖 订单簿实时更新
- 🔔 套利通知 (利润率 > 0.5%)
- 🔄 3 秒自动刷新

#### Predict 做市 CLI
```bash
cd bot
npm run market-maker
```

功能:
- 🎯 多市场并发做市
- 📊 实时持仓/订单/价格监控
- 💰 成交统计和盈亏计算
- ⚙️ 动态价格调整

---

## 📁 项目结构

```
predict-tradingbot/
├── bot/src/
│   ├── arb/                     # 套利检测引擎
│   │   ├── calculator.ts        # 深度感知计算
│   │   ├── detector.ts          # 套利检测器
│   │   └── predict-strategy.ts  # Predict 专用策略
│   ├── dashboard/               # Web Dashboard
│   │   ├── start-dashboard.ts   # 后端 SSE 服务
│   │   ├── account-service.ts   # 账户余额查询 ★
│   │   └── arb-service.ts       # 套利检测服务
│   ├── market-maker/            # Predict 做市模块
│   │   ├── cli.ts               # CLI 监控面板
│   │   ├── trading-client.ts    # 交易客户端
│   │   ├── engine.ts            # 做市引擎
│   │   └── multi-engine.ts      # 多市场管理
│   ├── terminal/                # CLI 工具
│   │   ├── arb-monitor.ts       # 套利监控面板 ★
│   │   └── linked-markets.ts    # 市场匹配分析
│   └── testing/                 # 测试脚本
│       ├── test-onchain-balance.ts       # Predict 余额测试
│       └── test-polymarket-account.ts    # Polymarket 余额测试
├── front/                       # Dashboard 前端
│   ├── preview.html             # React 主页面 ★
│   └── test-sse.html            # SSE 测试页面
└── sdk/                         # Predict SDK
```

---

## 🔧 开发命令

### Bot 模块
```bash
npm run build                    # 编译 TypeScript
npm run dev                      # Watch 模式
npm run typecheck                # 类型检查
npm run arb-monitor              # 套利监控 ★
npm run dashboard                # Web Dashboard
npm run market-maker             # Predict 做市

# 测试
npm run test:polymarket          # Polymarket API 测试
npm run test:predict             # Predict API 测试
npx tsx src/testing/test-onchain-balance.ts        # Predict 余额
npx tsx src/testing/test-polymarket-account.ts     # Polymarket 余额
```

### SDK 模块
```bash
yarn build                       # 完整构建
yarn test                        # Jest 测试
yarn typecheck                   # 类型检查
```

---

## 📊 实际运行数据

### 账户余额 (已集成)
| 平台 | 余额 | 钱包类型 | 链 |
|-----|------|---------|-----|
| Predict | 99.30 USDT | 智能钱包 | BSC |
| Polymarket | 51.22 USDC | 代理钱包 | Polygon |

### 套利机会统计 (示例)
| 市场 | 策略 | 利润率 | 可执行数量 | 状态 |
|-----|------|--------|-----------|------|
| Market #275 | MAKER | 1.2% | 15 shares | ✅ 活跃 |
| Market #289 | TAKER | 0.8% | 8 shares | ✅ 活跃 |

### 性能指标
| 指标 | 数值 |
|-----|------|
| Polymarket 延迟 | <50ms (WebSocket) |
| Predict 延迟 | ~100-200ms (轮询) |
| Dashboard 刷新 | 3 秒 |
| CLI 刷新 | 3 秒 |

---

## 📚 技术文档

| 文档 | 描述 |
|-----|------|
| [CLAUDE.md](CLAUDE.md) | 项目开发指南 |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | 详细实施计划 |
| [docs/MARKET_MAKER.md](docs/MARKET_MAKER.md) | 做市模块文档 |
| [docs/POLYMARKET_TRADING.md](docs/POLYMARKET_TRADING.md) | Polymarket 交易文档 |

---

## 🛠️ 技术栈

- **语言**: TypeScript
- **区块链**: ethers.js (BSC + Polygon)
- **API**: Predict.fun REST + Polymarket CLOB/WebSocket
- **前端**: React (单文件 HTML)
- **实时推送**: Server-Sent Events (SSE)
- **通知**: Telegram Bot API

---

## 🔐 安全说明

- ⚠️ **私钥管理**: 所有私钥存储在 `.env` 文件中，已添加到 `.gitignore`
- 🔒 **API Key**: 使用环境变量，不硬编码
- ✅ **只读模式**: arb-monitor 只读取数据，不执行交易
- ⚡ **风险控制**: 做市模块有仓位限制、不交叉、不做空约束

---

## 📞 支持与资源

- **Predict API 文档**: https://dev.predict.fun/
- **Predict SDK**: https://github.com/PredictDotFun/sdk
- **Polymarket API**: https://docs.polymarket.com/
- **问题反馈**: 请在 GitHub Issues 中提交

---

## 📝 更新日志

### v0.6 (2026-01-01)
- ✅ Web Dashboard 账户余额集成完成
- ✅ Predict 链上余额查询 (OrderBuilder SDK)
- ✅ Polymarket 链上余额查询 (ethers Contract)
- ✅ Dashboard 轮询优化 (3 秒间隔)
- ✅ 通知去重优化 (5 分钟窗口)
- ✅ SSE 实时推送优化

### v0.5 (2025-12-26)
- ✅ Predict 做市模块完成
- ✅ Web Dashboard 上线
- ✅ CLI 套利监控优化 (WebSocket 模式)

### v0.4 (2025-12-20)
- ✅ 套利检测引擎完成
- ✅ 深度计算器实现
- ✅ Telegram 通知集成

---

## 📄 许可证

MIT License

---

**免责声明**: 本项目仅供学习和研究使用。交易有风险，投资需谨慎。使用本软件进行交易所产生的任何损失，开发者不承担责任。
