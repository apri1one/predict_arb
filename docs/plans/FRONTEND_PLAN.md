# 套利扫描器实时前端方案

## 需求概述

构建一个**实时套利机会监控前端**，具备以下特性：
- 实时刷新套利机会（毫秒级 Polymarket + 秒级 Predict）
- 简洁现代的 UI 设计
- 适配 API 速率限制

---

## API 速率限制分析

| 平台 | 限制 | 最优策略 |
|------|------|----------|
| **Polymarket** | WebSocket 实时推送 | 无限制，毫秒级更新 |
| **Predict** | 240 次/分钟 = 4 次/秒 | 轮询间隔 ≥ 250ms/市场 |

### 刷新策略计算

假设监控 **N 个市场**：

```
Predict 安全刷新间隔 = N × 250ms
- 10 个市场: 2.5 秒/轮
- 20 个市场: 5 秒/轮
- 50 个市场: 12.5 秒/轮
- 100 个市场: 25 秒/轮
```

**推荐方案**：
- **Polymarket**: WebSocket 实时更新（已有）
- **Predict**: 并发请求 + 动态间隔（基于市场数量）
- **前端显示**: 1 秒刷新 UI（从缓存读取）

---

## 技术架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ 套利机会表  │  │ 市场详情    │  │ 统计面板    │             │
│  │ (实时更新)  │  │ (点击展开)  │  │ (汇总数据)  │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         └────────────────┼────────────────┘                     │
│                          │ SSE / WebSocket                      │
└──────────────────────────┼──────────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                    Backend (Node.js)                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  Arb Scanner Service                     │   │
│  │  ┌───────────────┐    ┌───────────────┐                 │   │
│  │  │ Polymarket WS │    │ Predict REST  │                 │   │
│  │  │ (实时 <50ms)  │    │ (轮询 N×250ms)│                 │   │
│  │  └───────┬───────┘    └───────┬───────┘                 │   │
│  │          └──────────┬─────────┘                         │   │
│  │                     ▼                                    │   │
│  │          ┌─────────────────────┐                        │   │
│  │          │  Arbitrage Engine   │                        │   │
│  │          │  (深度计算/套利检测) │                        │   │
│  │          └──────────┬──────────┘                        │   │
│  │                     ▼                                    │   │
│  │          ┌─────────────────────┐                        │   │
│  │          │   Memory Cache      │                        │   │
│  │          │  (套利机会/订单簿)   │                        │   │
│  │          └──────────┬──────────┘                        │   │
│  └─────────────────────┼───────────────────────────────────┘   │
│                        │                                        │
│  ┌─────────────────────▼───────────────────────────────────┐   │
│  │              HTTP Server + SSE                           │   │
│  │  GET /api/opportunities  - 当前套利机会                  │   │
│  │  GET /api/markets        - 市场列表                      │   │
│  │  GET /api/stats          - 统计数据                      │   │
│  │  GET /api/stream         - SSE 实时推送                  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## UI 框架选择

### 推荐: **React + Tailwind CSS + shadcn/ui**

| 组件 | 选择 | 理由 |
|------|------|------|
| 框架 | React 18 | 生态成熟，SSE/WS 集成简单 |
| 样式 | Tailwind CSS | 快速开发，现代外观 |
| 组件库 | shadcn/ui | 高质量、可定制、无依赖锁定 |
| 图表 | Recharts | 轻量级，React 原生 |
| 状态 | Zustand | 简单高效的状态管理 |
| 构建 | Vite | 快速 HMR，现代工具链 |

### 备选方案

| 方案 | 适用场景 |
|------|----------|
| Vue 3 + Element Plus | 如果更熟悉 Vue |
| Next.js | 需要 SEO 或 SSR |
| Svelte + Skeleton | 追求极致性能 |

---

## 前端页面设计

### 主界面布局

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 🔴 实时套利监控                    连接状态: ● 已连接    │  │
│  │ 最后更新: 2025-12-30 15:30:45      监控市场: 25          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─────────────────────┐  ┌─────────────────────────────────┐  │
│  │ 📊 统计概览         │  │ ⚡ 实时套利机会                  │  │
│  │ ┌─────┐ ┌─────┐    │  │                                  │  │
│  │ │ 12  │ │ 3   │    │  │ ┌────────────────────────────┐  │  │
│  │ │Maker│ │Taker│    │  │ │ #542 BTC $80K              │  │  │
│  │ └─────┘ └─────┘    │  │ │ Maker: 0.8% | Qty: 150     │  │  │
│  │                     │  │ │ Predict: 48¢ | PM: 51¢    │  │  │
│  │ 平均利润: 0.6%      │  │ └────────────────────────────┘  │  │
│  │ 最高利润: 1.2%      │  │                                  │  │
│  │ 总深度: $12,450     │  │ ┌────────────────────────────┐  │  │
│  └─────────────────────┘  │ │ #691 ETH $4K               │  │  │
│                            │ │ Taker: 0.3% | Qty: 80      │  │  │
│  ┌─────────────────────┐  │ │ Predict: 52¢ | PM: 47¢    │  │  │
│  │ 📈 利润分布         │  │ └────────────────────────────┘  │  │
│  │ [柱状图]            │  │                                  │  │
│  │                     │  │ ┌────────────────────────────┐  │  │
│  └─────────────────────┘  │ │ ...更多机会...              │  │  │
│                            │ └────────────────────────────┘  │  │
│  ┌─────────────────────┐  └─────────────────────────────────┘  │
│  │ ⏱️ 延迟监控         │                                       │
│  │ Predict: 156ms      │  ┌─────────────────────────────────┐  │
│  │ Polymarket: 23ms    │  │ 📋 全部市场 (点击展开详情)      │  │
│  │ 计算: 5ms           │  │ ┌────┬──────────┬─────┬──────┐ │  │
│  └─────────────────────┘  │ │ ID │ 市场名称  │ 状态 │ 利润 │ │  │
│                            │ ├────┼──────────┼─────┼──────┤ │  │
│                            │ │542 │ BTC 80K  │ ✅  │ 0.8% │ │  │
│                            │ │691 │ ETH 4K   │ ✅  │ 0.3% │ │  │
│                            │ │... │ ...      │ ... │ ...  │ │  │
│                            │ └────┴──────────┴─────┴──────┘ │  │
│                            └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 套利机会卡片设计

```
┌─────────────────────────────────────────────────────┐
│ 🟢 #542 Will Bitcoin hit $80,000?          [展开 ▼] │
├─────────────────────────────────────────────────────┤
│  策略      │  利润率  │  可用数量  │  预估收益      │
│  Maker     │  0.82%   │  150 份    │  $1.23         │
├─────────────────────────────────────────────────────┤
│  Predict YES Ask: 48.0¢  │  Polymarket NO Ask: 51.2¢│
│  总成本: 99.2¢           │  结算收益: 100¢ (套利)  │
├─────────────────────────────────────────────────────┤
│  深度: Predict 200 | Polymarket 180                 │
│  更新: 0.3s 前                                       │
└─────────────────────────────────────────────────────┘
```

### 颜色方案

```css
/* 深色主题 (推荐) */
--bg-primary: #0f172a;      /* 深蓝黑背景 */
--bg-card: #1e293b;         /* 卡片背景 */
--text-primary: #f1f5f9;    /* 主文字 */
--text-secondary: #94a3b8;  /* 次要文字 */
--accent-green: #22c55e;    /* 盈利/Maker */
--accent-blue: #3b82f6;     /* 中性/Taker */
--accent-red: #ef4444;      /* 亏损/警告 */
--accent-yellow: #eab308;   /* 提示 */
```

---

## 后端 API 设计

### 端点列表

```typescript
// GET /api/opportunities
// 返回当前所有套利机会
{
  timestamp: string,
  opportunities: [
    {
      marketId: number,
      title: string,
      strategy: 'MAKER' | 'TAKER',
      profitPercent: number,      // 利润率 (0-100)
      maxQuantity: number,        // 最大可交易数量
      estimatedProfit: number,    // 预估收益 (USD)
      predictPrice: number,       // Predict 价格
      polymarketPrice: number,    // Polymarket 对冲价格
      totalCost: number,          // 总成本
      depth: {
        predict: number,
        polymarket: number
      },
      lastUpdate: number,         // 时间戳 (ms)
      isInverted: boolean         // 是否反向市场
    }
  ],
  stats: {
    makerCount: number,
    takerCount: number,
    avgProfit: number,
    maxProfit: number,
    totalDepth: number
  }
}

// GET /api/markets
// 返回监控的市场列表
{
  markets: [
    {
      predictId: number,
      title: string,
      polymarketConditionId: string,
      status: 'active' | 'settled' | 'error',
      feeRateBps: number,
      isInverted: boolean
    }
  ]
}

// GET /api/stats
// 返回系统统计
{
  latency: {
    predict: number,      // ms
    polymarket: number    // ms
  },
  connectionStatus: {
    polymarketWs: 'connected' | 'disconnected' | 'reconnecting',
    predictApi: 'ok' | 'rate_limited' | 'error'
  },
  lastFullUpdate: string,
  marketsMonitored: number,
  refreshInterval: number   // 当前刷新间隔 (ms)
}

// GET /api/stream
// SSE 实时推送
event: opportunity
data: { ... 单个套利机会 ... }

event: stats
data: { ... 统计更新 ... }

event: heartbeat
data: { timestamp: ... }
```

---

## 实现文件清单

### 后端 (修改现有)

| 文件 | 修改内容 |
|------|----------|
| `bot/src/dashboard/server.ts` | 重构为完整 API 服务器 |
| `bot/src/dashboard/arb-service.ts` | **新建** 套利扫描服务 |
| `bot/src/dashboard/types.ts` | **新建** API 类型定义 |

### 前端 (新建)

```
bot/src/dashboard/frontend/
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── index.html
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── store/
│   │   └── useArbStore.ts        # Zustand 状态管理
│   ├── hooks/
│   │   └── useSSE.ts             # SSE 连接 Hook
│   ├── components/
│   │   ├── Header.tsx            # 顶部状态栏
│   │   ├── StatsPanel.tsx        # 统计面板
│   │   ├── OpportunityCard.tsx   # 套利机会卡片
│   │   ├── OpportunityList.tsx   # 机会列表
│   │   ├── MarketTable.tsx       # 市场表格
│   │   ├── LatencyMonitor.tsx    # 延迟监控
│   │   └── ProfitChart.tsx       # 利润图表
│   ├── lib/
│   │   └── api.ts                # API 客户端
│   └── styles/
│       └── globals.css           # 全局样式
└── public/
    └── favicon.ico
```

---

## 刷新策略实现

### 后端刷新逻辑 (arb-service.ts)

```typescript
class ArbScannerService {
    private marketCount: number;
    private predictInterval: number;  // 动态计算

    constructor() {
        // 动态计算刷新间隔
        this.predictInterval = Math.max(
            this.marketCount * 250,  // 每市场 250ms
            3000                      // 最小 3 秒
        );
    }

    async start() {
        // 1. 连接 Polymarket WebSocket (实时)
        this.polyWs.connect();
        this.polyWs.subscribe(this.tokenIds);
        this.polyWs.onOrderBookUpdate = this.recalculateArb;

        // 2. Predict 轮询 (动态间隔)
        setInterval(async () => {
            await this.updatePredictOrderbooks();
            this.recalculateArb();
            this.broadcastToClients();
        }, this.predictInterval);
    }

    // 广播到所有 SSE 客户端
    broadcastToClients() {
        this.sseClients.forEach(client => {
            client.send('opportunity', this.opportunities);
            client.send('stats', this.stats);
        });
    }
}
```

### 前端 SSE 消费 (useSSE.ts)

```typescript
function useSSE(url: string) {
    const [data, setData] = useState(null);
    const [connected, setConnected] = useState(false);

    useEffect(() => {
        const eventSource = new EventSource(url);

        eventSource.addEventListener('opportunity', (e) => {
            setData(JSON.parse(e.data));
        });

        eventSource.onopen = () => setConnected(true);
        eventSource.onerror = () => setConnected(false);

        return () => eventSource.close();
    }, [url]);

    return { data, connected };
}
```

---

## 启动命令

```bash
# 开发模式
cd bot/src/dashboard/frontend
npm run dev           # 前端 http://localhost:5173
npm run server        # 后端 http://localhost:3000

# 生产构建
npm run build         # 构建前端
npm run start         # 启动完整服务
```

---

## 关键配置

### 环境变量

```env
# .env
DASHBOARD_PORT=3000
PREDICT_API_KEY=xxx
PREDICT_API_KEY_2=xxx       # 备用 Key (可选)
MAX_MARKETS_TO_MONITOR=50   # 最大监控市场数
MIN_PROFIT_THRESHOLD=0.1    # 最小利润阈值 (%)
```

### 前端配置

```typescript
// src/config.ts
export const CONFIG = {
    API_BASE_URL: 'http://localhost:3000',
    SSE_ENDPOINT: '/api/stream',
    UI_REFRESH_INTERVAL: 1000,  // UI 刷新 1 秒
    PROFIT_HIGHLIGHT_THRESHOLD: 0.5,  // 高亮阈值 0.5%
};
```

---

## 给 Gemini 的实现指南

### 步骤 1: 后端 API
1. 重构 `server.ts`，添加完整 REST 端点
2. 创建 `arb-service.ts`，整合现有 `arb-monitor.ts` 逻辑
3. 实现 SSE 推送

### 步骤 2: 前端骨架
1. 初始化 Vite + React + Tailwind
2. 安装 shadcn/ui 组件
3. 创建基础布局

### 步骤 3: 核心组件
1. SSE Hook 连接后端
2. 套利机会列表（实时更新）
3. 统计面板

### 步骤 4: 优化
1. 添加加载状态和错误处理
2. 响应式设计
3. 深色/浅色主题切换

---

## 性能预期

| 指标 | 预期值 |
|------|--------|
| Polymarket 数据延迟 | <50ms |
| Predict 数据延迟 | 3-25 秒 (取决于市场数) |
| 前端更新频率 | 1 秒 |
| 首屏加载 | <2 秒 |
| 内存占用 | <100MB |

---

## 附加功能

### 历史记录功能

```typescript
// GET /api/history
// 返回历史套利机会记录
{
  records: [
    {
      id: string,
      timestamp: string,
      marketId: number,
      title: string,
      strategy: 'MAKER' | 'TAKER',
      profitPercent: number,
      maxQuantity: number,
      predictPrice: number,
      polymarketPrice: number,
      duration: number,      // 机会持续时间 (ms)
      status: 'active' | 'expired' | 'executed'
    }
  ],
  pagination: {
    page: number,
    pageSize: number,
    total: number
  }
}
```

**存储方案**：
- 开发阶段：内存数组（最近 1000 条）
- 生产阶段：SQLite 或 JSON 文件

### 交易按钮（占位）

```tsx
// OpportunityCard.tsx 中添加
<Button
  variant="outline"
  disabled={true}
  className="opacity-50"
>
  执行交易 (开发中)
</Button>
```

**后续计划**：交易执行后端将在单独计划中实现。

---

## 最终文件清单

### 后端

| 文件 | 内容 |
|------|------|
| `bot/src/dashboard/server.ts` | HTTP + SSE 服务器 |
| `bot/src/dashboard/arb-service.ts` | 套利扫描服务 |
| `bot/src/dashboard/history-store.ts` | 历史记录存储 |
| `bot/src/dashboard/types.ts` | 类型定义 |

### 前端

```
bot/src/dashboard/frontend/
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── src/
│   ├── App.tsx
│   ├── store/useArbStore.ts
│   ├── hooks/useSSE.ts
│   ├── components/
│   │   ├── Header.tsx
│   │   ├── StatsPanel.tsx
│   │   ├── OpportunityCard.tsx   # 含交易按钮占位
│   │   ├── OpportunityList.tsx
│   │   ├── HistoryTable.tsx      # 历史记录表格
│   │   ├── LatencyMonitor.tsx
│   │   └── ProfitChart.tsx
│   └── lib/api.ts
└── public/
```

---

## 用户确认

- [x] UI 框架：React + Tailwind + shadcn/ui
- [x] 功能范围：监控面板 + 历史记录 + 交易按钮占位
- [x] 交易执行：后续单独计划
