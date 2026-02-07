# Maker 套利任务执行系统实现计划 (V2)

## 目标

在 Dashboard 中实现 Maker 套利的完整执行流程，包含风控和应急预案：
- **Buy 任务**：Predict Maker 挂单 → 增量对冲 → Polymarket Taker 买入
- **Sell 任务**：检查双边持仓 → Predict 挂卖单 → 增量对冲 → Polymarket 卖出

**核心原则**：
- Predict Maker = 0 fee，Polymarket Taker = 0 fee
- 套利条件：`predictPrice + polyNoAsk < 1.0`
- 增量对冲：每次 Predict 部分成交就立即对冲，降低方向风险

---

## 业务流程

### Buy 任务流程 (循环状态机 + 增量对冲)

```
1. 【前置校验】
   ├─ 检查 Predict/Polymarket 余额是否充足
   ├─ 检查 market 是否 active (未结算/暂停)
   ├─ 验证 tokenId 映射正确 (YES + NO = 1)
   ├─ 检查最小下单单位/price tick
   └─ 检查该 market 无其他活跃任务 (并发锁)

2. 【用户配置】
   ├─ Predict 挂单价格 (默认买一价)
   ├─ 数量 (默认最大深度)
   ├─ Polymarket 最大可接受价格 (polymarketMaxAsk)
   ├─ 最小利润缓冲 (minProfitBuffer，如 0.5%)
   └─ 超时时间 (orderTimeout)

3. 【循环状态机执行】
   ┌─────────────────────────────────────────────────────────────────┐
   │  while (remainingQty > 0 && !cancelled) {                      │
   │                                                                 │
   │    // 步骤 A: 检查套利机会 (含深度)                              │
   │    avgHedgePrice = calcAvgPrice(polyBook, remainingQty);        │
   │    if (predictPrice + avgHedgePrice >= 1.0 - minProfitBuffer) { │
   │      status = PAUSED;                                           │
   │      await waitForOpportunity();  // 继续监控直到机会出现        │
   │      continue;                                                  │
   │    }                                                            │
   │                                                                 │
   │    // 步骤 B: 提交 Predict Maker 订单                            │
   │    currentOrderHash = placePredictOrder(remainingQty);          │
   │    status = PREDICT_SUBMITTED;                                  │
   │                                                                 │
   │    // 步骤 C: 并行监控                                           │
   │    await Promise.race([                                         │
   │      watchPredictFill(currentOrderHash),  // 成交事件            │
   │      watchPriceGuard(),                   // 价格守护            │
   │      watchTimeout(orderTimeout),          // 超时                │
   │    ]);                                                          │
   │                                                                 │
   │    // 步骤 D: 处理结果                                           │
   │    if (priceInvalid) {                                          │
   │      cancelOrder(currentOrderHash);                             │
   │      // 处理已部分成交的遗留                                     │
   │      if (partialFilledQty > lastHedgedQty) {                    │
   │        hedgeDelta(partialFilledQty - lastHedgedQty);            │
   │      }                                                          │
   │      status = PAUSED;                                           │
   │      continue;                                                  │
   │    }                                                            │
   │                                                                 │
   │    if (timeout) {                                               │
   │      cancelOrder(currentOrderHash);                             │
   │      status = TIMEOUT_CANCELLED;                                │
   │      // 同样处理部分成交遗留                                     │
   │      break;                                                     │
   │    }                                                            │
   │                                                                 │
   │    // 步骤 E: 增量对冲                                           │
   │    newFilledQty = getFilledQty(currentOrderHash);               │
   │    deltaQty = newFilledQty - lastHedgedQty;                     │
   │    if (deltaQty > 0) {                                          │
   │      hedgeResult = hedgeOnPolymarket(deltaQty);                 │
   │      lastHedgedQty += hedgeResult.filledQty;                    │
   │      remainingQty -= hedgeResult.filledQty;                     │
   │    }                                                            │
   │                                                                 │
   │    // 如果 Predict 订单完全成交，继续循环检查是否还有剩余         │
   │  }                                                              │
   └─────────────────────────────────────────────────────────────────┘

4. 【对冲失败应急预案】
   当 Polymarket 对冲失败时 (价格跳走/接口失败/流动性不足)：

   策略 A: 追价 (Chase)
   ├─ 逐步提高 limit price 直到 polymarketMaxAsk
   ├─ 每次追价间隔 500ms
   └─ 最多追 3 次

   策略 B: 暂停等待 (Wait)
   ├─ 状态变为 HEDGE_PENDING
   ├─ 继续监控 Polymarket 价格
   ├─ 价格回落到可接受范围时重试
   └─ 设置最大等待时间 (如 5 分钟)

   策略 C: 反向平仓 (Unwind)
   ├─ 如果超时仍无法对冲
   ├─ 在 Predict 上以 Taker 卖出 YES (会产生手续费)
   ├─ 记录损失
   └─ 状态变为 UNWIND_COMPLETED
```

### 状态机完整定义

```
                                    ┌─────────────────┐
                                    │                 │
                                    ▼                 │
PENDING ──► VALIDATING ──► PREDICT_SUBMITTED ◄───────┤
                                    │                 │
                          ┌────────┬┴────────┐        │
                          ▼        ▼         ▼        │
                    PARTIALLY   PAUSED   TIMEOUT      │
                      FILLED  (价格守护) (超时取消)    │
                          │        │         │        │
                          ▼        └─────────┴────────┘
                   HEDGING ──► HEDGE_PENDING ──► HEDGE_RETRY
                          │              │              │
                          ▼              ▼              ▼
                   COMPLETED      UNWIND_PENDING   HEDGE_FAILED
                                       │
                                       ▼
                                UNWIND_COMPLETED
                                       │
                                       ▼
                                    FAILED
```

### Sell 任务流程 (对称风控)

**腿位说明**:
- Predict 侧: 卖出已持有的 YES token
- Polymarket 侧: 卖出已持有的 NO token (不是买入!)
- 收益来源: 两边卖出价格之和 > 1.0 (或 > 成本基准)

**对冲方向说明**:
- BUY 任务对冲: 买 NO → 看 asks (卖盘)，用 bestAsk，限制 <= maxAsk
- SELL 任务对冲: 卖 NO → 看 bids (买盘)，用 bestBid，限制 >= minBid

```
1. 【前置校验】
   ├─ 检查 Predict YES 持仓 >= 数量
   ├─ 检查 Polymarket NO 持仓 >= 数量
   ├─ 检查 market 是否 active
   └─ 检查该 market 无其他活跃任务

2. 【用户配置】
   ├─ Predict 卖单价格 (默认卖一价)
   ├─ 数量 (不超过持仓)
   ├─ Polymarket 最低可接受买价 (polymarketMinBid)
   ├─ 超时时间
   └─ 可选: entryCost (原始建仓成本，用于精确盈亏计算)

3. 【价格守护 - SELL 版】
   ├─ 套利条件 (两种口径):
   │   ├─ 有 entryCost: predictSellPrice + polyNoBid > entryCost + minProfitBuffer
   │   └─ 无 entryCost: predictSellPrice + polyNoBid > 1.0 + minProfitBuffer
   ├─ polyNoBid 下跌时触发暂停 (买方出价降低，卖不出好价)
   └─ 同样采用循环状态机 + 增量对冲

4. 【执行流程】
   a. Predict: 挂 Maker 卖单 (卖 YES)
   b. 监控成交 + 价格守护 (监控 bids 而非 asks)
   c. 部分成交时: 立即在 Polymarket 卖出对应数量的 NO
      - 使用 IOC + marketable limit (price = bestBid，但必须 >= minBid)
      - 如果 bestBid < minBid，则无法成交，进入等待
   d. 若连续 3 次卖不出去: 进入应急流程
   e. 反向平仓 (SELL 版): 在 Predict 买回 YES (产生 Taker 手续费)
```

---

## 类型定义 (`types.ts`)

```typescript
// 任务类型
type TaskType = 'BUY' | 'SELL';

type TaskStatus =
  | 'PENDING'            // 待执行
  | 'VALIDATING'         // 前置校验中
  | 'PREDICT_SUBMITTED'  // Predict 订单已提交
  | 'PARTIALLY_FILLED'   // Predict 部分成交，正在对冲
  | 'PAUSED'             // 价格守护触发，暂停
  | 'TIMEOUT_CANCELLED'  // 超时取消 (与伪代码一致)
  | 'HEDGING'            // 正在 Polymarket 对冲
  | 'HEDGE_PENDING'      // 对冲失败，等待重试
  | 'HEDGE_RETRY'        // 对冲重试中
  | 'HEDGE_FAILED'       // 对冲彻底失败 (与状态机图一致)
  | 'UNWIND_PENDING'     // 准备反向平仓
  | 'UNWIND_COMPLETED'   // 反向平仓完成
  | 'COMPLETED'          // 成功完成
  | 'FAILED'             // 失败
  | 'CANCELLED';         // 用户取消

interface Task {
  id: string;
  type: TaskType;
  marketId: number;
  title: string;

  // Market 信息
  polymarketConditionId: string;
  polymarketNoTokenId: string;   // Buy 任务: 买入 NO token 作为对冲
  polymarketYesTokenId: string;  // (保留，实际 Sell 任务卖出的是已持有的 NO)
  isInverted: boolean;           // 是否反向映射
  tickSize: number;              // Polymarket 动态 tick size (从 API 获取)

  // 重要说明:
  // Buy 任务: Predict 买 YES → Polymarket 买 NO (需要 USDC)
  // Sell 任务: Predict 卖 YES → Polymarket 卖 NO (需要 NO token 持仓)

  // 配置 - 价格字段 (区分 BUY/SELL 语义)
  predictPrice: number;          // Predict 挂单价格

  // 对冲价格限制 (BUY/SELL 语义不同，分开定义)
  polymarketMaxAsk: number;      // BUY 专用: 对冲买入 NO 的最大可接受卖价
  polymarketMinBid: number;      // SELL 专用: 对冲卖出 NO 的最小可接受买价

  quantity: number;              // 目标数量
  minProfitBuffer: number;       // 最小利润缓冲 (如 0.005 = 0.5%)
  orderTimeout: number;          // 单次订单超时 (ms)
  maxHedgeRetries: number;       // 对冲最大重试次数

  // 成本基准 (SELL 任务使用，用于计算盈亏)
  entryCost?: number;            // 原始建仓成本 (predictBuyPrice + polyNoBuyPrice)
                                  // 如果没有成本记录，SELL 条件改用 > 1.0 + buffer

  // 当前状态
  status: TaskStatus;
  currentOrderHash?: string;     // 当前 Predict 订单 hash (动态更新)
  currentPolyOrderId?: string;   // 当前 Polymarket 订单 ID

  // 进度追踪
  totalQuantity: number;         // 目标总量
  predictFilledQty: number;      // Predict 已成交量
  hedgedQty: number;             // 已对冲量 (关键: 必须 <= predictFilledQty)
  remainingQty: number;          // 剩余量 = totalQuantity - hedgedQty

  // 风控计数
  pauseCount: number;            // 价格守护触发次数
  hedgeRetryCount: number;       // 对冲重试次数
  unwindQty: number;             // 反向平仓量

  // 结果
  avgPredictPrice: number;       // Predict 平均成交价
  avgPolymarketPrice: number;    // Polymarket 平均成交价
  actualProfit: number;          // 实际利润
  unwindLoss: number;            // 反向平仓损失

  // 时间戳
  createdAt: number;
  updatedAt: number;
  completedAt?: number;

  // 错误信息
  error?: string;
  errorDetails?: string[];       // 详细错误日志
}

// 订单事件
interface OrderEvent {
  type: 'FILL' | 'PARTIAL_FILL' | 'CANCEL' | 'EXPIRE';
  hash: string;
  filledQty: number;
  remainingQty: number;
  price: number;
  timestamp: number;
}

// 深度计算结果
interface DepthAnalysis {
  bestPrice: number;
  avgPrice: number;        // 吃穿深度后的平均价
  availableQty: number;    // 该价格范围内可用量
  isValid: boolean;        // 是否满足套利条件
  estimatedProfit: number; // 预估利润
}
```

---

## 交易执行层

### 2.1 Predict 交易封装 (`predict-trader.ts`)

```typescript
class PredictTrader {
  private orderBuilder: OrderBuilder;
  private jwt: string;
  private activeOrders: Map<string, OrderState>;  // 追踪活跃订单

  async init(): Promise<void>

  // 下单
  async placeLimitOrder(input: {
    marketId: number;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
  }): Promise<{ hash: string }>

  // 查询订单状态 (含成交量)
  async getOrderStatus(hash: string): Promise<{
    status: 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED';
    filledQty: number;
    remainingQty: number;
    avgPrice: number;
  }>

  // 取消订单 (返回取消时的成交量)
  async cancelOrder(hash: string): Promise<{
    success: boolean;
    filledQtyAtCancel: number;
  }>

  // 获取持仓
  async getPositions(): Promise<Position[]>

  // 获取余额
  async getBalance(): Promise<number>

  // 获取订单簿 (用于反向平仓定价)
  async getOrderBook(marketId: number): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  }>

  // 获取市场信息
  async getMarket(marketId: number): Promise<PredictMarketInfo>
}
```

### 2.2 Polymarket 交易封装 (`polymarket-trader.ts`)

```typescript
class PolymarketTrader {
  private wallet: Wallet;
  private config: PolyConfig;

  // 获取订单簿
  async getOrderBook(tokenId: string): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  }>

  // 计算深度 (吃穿订单簿)
  calcDepthAnalysis(
    book: OrderBook,
    side: 'BUY' | 'SELL',
    quantity: number,
    maxPrice?: number
  ): DepthAnalysis

  // 下单 (Limit order 作为 Taker)
  async placeLimitOrder(input: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    timeInForce?: 'GTC' | 'IOC' | 'FOK';  // 默认 GTC, 对冲用 IOC
  }): Promise<{ orderId: string }>

  // 获取市场信息 (含动态 tick size)
  async getMarket(conditionId: string): Promise<PolyMarketInfo | null>

  // 查询订单状态
  async getOrderStatus(orderId: string): Promise<{
    status: 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED';
    filledQty: number;
    remainingQty: number;
    avgPrice: number;
  }>

  // 取消订单
  async cancelOrder(orderId: string): Promise<boolean>

  // 查询余额
  async getBalance(): Promise<number>

  // 查询持仓
  async getPositions(): Promise<Position[]>
}

// Polymarket 市场信息 (从 CLOB /markets API 获取)
interface PolyMarketInfo {
  conditionId: string;
  questionId: string;
  tokens: Array<{ token_id: string; outcome: string }>;
  tickSize: number;      // minimum_tick_size 字段
  minOrderSize: number;  // minimum_order_size 字段
  active: boolean;
}
```

### 2.3 订单监控 (`order-monitor.ts`)

```typescript
interface MonitorConfig {
  predictPrice: number;
  polyTokenId: string;
  quantity: number;
  maxPrice: number;          // BUY: maxAsk, SELL: minBid (语义不同)
  minProfitBuffer: number;
  side: 'BUY' | 'SELL';      // 任务类型，决定监控 asks 还是 bids
  entryCost?: number;        // SELL 时的成本基准 (可选)
}

class OrderMonitor {
  private predictPollingInterval = 500;  // Predict 轮询间隔
  private polyWs: WebSocket;             // Polymarket WS
  private activeMonitors: Map<string, AbortController>;

  // Predict 订单监控 (轮询)
  watchPredictOrder(
    hash: string,
    callbacks: {
      onPartialFill: (filledQty: number, avgPrice: number) => void;
      onFill: (totalQty: number, avgPrice: number) => void;
      onCancel: (filledQty: number) => void;
    }
  ): { stop: () => void }

  // Polymarket 订单监控 (WebSocket)
  watchPolyOrder(
    orderId: string,
    callbacks: {
      onPartialFill: (filledQty: number) => void;
      onFill: (totalQty: number) => void;
      onReject: (reason: string) => void;
    }
  ): { stop: () => void }

  // 价格守护 (含深度计算)
  watchPriceGuard(
    config: MonitorConfig,
    callbacks: {
      onInvalid: (currentAvgPrice: number) => void;  // 套利消失
      onValid: (currentAvgPrice: number) => void;    // 套利恢复
    }
  ): { stop: () => void }

  // 内部: 深度感知的套利检查
  private checkArbWithDepth(
    predictPrice: number,
    polyBook: OrderBook,
    quantity: number,
    minBuffer: number
  ): { valid: boolean; avgPrice: number; profit: number }
}
```

### 2.4 任务执行器 (`task-executor.ts`)

```typescript
// 常量配置
const HEDGE_ORDER_TIMEOUT = 5000;  // 对冲订单超时 (ms)
const UNWIND_SLIPPAGE = 0.02;  // 反向平仓允许滑点 (2%)

class TaskExecutor {
  private predictTrader: PredictTrader;
  private polyTrader: PolymarketTrader;
  private monitor: OrderMonitor;
  private taskService: TaskService;
  private marketLocks: Map<number, string>;  // marketId -> taskId (并发锁)
  private hedgeMutex: Map<string, Promise<void>>;  // taskId -> 对冲串行化锁
  private eventEmitter: EventEmitter;

  // 获取最新 task 快照 (避免陈旧引用)
  private getTask(taskId: string): Task {
    const task = this.taskService.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    return task;
  }

  // 执行 Buy 任务 (循环状态机)
  async executeBuyTask(taskId: string): Promise<void> {
    let task = this.getTask(taskId);

    // 1. 获取并发锁
    if (!this.acquireLock(task.marketId, task.id)) {
      throw new Error(`Market ${task.marketId} has active task`);
    }

    try {
      // 2. 前置校验
      await this.validatePreConditions(task);

      // 3. 循环执行直到完成 (每次循环获取最新 task)
      while (true) {
        task = this.getTask(taskId);  // 刷新快照
        if (task.remainingQty <= 0 || task.status === 'CANCELLED') break;
        await this.executeBuyLoop(taskId);
      }

      // 4. 完成
      task = this.getTask(taskId);
      if (task.hedgedQty >= task.totalQuantity) {
        this.updateTask(task.id, {
          status: 'COMPLETED',
          completedAt: Date.now(),
        });
      }
    } finally {
      this.releaseLock(task.marketId);
    }
  }

  private async executeBuyLoop(taskId: string): Promise<void> {
    let task = this.getTask(taskId);

    // A. 检查套利机会 (含深度)
    const book = await this.polyTrader.getOrderBook(task.polymarketNoTokenId);
    const depth = this.polyTrader.calcDepthAnalysis(
      book, 'BUY', task.remainingQty, task.polymarketMaxAsk
    );

    if (!depth.isValid) {
      this.updateTask(taskId, { status: 'PAUSED', pauseCount: task.pauseCount + 1 });
      await this.waitForOpportunity(taskId);
      return;
    }

    // B. 提交 Predict 订单
    task = this.getTask(taskId);  // 刷新
    const { hash } = await this.predictTrader.placeLimitOrder({
      marketId: task.marketId,
      side: 'BUY',
      price: task.predictPrice,
      quantity: task.remainingQty,
    });
    this.updateTask(taskId, {
      status: 'PREDICT_SUBMITTED',
      currentOrderHash: hash
    });

    // C. 设置监控 + 信号控制
    let orderCompleted = false;
    let needCancel = false;
    let cancelReason: 'PRICE_GUARD' | 'TIMEOUT' | '' = '';

    // 用于唤醒主流程的 Promise
    let resolveSignal: () => void;
    const cancelSignal = new Promise<void>(resolve => { resolveSignal = resolve; });

    const predictWatcher = this.monitor.watchPredictOrder(hash, {
      onPartialFill: async (filledQty, avgPrice) => {
        // 串行化对冲: 获取最新 task，计算 delta
        await this.serializedHedge(taskId, async () => {
          const t = this.getTask(taskId);
          const delta = filledQty - t.hedgedQty;
          if (delta > 0) {
            await this.hedgeIncrement(taskId, delta, avgPrice);
          }
        });
      },
      onFill: async (totalQty, avgPrice) => {
        await this.serializedHedge(taskId, async () => {
          const t = this.getTask(taskId);
          const delta = totalQty - t.hedgedQty;
          if (delta > 0) {
            await this.hedgeIncrement(taskId, delta, avgPrice);
          }
        });
        orderCompleted = true;
        resolveSignal();
      },
      onCancel: () => {
        orderCompleted = true;
        resolveSignal();
      },
    });

    const priceGuard = this.monitor.watchPriceGuard({
      predictPrice: task.predictPrice,
      polyTokenId: task.polymarketNoTokenId,
      quantity: task.remainingQty,
      maxPrice: task.polymarketMaxAsk,  // BUY: 使用 maxAsk
      minProfitBuffer: task.minProfitBuffer,
      side: 'BUY',
    }, {
      onInvalid: () => {
        needCancel = true;
        cancelReason = 'PRICE_GUARD';
        resolveSignal();  // 唤醒主流程
      },
      onValid: () => {
        needCancel = false;
      },
    });

    // D. 等待结果: 完成 / 价格守护触发 / 超时
    const timeoutId = setTimeout(() => {
      needCancel = true;
      cancelReason = 'TIMEOUT';
      resolveSignal();
    }, task.orderTimeout);

    await cancelSignal;  // 等待任一信号
    clearTimeout(timeoutId);

    // E. 清理
    predictWatcher.stop();
    priceGuard.stop();

    // F. 处理取消情况
    if (needCancel && !orderCompleted) {
      const result = await this.predictTrader.cancelOrder(hash);

      // 处理取消时已部分成交的遗留 (串行化)
      await this.serializedHedge(taskId, async () => {
        const t = this.getTask(taskId);
        if (result.filledQtyAtCancel > t.hedgedQty) {
          await this.hedgeIncrement(
            taskId,
            result.filledQtyAtCancel - t.hedgedQty,
            t.predictPrice
          );
        }
      });

      this.updateTask(taskId, {
        status: cancelReason === 'TIMEOUT' ? 'TIMEOUT_CANCELLED' : 'PAUSED',
        currentOrderHash: undefined,
      });
    }
  }

  // 串行化对冲 (防止并发回调导致重复/漏对冲)
  private async serializedHedge(taskId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.hedgeMutex.get(taskId) || Promise.resolve();
    const next = prev.then(fn).catch(() => {});
    this.hedgeMutex.set(taskId, next);
    await next;
  }

  // 增量对冲
  // 策略: IOC + marketable limit (不超过 maxPrice) → 循环补单 → 应急流程
  private async hedgeIncrement(
    taskId: string,
    deltaQty: number,
    predictAvgPrice: number
  ): Promise<void> {
    this.updateTask(taskId, { status: 'HEDGING' });

    let task = this.getTask(taskId);
    let remainingToHedge = deltaQty;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;  // 连续失败次数阈值

    // Phase 1: IOC + marketable limit 循环补单
    while (remainingToHedge > 0 && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      task = this.getTask(taskId);

      // 获取最新订单簿
      const book = await this.polyTrader.getOrderBook(task.polymarketNoTokenId);
      if (!book.asks.length) {
        consecutiveFailures++;
        await this.sleep(500);
        continue;
      }

      // 使用 marketable limit: 当前最优卖价，但不超过 maxAsk
      const bestAsk = book.asks[0].price;

      // BUY: 如果最优卖价已超过 maxAsk，无法以可接受价格成交
      if (bestAsk > task.polymarketMaxAsk) {
        consecutiveFailures++;
        await this.sleep(500);
        continue;
      }

      // 归一化 bestAsk (交易所价格已在 tick 边界，只修复浮点误差)
      const normalizedAsk = this.normalizePrice(bestAsk, task.tickSize);

      // task.polymarketMaxAsk 已在 validatePreConditions 中量化过
      // 取较小值作为下单价
      const marketablePrice = Math.min(normalizedAsk, task.polymarketMaxAsk);

      try {
        const { orderId } = await this.polyTrader.placeLimitOrder({
          tokenId: task.polymarketNoTokenId,
          side: 'BUY',
          price: marketablePrice,
          quantity: remainingToHedge,
          timeInForce: 'IOC',  // 立即成交或取消
        });

        // IOC 订单状态轮询 (API 可能短暂延迟更新)
        const result = await this.pollOrderStatus(orderId);

        if (result.filledQty > 0) {
          // 成交了，更新状态
          task = this.getTask(taskId);
          this.updateTask(taskId, {
            hedgedQty: task.hedgedQty + result.filledQty,
            remainingQty: task.remainingQty - result.filledQty,
          });
          remainingToHedge -= result.filledQty;
          consecutiveFailures = 0;  // 重置失败计数
        } else {
          // 没成交 (可能深度被吃光)
          consecutiveFailures++;
        }

      } catch (e) {
        consecutiveFailures++;
      }

      // 短暂等待后继续尝试
      if (remainingToHedge > 0) {
        await this.sleep(200);
      }
    }

    // Phase 2: 如果还有剩余，进入应急流程
    if (remainingToHedge > 0) {
      this.updateTask(taskId, {
        status: 'HEDGE_PENDING',
        hedgeRetryCount: task.hedgeRetryCount + 1,
      });
      await this.handleHedgeFailure(taskId, remainingToHedge);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 对冲失败应急处理
  private async handleHedgeFailure(taskId: string, unhedgedQty: number): Promise<void> {
    // 等待一段时间看价格是否回落
    const waitResult = await this.waitForHedgeOpportunity(taskId, unhedgedQty, 5 * 60 * 1000);

    if (waitResult.success) {
      // 重试对冲
      const task = this.getTask(taskId);
      await this.hedgeIncrement(taskId, unhedgedQty, task.predictPrice);
      return;
    }

    // 反向平仓
    this.updateTask(taskId, { status: 'UNWIND_PENDING' });

    try {
      const task = this.getTask(taskId);

      // 获取当前最优买价，加滑点作为限价 (而非 price: 0)
      const book = await this.predictTrader.getOrderBook(task.marketId);
      const bestBid = book.bids[0]?.price || 0;
      const unwindPrice = Math.max(0.01, bestBid * (1 - UNWIND_SLIPPAGE));

      // 在 Predict 上以 Taker 卖出 YES (会产生手续费)
      const { hash } = await this.predictTrader.placeLimitOrder({
        marketId: task.marketId,
        side: 'SELL',
        price: unwindPrice,  // 限价单，允许一定滑点
        quantity: unhedgedQty,
      });

      // 等待成交
      const result = await this.waitForPredictFill(hash, 30000);

      this.updateTask(taskId, {
        status: result.filledQty >= unhedgedQty ? 'UNWIND_COMPLETED' : 'HEDGE_FAILED',
        unwindQty: task.unwindQty + result.filledQty,
        unwindLoss: task.unwindLoss + this.calcUnwindLoss(result, task.predictPrice),
      });
    } catch (e) {
      this.updateTask(taskId, {
        status: 'FAILED',
        error: 'Unwind failed',
        errorDetails: [...(this.getTask(taskId).errorDetails || []), String(e)],
      });
    }
  }

  // ============================================================
  // SELL 任务执行 (对称实现)
  // ============================================================

  // 执行 Sell 任务入口
  async executeSellTask(taskId: string): Promise<void> {
    let task = this.getTask(taskId);

    // 1. 获取并发锁
    if (!this.acquireLock(task.marketId, task.id)) {
      throw new Error(`Market ${task.marketId} has active task`);
    }

    try {
      // 2. 前置校验
      await this.validatePreConditions(task);

      // 3. 循环执行
      while (true) {
        task = this.getTask(taskId);
        if (task.remainingQty <= 0 || task.status === 'CANCELLED') break;
        await this.executeSellLoop(taskId);
      }

      // 4. 完成
      task = this.getTask(taskId);
      if (task.hedgedQty >= task.totalQuantity) {
        this.updateTask(task.id, {
          status: 'COMPLETED',
          completedAt: Date.now(),
        });
      }
    } finally {
      this.releaseLock(task.marketId);
    }
  }

  // SELL 循环状态机
  private async executeSellLoop(taskId: string): Promise<void> {
    let task = this.getTask(taskId);

    // A. 检查套利机会 (SELL: 看 bids 而非 asks)
    const book = await this.polyTrader.getOrderBook(task.polymarketNoTokenId);
    const depth = this.calcSellDepthAnalysis(book, task);

    if (!depth.isValid) {
      this.updateTask(taskId, { status: 'PAUSED', pauseCount: task.pauseCount + 1 });
      await this.waitForSellOpportunity(taskId);
      return;
    }

    // B. 提交 Predict 卖单
    task = this.getTask(taskId);
    const { hash } = await this.predictTrader.placeLimitOrder({
      marketId: task.marketId,
      side: 'SELL',  // SELL YES
      price: task.predictPrice,
      quantity: task.remainingQty,
    });
    this.updateTask(taskId, {
      status: 'PREDICT_SUBMITTED',
      currentOrderHash: hash
    });

    // C. 设置监控 + 信号控制
    let orderCompleted = false;
    let needCancel = false;
    let cancelReason: 'PRICE_GUARD' | 'TIMEOUT' | '' = '';

    let resolveSignal: () => void;
    const cancelSignal = new Promise<void>(resolve => { resolveSignal = resolve; });

    const predictWatcher = this.monitor.watchPredictOrder(hash, {
      onPartialFill: async (filledQty, avgPrice) => {
        await this.serializedHedge(taskId, async () => {
          const t = this.getTask(taskId);
          const delta = filledQty - t.hedgedQty;
          if (delta > 0) {
            await this.hedgeSellIncrement(taskId, delta, avgPrice);  // SELL 版对冲
          }
        });
      },
      onFill: async (totalQty, avgPrice) => {
        await this.serializedHedge(taskId, async () => {
          const t = this.getTask(taskId);
          const delta = totalQty - t.hedgedQty;
          if (delta > 0) {
            await this.hedgeSellIncrement(taskId, delta, avgPrice);
          }
        });
        orderCompleted = true;
        resolveSignal();
      },
      onCancel: () => {
        orderCompleted = true;
        resolveSignal();
      },
    });

    // SELL 价格守护: 监控 bids 而非 asks
    const priceGuard = this.monitor.watchPriceGuard({
      predictPrice: task.predictPrice,
      polyTokenId: task.polymarketNoTokenId,
      quantity: task.remainingQty,
      maxPrice: task.polymarketMinBid,  // SELL: 使用 minBid
      minProfitBuffer: task.minProfitBuffer,
      side: 'SELL',  // 告诉守护器这是 SELL 任务
    }, {
      onInvalid: () => {
        needCancel = true;
        cancelReason = 'PRICE_GUARD';
        resolveSignal();
      },
      onValid: () => {
        needCancel = false;
      },
    });

    // D. 等待结果
    const timeoutId = setTimeout(() => {
      needCancel = true;
      cancelReason = 'TIMEOUT';
      resolveSignal();
    }, task.orderTimeout);

    await cancelSignal;
    clearTimeout(timeoutId);

    // E. 清理
    predictWatcher.stop();
    priceGuard.stop();

    // F. 处理取消情况
    if (needCancel && !orderCompleted) {
      const result = await this.predictTrader.cancelOrder(hash);

      await this.serializedHedge(taskId, async () => {
        const t = this.getTask(taskId);
        if (result.filledQtyAtCancel > t.hedgedQty) {
          await this.hedgeSellIncrement(
            taskId,
            result.filledQtyAtCancel - t.hedgedQty,
            t.predictPrice
          );
        }
      });

      this.updateTask(taskId, {
        status: cancelReason === 'TIMEOUT' ? 'TIMEOUT_CANCELLED' : 'PAUSED',
        currentOrderHash: undefined,
      });
    }
  }

  // SELL 深度分析: 计算卖出 NO 的平均成交价
  private calcSellDepthAnalysis(book: OrderBook, task: Task): DepthAnalysis {
    // SELL: 看 bids (买盘)，卖家需要吃买盘
    if (!book.bids.length) {
      return { bestPrice: 0, avgPrice: 0, availableQty: 0, isValid: false, estimatedProfit: 0 };
    }

    const bestBid = book.bids[0].price;
    let remainingQty = task.remainingQty;
    let totalCost = 0;
    let filledQty = 0;

    // 从高到低吃买盘
    for (const level of book.bids) {
      if (level.price < task.polymarketMinBid) break;  // 低于最小可接受价，停止
      const fillAtLevel = Math.min(remainingQty, level.size);
      totalCost += fillAtLevel * level.price;
      filledQty += fillAtLevel;
      remainingQty -= fillAtLevel;
      if (remainingQty <= 0) break;
    }

    const avgPrice = filledQty > 0 ? totalCost / filledQty : 0;

    // SELL 套利条件检查
    const threshold = task.entryCost
      ? task.entryCost + task.minProfitBuffer
      : 1.0 + task.minProfitBuffer;

    const isValid = task.predictPrice + avgPrice > threshold;
    const estimatedProfit = (task.predictPrice + avgPrice - (task.entryCost || 1.0)) * filledQty;

    return { bestPrice: bestBid, avgPrice, availableQty: filledQty, isValid, estimatedProfit };
  }

  // SELL 增量对冲: 卖出 NO (使用 bids)
  private async hedgeSellIncrement(
    taskId: string,
    deltaQty: number,
    predictAvgPrice: number
  ): Promise<void> {
    this.updateTask(taskId, { status: 'HEDGING' });

    let task = this.getTask(taskId);
    let remainingToHedge = deltaQty;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    // Phase 1: IOC + marketable limit 循环补单 (SELL 版)
    while (remainingToHedge > 0 && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      task = this.getTask(taskId);

      // SELL: 获取买盘 bids
      const book = await this.polyTrader.getOrderBook(task.polymarketNoTokenId);
      if (!book.bids.length) {
        consecutiveFailures++;
        await this.sleep(500);
        continue;
      }

      // SELL: 使用 bestBid，但必须 >= minBid
      const bestBid = book.bids[0].price;

      // SELL: 如果最优买价低于 minBid，无法以可接受价格成交
      if (bestBid < task.polymarketMinBid) {
        consecutiveFailures++;
        await this.sleep(500);
        continue;
      }

      // 归一化 bestBid (交易所价格已在 tick 边界，只修复浮点误差)
      const normalizedBid = this.normalizePrice(bestBid, task.tickSize);

      // task.polymarketMinBid 已在 validatePreConditions 中量化过
      // 取较大值作为下单价 (但实际上我们已经检查过 bestBid >= minBid)
      const marketablePrice = normalizedBid;

      try {
        const { orderId } = await this.polyTrader.placeLimitOrder({
          tokenId: task.polymarketNoTokenId,
          side: 'SELL',  // SELL NO (不是 BUY!)
          price: marketablePrice,
          quantity: remainingToHedge,
          timeInForce: 'IOC',
        });

        // IOC 订单状态轮询 (API 可能短暂延迟)
        const result = await this.pollOrderStatus(orderId);

        if (result.filledQty > 0) {
          task = this.getTask(taskId);
          this.updateTask(taskId, {
            hedgedQty: task.hedgedQty + result.filledQty,
            remainingQty: task.remainingQty - result.filledQty,
          });
          remainingToHedge -= result.filledQty;
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
        }

      } catch (e) {
        consecutiveFailures++;
      }

      if (remainingToHedge > 0) {
        await this.sleep(200);
      }
    }

    // Phase 2: 应急流程
    if (remainingToHedge > 0) {
      this.updateTask(taskId, {
        status: 'HEDGE_PENDING',
        hedgeRetryCount: task.hedgeRetryCount + 1,
      });
      await this.handleSellHedgeFailure(taskId, remainingToHedge);
    }
  }

  // SELL 对冲失败应急处理
  private async handleSellHedgeFailure(taskId: string, unhedgedQty: number): Promise<void> {
    // 等待买盘价格回升
    const waitResult = await this.waitForSellHedgeOpportunity(taskId, unhedgedQty, 5 * 60 * 1000);

    if (waitResult.success) {
      const task = this.getTask(taskId);
      await this.hedgeSellIncrement(taskId, unhedgedQty, task.predictPrice);
      return;
    }

    // 反向平仓 (SELL 版): 在 Predict 买回 YES
    this.updateTask(taskId, { status: 'UNWIND_PENDING' });

    try {
      const task = this.getTask(taskId);

      // SELL 反向平仓: 买回 YES，需要看 asks
      const book = await this.predictTrader.getOrderBook(task.marketId);
      const bestAsk = book.asks[0]?.price || 1;
      const unwindPrice = Math.min(0.99, bestAsk * (1 + UNWIND_SLIPPAGE));  // 稍高于卖一价

      // 在 Predict 上以 Taker 买入 YES (会产生手续费)
      const { hash } = await this.predictTrader.placeLimitOrder({
        marketId: task.marketId,
        side: 'BUY',  // 买回 YES
        price: unwindPrice,
        quantity: unhedgedQty,
      });

      const result = await this.waitForPredictFill(hash, 30000);

      this.updateTask(taskId, {
        status: result.filledQty >= unhedgedQty ? 'UNWIND_COMPLETED' : 'HEDGE_FAILED',
        unwindQty: task.unwindQty + result.filledQty,
        unwindLoss: task.unwindLoss + this.calcSellUnwindLoss(result, task.predictPrice),
      });
    } catch (e) {
      this.updateTask(taskId, {
        status: 'FAILED',
        error: 'Sell unwind failed',
        errorDetails: [...(this.getTask(taskId).errorDetails || []), String(e)],
      });
    }
  }

  // 计算 SELL 反向平仓损失
  private calcSellUnwindLoss(result: FillResult, originalSellPrice: number): number {
    // SELL 反向平仓是买回 YES，损失 = 买入价 - 原卖出价
    return (result.avgPrice - originalSellPrice) * result.filledQty;
  }

  // 等待 SELL 对冲机会 (监控 bids 回升)
  private async waitForSellHedgeOpportunity(
    taskId: string,
    qty: number,
    timeout: number
  ): Promise<{ success: boolean }> {
    const startTime = Date.now();
    const task = this.getTask(taskId);

    while (Date.now() - startTime < timeout) {
      const book = await this.polyTrader.getOrderBook(task.polymarketNoTokenId);
      if (book.bids.length && book.bids[0].price >= task.polymarketMinBid) {
        return { success: true };
      }
      await this.sleep(1000);
    }

    return { success: false };
  }

  // 等待 SELL 套利机会恢复
  private async waitForSellOpportunity(taskId: string): Promise<void> {
    const task = this.getTask(taskId);

    while (true) {
      const book = await this.polyTrader.getOrderBook(task.polymarketNoTokenId);
      const depth = this.calcSellDepthAnalysis(book, task);

      if (depth.isValid) {
        return;  // 机会恢复
      }

      if (this.getTask(taskId).status === 'CANCELLED') {
        return;  // 任务被取消
      }

      await this.sleep(1000);
    }
  }

  // ============================================================
  // 工具方法
  // ============================================================

  // IOC 订单状态轮询 (API 可能短暂延迟更新)
  private async pollOrderStatus(orderId: string): Promise<OrderStatus> {
    const MAX_RETRIES = 3;
    const POLL_INTERVAL = 150;  // ms

    for (let i = 0; i < MAX_RETRIES; i++) {
      const result = await this.polyTrader.getOrderStatus(orderId);

      // 如果状态已确定 (FILLED/CANCELLED)，直接返回
      if (result.status === 'FILLED' || result.status === 'CANCELLED') {
        return result;
      }

      // 如果有部分成交，可以返回
      if (result.filledQty > 0) {
        return result;
      }

      // 状态还未更新，等待后重试
      await this.sleep(POLL_INTERVAL);
    }

    // 最终返回最后一次查询结果
    return await this.polyTrader.getOrderStatus(orderId);
  }

  // ============================================================
  // 价格取整策略 (两种用途，不可混用)
  // ============================================================

  /**
   * 用途 1: 归一化 (Normalize) - 交易所返回的 tick 对齐价
   *
   * 适用: bestAsk, bestBid, 盘口 level 价格
   * 原因: 交易所价格本身已是 tick 整数倍，只是 JS 浮点显示成 0.4510000001
   * 方法: Math.round (就近取整)
   * 目的: 恢复真实值，避免 ceil/floor 因浮点误差跳到隔壁 tick
   */
  private normalizePrice(price: number, tickSize: number): number {
    const decimals = this.getDecimalPlaces(tickSize);
    const rounded = Math.round(price / tickSize) * tickSize;
    return Number(rounded.toFixed(decimals));
  }

  /**
   * 用途 2: 量化风控边界 (Quantize) - 用户定义/计算出的阈值
   *
   * 适用: polymarketMaxAsk, polymarketMinBid, 任何风控边界
   * 原因: 这些不是交易所返回的，可能不在 tick 边界
   * 方法: maxAsk 用 floor (更严格，永不超上限)
   *       minBid 用 ceil (更严格，永不低于下限)
   * 目的: 确保风控边界永不被突破
   */
  private quantizeMaxPrice(price: number, tickSize: number): number {
    const decimals = this.getDecimalPlaces(tickSize);
    // floor: 0.4567 → 0.456 (永不超过用户设定的上限)
    const floored = Math.floor(price / tickSize) * tickSize;
    return Number(floored.toFixed(decimals));
  }

  private quantizeMinPrice(price: number, tickSize: number): number {
    const decimals = this.getDecimalPlaces(tickSize);
    // ceil: 0.4523 → 0.453 (永不低于用户设定的下限)
    const ceiled = Math.ceil(price / tickSize) * tickSize;
    return Number(ceiled.toFixed(decimals));
  }

  // 获取小数位数 (用 log10 计算，比字符串解析更稳健)
  // tickSize = 0.01  → decimals = 2
  // tickSize = 0.001 → decimals = 3
  private getDecimalPlaces(tickSize: number): number {
    if (tickSize >= 1) return 0;
    // -log10(0.001) = 3, -log10(0.01) = 2
    const places = -Math.floor(Math.log10(tickSize) + 1e-9);
    return Math.max(0, Math.min(places, 6));  // 限制在 0-6 位，防止异常值
  }

  // 前置校验 (区分 BUY / SELL)
  private async validatePreConditions(task: Task): Promise<void> {
    this.updateTask(task.id, { status: 'VALIDATING' });

    if (task.type === 'BUY') {
      // BUY: 检查双边现金余额
      const predictBalance = await this.predictTrader.getBalance();
      const polyBalance = await this.polyTrader.getBalance();
      const requiredPredict = task.predictPrice * task.quantity;
      const requiredPoly = task.polymarketMaxAsk * task.quantity;  // 使用正确字段名

      if (predictBalance < requiredPredict) {
        throw new Error(`Predict USDT insufficient: ${predictBalance} < ${requiredPredict}`);
      }
      if (polyBalance < requiredPoly) {
        throw new Error(`Polymarket USDC insufficient: ${polyBalance} < ${requiredPoly}`);
      }
    } else {
      // SELL: 检查双边 token 持仓
      const predictPositions = await this.predictTrader.getPositions();
      const polyPositions = await this.polyTrader.getPositions();

      const predictYesQty = predictPositions
        .find(p => p.marketId === task.marketId && p.side === 'YES')?.qty || 0;
      const polyNoQty = polyPositions
        .find(p => p.tokenId === task.polymarketNoTokenId)?.qty || 0;

      if (predictYesQty < task.quantity) {
        throw new Error(`Predict YES position insufficient: ${predictYesQty} < ${task.quantity}`);
      }
      if (polyNoQty < task.quantity) {
        throw new Error(`Polymarket NO position insufficient: ${polyNoQty} < ${task.quantity}`);
      }
    }

    // 2. Market 状态检查
    const market = await this.predictTrader.getMarket(task.marketId);
    if (market.status !== 'active') {
      throw new Error(`Market not active: ${market.status}`);
    }

    // 3. Token ID 验证 (确认映射关系)
    const polyMarket = await this.polyTrader.getMarket(task.polymarketConditionId);
    if (!polyMarket) {
      throw new Error(`Polymarket market not found: ${task.polymarketConditionId}`);
    }

    // 4. 从 API 获取最新 tickSize 并写回 task (不依赖前端传参)
    if (polyMarket.tickSize && polyMarket.tickSize !== task.tickSize) {
      this.updateTask(task.id, { tickSize: polyMarket.tickSize });
      task = this.getTask(task.id);  // 刷新本地引用
    }

    // 5. 量化风控边界到 tick (确保边界不被突破)
    // maxAsk 用 floor (更严格，永不超上限)
    // minBid 用 ceil (更严格，永不低于下限)
    const quantizedMaxAsk = this.quantizeMaxPrice(task.polymarketMaxAsk, task.tickSize);
    const quantizedMinBid = this.quantizeMinPrice(task.polymarketMinBid, task.tickSize);

    if (quantizedMaxAsk !== task.polymarketMaxAsk || quantizedMinBid !== task.polymarketMinBid) {
      this.updateTask(task.id, {
        polymarketMaxAsk: quantizedMaxAsk,
        polymarketMinBid: quantizedMinBid,
      });
      task = this.getTask(task.id);
    }

    // 6. 最小单位检查 (Predict)
    if (task.quantity < market.minOrderSize) {
      throw new Error(`Quantity below minimum: ${task.quantity} < ${market.minOrderSize}`);
    }

    // 7. 最小订单金额检查 (Polymarket)
    if (polyMarket.minOrderSize && task.quantity < polyMarket.minOrderSize) {
      throw new Error(`Polymarket quantity below minimum: ${task.quantity} < ${polyMarket.minOrderSize}`);
    }
  }

  // 并发锁
  private acquireLock(marketId: number, taskId: string): boolean {
    if (this.marketLocks.has(marketId)) {
      return false;
    }
    this.marketLocks.set(marketId, taskId);
    return true;
  }

  private releaseLock(marketId: number): void {
    this.marketLocks.delete(marketId);
  }
}
```

### 2.5 任务服务 (`task-service.ts`)

```typescript
class TaskService {
  private tasks: Map<string, Task>;
  private persistPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  // CRUD
  createTask(input: CreateTaskInput): Task {
    // 生成幂等 ID
    const id = this.generateIdempotentId(input);

    // 检查重复
    if (this.tasks.has(id)) {
      throw new Error(`Task ${id} already exists`);
    }

    const task: Task = {
      id,
      ...input,
      status: 'PENDING',
      predictFilledQty: 0,
      hedgedQty: 0,
      remainingQty: input.quantity,
      pauseCount: 0,
      hedgeRetryCount: 0,
      unwindQty: 0,
      actualProfit: 0,
      unwindLoss: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.tasks.set(id, task);
    this.persistAsync();
    return task;
  }

  updateTask(id: string, update: Partial<Task>): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);

    const updated = { ...task, ...update, updatedAt: Date.now() };
    this.tasks.set(id, updated);
    this.persistAsync();
    return updated;
  }

  // 原子写入 (防止进程崩溃导致数据损坏)
  private async persistAsync(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const tempPath = this.persistPath + '.tmp';
      const data = JSON.stringify(Array.from(this.tasks.entries()), null, 2);

      await fs.writeFile(tempPath, data, 'utf-8');
      await fs.rename(tempPath, this.persistPath);  // 原子操作
    });
  }

  // 恢复未完成任务
  async recoverTasks(executor: TaskExecutor): Promise<void> {
    for (const [id, task] of this.tasks) {
      if (this.isRecoverable(task.status)) {
        // 重建监听，继续执行
        await executor.resumeTask(task);
      }
    }
  }

  private isRecoverable(status: TaskStatus): boolean {
    return [
      'PREDICT_SUBMITTED',
      'PARTIALLY_FILLED',
      'HEDGING',
      'HEDGE_PENDING',
    ].includes(status);
  }

  // 幂等 ID 生成
  // 方案1: 前端传入 idempotencyKey
  // 方案2: 基于参数 + 时间窗口生成 (防止短时间重复提交)
  private generateIdempotentId(input: CreateTaskInput): string {
    // 如果前端传入了 idempotencyKey，直接使用
    if (input.idempotencyKey) {
      return input.idempotencyKey;
    }

    // 否则基于参数 + 10秒时间窗口生成
    const timeWindow = Math.floor(Date.now() / 10000);  // 10秒窗口
    const hash = crypto.createHash('sha256');
    hash.update(`${input.marketId}-${input.type}-${input.predictPrice}-${input.quantity}-${timeWindow}`);
    return hash.digest('hex').substring(0, 16);
  }
}

interface CreateTaskInput {
  type: TaskType;
  marketId: number;
  title: string;
  polymarketConditionId: string;
  polymarketNoTokenId: string;
  polymarketYesTokenId: string;
  isInverted: boolean;
  tickSize: number;              // Polymarket 动态 tick size
  predictPrice: number;

  // 对冲价格限制 (根据 type 使用不同字段)
  polymarketMaxAsk: number;      // BUY: 对冲买入 NO 的最大可接受卖价
  polymarketMinBid: number;      // SELL: 对冲卖出 NO 的最小可接受买价

  quantity: number;
  minProfitBuffer: number;
  orderTimeout: number;
  maxHedgeRetries: number;

  // 成本基准 (SELL 任务可选)
  entryCost?: number;            // 原始建仓成本

  idempotencyKey?: string;       // 可选，前端传入
}
```

---

## 前端 UI 更新

### 任务配置模态框 (完善版)

```jsx
const TaskModal = ({ opp, type, onSubmit, onClose }) => {
  const [config, setConfig] = useState({
    predictPrice: type === 'BUY' ? opp.predictBid : opp.predictAsk,
    quantity: opp.maxQuantity,
    // BUY: 最大买入价 (asks)，SELL: 最小卖出价 (bids)
    polymarketMaxAsk: opp.polymarketAsk + 0.02,   // BUY 用: 2% buffer
    polymarketMinBid: opp.polymarketBid - 0.02,   // SELL 用: 2% buffer
    minProfitBuffer: 0.005,  // 0.5%
    orderTimeout: 60000,     // 1 min
    maxHedgeRetries: 3,
    entryCost: opp.entryCost,  // SELL 用: 原始建仓成本 (可选)
  });

  const estProfit = useMemo(() => {
    if (type === 'BUY') {
      // BUY: 1 - predictBuyPrice - polyBuyNoPrice
      return (1 - config.predictPrice - config.polymarketMaxAsk) * config.quantity;
    } else {
      // SELL: predictSellPrice + polySellNoPrice - cost
      const cost = config.entryCost || 1.0;
      return (config.predictPrice + config.polymarketMinBid - cost) * config.quantity;
    }
  }, [config, type]);

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h3>{type === 'BUY' ? 'Buy Task' : 'Sell Task'}</h3>

        {/* 价格配置 */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label>Predict Price</label>
            <input type="number" step="0.001"
                   value={config.predictPrice}
                   onChange={e => setConfig({...config, predictPrice: +e.target.value})} />
          </div>
          <div>
            <label>{type === 'BUY' ? 'Max Poly Ask' : 'Min Poly Bid'}</label>
            <input type="number" step="0.001"
                   value={type === 'BUY' ? config.polymarketMaxAsk : config.polymarketMinBid}
                   onChange={e => setConfig({
                     ...config,
                     [type === 'BUY' ? 'polymarketMaxAsk' : 'polymarketMinBid']: +e.target.value
                   })} />
          </div>
        </div>

        {/* 数量 */}
        <div>
          <label>Quantity</label>
          <input type="number" value={config.quantity}
                 max={opp.maxQuantity}
                 onChange={e => setConfig({...config, quantity: +e.target.value})} />
        </div>

        {/* SELL 专用: 成本基准 */}
        {type === 'SELL' && (
          <div>
            <label>Entry Cost (optional)</label>
            <input type="number" step="0.001"
                   value={config.entryCost || ''}
                   placeholder="1.0 if not set"
                   onChange={e => setConfig({...config, entryCost: +e.target.value || undefined})} />
          </div>
        )}

        {/* 高级配置 (可折叠) */}
        <details>
          <summary>Advanced Settings</summary>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div>
              <label>Min Profit Buffer</label>
              <input type="number" step="0.001" value={config.minProfitBuffer}
                     onChange={e => setConfig({...config, minProfitBuffer: +e.target.value})} />
            </div>
            <div>
              <label>Order Timeout (ms)</label>
              <input type="number" value={config.orderTimeout}
                     onChange={e => setConfig({...config, orderTimeout: +e.target.value})} />
            </div>
            <div>
              <label>Max Hedge Retries</label>
              <input type="number" value={config.maxHedgeRetries}
                     onChange={e => setConfig({...config, maxHedgeRetries: +e.target.value})} />
            </div>
          </div>
        </details>

        {/* 预估收益 */}
        <div className="mt-4 p-3 bg-gray-800 rounded">
          <div className="flex justify-between">
            <span>Est. Profit (best case)</span>
            <span className={estProfit > 0 ? 'text-emerald-400' : 'text-rose-400'}>
              ${estProfit.toFixed(2)}
            </span>
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 bg-gray-600">Cancel</button>
          <button onClick={() => onSubmit(config)} className="flex-1 bg-emerald-500">
            Create Task
          </button>
        </div>
      </div>
    </div>
  );
};
```

---

## 风险和注意事项

1. **资金安全**：先用小金额 (如 $1) 测试完整流程
2. **增量对冲**：每次 Predict 部分成交立即对冲，不等待全部成交
3. **价格上限**：
   - BUY: `polymarketMaxAsk` 必须设置合理，防止亏损对冲
   - SELL: `polymarketMinBid` 必须设置合理，防止贱卖
4. **反向平仓**：
   - BUY 反向: 卖出 Predict YES，承受滑点
   - SELL 反向: 买回 Predict YES，承受滑点和手续费
5. **并发锁**：同一 market 只能有一个活跃任务
6. **幂等性**：重复创建相同任务会被拒绝
7. **崩溃恢复**：进程重启后自动恢复未完成任务
8. **原子写入**：使用 rename 保证持久化原子性
9. **价格取整**：两种策略不可混用
   - `normalizePrice()`: 修复交易所价格的浮点误差 (round)
   - `quantizeMaxPrice/MinPrice()`: 量化风控边界 (floor/ceil，更严格)
10. **IOC 延迟**：API 可能短暂延迟返回成交状态，需轮询确认

---

## 预估代码量

| 模块 | 预估行数 |
|------|---------|
| types.ts 扩展 | ~200 |
| task-service.ts | ~350 |
| predict-trader.ts | ~350 |
| polymarket-trader.ts | ~450 |
| order-monitor.ts | ~400 |
| task-executor.ts | ~800 |
| start-dashboard.ts 修改 | ~250 |
| preview.html 修改 | ~700 |
| **总计** | **~3,500** |

---

## V2.1 修订记录

1. **状态定义一致性**: 添加 `TIMEOUT_CANCELLED`, `HEDGE_FAILED` 到 TaskStatus
2. **避免陈旧引用**: 所有操作通过 `getTask(taskId)` 获取最新快照
3. **串行化对冲**: `serializedHedge()` 使用 Promise 队列防止并发回调问题
4. **Promise.race 完整性**: 添加 `cancelSignal` Promise，价格守护触发后唤醒主流程
5. **IOC 订单**: 对冲使用 `timeInForce: 'IOC'` 防止挂单堆积
6. **tick size 动态获取**: 从 `PolyMarketInfo.tickSize` 获取 (非硬编码)
7. **反向平仓定价**: 获取 `bestBid * (1 - UNWIND_SLIPPAGE)` 而非 `price: 0`
8. **Sell 腿位明确**: Polymarket 侧是卖出 NO (不是买入)
9. **幂等 ID 修复**: 支持前端传入 `idempotencyKey`，或基于参数+时间窗口生成
10. **前置校验区分**: BUY 检查余额，SELL 检查持仓
11. **对冲策略优化**: IOC + marketable limit → 循环补单 → 连续失败才进应急流程

---

## V2.2 修订记录

1. **SELL 完整实现**: 添加 `executeSellTask`, `executeSellLoop`, `hedgeSellIncrement` 对称实现
2. **价格字段分离**: `polymarketMaxPrice` 拆分为 `polymarketMaxAsk` (BUY) 和 `polymarketMinBid` (SELL)
3. **SELL 对冲方向**: SELL 看 bids (买盘)，用 bestBid，检查 `>= minBid`
4. **SELL 套利条件**: 支持两种口径:
   - 有 entryCost: `predictSellPrice + polyNoBid > entryCost + buffer`
   - 无 entryCost: `predictSellPrice + polyNoBid > 1.0 + buffer`
5. **成本基准字段**: Task 添加 `entryCost` 字段用于精确盈亏计算
6. **价格取整策略** (两种用途，不可混用):
   - **归一化 (normalizePrice)**: 用于交易所返回的 bestAsk/bestBid
     - 方法: `Math.round` (就近取整)
     - 目的: 修复浮点表示误差 (0.4510000001 → 0.451)
   - **量化风控边界 (quantizeMaxPrice/quantizeMinPrice)**: 用于用户设定的 maxAsk/minBid
     - maxAsk 用 `floor` (更严格，永不超上限)
     - minBid 用 `ceil` (更严格，永不低于下限)
     - 在 `validatePreConditions()` 中执行量化并写回 task
   - `getDecimalPlaces()` 用 `log10` 计算 (支持 tickSize=0.001)
7. **IOC 状态轮询**: `pollOrderStatus()` 最多重试 3 次 (间隔 150ms) 获取成交结果
8. **SELL 反向平仓**: 买回 YES (看 asks)，用 `bestAsk * (1 + UNWIND_SLIPPAGE)`
9. **价格守护扩展**: MonitorConfig 添加 `side` 参数区分 BUY/SELL 监控逻辑
10. **深度分析分离**: `calcSellDepthAnalysis()` 独立实现，遍历 bids 计算卖出均价
11. **tickSize 动态获取**: `validatePreConditions()` 中从 API 获取最新 tickSize 并写回 task
