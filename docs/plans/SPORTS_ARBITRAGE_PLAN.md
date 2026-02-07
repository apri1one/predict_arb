# 体育市场套利工具集成计划

## 目标
将体育市场匹配结果集成到现有套利工具，在前端添加 SPORTS 标签页，以卡片形式展示匹配的体育赛事。只支持 **BUY 任务**。

---

## 体育市场选项格式

| 平台 | 格式 | 示例 |
|------|------|------|
| Predict | `outcomes[].name` | `"Bulls"`, `"Rockets"` |
| Polymarket | `outcomes[]` 数组 | `["Heat", "Bulls"]` |

### Predict 选项顺序规则
- **outcomes[0]** = 客队 (标题中 "@" 前的队)
- **outcomes[1]** = 主队 (标题中 "@" 后的队)
- 示例: "Bulls @ Rockets" → outcomes[0]="Bulls", outcomes[1]="Rockets"

### Predict 订单簿规则
- **只返回 outcomes[0] (客队) 的价格**
- 主队价格 = `1 - 客队价格`

### 套利映射 (两平台反向)
```
买 Predict 队A + 买 Polymarket 队B = 锁定套利

示例: Bulls @ Rockets
- 买 Predict Bulls (outcomes[0]) → 买 Polymarket Rockets
- 买 Predict Rockets (1-price) → 买 Polymarket Bulls
```

### 互斥性约束（重要补充）
体育市场是二元市场时（两队二选一），方向套利应满足互斥性：如果
`predict_no + poly_yes < 1` 成立，则 `predict_yes + poly_no` 理应大于 1（反之亦然）。

落地时建议把它作为**一致性校验/安全边界**而不是“数学恒等式”，因为实盘用的是 bid/ask 价差：
- Predict 侧主队价格来自反演（`1 - awayPrice`），会用到 `awayBid/awayAsk` 的不同组合；
- Polymarket 两个队名 token 的 ask/bid 同样存在价差，可能出现“两个方向都看起来 < 1”的假信号。

**执行规则建议**：
- 对每场比赛、每种模式（M-T/T-T）分别计算两个方向的成本；
- 若出现“两个方向同时满足 `cost < 1 - ε`”（例如 ε=0.001），视为**匹配/映射或数据异常**：禁用该场比赛的下单按钮并打日志，避免错配导致的锁定失败。

---

## 手续费模型

| 平台 | 模式 | 手续费 |
|------|------|--------|
| Predict | **Maker** | **0%** |
| Predict | **Taker** | 动态: `feeRate × min(price, 1-price)` |
| Polymarket | 全部 | **0%** |

---

## M-T vs T-T 套利模式

### 价格定义 (以客队 outcomes[0] 为例)
```
Predict 订单簿 (outcomes[0] = 客队):
  - bid[0][0] = 买方最高出价 (你挂 Maker 卖单可成交的价格)
  - ask[0][0] = 卖方最低要价 (你 Taker 买入需支付的价格)

Polymarket 订单簿 (对应 token):
  - bid = 买方最高出价
  - ask = 卖方最低要价 (你 Taker 买入需支付的价格)
```

### 双向套利计算

**每场比赛需要计算 4 个套利机会**（2方向 × 2模式）:

| 方向 | 模式 | Predict 买入 | Poly 对冲买 | 成本公式 |
|------|------|-------------|------------|---------|
| 买客队 | M-T | outcomes[0] @ bid | 主队 @ ask | `pred_bid + poly_home_ask` |
| 买客队 | T-T | outcomes[0] @ ask | 主队 @ ask | `pred_ask + poly_home_ask + fee` |
| 买主队 | M-T | outcomes[1] @ (1-ask) | 客队 @ ask | `(1-pred_ask) + poly_away_ask` |
| 买主队 | T-T | outcomes[1] @ (1-bid) | 客队 @ ask | `(1-pred_bid) + poly_away_ask + fee` |

**注意**: Predict 订单簿只返回 outcomes[0] (客队) 价格
- 客队 bid/ask = 订单簿直接返回
- 主队 bid = `1 - 客队 ask`
- 主队 ask = `1 - 客队 bid`

### 计算落地注意（与现有二元 YES/NO 深度计算的差异）
现有 `depth-calculator.ts` 的 `calculateNoSideDepth` 依赖 “YES/NO 互补反演”（例如 `poly_yes_ask = 1 - poly_no_bid`）。
体育市场在 Polymarket 上是**两个队名 token**，实盘计算必须直接读取两边 token 的 orderbook（awayToken/homeToken），不能用 `1 - price` 反演得到对方价格/深度。

建议在 `sports-service.ts` 中实现专用的深度/成本计算（但输出仍复用 `ArbOpportunity` 结构），避免误用 `calculateNoSideDepth`。

### M-T (Maker-Taker) - 主要套利模式
```
利润 = 1 - predict_bid - poly_opposite_ask

买客队 M-T:
  成本 = pred_away_bid + poly_home_ask
  利润 = 1 - pred_away_bid - poly_home_ask

买主队 M-T:
  成本 = (1 - pred_away_ask) + poly_away_ask
  利润 = 1 - (1 - pred_away_ask) - poly_away_ask
       = pred_away_ask - poly_away_ask
```
- Predict 挂 Maker 单（无手续费）
- 等待被吃单成交
- Polymarket Taker 买入对冲
- **套利空间大**（通常只有 M-T 有利润）

### T-T (Taker-Taker)
```
利润 = 1 - predict_ask - poly_opposite_ask - predict_fee

买客队 T-T:
  成本 = pred_away_ask + poly_home_ask + fee
  利润 = 1 - pred_away_ask - poly_home_ask - fee

买主队 T-T:
  成本 = (1 - pred_away_bid) + poly_away_ask + fee
  利润 = pred_away_bid - poly_away_ask - fee
```
- Predict Taker 买入（有动态手续费）
- Polymarket Taker 买入对冲
- **套利空间小**（因 Predict Taker fee）

### 前端显示逻辑
```
对于每场比赛，计算 4 个利润值:
  - awayMT = 1 - pred_away_bid - poly_home_ask
  - awayTT = 1 - pred_away_ask - poly_home_ask - fee
  - homeMT = pred_away_ask - poly_away_ask
  - homeTT = pred_away_bid - poly_away_ask - fee

卡片显示:
  [Buy 客队] → 显示 awayMT / awayTT (正利润可点击)
  [Buy 主队] → 显示 homeMT / homeTT (正利润可点击)
```

---

## 现有架构理解

### 后端
- **task-executor.ts** - 统一任务执行（支持 MAKER/TAKER）
- **taker-mode/executor.ts** - Taker 模式执行器
- **task-service.ts** - 任务 CRUD + 并发锁
- **arb-service.ts** - 套利机会扫描 + SSE 广播
- **start-dashboard.ts** - 后端入口

### 前端
- **app.jsx** - 主应用，Tab 切换（LIVE/TASKS/CLOSE/HISTORY/ANALYTICS）
- **components.jsx** - UI 组件库（OpportunityCard, Badge 等）
- **sse.js** - SSE 连接 + 数据缓存

### 体育匹配
- **bot/src/terminal/sports-market-matcher.ts** - NBA 匹配示例（现有脚本）
- 匹配方式：conditionId 直接匹配 + slug 模式匹配
- Polymarket Sports API：`tag_id=745` (NBA), `sports_market_types=moneyline`

---

## 实现计划

### 阶段 1: 创建体育市场服务 (后端)

**新建文件**: `bot/src/dashboard/sports-service.ts`

功能：
1. 定期扫描体育市场匹配（复用 `bot/src/terminal/sports-market-matcher.ts` 逻辑）
2. 构建 `SportsMatchedMarket` 数据结构
3. 计算套利机会（复用 depth-calculator.ts）
4. 通过 SSE 广播 `sports` 事件

```typescript
interface SportsMatchedMarket {
  // 匹配信息
  predictMarketId: number;
  predictTitle: string;
  predictCategorySlug: string;
  polymarketConditionId: string;
  polymarketQuestion: string;

  // 比赛信息
  sport: 'nba' | 'nfl' | 'nhl' | 'epl' | 'mma';
  homeTeam: string;
  awayTeam: string;
  gameDate: string;

  // 套利信息（复用现有结构）
  // 每场比赛 4 个机会（2方向 × 2模式）
  // 方向：away/home 表示用户买入哪一队（Predict 买入该队），对冲买入另一队（Polymarket）
  awayMT?: ArbOpportunity;  // 买客队，M-T
  awayTT?: ArbOpportunity;  // 买客队，T-T
  homeMT?: ArbOpportunity;  // 买主队，M-T
  homeTT?: ArbOpportunity;  // 买主队，T-T

  // 状态
  polymarketLiquidity: number;
  lastUpdated: number;
}
```

### 阶段 2: 集成到 SSE 数据流

**修改文件**: `bot/src/dashboard/start-dashboard.ts`

1. 初始化 SportsService
2. 添加 `/api/sports` REST 端点
3. 添加 SSE `sports` 事件广播
4. 设置扫描间隔（2秒，与 dashboard 的 `POLL_INTERVAL_MS` 保持一致）

### 阶段 3: 前端 SPORTS 标签页

**修改文件**: `front/preview/app.jsx`

1. 添加 `SPORTS` Tab
2. 订阅 SSE `sports` 事件
3. 添加体育市场状态管理

**修改文件**: `front/preview/sse.js`

1. 添加 `sports` 事件监听器
2. 数据缓存和去重

### 阶段 4: 体育卡片组件

**修改文件**: `front/preview/components.jsx`

新增 `SportsCard` 组件：
```jsx
<SportsCard>
  ├─ 头部: 🏀 NBA + "Bulls @ Rockets"
  ├─ 比赛时间: "Jan 15, 2026 7:30 PM"
  ├─ 选项显示: "Bulls" vs "Rockets" (非 YES/NO)
  ├─ 价格对比表:
  │   ┌─────────────┬─────────┬─────────┐
  │   │             │ Bulls   │ Rockets │
  │   ├─────────────┼─────────┼─────────┤
  │   │ Predict Bid │ $0.45   │ $0.52   │
  │   │ Predict Ask │ $0.47   │ $0.54   │
  │   │ Poly Ask    │ $0.53   │ $0.47   │
  │   └─────────────┴─────────┴─────────┘
  ├─ 套利指标:
  │   - M-T: +2.1% ($0.45 + $0.53 = $0.98) ✅
  │   - T-T: +0.5% (含 fee) ⚠️
  ├─ 操作按钮:
  │   - [Buy Bulls] → 弹出模式选择
  │   - [Buy Rockets] → 弹出模式选择
  └─ 流动性: Poly $241K
</SportsCard>
```

### 阶段 5: BUY 任务交互

**点击 Buy 按钮后**:
1. 弹出模式选择框 (复用/改造 TaskModal)
2. 显示两种模式的利润预估:
   - **M-T**: 显示利润%（无利润时 disabled）
   - **T-T**: 显示利润%（无利润时 disabled）
3. 用户选择模式后创建任务

```jsx
<ModeSelector>
  ├─ "选择套利模式 - Buy Bulls"
  ├─ [M-T] +2.1% profit (Maker-Taker) ← 可点击
  ├─ [T-T] -0.3% loss (Taker-Taker) ← 灰色不可点击
  └─ [取消]
</ModeSelector>
```

**关键逻辑**:
- M-T 利润 = `1 - predict_bid - poly_ask`
- T-T 利润 = `1 - predict_ask - poly_ask - predict_fee`
- 利润 <= 0 时按钮 disabled

### 阶段 6: 任务创建参数映射

**场景**: Bulls @ Rockets，用户选择买 Bulls (M-T 模式)

```typescript
// Predict 信息
const predictMarket = {
  outcomes: [{ name: 'Bulls' }, { name: 'Rockets' }],  // [0]=客队, [1]=主队
  orderbook: { bids: [[0.45, 100]], asks: [[0.47, 100]] }  // 只有 outcomes[0] 价格
};

// Polymarket 信息
const polyMarket = {
  outcomes: ['Bulls', 'Rockets'],
  clobTokenIds: ['bullsTokenId', 'rocketsTokenId'],  // 对应顺序
};

// === 买 Bulls (outcomes[0]) ===
const task_buyBulls: CreateTaskParams = {
  type: 'BUY',
  strategy: 'MAKER',  // M-T
  marketId: predictMarketId,

  // arbSide = 'YES' 表示买 outcomes[0] (Bulls)
  arbSide: 'YES',

  // Predict 价格 (直接用订单簿 bid)
  predictPrice: 0.45,  // predictBook.bids[0][0]

  // 对冲: 买 Polymarket Rockets (对手队)
  polymarketYesTokenId: bullsTokenId,      // 主方 token (不用)
  polymarketNoTokenId: rocketsTokenId,     // 对冲方 token ← 实际买入
  polymarketMaxAsk: polyRocketsAsk + 0.01, // 对冲价上限

  quantity,
  negRisk,
  tickSize,
  feeRateBps: 0,  // Maker 无 fee
};

// === 买 Rockets (outcomes[1]) ===
const task_buyRockets: CreateTaskParams = {
  type: 'BUY',
  strategy: 'MAKER',
  marketId: predictMarketId,

  // arbSide = 'NO' 表示买 outcomes[1] (Rockets)
  arbSide: 'NO',

  // Predict 价格: 主队价 = 1 - 客队价
  predictPrice: 1 - 0.47,  // = 0.53, 用 1 - ask 作为主队 bid

  // 对冲: 买 Polymarket Bulls (对手队)
  polymarketYesTokenId: bullsTokenId,      // 对冲方 token ← 实际买入
  polymarketNoTokenId: rocketsTokenId,     // 主方 token (不用)
  polymarketMaxAsk: polyBullsAsk + 0.01,   // 对冲价上限

  quantity,
  negRisk,
  tickSize,
  feeRateBps: 0,
};
```

**关键映射**:
| 用户操作 | arbSide | Predict 买入 | Predict 价格来源 | Poly 对冲 |
|---------|---------|-------------|-----------------|----------|
| Buy 客队 | YES | outcomes[0] | `book.bids[0][0]` | 买主队 token |
| Buy 主队 | NO | outcomes[1] | `1 - book.asks[0][0]` | 买客队 token |

---

## 关键文件修改清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `bot/src/dashboard/sports-service.ts` | **新建** | 体育市场匹配 + 套利计算 |
| `bot/src/dashboard/sports-types.ts` | **新建** | 体育市场类型定义 |
| `bot/src/dashboard/start-dashboard.ts` | 修改 | 集成 SportsService + SSE + REST API |
| `front/preview/app.jsx` | 修改 | 添加 SPORTS Tab |
| `front/preview/components.jsx` | 修改 | 添加 SportsCard + ModeSelector 组件 |
| `front/preview/sse.js` | 修改 | 添加 sports 事件监听 |

### 不需要修改 (完全复用)
- `task-executor.ts` - BUY 任务执行逻辑
- `taker-mode/executor.ts` - T-T 模式对冲
- `task-service.ts` - 任务 CRUD
- `polymarket-trader.ts` - Poly 下单
- `predict-trader.ts` - Predict 下单

---

## 数据流设计

```
SportsService (后端)
    ├─ 2s 扫描 Predict 活跃市场 (与 POLL_INTERVAL_MS 一致)
    ├─ 筛选体育市场 (NBA/NFL/...)
    ├─ 调用 Polymarket Sports API
    ├─ 执行匹配 (conditionId/slug)
    ├─ 计算套利机会 (depth-calculator)
    └─ SSE 广播 'sports' 事件
        ↓
前端 (sse.js)
    └─ 监听 'sports' 事件
        ↓
App.jsx
    ├─ SPORTS Tab 显示
    └─ SportsCard[] 渲染
        ↓
用户操作
    ├─ 点击 Buy/Sell
    ├─ TaskModal 创建任务
    └─ task-executor 执行 (复用现有流程)
```

---

## 对冲流程 (只支持 BUY 任务)

### M-T 模式 (task-executor.ts MAKER 分支)
```
1. Predict 挂 Maker 买单 (无手续费)
2. 价格守护: poly_ask <= polymarketMaxAsk
3. 等待被吃单成交
4. 成交后 Polymarket Taker 买入对冲 (IOC)
5. 增量对冲: 部分成交时立即对冲
```

### T-T 模式 (taker-mode/executor.ts)
```
1. Predict Taker 买入 @ ask 价格 (有动态手续费)
2. 成本守护: predict_ask + poly_ask + fee < maxTotalCost
3. 超时撤单: 默认 20s
4. 增量对冲: Predict 部分成交 → 立即 Polymarket IOC 买入
5. Fee 处理: 对冲数量 = 实际到账 shares (扣 fee)
```

### 关键方法
| 方法 | 文件 | 说明 |
|------|------|------|
| `executeBuyTask` | task-executor.ts | 路由到 MAKER/TAKER |
| `runWithPriceGuard` | task-executor.ts | M-T 价格守护 |
| `executeTakerBuy` | taker-mode/executor.ts | T-T 成本守护 |
| `incrementalHedge` | taker-mode/executor.ts | 增量对冲 |

---

## 风控机制 (完全复用)

| 机制 | 模式 | 参数 | 说明 |
|------|------|------|------|
| Price Guard | M-T | `polymarketMaxAsk` | 对冲价格上限 |
| Cost Guard | T-T | `maxTotalCost` | 总成本上限 |
| Order Timeout | 全部 | `orderTimeout` (默认 20s) | 订单超时撤单 |
| Hedge Retry | 全部 | `maxHedgeRetries` (默认 3) | 对冲重试次数 |
| Unwind | 全部 | - | 对冲失败时反向平仓 |

---

## 订单簿刷新性能测试 (实施前必做)

### 测试目标
同时获取多个体育市场订单簿，确定合适的刷新间隔。

### 测试脚本 (新建)
`bot/test-sports-orderbook-latency.ts`
```typescript
// 测试内容:
// 1. 获取所有匹配的体育市场 (约 4-10 个)
// 2. 并行请求 Predict + Polymarket 订单簿
// 3. 统计延迟: 平均值、P95、P99
// 4. 测试不同并发数的影响

interface LatencyResult {
  market: string;
  predictLatency: number;
  polyLatency: number;
  totalLatency: number;
}
```

### 预期输出
```
=== Sports Orderbook Latency Test ===

Markets: 6 (NBA)
Concurrent requests: 12 (6 Predict + 6 Poly)

Round 1:
  Predict avg: 120ms, P95: 180ms
  Poly avg: 85ms, P95: 130ms
  Total: 205ms (parallel), 410ms (sequential)

...

Recommendation:
  - 刷新间隔: XXXX ms (基于 P95 + buffer)
  - 并发策略: parallel / batch
```

### 关键决策点
| 指标 | 阈值 | 策略 |
|------|------|------|
| P95 < 500ms | 使用 2s 刷新 (同 dashboard) |
| P95 500-1000ms | 使用 3-5s 刷新 |
| P95 > 1000ms | 使用批量/分组刷新 |

---

## getHedgeTokenId 映射 (完全复用)

现有代码 (`task-executor.ts:1625`):
```typescript
private getHedgeTokenId(task: Task): string {
    const arbSide = task.arbSide || 'YES';

    if (arbSide === 'YES') {
        // YES 端套利: 对冲买 Poly NO (或 YES if inverted)
        return task.isInverted ? task.polymarketYesTokenId : task.polymarketNoTokenId;
    } else {
        // NO 端套利: 对冲买 Poly YES (或 NO if inverted)
        return task.isInverted ? task.polymarketNoTokenId : task.polymarketYesTokenId;
    }
}
```

### 体育市场映射
| 字段 | YES/NO 市场 | 体育市场 |
|------|------------|---------|
| `polymarketYesTokenId` | YES token | **客队** token (outcomes[0]) |
| `polymarketNoTokenId` | NO token | **主队** token (outcomes[1]) |
| `arbSide = 'YES'` | 买 Predict YES | 买 Predict **客队** |
| `arbSide = 'NO'` | 买 Predict NO | 买 Predict **主队** |

### 套利流程映射
| 用户操作 | arbSide | Predict 买 | Poly 对冲买 | getHedgeTokenId 返回 |
|---------|---------|-----------|------------|-------------------|
| Buy 客队 (Bulls) | YES | 客队 | 主队 | `polymarketNoTokenId` (主队 token) |
| Buy 主队 (Rockets) | NO | 主队 | 客队 | `polymarketYesTokenId` (客队 token) |

**结论**: `getHedgeTokenId` 逻辑完全复用，只需正确设置 token 映射。

---

## 额外一致性校验（建议加入风控前置）
1. **仅接入二元市场**：若任一平台 outcomes 数量 ≠ 2，直接过滤（避免平局/三选项等导致映射失效）。
2. **方向互斥校验**：见上文“互斥性约束（重要补充）”，若同模式下两个方向同时 `cost < 1 - ε`，禁用交易并记录日志。
3. **Predict outcomes 顺序校验**：必须验证 Predict orderbook 确实对应 `outcomes[0]`（或 indexSet=1）那一侧；若发现不一致，需改为显式按 token 拉取或调整映射规则。

---

## 验证方案

1. **后端验证**:
   ```bash
   cd bot && npm run dashboard
   # 检查控制台输出：体育市场扫描日志
   # curl http://localhost:3005/api/sports
   ```

2. **前端验证**:
   - 打开 Dashboard (http://localhost:3005)
   - 点击 SPORTS Tab
   - 验证卡片展示：比赛信息、价格、套利指标
   - 点击 Buy/Sell，验证任务创建流程

3. **端到端验证**:
   - 创建一个体育市场套利任务
   - 验证任务状态转换
   - 验证风控机制触发

---

## 风险和注意事项

1. **API 频率限制**: Polymarket Sports API 可能有频率限制，需要缓存
2. **市场匹配准确性**: conditionId 匹配优先，slug 匹配作为备用
3. **时间敏感性**: 体育市场有开赛时间限制，需要显示倒计时
4. **深度不足**: 体育市场流动性可能较低，需要显示风险警告
