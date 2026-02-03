export interface ArbOpportunity {
    marketId: number;
    title: string;
    strategy: 'MAKER' | 'TAKER';
    profitPercent: number;      // 0-100
    maxQuantity: number;
    estimatedProfit: number;    // USD
    predictPrice: number;
    polymarketPrice: number;
    totalCost: number;
    depth: {
        predict: number;
        polymarket: number;
        predictAskDepth: number;    // Predict YES ASK 深度
        predictBidDepth: number;    // Predict YES BID 深度
        polymarketNoAskDepth: number; // Polymarket NO ASK 深度
    };
    polyVolume?: number;            // Polymarket 总成交量 (USD)
    predictVolume?: number;         // Predict 总成交量 (USD)
    lastUpdate: number;         // Timestamp (ms)
    isInverted: boolean;
    side: 'YES' | 'NO';         // YES 端套利 or NO 端套利
    isNew?: boolean;            // 是否是新发现的机会 (用于前端通知)

    // 执行必需字段 (新增)
    polymarketConditionId: string;
    polymarketSlug?: string;       // Polymarket market slug (用于 URL 导航)
    predictSlug?: string;          // Predict market slug (用于 URL 导航)
    polymarketNoTokenId: string;
    polymarketYesTokenId: string;
    tickSize: number;
    feeRateBps: number;
    negRisk: boolean;              // Polymarket negRisk 市场标志

    // Predict 双边价格 (用于 TaskModal)
    predictBid: number;         // YES BID 价格
    predictAsk: number;         // YES ASK 价格

    // 前端显示用的成本 (美分单位)
    makerCost: number;          // Maker 总成本 (¢)
    takerCost: number;          // Taker 总成本 (¢)

    // 风险和费用
    risk: {
        level: 'LOW' | 'MEDIUM' | 'HIGH';
        slippage: number;
    };
    fees: {
        predict: number;
        gas: number;
    };
    costs: {
        total: number;
    };
    endDate?: string;

    // Boost state
    boosted?: boolean;
    boostStartTime?: string;
    boostEndTime?: string;
}

export interface MarketInfo {
    predictId: number;
    title: string;
    polymarketConditionId: string;
    status: 'active' | 'settled' | 'error';
    feeRateBps: number;
    isInverted: boolean;
}

export interface SystemStats {
    latency: {
        predict: number;      // ms
        polymarket: number;   // ms
    };
    connectionStatus: {
        polymarketWs: 'connected' | 'disconnected' | 'reconnecting';
        predictApi: 'ok' | 'rate_limited' | 'error';
    };
    lastFullUpdate: string;   // ISO string
    marketsMonitored: number;
    refreshInterval: number;  // ms
    arbStats: {
        makerCount: number;
        takerCount: number;
        avgProfit: number;
        maxProfit: number;
        totalDepth: number;
    };
    dataVersion: number;      // 递增版本号，用于一致性验证
}

export interface DashboardData {
    opportunities: ArbOpportunity[];
    stats: SystemStats;
    markets: MarketInfo[];
}

export interface Position {
    market: string;
    side: 'YES' | 'NO';
    qty: number;
    avgPrice: number;
}

// ============================================================
// Close Position Types (平仓模块)
// ============================================================

/**
 * 带完整映射信息的持仓腿
 */
export interface PositionLeg {
    polymarketConditionId: string;   // 统一事件键
    predictMarketId?: number;        // Predict 市场 ID
    platform: 'predict' | 'polymarket';
    side: 'YES' | 'NO';
    shares: number;
    avgPrice: number;                // 0-1 价格
    costPerShare: number;            // 每股成本 (avgPrice)
    tokenId?: string;                // Polymarket token ID
    title?: string;                  // 市场/事件标题
}

/**
 * 可平仓的双腿持仓
 */
export interface ClosePosition {
    polymarketConditionId: string;   // 统一事件键
    predictMarketId: number;
    title: string;
    arbSide: ArbSide;                // YES/NO
    predictLeg: PositionLeg;
    polymarketLeg: PositionLeg;
    matchedShares: number;           // 可平仓数量 = min(predict, poly)
    entryCostTotal: number;          // 双腿总成本
    entryCostPerShare: number;       // 每股成本
}

/**
 * 未匹配的单腿持仓 (只在一个平台有持仓)
 */
export interface UnmatchedPosition {
    platform: 'predict' | 'polymarket';
    marketId?: number;               // Predict 市场 ID
    conditionId?: string;            // Polymarket conditionId
    tokenId?: string;                // Polymarket tokenId
    title: string;
    side: 'YES' | 'NO';
    shares: number;
    avgPrice: number;
    reason: 'no_mapping' | 'no_counterpart' | 'direction_mismatch';  // 未匹配原因
}

/**
 * 平仓机会 (T-T / M-T)
 */
export interface CloseOpportunity {
    polymarketConditionId: string;
    predictMarketId: number;
    title: string;
    arbSide: ArbSide;
    matchedShares: number;           // 可平仓数量
    maxCloseShares: number;          // 考虑深度后的最大可卖量

    // 市场详情字段（用于创建任务）
    polymarketYesTokenId?: string;
    polymarketNoTokenId?: string;
    negRisk?: boolean;
    tickSize?: number;
    isInverted?: boolean;  // 反向市场标志

    // T-T (Taker-Taker)
    tt: {
        predictBid: number;          // Predict 买一价
        predictBidDepth: number;     // Predict 买一深度
        polyBid: number;             // Polymarket 买一价
        polyBidDepth: number;        // Polymarket 买一深度
        predictFee: number;          // Predict Taker 手续费
        estProfitPerShare: number;   // 每股预估利润
        estProfitTotal: number;      // 总预估利润
        estProfitPct: number;        // 利润百分比
        minPolyBid: number;          // 最低可接受 Poly 买价
        isValid: boolean;            // 是否有利可图
    };

    // M-T (Maker-Taker)
    mt: {
        predictAsk: number;          // Predict 卖一价 (Maker 挂单价)
        polyBid: number;             // Polymarket 买一价
        polyBidDepth: number;
        maxCloseShares: number;      // M-T 不受 Predict Bid 深度限制
        estProfitPerShare: number;
        estProfitTotal: number;
        estProfitPct: number;
        minPolyBid: number;
        isValid: boolean;
    };

    // 多档深度分析 (T-T 模式)
    depthAnalysis?: CloseDepthAnalysis;

    // 元信息
    feeRateBps: number;
    entryCostPerShare: number;
    lastUpdate: number;
}

/**
 * 订单簿单档分析
 */
export interface DepthLevel {
    price: number;           // 当前档价格
    size: number;            // 当前档深度
    cumulativeSize: number;  // 累计深度
    profitPerShare: number;  // 当前档每股利润
    isProfitable: boolean;   // 当前档是否盈利
    polyPrice: number;       // 对应的 Poly 档位价格
    polySize: number;        // 对应的 Poly 档位深度
}

/**
 * 平仓多档深度分析结果
 */
export interface CloseDepthAnalysis {
    predictLevels: DepthLevel[];    // Predict 各档分析
    polyLevels: DepthLevel[];       // Polymarket 各档分析
    maxProfitableShares: number;    // 最大可盈利数量 (所有盈利档位累计)
    avgProfitPrice: number;         // 平均成交价 (如果成交所有盈利档位)
    totalProfit: number;            // 总利润 (所有盈利档位累计)
    breakEvenPrice: number;         // 盈亏平衡价格 (Predict 侧)
}

export interface AccountBalance {
    total: number;
    available: number;
    portfolio: number;    // 持仓价值 (原 locked)
    positions: Position[];
}

export interface AccountsData {
    predict: AccountBalance;
    polymarket: AccountBalance;
}

// ============================================================
// Task System Types
// ============================================================

export type TaskType = 'BUY' | 'SELL';

export type TaskStatus =
    | 'PENDING'            // 待执行
    | 'VALIDATING'         // 前置校验中
    | 'PREDICT_SUBMITTED'  // Predict 订单已提交
    | 'PARTIALLY_FILLED'   // Predict 部分成交，正在对冲
    | 'PAUSED'             // 价格守护触发，暂停
    | 'TIMEOUT_CANCELLED'  // 超时取消
    | 'HEDGING'            // 正在 Polymarket 对冲
    | 'HEDGE_PENDING'      // 对冲失败，等待重试
    | 'HEDGE_RETRY'        // 对冲重试中
    | 'HEDGE_FAILED'       // 对冲彻底失败
    | 'LOSS_HEDGE'         // 亏损对冲中 (价格超出阈值，等待回落)
    | 'UNWINDING'          // 正在反向平仓
    | 'UNWIND_PENDING'     // 准备反向平仓
    | 'UNWIND_COMPLETED'   // 反向平仓完成
    | 'COMPLETED'          // 成功完成
    | 'FAILED'             // 失败
    | 'CANCELLED';         // 用户取消

export type TaskStrategy = 'MAKER' | 'TAKER';

export type ArbSide = 'YES' | 'NO';  // 套利方向

export interface Task {
    id: string;
    type: TaskType;
    marketId: number;
    title: string;

    // URL 导航字段
    predictSlug?: string;          // Predict market slug
    polymarketSlug?: string;       // Polymarket event/market slug

    // 策略类型（默认 MAKER）
    strategy?: TaskStrategy;

    // 套利方向 (YES端: Predict买YES+Poly买NO, NO端: Predict买NO+Poly买YES)
    arbSide: ArbSide;

    // Market 信息
    polymarketConditionId: string;
    polymarketNoTokenId: string;   // Buy: 买入 NO token 作为对冲
    polymarketYesTokenId: string;  // Sell: 卖出已持有的 NO
    isInverted: boolean;
    tickSize: number;              // Polymarket 动态 tick size
    negRisk: boolean;              // Polymarket negRisk 市场标志

    // 配置 - 价格字段 (区分 BUY/SELL 语义)
    predictPrice: number;          // Predict 挂单价格 (Maker: bid, Taker: ask)
    polymarketMaxAsk: number;      // BUY: 对冲买入 NO 的最大可接受卖价
    polymarketMinBid: number;      // SELL: 对冲卖出 NO 的最小可接受买价

    // Taker 模式专用字段
    predictAskPrice?: number;      // Taker: 下单时的 ask 价格
    maxTotalCost?: number;         // Taker: 最大总成本阈值 (默认 1，totalCost < 1 即盈利)

    quantity: number;              // 目标数量
    minProfitBuffer: number;       // 最小利润缓冲 (如 0.005 = 0.5%)
    orderTimeout: number;          // 单次订单超时 (ms)
    maxHedgeRetries: number;       // 对冲最大重试次数

    // 成本基准 (SELL 任务使用)
    entryCost?: number;            // 原始建仓成本

    // 当前状态
    status: TaskStatus;
    currentOrderHash?: string;     // 当前 Predict 订单 hash
    currentPolyOrderId?: string;   // 当前 Polymarket 订单 ID

    // 进度追踪
    totalQuantity: number;         // 目标总量
    predictFilledQty: number;      // Predict 已成交量
    hedgedQty: number;             // 已对冲量
    remainingQty: number;          // 剩余量

    // 风控计数
    pauseCount: number;            // 价格守护触发次数
    hedgeRetryCount: number;       // 对冲重试次数
    unwindQty: number;             // 反向平仓量

    // 结果
    avgPredictPrice: number;       // Predict 平均成交价
    avgPolymarketPrice: number;    // Polymarket 平均成交价
    actualProfit: number;          // 实际利润
    unwindLoss: number;            // 反向平仓损失
    unwindPrice?: number;          // UNWIND 挂单价格 (best bid)

    // 时间戳
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    expiresAt?: number;            // 任务过期时间 (自动取消)

    // 错误信息
    error?: string;
    errorDetails?: string[];

    // Taker 模式专用: 取消原因
    cancelReason?: 'ORDER_TIMEOUT' | 'COST_INVALID' | 'USER_CANCELLED';

    // Taker 模式专用: 费率 (创建时记录)
    feeRateBps?: number;

    // 体育市场标识 (使用 REST API 而非 WS 获取订单簿)
    isSportsMarket?: boolean;
}

export interface CreateTaskInput {
    type: TaskType;
    marketId: number;
    title: string;
    polymarketConditionId: string;
    polymarketNoTokenId: string;
    polymarketYesTokenId: string;
    isInverted: boolean;
    tickSize: number;
    negRisk: boolean;              // Polymarket negRisk 市场标志
    predictPrice: number;
    polymarketMaxAsk: number;
    polymarketMinBid: number;
    quantity: number;
    minProfitBuffer: number;
    orderTimeout: number;
    maxHedgeRetries: number;
    entryCost?: number;
    idempotencyKey?: string;
    feeRateBps?: number;

    // URL 导航字段
    predictSlug?: string;
    polymarketSlug?: string;

    // 套利方向 (YES端: Predict买YES+Poly买NO, NO端: Predict买NO+Poly买YES)
    arbSide: ArbSide;

    // Taker 模式字段 (可选，strategy='TAKER' 时必填)
    strategy?: TaskStrategy;
    predictAskPrice?: number;      // Taker: 下单时的 ask 价格
    maxTotalCost?: number;         // Taker: 最大总成本阈值 (默认 1，totalCost < 1 即盈利)

    // 任务过期时间 (0 = 不过期, 单位: 小时)
    expiryHours?: number;

    // 体育市场标识 (使用 REST API 而非 WS 获取订单簿)
    isSportsMarket?: boolean;
}

export interface TaskFilter {
    status?: TaskStatus[];
    type?: TaskType;
    marketId?: number;
    includeCompleted?: boolean;
}

// 订单事件
export interface OrderEvent {
    type: 'FILL' | 'PARTIAL_FILL' | 'CANCEL' | 'EXPIRE';
    hash: string;
    filledQty: number;
    remainingQty: number;
    price: number;
    timestamp: number;
}

// 深度计算结果
export interface DepthAnalysis {
    bestPrice: number;
    avgPrice: number;
    availableQty: number;
    isValid: boolean;
    estimatedProfit: number;
}
