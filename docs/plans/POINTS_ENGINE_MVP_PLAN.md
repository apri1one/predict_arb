# points-engine（MVP）计划：Predict Points 双边做市 + Poly Taker 对冲 + Split/Merge 资金管理

## 结论

新增一个独立进程模块 `points-engine`（不嵌入 Dashboard 进程），从 Dashboard 获取市场/订单簿/机会数据并向 Dashboard 下发 task 指令，完成：
- Predict 上同一 outcome 的双边挂单（满足 Points 规则，尽量靠近 best）
- 成交后 Polymarket 以 taker 方式对冲（仅对冲，不做 Poly maker）
- 使用 split/merge 管理成对库存 `pair=min(YES,NO)`，在 `pairLow/pairHigh` 带宽内稳定运行并释放资金

---

## 关键定义（必须统一口径）

### 1) Points 合格挂单（Predict）
- `minSharesForPoints = 100`（anchor 固定为 100）
- 合格价格区间：相对“市场价”±6¢
  - 买单：`[mid-6¢, mid]`
  - 卖单：`[mid, mid+6¢]`
- 同一 outcome 必须同时具备 bid + ask 才有更高 Points。
- 越靠近 best bid/ask 权重越高；多档挂单可累计，best 档权重更高。

### 2) `pair` 与 `pair 带宽（band）`
- `pair`：同一平台、同一 condition 下成对库存
  - `pairPredict = min(Yp, Np)`
  - `pairPoly = min(Ym, Nm)`
- `pairLow/pairHigh`：围绕 `targetPair` 的“迟滞带宽”（避免频繁 split/merge）
  - `pair < pairLow`：库存不足，触发 split/补仓
  - `pair > pairHigh`：库存过多，触发 merge/减仓释放稳定币
- 约束：`pairLow >= 200`（交互可设置项）

### 3) 净敞口与对冲方向（跨平台）
- `net = (Yp+Ym) - (Np+Nm)`（目标：`net = 0`）
- 对冲仅在 Polymarket 做 taker，且优先选择不打穿 `pairPoly` 的方向：
  - `net > 0`（YES 过多）→ Poly 买 NO
  - `net < 0`（NO 过多）→ Poly 买 YES

---

## MVP 范围（先做什么）

### 目标能力
1. 管理 ≤20 个市场（可配置）
2. 每个市场/每个 outcome（先 MVP 只做一个 outcome，例如 YES）维护 Predict 双边挂单：
   - `anchorShares=100` 固定
   - `activeShares` 可配置（默认 200），并可按 Poly 深度/滑点风控动态缩放
3. 成交事件驱动：Predict 成交 → 0.5~2s 净额窗口合并 → Poly taker 对冲（≤3s）
4. `pair` 带宽管理：两边按 `pairLow/pairHigh/targetPair` 触发 split/merge

### 非 MVP（v2 再做）
- 同一事件同时做 YES 和 NO 的“主/次 outcome”分层与亏损预算。
- 自动选市场（基于 24h vol、points 激活状态等），MVP 先由 Dashboard 提供候选市场列表。
- 将策略完全嵌入 Dashboard 进程（MVP 保持独立进程，便于调试）。

---

## 数据依赖（来自 Dashboard）

points-engine 不直接维护复杂的市场发现逻辑，依赖 Dashboard 提供：
- 订阅/读取市场列表（≤20）
- Predict 订单簿（WS 缓存后的快照）
- Polymarket 订单簿（WS 缓存/快照）
- tick size / market mid / points 激活信息（如果 Dashboard 已计算/缓存）
- 任务创建/启动/取消接口（Task API）
- 任务事件流（SSE 或轮询）用于推进 points-engine 的状态机

说明：MVP 的核心诉求是“调试 points-engine 不需要重启 Dashboard”，因此 points-engine 作为外部客户端消费 Dashboard 提供的数据服务。

---

## 策略执行（MVP 规则）

### 1) anchor/active 动态跟随（价格）
- anchor 价格偏移（由风格决定）：
  - 激进：best ± 1 tick
  - 均衡：best ± 2 tick
  - 保守：best ± 3 tick
- active 追价频率：`repriceIntervalMs = 10s`
- 追价触发：不在买一/卖一则追 1 tick（默认）
- **追价限制（硬条件）**：若追价后“双腿成本 > 1”（含 Poly 预估滑点/费用），则放弃追价，维持原挂单位置（只在出界 ±6¢ 或风控触发时强制调整/降档）。

### 2) Polymarket 滑点风控（必须）
由于 Predict 先 maker，Predict 侧不承担“吃单滑点”，核心风险来自 Poly 对冲：
- `maxPolySlippageBps = 100`（你确认的默认值）
- 计算：以 Poly 当前盘口深度估算对冲 `q` 的预期均价与滑点
- 动作：若 `q` 的预估滑点 > 100bps 或深度不足，则缩小 Predict `activeShares` 上限；极端情况下只保留 anchor（维持 Points 合格但降低成交）。

### 3) 对冲超时降档
- `maxUnhedgedMs = 3000`
- 超时/失败：撤掉 active，仅保留 anchor；进入冷却，待 Poly 深度/网络恢复再逐步升档。

### 4) split/merge（库存与资金释放）
按 `pair` 带宽触发：
- Predict：
  - `pairPredict < pairLow` → split 补到 targetPair（或补到 pairHigh，具体由配置决定）
  - `pairPredict > pairHigh` → merge 降到 targetPair（释放 USDT）
- Polymarket：
  - `pairPoly < pairLow` → split 补到 targetPair（谨慎：只在确实需要维持 Poly 侧成对库存时触发）
  - `pairPoly > pairHigh` → merge 降到 targetPair（释放 USDC）

---

## 风控清单（MVP 必须具备）

1. `polySlippageGuard`：对冲深度不足/滑点超阈值 → 缩 active 或降档
2. `wsStalenessGuard`：任一订单簿数据过期 → 停止追价与新任务，必要时降档
3. `globalFillBudget`：限制所有市场 active 同时可能成交的资金占用，避免“余额不足导致 Predict 自动取消买单”造成双边断档
4. `selfCrossGuard`：保持 bid/ask 至少 1 tick 间隔，避免自成交风险
5. `rateLimitGuard`：控制对 Dashboard 的请求频率与 Task 创建频率（20 市场以内也需限流）

---

## 配置方案（参数集中化）

将所有可调参数集中在单独配置文件（不含密钥），建议路径：
- `bot/points-engine.config.json`

其中 `pairLow/pairHigh/targetPair` 支持：
- 全局默认值
- per-market/per-condition 覆盖
- 约束：`pairLow >= 200`

---

## 验收标准（MVP）

1. 能稳定运行 20 个市场以内，Predict 双边挂单持续合格（anchor 不掉线）
2. Predict 成交后 ≤3s 内完成 Poly taker 对冲；失败则触发降档，且不会继续扩大敞口
3. 在 Poly 深度不足时，active 自动缩小，避免连续对冲失败
4. `pair` 在带宽内稳定波动，不频繁 split/merge；需要时能 merge 释放资金维持挂单
5. points-engine 调试/重启不需要重启 Dashboard（通过外部接口交互）

