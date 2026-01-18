var Preview = window.Preview || (window.Preview = {});

// --- Data Helpers ---
const mapOpportunity = (raw) => {
    const profitPercent = Number(raw?.profitPercent || 0);
    const maxQuantity = Number(raw?.maxQuantity || 0);
    const predictPrice = Number(raw?.predictPrice || 0);
    const polymarketPrice = Number(raw?.polymarketPrice || 0);
    const estimatedProfit = Number(raw?.estimatedProfit || 0);
    const depthPredict = Number(raw?.depth?.predict || 0);
    const depthPolymarket = Number(raw?.depth?.polymarket || 0);
    const totalCost = Number(raw?.totalCost || 0);
    const polymarketConditionId = raw?.polymarketConditionId || '';
    const polymarketSlug = raw?.polymarketSlug || '';
    const predictSlug = raw?.predictSlug || '';  // 后端验证过的 Predict URL slug
    const polymarketNoTokenId = raw?.polymarketNoTokenId || '';
    const polymarketYesTokenId = raw?.polymarketYesTokenId || '';
    const tickSize = Number(raw?.tickSize || 0);
    const feeRateBps = Number(raw?.feeRateBps || 0);
    const negRisk = Boolean(raw?.negRisk);  // Polymarket negRisk 市场标志
    // Volume 数据
    const predictVolume = Number(raw?.predictVolume || 0);
    const polyVolume = Number(raw?.polyVolume || 0);
    // 新增: Predict 买卖价格 (兼容两种字段名)
    const predictBid = Number(raw?.predictYesBid || raw?.predictBid || 0);
    const predictAsk = Number(raw?.predictYesAsk || raw?.predictAsk || 0);
    // 后端计算好的成本（已包含正确的市场费率）
    const makerCost = Number(raw?.makerCost || 0);
    const takerCost = Number(raw?.takerCost || 0);
    const predictFeeFromBackend = Number(raw?.predictFee || 0);
    // 新增: YES/NO 端标识
    const side = raw?.side || 'YES';

    const notional = Math.max(0, (predictPrice + polymarketPrice) * maxQuantity);
    const predictFee = notional * 0.02;
    const gas = Math.min(1.5, 0.2 + notional * 0.001);

    const riskLevel = profitPercent < 1 || maxQuantity < 20
        ? 'HIGH'
        : (profitPercent < 2.5 || maxQuantity < 60 ? 'MED' : 'LOW');
    const slippage = Math.max(0.2, Math.min(2.5, profitPercent < 1 ? 1.8 : profitPercent < 2 ? 1.1 : 0.6));

    return {
        id: `${raw?.marketId || 'm'}-${side}-${raw?.strategy || 'UNK'}`,
        marketId: raw?.marketId || 0,
        title: raw?.title || 'Unknown Market',
        strategy: raw?.strategy || 'MAKER',
        side,
        profitPercent,
        maxQuantity,
        estimatedProfit,
        predictPrice,
        predictBid,
        predictAsk,
        polymarketPrice,
        totalCost,
        makerCost,
        takerCost,
        predictFeeFromBackend,
        polymarketConditionId,
        polymarketSlug,
        predictSlug,
        polymarketNoTokenId,
        polymarketYesTokenId,
        tickSize,
        feeRateBps,
        negRisk,
        predictVolume,
        polyVolume,
        depth: {
            predict: depthPredict,
            polymarket: depthPolymarket,
            predictBidDepth: Number(raw?.depth?.predictBidDepth || 0),
            predictAskDepth: Number(raw?.depth?.predictAskDepth || 0),
            polymarketNoAskDepth: Number(raw?.depth?.polymarketNoAskDepth || 0),
        },
        lastUpdate: raw?.lastUpdate || Date.now(),
        isInverted: Boolean(raw?.isInverted),
        isNew: Boolean(raw?.isNew),     // 是否是新发现的机会
        endDate: raw?.endDate || null,  // 结算时间 (ISO 8601)
        risk: {
            level: riskLevel,
            slippage,
        },
        fees: {
            predict: predictFee,
            gas,
        },
        costs: {
            total: predictFee + gas,
        },
    };
};

Preview.mapOpportunity = mapOpportunity;
