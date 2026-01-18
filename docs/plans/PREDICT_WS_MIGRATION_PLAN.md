# Predict WebSocket 迭代计划（替换行情/订单状态 REST）

> 最后更新: 2026-01-18
> 状态: **Milestone 2 已完成**

## 结论

将 Predict 的"订单簿 + 订单状态/成交事件"从 REST 轮询迁移到官方 WebSocket：`predictOrderbook/{marketId}` + `predictWalletEvents/{jwt}`。迁移完成后，REST 仅保留下单/撤单、认证/JWT、必要的市场元数据与兜底回填。

---

## 📊 当前进度

| 里程碑 | 状态 | 完成日期 |
|-------|------|---------|
| Milestone 0: WS 渠道验证 | ✅ 完成 | - |
| Milestone 1: 订单簿缓存层 | ✅ 完成 | 2026-01-17 |
| Milestone 2: 订单状态迁移 | ✅ 完成 | 2026-01-18 |
| Milestone 3: 清理与统一 | 🔲 待开始 | - |

### Milestone 1 完成内容

#### 新增文件
- `bot/src/services/predict-orderbook-cache.ts` - 统一订单簿缓存层
- `bot/src/testing/test-unified-orderbook-cache.ts` - 9 个测试用例

#### 核心功能
| 功能 | 状态 |
|-----|------|
| TTL 管理（默认 15s） | ✅ |
| WS 优先 + REST 降级 | ✅ |
| 外部更新接口（渐进迁移） | ✅ |
| 刷新去重（3s 冷却 + in-flight 去重） | ✅ |
| 深拷贝防污染 | ✅ |

#### 模块集成
| 模块 | Provider 注入 | 状态 |
|-----|--------------|------|
| Dashboard 套利扫描 | `getPredictOrderbookFromCache` | ✅ |
| PredictTrader | `setPredictOrderbookCacheProvider` | ✅ |
| close-service | `setClosePredictOrderbookProvider` | ✅ |
| sports-service | `setPredictOrderbookProvider` | ✅ |

#### 数据流
```
Predict WS 更新
     ↓
predictWsOrderbookCallback
     ↓
┌─────────────────────────────────────┐
│ 1. 更新旧缓存 (兼容层)               │
│ 2. updateFromExternal → 统一缓存层   │
└─────────────────────────────────────┘
     ↓
所有读取 → getPredictOrderbookFromCache
     ↓
优先统一缓存 → 降级旧缓存 → REST（去重/冷却）
```

#### 验证测试
运行命令：
```bash
cd bot && npx tsx src/testing/test-unified-orderbook-cache.ts
```

| # | 测试 | 状态 |
|---|------|------|
| 1 | WS 更新 → 缓存读取 | ✅ |
| 2 | Provider 格式转换 | ✅ |
| 3 | TTL 过期行为 | ✅ |
| 4 | allowStale 模式 | ✅ |
| 5 | 拷贝保护（数组+对象） | ✅ |
| 6 | Cache miss 统计 | ✅ |
| 6b | REST 刷新去重 | ✅ |
| 7 | 更新回调 | ✅ |
| 8 | 排序行为 | ✅ |

### Milestone 2 完成内容

#### ✅ 订单测试通过 (2026-01-18)

| 指标 | 结果 |
|-----|------|
| 下单延迟 | 776ms |
| WS 事件延迟 | 6761ms |
| 事件类型 | `ORDER_TX_CONFIRMED` |
| watchOrder 回调 | ✅ 正常触发 |

**关键发现与修复**：
- Predict WS 钱包事件使用 `orderId`（数字 ID），不是 `orderHash`
- 新增 `orderHash ↔ orderId` 双向映射机制
- `placeOrder` 现返回 `orderId`，自动注册映射

#### 核心模块

| 模块 | 路径 | 说明 |
|-----|------|------|
| WS 客户端 | `bot/src/services/predict-ws-client.ts` | 支持 `subscribeWalletEvents(callback)` |
| 订单监控 | `bot/src/services/predict-order-watcher.ts` | Predict WS 订单监控，与 BSC watcher 兼容 API |
| 统一工厂 | `bot/src/services/order-watcher-factory.ts` | 配置化选择 Predict WS 或 BSC WSS |

#### ✅ 统一 Order Watcher 工厂 (2026-01-18)

新增 `order-watcher-factory.ts` 统一工厂模块，支持配置选择订单监控来源：

**环境变量**: `PREDICT_ORDER_WATCHER_SOURCE`

| 值 | 说明 |
|---|------|
| `predict` | 默认。仅使用 Predict WS 钱包事件 |
| `bsc` | 仅使用 BSC WSS 链上事件 |
| `auto` | 优先 Predict WS，失败时 fallback 到 BSC |

**API**:
```typescript
import {
    getOrderWatcher,        // 异步获取 watcher（根据配置自动选择）
    getActiveOrderWatcher,  // 同步获取已初始化的 watcher
    isUsingPredictWs,       // 判断当前是否使用 Predict WS
    isUsingBscWss,          // 判断当前是否使用 BSC WSS
    getSharesFromFillEvent, // 统一的成交量解析
} from './services/order-watcher-factory.js';
```

**task-executor 集成**:
- `init()` 时自动初始化 watcher
- `monitorAndHedge()` 使用工厂获取的 watcher 监听成交事件
- 日志输出标识当前使用的 watcher 类型

#### 代码审查修复（2026-01-17）

| 问题 | 优先级 | 修复状态 |
|-----|-------|---------|
| 钱包事件类型映射不完整 | 高 | ✅ 已修复 |
| 去重键包含 timestamp 导致重连后失效 | 中 | ✅ 已修复 |
| JWT 仅初始化一次，无刷新机制 | 中 | ✅ 已修复 |
| 测试脚本网络隔离 | 低 | ✅ 已验证 |

##### [高] 事件类型映射扩展

`predict-ws-client.ts:parseWalletEvent` 现支持多种格式：
- 小写格式：`accepted`, `rejected`, `filled`, `partially_filled`, `cancelled`, `expired`
- 驼峰格式：`orderAccepted`, `orderNotAccepted`, `orderFilled`, `orderPartiallyFilled`
- 链上事件：`orderTransactionSubmitted`, `orderTransactionSuccess`, `orderTransactionFailed`

##### [中] 去重键修复

`predict-order-watcher.ts:handleWalletEvent` 去重键变更：
```typescript
// 旧（timestamp 导致重连失效）
const dedupKey = `${orderHash}:${event.type}:${event.filledQty ?? 0}:${event.timestamp}`;

// 新（使用 txHash 稳定去重）
const dedupKey = `${orderHash}:${txHash}:${event.filledQty ?? 0}`;
```

##### [中] JWT 刷新机制

`predict-order-watcher.ts` 新增 JWT 管理：
- `isJwtExpiringSoon()` - 检查是否即将过期（提前 5 分钟）
- `startJwtRefreshTimer()` - 定期检查刷新
- `refreshJwt()` - 刷新 JWT 并重新订阅
- `parseJwtExpiration()` - 解析 JWT 过期时间

#### 代码审查修复（2026-01-18）

| 问题 | 优先级 | 修复状态 |
|-----|-------|---------|
| orderTransactionSubmitted/Success 未区分，提前触发对冲 | 中 | ✅ 已修复 |
| JWT 刷新订阅失败只记日志不重试 | 中 | ✅ 已修复 |
| logIndex=0 导致单 tx 多笔成交被丢弃 | 低 | ✅ 已修复 |

##### [中] 区分链上交易提交与确认事件

`predict-ws-client.ts` 新增事件类型：
- `ORDER_TX_PENDING` - 交易已提交（待确认，**不触发 fill**）
- `ORDER_TX_CONFIRMED` - 交易成功确认（触发 fill）

`predict-order-watcher.ts` fill 事件过滤：
```typescript
// 只处理确认的成交事件，排除 ORDER_TX_PENDING
const fillEvents = ['ORDER_FILLED', 'ORDER_PARTIALLY_FILLED', 'ORDER_TX_CONFIRMED'];
```

##### [中] JWT 订阅失败重试与告警

`predict-order-watcher.ts` 新增订阅管理：
- `subscriptionValid` 标志位 - 跟踪订阅状态
- `subscribeWithRetry()` - 最多重试 3 次，间隔 5 秒
- `subscriptionLost` 事件 - 订阅失败时触发告警
- `subscriptionRestored` 事件 - 订阅恢复时触发
- `isSubscriptionValid()` - 外部可查询订阅状态

##### [低] 伪 logIndex 避免去重丢失

`predict-order-watcher.ts:convertToFilledEvent` 改进：
```typescript
// 使用 filledQty 的低 16 位作为伪 logIndex
// 确保同一 txHash 内不同成交量的事件不被 task-executor 去重
const pseudoLogIndex = raw?.logIndex ?? (filledQty % 65536);
```

#### 代码审查修复（2026-01-18 第二批）

| 问题 | 优先级 | 修复状态 |
|-----|-------|---------|
| 初始订阅成功后未设置 subscriptionValid | 中 | ✅ 已修复 |
| parseWalletEvent 兜底生成 ORDER_ORDER_* | 中 | ✅ 已修复 |
| subscribeWithRetry 未检查 WS 连接状态 | 中 | ✅ 已修复 |
| 伪 logIndex 浮点运算不稳定 | 低 | ✅ 已修复 |
| timestamp 解析不支持 ISO 字符串 | 低 | ✅ 已修复 |

##### [中] 初始订阅设置 subscriptionValid

`predict-order-watcher.ts:start()` 订阅成功后设置标志：
```typescript
const success = await this.wsClient.subscribeWalletEvents(handler);
if (!success) throw new Error(...);
this.subscriptionValid = true;  // 新增
```

##### [中] 事件类型映射兜底修复

`predict-ws-client.ts:parseWalletEvent` 改进：
- 新增下划线格式映射：`order_filled`, `order_tx_confirmed` 等
- 兜底逻辑移除 `order_` 前缀避免生成 `ORDER_ORDER_*`
- 新增 `parseTimestamp()` 支持毫秒、秒、ISO 字符串三种格式

##### [中] subscribeWithRetry 检查连接状态

```typescript
for (attempt) {
    // 新增：检查 WS 连接状态，必要时重连
    if (!this.wsClient.isConnected()) {
        await this.wsClient.connect();
    }
    // ... 订阅逻辑
}
```

##### [低] 伪 logIndex 整数化

```typescript
// 旧：浮点运算可能不稳定
const pseudoLogIndex = filledQty % 65536;

// 新：整数运算确保稳定
const pseudoLogIndex = Math.floor(filledQty * 1e6) % 65536;
```

---

## 背景与目标

### 背景
- 项目当前同时存在 Predict REST 拉取订单簿与订单状态的逻辑（多处 `fetch https://api.predict.fun/v1/markets/{id}/orderbook`）。
- 仓库内已实现官方 Predict WS 客户端：`bot/src/services/predict-ws-client.ts`（支持订单簿订阅、钱包事件订阅、心跳与重连）。
- 新策略模块 `points-engine` 需要低延迟、低调用次数的推送数据源；继续使用 REST 轮询会增加延迟与 API 频次压力。

### 目标
- 订单簿：以 WebSocket 推送为“唯一实时源”，Dashboard/策略模块统一从缓存读取。
- 订单状态：优先使用 `predictWalletEvents/{jwt}` 提供的订单状态变更与成交信息，替代链上 watcher/REST 补查的主路径。
- 降低 API 调用：把订单簿相关 REST 调用从“核心路径”移除，仅用于断线兜底与初始化回填。

### 非目标（本阶段不做）
- 不修改既有套利/做市策略逻辑的数学模型。
- 不强制移除 REST 客户端（保留用于下单/认证/兜底），只做职责收敛。
- 不在本计划内实现 `points-engine`（见单独计划）。

---

## 现状盘点（需要迁移/收敛的点）

### 已存在的 WS 客户端
- `bot/src/services/predict-ws-client.ts`
  - 订阅订单簿：`predictOrderbook/{marketId}`
  - 订阅钱包事件：`predictWalletEvents/{jwt}`
  - 心跳与重连逻辑

### 已存在的 REST 客户端（职责需要收敛）
- `bot/src/predict/rest-client.ts`
- `bot/src/predict/index.ts`（轮询模型，且注释“无 WS API”已过时）

### 已发现的 REST 订单簿/市场数据调用位置（优先迁移）
- `bot/src/dashboard/start-dashboard.ts`（多处 orderbook/stats fetch）
- `bot/src/dashboard/sports-service.ts`（orderbook/stats fetch）
- `bot/src/dashboard/predict-trader.ts`（订单执行封装中仍存在 orderbook REST 调用）
- `bot/src/trading/maker-strategy.ts`（orderbook REST）

### 已存在的链上 watcher（可降级为可选 fallback）
- `bot/src/services/bsc-order-watcher.ts`

---

## 待迁移清单（核心路径，按优先级）

### P0：Dashboard 主循环/缓存（必须先改）
- `bot/src/dashboard/start-dashboard.ts`
  - `fetchPredictOrderbook()`：目前通过 REST 拉取 `/v1/markets/{id}/orderbook`，并写入 `predictOrderbookCache`；需要改为 Predict WS 更新 cache（REST 仅用于冷启动回填/断线兜底）。
  - `detectArbitrageOpportunities()`：当前每轮扫描都会调用 `fetchPredictOrderbook()`，导致 Predict 订单簿持续依赖 REST；迁移后扫描只应读 `predictOrderbookCache`（由 WS 驱动刷新）。
  - `PREDICT_CACHE_TTL_MS`：当前 TTL=2s；WS 版应改为“staleness 监控 + 降级策略”，避免用固定 TTL 误判。

### P0：Task 执行的 Predict 订单状态/成交事件（主路径迁移）
- `bot/src/dashboard/task-executor.ts`
  - 当前“WSS-first 成交追踪”是 BSC 链上事件（`bsc-order-watcher`）+ REST 兜底；应迁移到 `predictWalletEvents/{jwt}` 为主，BSC WSS 作为 fallback（可关闭）。
- `bot/src/dashboard/order-status-cache.ts`
  - 当前通过 `GET /v1/orders?status=OPEN` 批量轮询；WS 迁移后应以 `predictWalletEvents` 驱动更新（轮询仅作为断线兜底）。
- `bot/src/dashboard/order-monitor.ts`
  - `watchPredictOrder()` 仍是轮询 `getOrderStatus()`；WS 迁移后应替换为事件驱动或减少轮询依赖。

### P1：CloseService 的 Predict 订单簿来源
- `bot/src/dashboard/close-service.ts`
  - `fetchPredictOrderbook()` 已支持 provider 注入，但在 cache miss 时会 fallback REST；WS 迁移后 provider 应稳定可用（减少 REST fallback 触发概率）。

### P1：ArbService/SportsService 的 Predict 订单簿来源
- `bot/src/dashboard/arb-service.ts`
  - `getPredictOrderbook()` 当前 REST 拉取 `/orderbook`；应改为读 WS cache（与 start-dashboard 共用）。
- `bot/src/dashboard/sports-service.ts`
  - `fetchPredictOrderbookWithKey()`/分页 markets：目前强依赖 REST；WS 迁移后，sports 的订单簿应走同一 WS cache 或降低刷新频率/改用 provider。

### P2：遗留轮询客户端（收敛/标记废弃）
- `bot/src/predict/index.ts`（轮询模型、且注释已过时）

---

## 设计原则

1. **单一真源**：Predict 实时订单簿以 WS 缓存为准，业务逻辑禁止同时依赖“WS+REST”两套不一致的实时数据源。
2. **兜底明确**：WS 断线/数据过期时，只允许进入“冻结/降档/暂停”状态；REST 仅可用于回填快照（且必须标注为 fallback）。
3. **可观测性**：对 WS 的连接状态、订阅数量、延迟、stale 次数、重连次数做日志/指标输出，便于定位问题。
4. **兼容现有任务系统**：不改变 Task API 对外语义；只替换 TaskExecutor/Trader 内部的数据来源。

---

## 迁移方案（建议里程碑）

### Milestone 0：验证 WS 渠道可用性（不改业务）
- 使用现有脚本回归：
  - `bot/src/testing/test-predict-ws-simple.ts`
  - `bot/src/testing/test-predict-ws.ts`
  - `bot/src/testing/test-all-channels-latency.ts`
- 验收标准：
  - 可稳定订阅 20 个 market 的 `predictOrderbook/{marketId}` 并持续更新。
  - `predictWalletEvents/{jwt}` 可收到成交/取消等事件（至少 1 次真实订单/测试订单验证）。
 - 建议命令（安全/不下单）：
   - `cd bot && npx tsx src/testing/test-predict-ws.ts connection`
   - `cd bot && npx tsx src/testing/test-predict-ws.ts orderbook`
 - 下单相关测试（谨慎，小额）：
   - `cd bot && npx tsx src/testing/test-predict-ws.ts order <marketId>`
   - `cd bot && npx tsx src/testing/test-all-channels-latency.ts [marketId]`

### Milestone 1：Dashboard 内建立 Predict WS 缓存层（订单簿）✅ 已完成

**实现内容：**
- ✅ 新建统一缓存层 `bot/src/services/predict-orderbook-cache.ts`
- ✅ 维护 `Map<marketId, CachedOrderbook>` 含 `timestamp`, `source`
- ✅ `getOrderbookSync(marketId)` 同步读取 + 后台刷新触发
- ✅ Dashboard 各模块通过 Provider 注入统一读取缓存
- ✅ REST 兜底增加 3s 冷却 + in-flight 去重，防止限流
- ✅ 深拷贝返回，防止下游污染共享缓存

**验收结果：**
- ✅ 9 个单元测试全部通过
- ✅ 类型检查通过
- ⏳ 待监控生产环境 REST 调用频次下降情况

### Milestone 2：订单状态/成交事件迁移到 `predictWalletEvents/{jwt}`
- 以 `predictWalletEvents` 作为订单状态主来源：
  - Task 执行中监听对应 orderHash 的事件：`ORDER_*`
  - 维护 `orderStatusCache`（已有 `bot/src/dashboard/order-status-cache.ts`，需确认数据源改为 WS）
- 将 `bsc-order-watcher` 改为 fallback：
  - 增加开关（环境变量/配置）默认关闭
  - 仅当 WS 不可用或事件缺失时启用
- 验收标准：
  - TaskExecutor 能在 WS 事件驱动下完成“成交/部分成交/取消”状态迁移。
  - 可关闭 `bsc-order-watcher` 仍能稳定工作。

### Milestone 3：清理与统一（收敛 PredictClient 轮询）
- 处理 `bot/src/predict/index.ts`：
  - 将“轮询模型”标记为 deprecated 或替换为 WS 版本（具体实现视后续重构方案）
  - 修正错误注释（当前写了“无 WS API”）
- 将内部模块的“订单簿获取接口”统一成：
  - `getPredictOrderbook(marketId): NormalizedOrderBook | null`（从缓存读）
- 验收标准：
  - repo 内核心路径不再出现频繁 `GET /v1/markets/{id}/orderbook`。

---

## 风控与失败处理（WS 相关）

- `wsStalenessGuard`：订单簿超过阈值未更新 → 停止追价/停止新任务，仅保留最低风险挂单（anchor）或暂停该市场。
- `wsReconnectBackoff`：重连失败累计 N 次 → 进入全局降级模式，暂停策略引擎。
- `fallbackBudget`：REST 兜底回填设置频次上限（例如每 market 每分钟最多 1 次），避免断线时把 REST 打爆。

---

## 交付物

1. Predict WS 缓存层（Dashboard 内部可复用）
2. 订单状态事件驱动（`predictWalletEvents` 主路径 + `bsc-order-watcher` fallback）
3. 文档与运行手册更新（启动参数、开关、诊断方式）

---

## 风险与注意事项

- `predictWalletEvents/{jwt}` 依赖 JWT 生命周期与续期策略：需确保 JWT 过期前刷新，否则会静默失联。
- WS 推送的订单簿是否为全量快照还是增量更新：缓存层必须正确处理（以官方文档为准）。
- 多市场订阅数量与内存/CPU：需做上限（本项目目标 20 个以内）。

---

## 建议改造顺序（最小风险）

1. ✅ **先接入 Predict WS 订单簿到 Dashboard cache** (已完成 2026-01-17)
   - 目标：`predictOrderbookCache` 不再依赖 REST 主路径刷新。
   - 成果：统一缓存层 + 4 模块 Provider 注入 + 9 个测试用例
2. ✅ **再切换 TaskExecutor 的成交/订单状态来源** (已完成 2026-01-18)
   - 目标：以 `predictWalletEvents/{jwt}` 为主；BSC watcher 与 `OrderStatusCache` 轮询作为 fallback（可配置关闭）。
   - 成果：统一工厂 `order-watcher-factory.ts` + 环境变量配置 + task-executor 集成
3. 🔲 **最后清理/收敛遗留轮询实现**
   - 目标：减少维护面，避免两套实现长期并存导致口径不一致。

---

## 下一步行动

### 已完成（Milestone 2）

- [x] 调研 `predictWalletEvents/{jwt}` 事件结构与字段映射 → 已修复事件类型映射
- [x] JWT 刷新机制 → 已实现
- [x] 真实订单测试验证事件类型正确性 → 订单测试通过 (776ms 下单, 6761ms WS 事件)
- [x] 实现 `predictWalletEvents` 订阅与事件分发 → `predict-order-watcher.ts` 已实现
- [x] 修改 `task-executor.ts` 以 WS 事件驱动订单状态更新 → 已集成工厂模块
- [x] 将 `bsc-order-watcher` 改为可配置 fallback → `order-watcher-factory.ts` 提供 `PREDICT_ORDER_WATCHER_SOURCE` 配置

### 近期（Milestone 3 准备）

- [ ] 监控生产环境 REST 订单簿调用频次，验证 Milestone 1/2 效果
- [ ] 设计 `orderStatusCache` 与 WS 事件的集成方案（可选）

### 长期（Milestone 3）

- [ ] 移除旧缓存兼容层
- [ ] 清理 `bot/src/predict/index.ts` 轮询代码
- [ ] 统一 `getPredictOrderbook()` 接口

---

## 配置参数参考

### 环境变量

| 变量 | 默认值 | 说明 |
|-----|-------|------|
| `PREDICT_ORDERBOOK_CACHE_TTL_MS` | 15000 | 缓存 TTL（毫秒） |
| `PREDICT_ALLOW_STALE_ORDERBOOK_CACHE` | false | 是否允许使用过期数据 |
| `PREDICT_ORDERBOOK_SOURCE` | - | `ws`=仅WS, `rest`=仅REST, 空=混合 |
| `PREDICT_ORDER_WATCHER_SOURCE` | predict | 订单监控来源：`predict`=Predict WS, `bsc`=BSC WSS, `auto`=自动切换 |

### 代码常量

```typescript
// predict-orderbook-cache.ts
const DEFAULT_TTL_MS = 15000;           // 默认 15 秒过期
const DEFAULT_STALE_THRESHOLD_MS = 5000; // 5 秒内认为新鲜
const REST_TIMEOUT_MS = 5000;           // REST 请求超时
const MAX_CONCURRENT_REST = 5;          // 最大并发 REST 请求
const REFRESH_COOLDOWN_MS = 3000;       // 刷新冷却时间
```

---

## 变更记录

| 日期 | 变更内容 |
|-----|---------|
| 2026-01-18 | **✅ Milestone 2 完成**：统一 Order Watcher 工厂，支持 Predict WS / BSC WSS 配置切换 |
| 2026-01-18 | 新增 `order-watcher-factory.ts`，环境变量 `PREDICT_ORDER_WATCHER_SOURCE` |
| 2026-01-18 | task-executor 集成工厂模块，init 时自动初始化 watcher |
| 2026-01-18 | **✅ 订单测试通过**：WS 事件延迟 6761ms，watchOrder 回调正常触发 |
| 2026-01-18 | 关键修复：orderId 解析、orderHash↔orderId 映射、placeOrder 返回 orderId |
| 2026-01-18 | Milestone 2 三轮审查修复：初始订阅标志、事件类型兜底、WS 连接检查、logIndex 整数化 |
| 2026-01-18 | Milestone 2 二轮审查修复：区分 TX_PENDING/CONFIRMED、订阅重试告警、伪 logIndex |
| 2026-01-17 | Milestone 2 代码审查修复：事件类型映射、去重键、JWT 刷新 |
| 2026-01-17 | Milestone 1 完成：统一订单簿缓存层 |
| 2026-01-17 | 新增 `predict-orderbook-cache.ts` |
| 2026-01-17 | 集成到 Dashboard 4 个模块 |
| 2026-01-17 | 完成 9 个测试用例 |
