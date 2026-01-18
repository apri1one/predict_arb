# DASHBOARD 订单簿 WS 方案

## 目标
- 使用 WS 订阅替换 dashboard 中 Predict 订单簿的 REST 轮询。
- 订阅全部 marketPairs + 体育匹配市场。
- 全模块统一使用单一 Predict 订单簿缓存。
- 不做影子模式，切换直接生效。

## 非目标
- 不改 Polymarket 订单簿处理方式（仍是 WS 优先）。
- 不改 UI。
- 除数据源切换与新鲜度规则外，不改交易逻辑。

## 前置条件
- `polymarket-match-result.json` 已生成并加载到 `marketPairs`。
- 体育匹配已启用并产出 Predict 市场 ID。
- Predict WS 稳定可用。

## 备份（必须）
- 修改前创建完整项目副本。
- Windows 建议命令（排除大目录）：
```bash
robocopy E:\predict-tradingbot E:\predict-tradingbot_backup /MIR /XD node_modules bot\node_modules sdk\node_modules front\node_modules .git
```

## 架构变更
### 现状
- `start-dashboard.ts` 通过 REST 扫描 Predict 订单簿并写入本地 Map 缓存。
- `arb-service.ts` 通过 REST 拉取 Predict 订单簿。
- `sports-service.ts` 通过 REST 刷新 Predict 订单簿。
- `predict-trader.ts` 与 `close-service.ts` 在缓存 miss 时回退 REST。

### 改造后（WS 模式）
- `PredictOrderbookCache` 作为唯一数据源。
- `start-dashboard.ts` 使用统一缓存读取 + WS 订阅。
- `arb-service.ts`、`sports-service.ts`、`predict-trader.ts`、`close-service.ts` 只读统一缓存。
- WS 模式下禁用 Predict 订单簿 REST 调用。

## 参考：Polymarket 架构（对齐目标）
### WS 订单簿缓存
- `bot/src/polymarket/ws-client.ts`
  - 内存 orderBooks 缓存。
  - `addOrderBookListener` 多订阅者模式。
  - `getOrderBook` 直接返回缓存。
  - REST 仅作为上层兜底。

### 用户 WS（订单/成交事件）
- `bot/src/polymarket/user-ws-client.ts`
  - 独立用户通道，用于订单状态与成交事件。
  - 本地事件缓存，避免竞态。

### 统一入口
- `bot/src/polymarket/index.ts`
  - `getOrderBook`：WS 优先、REST 兜底。
  - 订阅市场 -> tokenId 映射。

## 前端订单簿流向（保持 SSE）
- 前端仅使用 SSE（`front/index.tsx`、`front/preview/sse.js`）。
- 体育订单簿展示来自后端 `SportsMatchedMarket.orderbook`
  （`bot/src/dashboard/sports-service.ts`、`bot/src/dashboard/sports-types.ts`）。
- 前端不直连 WS，保持 SSE 交付不变。

## 统一 SSE 广播（WS 驱动 + 50ms 节流）
- 目标：所有面板（live/opportunities、sports、close、accounts）都走统一的 WS 驱动广播管线，50ms 节流。
- 方法：
  - 单一广播调度器（50ms 节流）。
  - 数据产出方只标记 dirty，不直接广播。
  - 调度器批量 flush，避免乱序。
  - 保留低频全量同步（如 2s）作为兜底。

### 需要对齐的数据源
- Live opportunities：已由 Polymarket 订单簿 WS 驱动。
- Sports：Predict 订单簿迁到统一 WS 缓存，周期刷新改为 WS 触发重算 + 低频兜底。
- Close：根据 WS 订单簿变化触发重算 + 低频兜底。
- Accounts：继续低频拉取（5s），但通过统一调度器广播。

## 配置项
- `DASHBOARD_PREDICT_ORDERBOOK_MODE=ws|legacy`
  - `ws`：仅用统一 WS 缓存。
  - `legacy`：保持现有 REST 轮询逻辑。
- `PREDICT_ORDERBOOK_SOURCE=ws`
  - WS 模式下禁用统一缓存中的 REST。
- `PREDICT_ORDERBOOK_CACHE_TTL_MS`（已存在，可调）。
- `PREDICT_ALLOW_STALE_ORDERBOOK_CACHE=false`（建议风险控制）。
- 新增：`PREDICT_ORDERBOOK_STALE_MS`（成本保护用，过期即无效）。

## 实施计划（无影子模式）
### 阶段 0 - 备份
1) 按上文创建备份目录。
2) 确认备份包含 `bot/`、`front/`、`sdk/`、`docs/`。

### 阶段 1 - 接入统一缓存
1) 在 `bot/src/dashboard/start-dashboard.ts` 解析 `DASHBOARD_PREDICT_ORDERBOOK_MODE`。
2) WS 模式下初始化 `PredictOrderbookCache`。
3) 订阅列表：
   - 所有 `marketPairs` 的 Predict ID。
   - 所有体育匹配的 Predict ID（必要时在 `SportsService` 增加 getter）。
4) 列表准备完成后一次性 `subscribeMarkets()`。
5) 用统一缓存替代本地 `predictOrderbookCache` Map。
6) WS 模式下完全跳过 `fetchPredictOrderbook()` 的 REST 扫描。

### 阶段 2 - 模块对齐
1) `bot/src/dashboard/arb-service.ts`
   - 用统一缓存替代 REST `getPredictOrderbook()`。
2) `bot/src/dashboard/sports-service.ts`
   - WS 模式下移除 `refreshPredictOrderbooks()` 的 REST 刷新。
   - 重建市场时只读统一缓存。
3) `bot/src/dashboard/predict-trader.ts`
   - 仅用 provider，WS 模式下跳过 REST fallback。
4) `bot/src/dashboard/close-service.ts`
   - 仅用 provider，WS 模式下跳过 REST fallback。
5) `bot/src/dashboard/start-dashboard.ts`
   - 保持 SSE payload 格式不变，仅替换数据源。

### 阶段 3 - 风控更新
1) `bot/src/dashboard/taker-mode/executor.ts`
   - `getCurrentCost` 改为读统一缓存。
   - 使用 `PREDICT_ORDERBOOK_STALE_MS` 拒绝过期/缺失数据。
2) Polymarket 成本保护保持 WS 优先 + REST 兜底（不改）。

### 阶段 4 - 可观测性
1) 输出统一缓存统计：
   - subscriptions、wsUpdates、lastUpdateTime、cacheSize。
2) 定期输出 WS 健康日志。

### 阶段 5 - 统一 SSE 广播
1) 在 `bot/src/dashboard/start-dashboard.ts` 增加 50ms 节流广播调度器。
2) 将直接 `broadcastSSEGlobal()` 改为 `markDirty()` + 统一 flush。
3) 保留 2s 低频全量同步兜底。
4) sports/close/accounts 都走统一调度器。

### 调度器详细规格
- 通道：`opportunity`、`stats`、`markets`、`tasks`、`sports`、`closeOpportunities`、`accounts`。
- 状态：
  - `dirtyFlags: Set<Channel>`
  - `pendingPayloads: Map<Channel, string>`
  - `flushTimer: ReturnType<typeof setTimeout> | null`
- API：
  - `markDirty(channel, payload)`：
    - `pendingPayloads.set(channel, payload)`
    - `dirtyFlags.add(channel)`
    - 若未运行，启动 `flushTimer`
  - `flush()`：
    - 遍历 `dirtyFlags` 调用 `broadcastSSEGlobal(channel, payload)`
    - 清空 `dirtyFlags`
    - `flushTimer = null`
- 节流：
  - `BROADCAST_THROTTLE_MS = 50`

### 伪函数代码（放置位置：start-dashboard.ts）
```ts
type BroadcastChannel =
    | 'opportunity'
    | 'stats'
    | 'markets'
    | 'tasks'
    | 'sports'
    | 'closeOpportunities'
    | 'accounts';

const BROADCAST_THROTTLE_MS = 50;
const SPORTS_RECOMPUTE_THROTTLE_MS = 200;
const CLOSE_RECOMPUTE_THROTTLE_MS = 200;

const dirtyFlags = new Set<BroadcastChannel>();
const pendingPayloads = new Map<BroadcastChannel, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function markDirty(channel: BroadcastChannel, payload: string): void {
    pendingPayloads.set(channel, payload);
    dirtyFlags.add(channel);
    scheduleFlush();
}

function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushBroadcast();
    }, BROADCAST_THROTTLE_MS);
}

function flushBroadcast(): void {
    for (const channel of dirtyFlags) {
        const payload = pendingPayloads.get(channel);
        if (payload !== undefined) {
            broadcastSSEGlobal(channel, payload);
        }
    }
    dirtyFlags.clear();
}

// 节流重算工具
let sportsTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSportsRecompute(): void {
    if (sportsTimer) return;
    sportsTimer = setTimeout(() => {
        sportsTimer = null;
        const sportsData = JSON.stringify(getSportsService().getSSEData());
        markDirty('sports', sportsData);
    }, SPORTS_RECOMPUTE_THROTTLE_MS);
}

let closeTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCloseRecompute(): void {
    if (closeTimer) return;
    closeTimer = setTimeout(async () => {
        closeTimer = null;
        cachedCloseOpportunities = await calculateCloseOpportunities();
        markDirty('closeOpportunities', JSON.stringify(cachedCloseOpportunities));
    }, CLOSE_RECOMPUTE_THROTTLE_MS);
}

// 触发点
function onPolymarketWsUpdate(assetId: string): void {
    // 更新 opportunities（内存）
    markDirty('opportunity', JSON.stringify(dashboardData.opportunities));
    scheduleSportsRecompute();
    scheduleCloseRecompute();
}

async function broadcastUpdate(): Promise<void> {
    // 构建 payload 后标记 dirty（不直接广播）
    markDirty('opportunity', JSON.stringify(dashboardData.opportunities));
    markDirty('stats', JSON.stringify(dashboardData.stats));
    markDirty('markets', JSON.stringify(buildMarketList()));
    markDirty('tasks', JSON.stringify(taskService.getTasks({ includeCompleted: true })));
    markDirty('accounts', JSON.stringify(await getAccountData()));
}
```

### 触发规则细化
- Live opportunities：
  - `handlePolymarketWsUpdate()` 使用 `markDirty('opportunity', JSON.stringify(dashboardData.opportunities))`
  - 移除 WS 路径中的直接 `broadcastSSEGlobal`
- 主轮询（2s）：
  - `broadcastUpdate()` 只构建 payload 并调用 `markDirty(...)`
  - 不再直接 `broadcastSSEGlobal`
- Sports：
  - 增加 `SPORTS_RECOMPUTE_THROTTLE_MS = 200`
  - WS 订单簿更新时只设置 dirty 并节流重算
  - 重算后调用 `markDirty('sports', JSON.stringify(getSportsService().getSSEData()))`
- Close opportunities：
  - 增加 `CLOSE_RECOMPUTE_THROTTLE_MS = 200`
  - WS 订单簿更新时只设置 dirty 并节流重算
  - 重算后调用 `markDirty('closeOpportunities', JSON.stringify(cachedCloseOpportunities))`
- Accounts：
  - 保持 5s 轮询，替换为 `markDirty('accounts', accountsData)`

### 约束/护栏
- 保留 2s 低频全量同步作为 WS 失效时兜底。
- sports payload 较大：不要每个 WS tick 都重算，必须节流。
- close payload 计算较重：必须节流。

### 阶段 6 - 验证
1) 以 WS 模式启动 dashboard。
2) 运行订单簿测试：
   - `bot/src/testing/test-orderbook-latency.ts`
   - `bot/src/testing/monitor-orderbook-realtime.ts`
3) 确认机会刷新与任务执行正常。

## 回滚
- 设置 `DASHBOARD_PREDICT_ORDERBOOK_MODE=legacy` 恢复 REST 轮询。
- 或使用备份目录整体回滚。

## 风险与应对
- WS 订阅上限：调整 `SUBSCRIPTION_BATCH_SIZE` 与批次延迟。
- 数据过期：强制 `PREDICT_ORDERBOOK_STALE_MS`，过期视为无效。
- WS 断连：输出健康日志并确保自动重连。
