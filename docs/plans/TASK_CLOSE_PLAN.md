# Task 平仓模块计划

## 目标与范围
- 在现有 Task 系统上新增“持仓平仓”能力，对同一事件的双腿持仓进行收益评估与自动平仓。
- 覆盖两种平仓方式：Taker-Taker（T-T）与 Predict Maker + Polymarket Taker（M-T）。
- 前端展示可平仓收益与风险提示，并支持一键创建并启动 Task。

## 关键事实与约束
- Polymarket Maker/Taker 均无手续费；Predict Maker 无手续费，Predict Taker 有手续费（`calculatePredictFee`）。
- 事件匹配依据 Predict `polymarketConditionIds[0]`，不是标题匹配。
- 缓存文件：`bot/polymarket-match-result.json`，由 `npm run scan-markets` 生成。
- Dashboard 已能获取持仓数据（含成本、shares），需补充事件映射字段。
- Maker 平仓默认价格取“卖一价”，允许用户自定义。

## 市场映射与缓存（必须遵守）
预扫描（`npm run scan-markets`）：
- Predict `GET /v1/markets` → 过滤 `polymarketConditionIds.length > 0 && status='REGISTERED'`。
- 逐个 `GET /v1/markets/{id}` → 取 `polymarketConditionIds[0]`。
- 校验 `GET https://clob.polymarket.com/markets/{conditionId}`。
- 保存到 `bot/polymarket-match-result.json`。

运行时（`npm run dashboard`）：
- `arb-service.ts` 读取 `polymarket-match-result.json`。
- 使用缓存的 conditionId 映射获取订单簿与标的元数据。

## 数据模型与来源
统一以 **Polymarket conditionId** 作为事件键（不使用标题、不用 Predict 自身 conditionId）：
- `PositionLeg`: { polymarketConditionId, predictMarketId?, platform, side(YES/NO), shares, avgPrice, costPerShare, tokenId? }
- `ClosePosition`: { polymarketConditionId, predictMarketId, arbSide, predictLeg, polymarketLeg, matchedShares, entryCostTotal, entryCostPerShare }
- `CloseOpportunity`: { polymarketConditionId, matchedShares, method(TT/MT), predictPrice, polyBid, minPolyBid, estProfit, estProfitPct }

数据来源建议：
- Predict 持仓：用 marketId → `polymarket-match-result.json` 映射到 conditionId。
- Polymarket 持仓：优先读取 data-api 返回的 conditionId；若缺失，使用 tokenId → conditionId 的映射（来自 clob 或缓存）。

## 平仓机会计算（后端）
1. **匹配双腿**：按 `polymarketConditionId` 聚合 Predict 与 Polymarket 持仓，生成 `ClosePosition`。
2. **可平仓数量**：`matchedShares = min(predictShares, polyShares)`。
3. **成本口径（已确认）**：
   - `entryCostTotal = yesCostTotal + noCostTotal`（同一事件双腿总成本）
   - `entryCostPerShare = entryCostTotal / matchedShares`
4. **T-T 估算（Predict Taker）**：
   - `predictPrice = bestBid (limit, side=SELL)`
   - `polyBid = bestBid (limit, side=SELL)`
   - `predictFee = calculatePredictFee(predictPrice, feeRateBps)`
   - `profitPerShare = (predictPrice - predictFee) + polyBid - entryCostPerShare`
   - `minPolyBid = entryCostPerShare - (predictPrice - predictFee)`
5. **M-T 估算（Predict Maker）**：
   - `predictPrice = 卖一价或用户指定`
   - `profitPerShare = predictPrice + polyBid - entryCostPerShare`（不计手续费）
   - `minPolyBid = entryCostPerShare - predictPrice`

## 任务创建与字段映射
复用 `Task` 体系，统一 `type=SELL`：
- **T-T**：`strategy=TAKER`
  - 必填：`predictPrice`, `polymarketMinBid`, `quantity`, `entryCost`(total), `arbSide`, `feeRateBps`
  - `TaskService` 校验需允许 TAKER+SELL 不强制 `predictAskPrice/maxTotalCost`。
- **M-T**：`strategy=MAKER`
  - 走现有 `TaskExecutor` SELL 流程。

## 执行流程（Task Executor）
### T-T（Predict 先卖，Poly 对冲）
1. Predict 以 `bestBid` 提交 `SELL`（limit，模拟 taker，防滑点）。
2. 监控成交量，按成交量在 Polymarket `SELL @ bestBid`。
3. 若 `polyBid < minPolyBid`，进入 PAUSED，等待恢复后补对冲。

### M-T（Predict Maker 挂单）
1. Predict 默认以卖一价挂单（maker），允许用户自定义卖价。
2. 成交后按成交量在 Polymarket `SELL @ bestBid`。
3. 若 `polyBid < minPolyBid`，暂停或撤单。

## 前端展示与交互
- 在 Task 标签页新增“可平仓获利事件”区域，以卡片形式展示，样式与 dashboard 事件卡片一致（参考 OpportunityCard 的布局与视觉密度）。
- 卡片采用“TT/MT 双列显示”：
  - 左列 T-T：显示 predict bestBid、poly bestBid、预估收益(金额/百分比)。
  - 右列 M-T：显示 predict 卖一价(默认)、poly bestBid、预估收益(金额/百分比)。
- 底部元信息：Predict/Polymarket 持仓、最大可卖 shares、更新时间。
  - `maxCloseShares = min(positionShares, min(predictBestBidDepth, polyBestBidDepth))`。
- 卡片交互：
  - 卡片内提供“平仓”入口，点击后展开/弹出配置面板。
  - 选择平仓方式：T-T 或 M-T。
  - T-T：价格自动使用买一价(bestBid)，确认后自动启动；确认方式为按钮状态切换（再次点击执行）；仅需设置 shares。
  - M-T：需要输入 Predict 卖价（默认卖一价/ask）与 shares。
  - shares 上限使用 `maxCloseShares`，超出时提示并自动纠正。
- 提示：深度不足、价格低于 minPolyBid、持仓不足。

## API 与事件
新增 SSE 事件 `closeOpportunities` 或新增 `/api/close-opportunities`：
- 返回 `CloseOpportunity[]` 供前端展示与下单。

## 风控与异常处理
- 价格守护：`polyBid < minPolyBid` 触发 PAUSED；恢复后补对冲。
- 超时：Predict 订单超时未成交 → 取消并记录。
- 部分成交：按成交量对冲，确保 `hedgedQty <= predictFilledQty`。
- 并发锁：同一 marketId 仅允许 1 个活跃 Task。

## 测试与验收
- 单元测试：成本/收益计算、minPolyBid 公式、价格/数量对齐。
- 集成测试：partial fill、价格回撤、恢复对冲。
- 手动验收：小额真实仓位跑通 TT 与 MT。

## 里程碑
1. 映射与持仓字段补全（conditionId/marketId/tokenId）。
2. 平仓机会计算与 API/SSE 输出。
3. Task 创建/校验/执行适配（TAKER+SELL）。
4. 前端展示与交互。
5. 测试与风险验证。
