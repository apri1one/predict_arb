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
    };
    lastUpdate: number;         // Timestamp (ms)
    isInverted: boolean;
    // 用于跳转链接
    polymarketConditionId?: string;
    predictSlug?: string;
    polymarketSlug?: string;
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
