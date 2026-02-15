# 深度监控竞态条件修复分析报告

## 问题背景

在 `task-executor.ts` 中，存在深度监控（depth monitor）和主循环（main loop）之间的竞态条件：

**竞态场景**：
1. 深度监控检测到深度不足，调用 `cancelOrder` 取消订单
2. 在 `cancelOrder` 网络调用返回之前，主循环的 `getOrderStatus` 检测到订单状态变为 `CANCELLED`
3. 主循环误判这是"外部取消"（用户手动取消），触发任务失败逻辑

**后果**：
- 任务被错误标记为 `HEDGE_FAILED` 或 `CANCELLED`
- 深度监控后续的重新提交订单操作被忽略
- 实际可正常继续的套利任务被中断

## 解决方案

通过引入 `isDepthAdjusting` 布尔标志，标记深度监控正在调整订单的时间窗口。

### 1. 类型定义

在 `TaskContext` 接口中添加标志（第 111 行）：

```typescript
interface TaskContext {
    // ... 其他字段

    /** 深度监控正在调整订单（取消→重提），防止主循环误判为外部取消 */
    isDepthAdjusting?: boolean;
}
```

### 2. 主循环判断逻辑

在订单取消检测中增加标志检查（第 2288 行）：

```typescript
// 检查是否是保护机制取消
// isDepthAdjusting = 深度监控正在调整订单（取消→重提）
if (ctx.currentOrderHash !== watchedOrderHash || ctx.isPaused || ctx.isDepthAdjusting) {
    console.log(`[TaskExecutor] Task ${task.id}: Order cancelled by guard (hash changed: ${watchedOrderHash?.slice(0, 10)} → ${ctx.currentOrderHash?.slice(0, 10) || 'null'}, isDepthAdjusting: ${!!ctx.isDepthAdjusting}), continuing...`);
    // 不取消任务，继续监控循环
    continue;
}
```

### 3. 标志设置和清除位置

#### 3.1 深度恢复流程（第 3003 行）

**场景**：任务暂停后深度恢复，重新提交订单

```typescript
// 设置标志
ctx.isDepthAdjusting = true;

try {
    const result = await this.submitPredictOrder(taskWithRemaining, side);
    if (result.success) {
        ctx.isPaused = false;
        ctx.currentOrderHash = result.hash;
        // ... 更新任务状态
    }
} finally {
    // 清除标志
    ctx.isDepthAdjusting = false;
}
```

**时间窗口**：从开始提交订单到订单提交完成（成功或失败）

#### 3.2 深度扩增流程（第 3113 行）

**场景**：深度充足且支持更大数量，取消当前订单并以更大数量重新提交

```typescript
// 标记深度调整中
ctx.isDepthAdjusting = true;

// 取消当前订单
let cancelSuccess = false;
if (ctx.currentOrderHash) {
    cancelSuccess = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
    // ...
}

try {
    const result = await this.submitPredictOrder(taskWithExpandedQty, side);
    if (result.success) {
        ctx.currentOrderHash = result.hash;
        // ... 更新任务状态
    }
} finally {
    // 清除标志
    ctx.isDepthAdjusting = false;
}
```

**时间窗口**：从开始取消订单到重新提交完成

#### 3.3 深度调整流程（第 3333 行）

**场景**：深度不足，缩减订单数量

```typescript
// 标记深度调整中
ctx.isDepthAdjusting = true;

// 取消当前订单
let depthAdjustCancelSuccess = false;
if (ctx.currentOrderHash) {
    depthAdjustCancelSuccess = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
    // ...
}

try {
    const result = await this.submitPredictOrder(taskWithNewQty, side);
    if (result.success) {
        ctx.currentOrderHash = result.hash;
        // ... 更新任务状态
    }
} finally {
    // 清除标志
    ctx.isDepthAdjusting = false;
}
```

**时间窗口**：从开始取消订单到重新提交完成

## 代码审查结果

### ✅ 标志设置和清除位置完整

| 位置 | 场景 | 设置行号 | 清除行号 | try-finally 保护 |
|-----|------|---------|---------|-----------------|
| 深度恢复 | 暂停后恢复 | 3003 | 3071 | ✅ |
| 深度扩增 | 数量向上扩增 | 3113 | 3225 | ✅ |
| 深度调整 | 数量向下缩减 | 3333 | 3424 | ✅ |

**关键设计要点**：
1. 所有三个位置都使用 `try-finally` 确保标志在异常情况下也能清除
2. 标志在开始异步操作前设置，在操作完成后清除
3. 覆盖了深度监控的所有订单调整路径

### ✅ 异常处理完整

#### Abort 信号检查

在深度调整的关键异步操作后，都检查了 abort 信号：

```typescript
// 深度恢复 (3006 行)
if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) {
    console.log(`[TaskExecutor] Depth recovery aborted`);
    ctx.isSubmitting = false;
    return; // ⚠️ 未清除 isDepthAdjusting
}

// 深度扩增 (3167 行)
if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) {
    console.log(`[TaskExecutor] Depth expand aborted`);
    return; // ⚠️ 未清除 isDepthAdjusting
}

// 深度调整 (3382 行)
if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) {
    console.log(`[TaskExecutor] Depth adjustment aborted`);
    return; // ⚠️ 未清除 isDepthAdjusting
}
```

#### 终态检查

在深度调整前，检查任务是否已进入终态：

```typescript
// 深度恢复 (3015-3019 行)
if (!currentTaskAfterDepthCheck || terminalStatuses.includes(currentTaskAfterDepthCheck.status)) {
    console.log(`[TaskExecutor] Depth recovery aborted: task in terminal state`);
    ctx.isSubmitting = false;
    return; // ⚠️ 未清除 isDepthAdjusting
}

// 深度扩增 (3175-3178 行)
if (!currentTaskAfterCancel || terminalStatuses.includes(currentTaskAfterCancel.status)) {
    console.log(`[TaskExecutor] Depth expand aborted: task in terminal state`);
    return; // ⚠️ 未清除 isDepthAdjusting
}

// 深度调整 (3376-3379 行)
if (!taskBeforeResubmit || terminalStatuses.includes(taskBeforeResubmit.status)) {
    console.log(`[TaskExecutor] Depth adjustment: task became ${taskBeforeResubmit?.status}`);
    return; // ⚠️ 未清除 isDepthAdjusting
}
```

### ⚠️ 发现的问题

#### 问题 1：提前 return 未清除标志

在 abort 信号触发或任务进入终态时，代码直接 `return`，绕过了 `finally` 块，导致 `isDepthAdjusting` 标志未被清除。

**影响**：
- 标志永久保持 `true` 状态
- 后续主循环的所有订单取消都会被误判为保护机制取消
- 任务无法正常结束

**严重程度**：🔴 高危

#### 问题 2：取消失败时标志仍被设置

在深度扩增和深度调整流程中，如果 `cancelOrder` 失败，代码会提前返回但标志已设置：

```typescript
// 深度扩增 (3158-3163 行)
if (cancelSuccess) {
    ctx.currentOrderHash = undefined;
} else {
    // 取消失败，跳过本次扩增
    setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
    return; // ⚠️ 标志已设置但未进入 try-finally
}

// 深度调整 (3360-3365 行)
if (depthAdjustCancelSuccess) {
    ctx.currentOrderHash = undefined;
} else {
    console.warn('[TaskExecutor] Depth adjustment skipped: cancel failed');
    setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
    return; // ⚠️ 标志已设置但未进入 try-finally
}
```

**影响**：
- 取消失败后标志未清除
- 下次深度检查循环会误判订单状态

**严重程度**：🟡 中危

## 边界情况分析

### 1. ✅ 深度调整过程中任务被手动取消

**场景**：用户在深度调整时点击"取消任务"

**处理流程**：
1. `cancelTask` 调用 `ctx.abortController.abort()`
2. 深度监控检测到 `ctx.signal.aborted`，提前返回
3. ⚠️ **问题**：`isDepthAdjusting` 未清除

**影响**：轻微，任务已进入终态，标志不再使用

### 2. ✅ 深度调整过程中 abort signal 触发

**场景**：价格守护触发 abort 或任务超时

**处理流程**：同上

### 3. ✅ 深度调整过程中订单部分成交

**场景**：取消订单时订单已部分成交

**处理流程**：
```typescript
// 取消前检查订单状态 (3118-3127 行)
const preStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
if (preStatus && preStatus.status === 'FILLED') {
    console.log(`[TaskExecutor] Depth expand: order already FILLED, skip expand`);
    setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
    return; // ⚠️ 标志已设置但未清除
}
```

**处理**：✅ 有检测，但存在标志未清除问题

### 4. ❌ 多个深度调整并发执行

**场景**：WebSocket 事件和轮询同时触发深度检查

**保护机制**：
```typescript
// 防重入标志 (2997-3001 行)
if (ctx.isSubmitting) {
    console.log(`[TaskExecutor] Depth resume skipped: another path is submitting`);
    setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
    return;
}
ctx.isSubmitting = true;
```

**处理**：✅ 通过 `isSubmitting` 标志防止并发

### 5. ✅ 深度调整失败后的状态恢复

**场景**：重新提交订单失败

**处理流程**：
```typescript
} else {
    console.warn(`[TaskExecutor] Depth recovered but re-submit failed: ${result.error}`);
    // isPaused 未变，保持 PAUSED，下一轮 checkDepth 重试
}
} finally {
    ctx.isSubmitting = false;
    ctx.isDepthAdjusting = false; // ✅ 标志正确清除
}
```

**处理**：✅ `finally` 确保标志清除

### 6. ✅ 深度调整过程中网络异常

**场景**：`cancelOrder` 或 `submitOrder` 网络超时

**处理流程**：
- 异常会被 `try-catch` 捕获
- `finally` 块确保标志清除

**处理**：✅ 异常安全

### 7. ⚠️ 深度监控循环终止

**场景**：`checkDepth` 递归调用链断裂

**可能原因**：
- 任务进入终态后 `return`（第 2964 行）
- Abort 信号触发后 `return`（第 2957 行）

**处理**：⚠️ 这些 return 发生在标志设置之前，是安全的

## 修复建议

### 修复 1：确保 abort/终态检查时清除标志

**问题位置**：
- 深度恢复：3008、3017 行
- 深度扩增：3168、3176 行
- 深度调整：3383 行

**修复代码**：

```typescript
// 深度恢复 (3005-3019 行)
// 再次检查 abort 状态（深度检测是异步的，期间可能任务已被取消）
if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) {
    console.log(`[TaskExecutor] Depth recovery aborted (task cancelled during async depth check)`);
    ctx.isSubmitting = false;
    ctx.isDepthAdjusting = false; // ✅ 添加清除
    return;
}

// 再次检查任务终态（双重保险）
const currentTaskAfterDepthCheck = this.taskService.getTask(task.id);
const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
if (!currentTaskAfterDepthCheck || terminalStatuses.includes(currentTaskAfterDepthCheck.status)) {
    console.log(`[TaskExecutor] Depth recovery aborted: task in terminal state ${currentTaskAfterDepthCheck?.status}`);
    ctx.isSubmitting = false;
    ctx.isDepthAdjusting = false; // ✅ 添加清除
    return;
}
```

**需要修复的位置**：共 6 处提前 return

### 修复 2：取消失败时清除标志

**问题位置**：
- 深度扩增：3161 行
- 深度调整：3363 行

**修复代码**：

```typescript
// 深度扩增 (3157-3163 行)
if (cancelSuccess) {
    ctx.currentOrderHash = undefined;
} else {
    // 取消失败，跳过本次扩增
    ctx.isDepthAdjusting = false; // ✅ 添加清除
    setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
    return;
}

// 深度调整 (3358-3365 行)
if (depthAdjustCancelSuccess) {
    ctx.currentOrderHash = undefined;
} else {
    // 取消失败，不能安全地重新下单，跳过本次调整
    console.warn('[TaskExecutor] Depth adjustment skipped: cancel failed, retaining current order');
    ctx.isDepthAdjusting = false; // ✅ 添加清除
    setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
    return;
}
```

**需要修复的位置**：2 处

### 修复 3：订单已 FILLED 时清除标志

**问题位置**：
- 深度扩增：3126、3138 行

**修复代码**：

```typescript
// 深度扩增 (3123-3127 行)
if (preStatus && preStatus.status === 'FILLED') {
    console.log(`[TaskExecutor] Depth expand: order already FILLED, skip expand → main loop will hedge`);
    ctx.isDepthAdjusting = false; // ✅ 添加清除
    setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
    return;
}

// 深度扩增 (3135-3139 行)
if (postStatus && postStatus.status === 'FILLED') {
    console.log(`[TaskExecutor] Depth expand: cancel noop but order FILLED → main loop will hedge`);
    ctx.isDepthAdjusting = false; // ✅ 添加清除
    setTimeout(checkDepth, DEPTH_CHECK_INTERVAL);
    return;
}
```

**需要修复的位置**：2 处

### 修复 4：深度暂停流程标志问题

**问题位置**：深度暂停流程（3241-3327 行）未设置标志

**分析**：
- 深度暂停时也会取消订单
- 但此场景中订单不会重新提交，任务进入 `PAUSED` 状态
- 主循环检测到取消时，应通过 `ctx.isPaused` 判断，不需要 `isDepthAdjusting`

**结论**：✅ 当前设计合理，不需要修复

## 测试结果

运行测试脚本 `test-depth-race-condition.ts`：

```
✅ 通过: 10
❌ 失败: 0
📊 总计: 10
🎯 成功率: 100.0%
```

**测试覆盖**：
- ✅ 基础逻辑测试（9 个场景）
- ✅ 时序竞态模拟测试
- ✅ 边界情况验证

## 总结

### 当前实现评估

| 项目 | 状态 | 说明 |
|-----|------|------|
| 标志设置位置 | ✅ 完整 | 三个深度调整路径都正确设置 |
| 标志清除位置 | ⚠️ 不完整 | 存在 10 处提前 return 未清除标志 |
| try-finally 保护 | ✅ 正确 | 主路径使用 finally 确保清除 |
| 主循环判断逻辑 | ✅ 正确 | 正确检测标志并跳过误判 |
| 并发控制 | ✅ 完整 | isSubmitting 防止并发 |
| 异常处理 | ⚠️ 不完整 | 部分异常路径未清除标志 |

### 严重问题

🔴 **高危问题（10 处）**：提前 return 未清除 `isDepthAdjusting` 标志

**触发条件**：
- 任务被手动取消（abort 信号）
- 任务进入终态（COMPLETED/FAILED 等）
- 订单取消失败
- 订单提交前已 FILLED

**后果**：
- 标志永久为 `true`
- 主循环无法检测真正的外部取消
- 任务可能无法正常终止

### 修复优先级

1. 🔴 **立即修复**：所有提前 return 处添加标志清除（10 处）
2. 🟢 **验证测试**：运行测试脚本确认修复有效
3. 🟢 **集成测试**：在真实环境验证深度调整流程

### 推荐修复策略

将标志清除逻辑从 `finally` 移到所有 return 之前，确保无论何种退出路径都会清除标志：

```typescript
// 推荐模式
ctx.isDepthAdjusting = true;
try {
    // 异步操作
    if (someCondition) {
        ctx.isDepthAdjusting = false; // 清除
        return;
    }
    // 正常流程
} catch (e) {
    ctx.isDepthAdjusting = false; // 清除
    throw e;
} finally {
    ctx.isDepthAdjusting = false; // 兜底清除
}
```

## 附录：需要修复的代码行号

| 位置 | 行号 | 场景 | 修复操作 |
|-----|------|------|---------|
| 深度恢复 | 3008 | abort 信号 | 添加 `ctx.isDepthAdjusting = false` |
| 深度恢复 | 3017 | 任务终态 | 添加 `ctx.isDepthAdjusting = false` |
| 深度扩增 | 3126 | 订单已 FILLED | 添加 `ctx.isDepthAdjusting = false` |
| 深度扩增 | 3138 | cancel 后 FILLED | 添加 `ctx.isDepthAdjusting = false` |
| 深度扩增 | 3161 | 取消失败 | 添加 `ctx.isDepthAdjusting = false` |
| 深度扩增 | 3168 | abort 信号 | 添加 `ctx.isDepthAdjusting = false` |
| 深度扩增 | 3176 | 任务终态 | 添加 `ctx.isDepthAdjusting = false` |
| 深度调整 | 3363 | 取消失败 | 添加 `ctx.isDepthAdjusting = false` |
| 深度调整 | 3378 | 任务终态 | 添加 `ctx.isDepthAdjusting = false` |
| 深度调整 | 3383 | abort 信号 | 添加 `ctx.isDepthAdjusting = false` |
