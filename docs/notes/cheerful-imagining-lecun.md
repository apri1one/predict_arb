# Taker Mode 套利执行模块实现计划

## 背景

当前系统有两种套利策略检测：
- **MAKER**: `predict_yes_bid + polymarket_no_ask < 1` → Predict 挂 bid 等待成交
- **TAKER**: `predict_yes_ask + polymarket_no_ask + fee < 1` → Predict 主动吃 ask

现有执行层只实现了 Maker 模式（挂单等待）。需要新增 Taker 模式（主动吃单）。

## 核心区别

| 特性 | Maker Mode | Taker Mode |
|------|-----------|------------|
| Predict 订单价格 | bid (买一价) | ask (卖一价) |
| 成交速度 | 慢（等待被动成交） | 快（主动吃单） |
| 订单类型 | LIMIT @ bid | LIMIT @ ask |
| 价格守护 | 监控 Poly ask 上涨 | 监控总成本 > 1 |
| 对冲方式 | 填充式 IOC | 填充式 IOC（相同） |

## 实现方案

### 方案概述

复用现有 TaskExecutor 架构，通过 `task.strategy` 字段区分 MAKER/TAKER：
- MAKER: 使用现有逻辑（bid 价格）
- TAKER: 新增逻辑（ask 价格）

### 步骤 1: 扩展类型定义

**文件**: `bot/src/dashboard/types.ts`

```typescript
export interface Task {
    // ... 现有字段 ...
    strategy: 'MAKER' | 'TAKER';  // 新增：执行策略

    // Taker 模式专用字段
    predictAskPrice?: number;     // Taker 模式的 ask 价格
    maxTotalCost?: number;        // Taker 模式的最大总成本阈值
}

export interface CreateTaskInput {
    // ... 现有字段 ...
    strategy: 'MAKER' | 'TAKER';
    predictAskPrice?: number;     // Taker 模式必填
}
```

### 步骤 2: 修改任务创建逻辑

**文件**: `bot/src/dashboard/task-service.ts`

```typescript
createTask(input: CreateTaskInput): Task {
    // 验证 Taker 模式必填字段
    if (input.strategy === 'TAKER') {
        if (!input.predictAskPrice) {
            throw new Error('TAKER strategy requires predictAskPrice');
        }
    }

    const task: Task = {
        // ... 现有字段 ...
        strategy: input.strategy,
        predictPrice: input.strategy === 'MAKER'
            ? input.predictPrice      // Maker: 用 bid
            : input.predictAskPrice!, // Taker: 用 ask
        predictAskPrice: input.predictAskPrice,
        maxTotalCost: input.maxTotalCost ?? 0.995, // 默认 99.5%
    };

    return task;
}
```

### 步骤 3: 修改执行器 - Taker 订单提交

**文件**: `bot/src/dashboard/task-executor.ts`

在 `executeBuyTask()` 中区分策略：

```typescript
async executeBuyTask(ctx: TaskContext): Promise<void> {
    const { task } = ctx;

    if (task.strategy === 'TAKER') {
        await this.executeTakerBuyTask(ctx);
    } else {
        await this.executeMakerBuyTask(ctx);  // 现有逻辑
    }
}

async executeTakerBuyTask(ctx: TaskContext): Promise<void> {
    const { task } = ctx;

    // 1. 获取最新 ask 价格
    const predictBook = await this.fetchPredictOrderbook(task.marketId);
    const currentAsk = predictBook.asks[0]?.[0];

    if (!currentAsk) {
        throw new Error('No ask price available');
    }

    // 2. 验证套利仍然有效
    const polyBook = await this.polyTrader.getOrderbook(this.getHedgeTokenId(task));
    const polyAsk = polyBook.asks[0]?.price ?? 1;
    const fee = this.calculatePredictFee(currentAsk, task.feeRateBps || 200);
    const totalCost = currentAsk + polyAsk + fee;

    if (totalCost >= (task.maxTotalCost || 0.995)) {
        throw new Error(`Total cost ${totalCost} exceeds max ${task.maxTotalCost}`);
    }

    // 3. 提交 LIMIT 订单 @ ask 价格
    const result = await this.submitPredictOrder(
        { ...task, predictPrice: currentAsk },
        'BUY'
    );

    if (!result.success) {
        throw new Error(`Taker order failed: ${result.error}`);
    }

    ctx.currentOrderHash = result.hash;

    // 4. 启动监控和对冲（与 Maker 相同）
    await this.runTakerWithPriceGuard(ctx, 'BUY');
}
```

### 步骤 4: Taker 模式价格守护

**文件**: `bot/src/dashboard/order-monitor.ts`

新增 Taker 专用价格守护配置：

```typescript
export interface TakerPriceGuardConfig {
    predictMarketId: number;
    polymarketTokenId: string;
    feeRateBps: number;
    maxTotalCost: number;  // 最大总成本阈值 (如 0.995)
}

// Taker 模式：监控总成本
async startTakerPriceGuard(
    config: TakerPriceGuardConfig,
    callbacks: { onCostExceeded: () => void; onCostValid: () => void }
): Promise<void> {
    // 定期轮询双边订单簿
    const checkCost = async () => {
        const predictBook = await this.fetchPredictOrderbook(config.predictMarketId);
        const polyBook = await this.polyTrader.getOrderbook(config.polymarketTokenId);

        const predictAsk = predictBook.asks[0]?.[0] ?? 1;
        const polyAsk = polyBook.asks[0]?.price ?? 1;
        const fee = calculatePredictFee(predictAsk, config.feeRateBps);
        const totalCost = predictAsk + polyAsk + fee;

        if (totalCost >= config.maxTotalCost) {
            callbacks.onCostExceeded();
        } else {
            callbacks.onCostValid();
        }
    };

    // 启动轮询 (500ms 间隔)
    this.takerGuardInterval = setInterval(checkCost, 500);
}
```

### 步骤 5: 修改前端默认价格

**文件**: `front/preview/components.jsx`

在任务创建对话框中，根据 strategy 设置默认价格：

```jsx
// OpportunityCard 组件中的任务创建逻辑
const handleCreateTask = () => {
    const defaultPrice = opp.strategy === 'TAKER'
        ? opp.predictAsk   // Taker: 默认用 ask
        : opp.predictBid;  // Maker: 默认用 bid

    // 打开创建任务对话框，预填价格
    openTaskDialog({
        strategy: opp.strategy,
        predictPrice: defaultPrice,
        predictAskPrice: opp.strategy === 'TAKER' ? opp.predictAsk : undefined,
        // ...
    });
};
```

### 步骤 6: 后端 API 调整

**文件**: `bot/src/dashboard/start-dashboard.ts`

扩展 `/api/tasks` 创建接口：

```typescript
// POST /api/tasks
const createTaskInput: CreateTaskInput = {
    // ... 现有字段 ...
    strategy: body.strategy || 'MAKER',
    predictAskPrice: body.predictAskPrice,
    maxTotalCost: body.maxTotalCost,
};
```

## 文件修改清单

| 文件 | 修改内容 |
|------|----------|
| `bot/src/dashboard/types.ts` | 新增 `strategy`, `predictAskPrice`, `maxTotalCost` 字段 |
| `bot/src/dashboard/task-service.ts` | Taker 模式验证逻辑 |
| `bot/src/dashboard/task-executor.ts` | `executeTakerBuyTask()`, `runTakerWithPriceGuard()` |
| `bot/src/dashboard/order-monitor.ts` | `startTakerPriceGuard()` 总成本监控 |
| `bot/src/dashboard/start-dashboard.ts` | API 扩展支持 strategy 参数 |
| `front/preview/components.jsx` | 默认价格切换 (bid/ask) |

## 执行流程对比

### Maker Mode (现有)
```
1. 挂单 @ bid 价格
2. 价格守护: 监控 Poly ask
3. 等待 Predict 成交 (被动)
4. 成交后 → IOC 对冲 Polymarket
5. 重复直到完成
```

### Taker Mode (新增)
```
1. 下单 @ ask 价格 (主动吃单)
2. 价格守护: 监控总成本 < maxCost
3. Predict 快速成交 (通常几秒内)
4. 成交后 → IOC 对冲 Polymarket
5. 若有剩余，重新获取 ask 价格继续
```

## 注意事项

1. **Taker 成交更快但利润更低**：ask 价格高于 bid，利润空间较小
2. **价格守护简化**：Taker 模式下订单很快成交，价格守护主要防止下单前价格变化
3. **复用对冲逻辑**：Polymarket 对冲完全复用现有 IOC 填充式逻辑
4. **前端区分显示**：后续可通过卡片背景色区分 MAKER (蓝) / TAKER (橙)

## 已确认事项

1. ✅ Taker 订单用 LIMIT @ ask（避免滑点）
2. ✅ Maker/Taker 共存，通过 strategy 字段区分
3. ✅ 价格守护监控总成本（predict_ask + poly_ask + fee < 1）
4. ✅ Taker Mode 只支持 BUY 任务（不支持 SELL）

## 实现优先级

1. **Phase 1**: 类型定义 + 任务创建逻辑
2. **Phase 2**: 执行器 Taker BUY 流程
3. **Phase 3**: 价格守护（可选，Taker 成交快可简化）
4. **Phase 4**: 前端默认价格切换
