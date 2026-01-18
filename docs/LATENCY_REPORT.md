# 延迟测试报告

**测试时间**: 2025-12-19 06:25

## 测试结果总结

| 测试项 | 平均延迟 | P50 | P95 | 结论 |
|-------|---------|-----|-----|------|
| **Predict REST API** | 292ms | 280ms | 527ms | 稳定，偶发延迟 |
| **Polymarket REST API** | 269ms | 257ms | 416ms | 稳定 |
| **Polymarket WebSocket** | 269ms (首消息) | - | - | 仅收到1条消息 |
| **BSC RPC: Ankr** | 91ms | 76ms | 234ms | 🏆 最快 |
| **BSC RPC: BSC Official** | 197ms | 154ms | 596ms | 稳定 |
| **BSC RPC: BSC Dataseed 1** | 195ms | 150ms | 600ms | 稳定 |
| **BSC RPC: BSC Dataseed 2** | 205ms | 150ms | 714ms | 稳定 |
| **BSC RPC: PublicNode** | 363ms | 251ms | 752ms | 较慢 |

---

## 关键发现

### 1. Predict vs Polymarket 延迟对比

| 平台 | 获取方式 | 平均延迟 |
|------|---------|---------|
| Predict | REST 轮询 | ~280ms |
| Polymarket | REST | ~260ms |
| Polymarket | WebSocket | ~270ms (首个快照) |

**结论**: 两个平台的 REST API 延迟相近，差异约 20ms，可以接受。

### 2. WebSocket 观察

- 首个订阅消息延迟: 269ms
- 15 秒内仅收到 1 条消息（订单簿快照）
- **原因**: Anthony Joshua 市场可能交易不活跃，订单簿更新少

WebSocket 适用于**高频交易市场**，对于低活跃度市场，REST 轮询效果相近。

### 3. BSC RPC 节点推荐

| 排名 | 节点 | P50 延迟 | 推荐原因 |
|------|------|---------|---------|
| 🥇 | **Ankr** | 76ms | 最低延迟，稳定 |
| 🥈 | BSC Dataseed 1 | 150ms | 官方节点，可靠 |
| 🥉 | BSC Official | 154ms | 备选 |

**结论**: 推荐使用 **Ankr** 作为主 RPC，**BSC Dataseed 1** 作为备选。

---

## 套利执行策略建议

### 延迟预算分析

```
套利执行总延迟 = Predict 下单延迟 + Polymarket 下单延迟 + 安全边际

预估:
- Predict 下单: ~300ms (含签名)
- Polymarket 下单: ~300ms (含签名)
- 安全边际: 200ms
- 总计: ~800ms
```

### Maker 模式策略

1. **监控方式**: 使用 REST 轮询，间隔 500ms
2. **取消检测**: 套利消失时立即取消挂单 (延迟 ~300ms)
3. **风险**: 在 300ms 窗口内可能有执行风险

### Taker 模式策略

1. **双边执行**: 考虑延迟差异，可能需要先执行较慢的一方
2. **价格保护**: 设置最大滑点 (如 0.5%)
3. **超时**: 如果 1 秒内未双边成交，触发警报

---

## 链上监控 vs API 轮询

| 方式 | 延迟 | 复杂度 | 可靠性 |
|------|------|--------|--------|
| API 轮询 (500ms) | 500ms | 低 | 高 |
| 链上事件 (Ankr) | ~100ms | 高 | 中 |

**结论**: 
- 对于 Maker 模式（利润要求 >= 0），API 轮询足够
- 如果未来需要更快的成交检测，可以考虑链上监控

---

## 下一步行动

1. ✅ 延迟测试完成
2. 🔲 开始 Phase 2: Telegram Bot 集成
3. 🔲 开始 Phase 3: Paper Trading 模式
