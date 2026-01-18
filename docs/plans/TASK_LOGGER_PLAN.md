# 任务交易日志系统实现计划

## 目标
为任务模块添加详细日志，监控每笔交易及订单簿情况，方便复盘和bug修复。

## 用户需求
- **存储格式**: JSONL 实时追加 + SQLite 分析查询
- **快照时机**: 全部关键节点（任务创建、订单提交/成交、价格守护触发）
- **保留策略**: 按任务分组，每个任务独立日志文件

---

## 目录结构

```
bot/data/logs/
├── tasks/
│   └── {taskId}/
│       ├── events.jsonl       # 事件日志
│       ├── orderbooks.jsonl   # 订单簿快照
│       └── summary.json       # 任务完成后汇总
├── index.db                   # SQLite 分析数据库
└── archive/                   # 归档目录
```

---

## 新建文件

| 文件 | 用途 | 预估行数 |
|-----|------|---------|
| `bot/src/dashboard/task-logger/types.ts` | 日志类型定义 | ~150 |
| `bot/src/dashboard/task-logger/task-logger.ts` | 核心日志服务 | ~300 |
| `bot/src/dashboard/task-logger/index.ts` | 模块导出 | ~10 |
| `bot/src/terminal/import-logs-to-sqlite.ts` | JSONL→SQLite 导入 | ~200 |
| `bot/src/terminal/query-task-logs.ts` | 复盘查询工具 | ~150 |

---

## 修改文件

### 1. `bot/src/dashboard/task-executor.ts` (~30处插入)

关键插入点：
- 任务启动时 → `TASK_STARTED` + 订单簿快照
- Predict 订单提交后 → `ORDER_SUBMITTED`
- 价格守护触发 → `PRICE_GUARD_TRIGGERED` + 快照
- 部分成交时 → `ORDER_PARTIAL_FILL`
- 任务完成时 → `TASK_COMPLETED` + 生成汇总
- 对冲执行时 → `HEDGE_STARTED/COMPLETED/FAILED` + 快照
- UNWIND 执行时 → `UNWIND_*` 事件

### 2. `bot/src/dashboard/task-service.ts` (少量)

- `createTask()`: 初始化日志目录 + 记录 `TASK_CREATED`

---

## 日志事件类型

```typescript
// 任务生命周期
type TaskLifecycleEventType =
    | 'TASK_CREATED'      // 任务创建
    | 'TASK_STARTED'      // 任务启动
    | 'TASK_PAUSED'       // 价格守护暂停
    | 'TASK_RESUMED'      // 价格恢复继续
    | 'TASK_COMPLETED'    // 任务完成
    | 'TASK_FAILED'       // 任务失败
    | 'TASK_CANCELLED';   // 任务取消

// 订单事件
type OrderEventType =
    | 'ORDER_SUBMITTED'    // 订单提交
    | 'ORDER_PARTIAL_FILL' // 部分成交
    | 'ORDER_FILLED'       // 完全成交
    | 'ORDER_CANCELLED'    // 订单取消
    | 'ORDER_EXPIRED'      // 订单过期
    | 'ORDER_FAILED';      // 订单失败

// 价格守护事件
type PriceGuardEventType =
    | 'PRICE_GUARD_TRIGGERED'  // 价格超阈值触发
    | 'PRICE_GUARD_RESUMED';   // 价格恢复

// 对冲事件
type HedgeEventType =
    | 'HEDGE_STARTED'     // 开始对冲
    | 'HEDGE_ATTEMPT'     // 对冲尝试
    | 'HEDGE_PARTIAL'     // 部分对冲
    | 'HEDGE_COMPLETED'   // 对冲完成
    | 'HEDGE_FAILED';     // 对冲失败

// UNWIND 事件
type UnwindEventType =
    | 'UNWIND_STARTED'    // 开始反向平仓
    | 'UNWIND_ATTEMPT'    // 平仓尝试
    | 'UNWIND_PARTIAL'    // 部分平仓
    | 'UNWIND_COMPLETED'  // 平仓完成
    | 'UNWIND_FAILED';    // 平仓失败
```

---

## 订单簿快照结构 (精简前5档)

```typescript
interface OrderBookSnapshot {
    timestamp: number;          // Unix 毫秒
    taskId: string;
    sequence: number;           // 快照序号
    trigger: 'task_created' | 'order_submit' | 'order_fill' | 'price_guard' | 'hedge_start';

    predict: {
        bids: [number, number][];   // 前5档 [价格, 数量]
        asks: [number, number][];
        bestBid: number | null;
        bestAsk: number | null;
        spread: number | null;
        latencyMs: number;          // API 延迟
    } | null;

    polymarket: {
        bids: [number, number][];   // NO 方向
        asks: [number, number][];
        bestBid: number | null;
        bestAsk: number | null;
        spread: number | null;
        latencyMs: number;
    } | null;

    arbMetrics: {
        totalCost: number;          // 总成本 = predictPrice + polyPrice + fees
        profitPercent: number;      // 利润百分比
        isValid: boolean;           // 套利是否有效
        maxDepth: number;           // 可执行的最大深度
    };
}
```

---

## 事件日志结构示例

### events.jsonl 示例
```json
{"timestamp":1704067200000,"taskId":"abc123","sequence":1,"type":"TASK_CREATED","payload":{"status":"PENDING","taskConfig":{"type":"BUY","marketId":289,"predictPrice":0.55,"quantity":100}}}
{"timestamp":1704067201000,"taskId":"abc123","sequence":2,"type":"TASK_STARTED","payload":{"status":"PREDICT_SUBMITTED"}}
{"timestamp":1704067202000,"taskId":"abc123","sequence":3,"type":"ORDER_SUBMITTED","payload":{"platform":"predict","orderId":"0x123...","side":"BUY","price":0.55,"quantity":100,"filledQty":0}}
{"timestamp":1704067210000,"taskId":"abc123","sequence":4,"type":"ORDER_PARTIAL_FILL","payload":{"platform":"predict","orderId":"0x123...","filledQty":50,"avgPrice":0.55}}
{"timestamp":1704067215000,"taskId":"abc123","sequence":5,"type":"HEDGE_STARTED","payload":{"hedgeQty":50,"totalHedged":0,"orderbookSnapshotSeq":2}}
{"timestamp":1704067216000,"taskId":"abc123","sequence":6,"type":"HEDGE_COMPLETED","payload":{"hedgeQty":50,"totalHedged":50,"avgHedgePrice":0.44}}
```

---

## SQLite 表结构

```sql
-- 任务主表
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                    -- BUY | SELL
    market_id INTEGER NOT NULL,
    title TEXT,
    status TEXT NOT NULL,

    -- 配置
    predict_price REAL NOT NULL,
    polymarket_max_ask REAL,
    polymarket_min_bid REAL,
    quantity REAL NOT NULL,

    -- 结果
    predict_filled_qty REAL DEFAULT 0,
    hedged_qty REAL DEFAULT 0,
    avg_predict_price REAL,
    avg_polymarket_price REAL,
    actual_profit REAL,
    unwind_loss REAL,

    -- 风控
    pause_count INTEGER DEFAULT 0,
    hedge_retry_count INTEGER DEFAULT 0,

    -- 时间
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration_ms INTEGER,

    -- 计算字段
    profit_percent REAL,
    is_success INTEGER                     -- 1=成功, 0=失败
);

-- 事件表
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT,                          -- JSON 格式
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 订单簿快照表
CREATE TABLE orderbook_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    trigger TEXT NOT NULL,

    -- Predict 数据
    predict_best_bid REAL,
    predict_best_ask REAL,
    predict_spread REAL,
    predict_latency_ms INTEGER,
    predict_depth_json TEXT,               -- 前5档 JSON

    -- Polymarket 数据
    poly_best_bid REAL,
    poly_best_ask REAL,
    poly_spread REAL,
    poly_latency_ms INTEGER,
    poly_depth_json TEXT,

    -- 套利指标
    total_cost REAL,
    profit_percent REAL,
    is_arb_valid INTEGER,
    max_depth REAL,

    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 订单表
CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    platform TEXT NOT NULL,                -- predict | polymarket
    order_id TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    filled_qty REAL DEFAULT 0,
    avg_price REAL,
    status TEXT,
    submitted_at INTEGER,
    filled_at INTEGER,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 索引
CREATE INDEX idx_events_task ON events(task_id);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_snapshots_task ON orderbook_snapshots(task_id);
CREATE INDEX idx_orders_task ON orders(task_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created ON tasks(created_at);
```

---

## 工具命令

```bash
# 导入单个任务日志到 SQLite
npx tsx src/terminal/import-logs-to-sqlite.ts --task=abc123

# 导入所有任务日志
npx tsx src/terminal/import-logs-to-sqlite.ts --all

# 查看任务时间线
npx tsx src/terminal/query-task-logs.ts timeline <taskId>

# 统计报表 (最近7天)
npx tsx src/terminal/query-task-logs.ts stats --days=7

# 失败任务分析
npx tsx src/terminal/query-task-logs.ts failures --days=7

# 查看特定快照的订单簿
npx tsx src/terminal/query-task-logs.ts orderbook <taskId> <sequence>
```

---

## 实施步骤

### Phase 1: 基础设施
1. 创建 `task-logger/types.ts` - 定义所有类型
2. 创建 `task-logger/task-logger.ts` - 核心日志服务
3. 创建 `task-logger/index.ts` - 模块导出

### Phase 2: 集成到执行器
4. 修改 `task-executor.ts` - 在所有关键节点插入日志
5. 修改 `task-service.ts` - 在任务创建时初始化日志

### Phase 3: 分析工具
6. 创建 `import-logs-to-sqlite.ts` - JSONL→SQLite 导入
7. 创建 `query-task-logs.ts` - 复盘查询工具

### Phase 4: 测试验证
8. 创建测试任务验证日志完整性
9. 验证 SQLite 导入和查询

---

## 参考现有实现

可复用 `bot/src/market-maker/logger.ts` 的设计模式：
- 日志分级 (DEBUG/INFO/WARN/ERROR)
- 文件流管理 (追加写入)
- 单例模式

---

## 待确认问题

1. **日志保留时间**: 需要自动清理超过 7 天的日志（含 JSONL 与 SQLite）。
2. **实时查看**: 需要在 Dashboard 中增加日志查看界面。
3. **告警集成**: 需要添加通知，任务启动也需要推送，并覆盖关键节点。
4. **性能影响**: 日志写入是否需要异步队列避免阻塞主流程？

---

## 通知范围（确认）

- **任务启动**：TASK_STARTED
- **关键节点**：ORDER_SUBMITTED / ORDER_PARTIAL_FILL / ORDER_FILLED / PRICE_GUARD_TRIGGERED / HEDGE_STARTED / HEDGE_COMPLETED / HEDGE_FAILED / UNWIND_STARTED / UNWIND_COMPLETED / UNWIND_FAILED / TASK_FAILED / TASK_COMPLETED / TASK_CANCELLED

---

## 计划缺项补充（建议新增）

1. **日志版本与配置快照**
   - 每个任务记录 `logSchemaVersion`、代码版本/commit、任务配置快照（tickSize/feeRateBps/isInverted/tokenIds/风险参数）。
2. **事件关联字段**
   - 增加 `runId / executorId / attemptId / orderId / hash`，便于跨重试/对冲阶段串联事件。
3. **异常结构化**
   - 错误字段记录 `errorType + message + stack + httpStatus + responseBody`，避免只记录 message。
4. **日志保留与归档**
   - 归档策略：按任务/按天归档，超过 N 天压缩或清理。
5. **写入一致性/幂等**
   - SQLite 导入去重键（`task_id + sequence`），避免重复导入。
6. **快照频率控制**
   - orderbook snapshot 支持降频/开关，避免高频写入拖慢主流程。
7. **安全脱敏**
   - 日志中敏感字段（API key、地址）可配置脱敏。
8. **崩溃恢复**
   - 退出时强制 flush，JSONL 半行容错处理。

---

## Q4 建议：采用异步队列（推荐）

建议：**需要异步队列**。原因是事件/快照频率高，JSONL 追加 + SQLite 写入容易阻塞事件循环。

最小实现建议：
- **内存队列 + 批量 flush**（例如 100 条或 500ms flush）
- **队列上限**，超过后丢弃低优先级快照，但保留关键事件
- **退出前 flush**，确保关键日志落盘

伪流程：
1. `log(event)` 将事件推入队列（标记优先级：CRITICAL/INFO/SNAPSHOT）
2. 定时器或阈值触发批量写入 JSONL
3. SQLite 导入可做异步批量插入（或离线导入脚本）
4. 队列满时仅丢弃 SNAPSHOT，保留 TASK/ORDER/HEDGE/UNWIND 事件
