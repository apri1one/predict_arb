var Preview = window.Preview || (window.Preview = {});
var { useState, useEffect, useRef, useCallback } = Preview.ReactHooks;
var { Icon } = Preview;
var { API_BASE_URL } = Preview;

// ============================================================================
// ClosePositionCard - 单个平仓机会卡片
// ============================================================================
const ClosePositionCard = ({ opportunity, onTaskCreated, activeTask }) => {
    const [expanded, setExpanded] = useState(false);

    // T-T 状态
    const [ttConfirming, setTtConfirming] = useState(false);
    const [ttSubmitting, setTtSubmitting] = useState(false);
    const [ttError, setTtError] = useState(null);
    const [ttQuantity, setTtQuantity] = useState(opportunity.matchedShares);
    const ttTimeoutRef = useRef(null);

    // M-T 状态
    const [mtConfirming, setMtConfirming] = useState(false);
    const [mtSubmitting, setMtSubmitting] = useState(false);
    const [mtError, setMtError] = useState(null);
    const [mtQuantity, setMtQuantity] = useState(opportunity.matchedShares);
    // 以美分存储 (0-100)，避免浮点精度问题
    const [mtAskPriceCents, setMtAskPriceCents] = useState(
        Math.round((opportunity.mt?.predictAsk || 0.5) * 100 * 10) / 10
    );
    const [mtPriceEdited, setMtPriceEdited] = useState(false);
    const mtTimeoutRef = useRef(null);

    const { tt, mt } = opportunity;

    // 转换为 0-1 格式用于计算
    const mtAskPrice = mtAskPriceCents / 100;

    // 3 秒后重置 T-T 确认状态
    useEffect(() => {
        if (ttConfirming && !ttSubmitting) {
            ttTimeoutRef.current = window.setTimeout(() => {
                setTtConfirming(false);
            }, 3000);
        }
        return () => {
            if (ttTimeoutRef.current) clearTimeout(ttTimeoutRef.current);
        };
    }, [ttConfirming, ttSubmitting]);

    // 3 秒后重置 M-T 确认状态
    useEffect(() => {
        if (mtConfirming && !mtSubmitting) {
            mtTimeoutRef.current = window.setTimeout(() => {
                setMtConfirming(false);
            }, 3000);
        }
        return () => {
            if (mtTimeoutRef.current) clearTimeout(mtTimeoutRef.current);
        };
    }, [mtConfirming, mtSubmitting]);

    // 同步数量
    useEffect(() => {
        // T-T 用 maxCloseShares（受 Predict Bid 深度限制）
        setTtQuantity(opportunity.maxCloseShares);
        // M-T 用 mt.maxCloseShares（不受 Predict Bid 深度限制，只受 Poly Bid 深度限制）
        setMtQuantity(opportunity.mt?.maxCloseShares || opportunity.matchedShares);
        // 同步美分价格，保留一位小数
        if (!mtPriceEdited) {
            setMtAskPriceCents(Math.round((opportunity.mt?.predictAsk || 0.5) * 100 * 10) / 10);
        }
    }, [opportunity.maxCloseShares, opportunity.mt?.maxCloseShares, opportunity.mt?.predictAsk]);

    // 计算 M-T 动态 minPolyBid
    const calcMtMinPolyBid = () => {
        return opportunity.entryCostPerShare - mtAskPrice;
    };

    // 计算 M-T 动态利润
    const calcMtProfit = () => {
        const polyBid = mt?.polyBid || 0;
        const profitPerShare = mtAskPrice + polyBid - opportunity.entryCostPerShare;
        return profitPerShare * mtQuantity;
    };

    // T-T 直接提交任务
    const handleTtClick = async () => {
        if (ttSubmitting) return;

        if (ttConfirming) {
            setTtSubmitting(true);
            setTtError(null);

            try {
                const maxQty = opportunity.maxCloseShares;
                const qty = ttQuantity;
                if (!Number.isFinite(qty) || qty <= 0) {
                    throw new Error('Invalid shares');
                }
                if (qty > maxQty) {
                    throw new Error(`Shares exceed max (${maxQty.toFixed(1)})`);
                }

                const payload = {
                    type: 'SELL',
                    marketId: opportunity.predictMarketId,
                    title: opportunity.title,
                    polymarketConditionId: opportunity.polymarketConditionId,
                    polymarketNoTokenId: opportunity.polymarketNoTokenId || '',
                    polymarketYesTokenId: opportunity.polymarketYesTokenId || '',
                    isInverted: opportunity.isInverted || false,
                    tickSize: opportunity.tickSize || 0.01,
                    negRisk: opportunity.negRisk || false,
                    arbSide: opportunity.arbSide,
                    quantity: qty,
                    entryCost: opportunity.entryCostPerShare * qty,
                    feeRateBps: opportunity.feeRateBps,
                    polymarketMinBid: tt.minPolyBid,
                    strategy: 'TAKER',
                    predictPrice: tt.predictBid,
                    polymarketMaxAsk: 0,
                    minProfitBuffer: 0.001,
                    orderTimeout: 300000,
                    maxHedgeRetries: 3,
                };

                // 1. 创建任务
                const createRes = await fetch(`${API_BASE_URL}/api/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (!createRes.ok) {
                    const errData = await createRes.json().catch(() => ({ message: `HTTP ${createRes.status}` }));
                    throw new Error(errData.message || errData.error || `HTTP ${createRes.status}`);
                }

                const { data: task } = await createRes.json();
                console.log('T-T 平仓任务已创建:', task.id);

                // 2. 自动启动任务
                const startRes = await fetch(`${API_BASE_URL}/api/tasks/${task.id}/start`, {
                    method: 'POST',
                });

                if (!startRes.ok) {
                    const errData = await startRes.json().catch(() => ({ message: `HTTP ${startRes.status}` }));
                    throw new Error(`任务创建成功但启动失败: ${errData.message || errData.error}`);
                }

                console.log('T-T 平仓任务已启动:', task.id);
                setTtConfirming(false);
                onTaskCreated?.();
            } catch (e) {
                setTtError(e.message);
            } finally {
                setTtSubmitting(false);
            }
        } else {
            setTtConfirming(true);
            setTtError(null);
        }
    };

    // M-T 提交任务 (Maker 模式平仓)
    const handleMtClick = async () => {
        if (mtSubmitting) return;

        if (mtConfirming) {
            setMtSubmitting(true);
            setMtError(null);

            try {
                const maxQty = opportunity.matchedShares;
                const qty = mtQuantity;
                if (!Number.isFinite(qty) || qty <= 0) {
                    throw new Error('Invalid shares');
                }
                if (qty > maxQty) {
                    throw new Error(`Shares exceed max (${maxQty.toFixed(1)})`);
                }
                if (!Number.isFinite(mtAskPriceCents) || mtAskPriceCents <= 0 || mtAskPriceCents >= 100) {
                    throw new Error('Invalid ask price (0 < price < 100¢)');
                }

                const dynamicMinPolyBid = calcMtMinPolyBid();

                const payload = {
                    type: 'SELL',
                    marketId: opportunity.predictMarketId,
                    title: opportunity.title,
                    polymarketConditionId: opportunity.polymarketConditionId,
                    polymarketNoTokenId: opportunity.polymarketNoTokenId || '',
                    polymarketYesTokenId: opportunity.polymarketYesTokenId || '',
                    isInverted: opportunity.isInverted || false,
                    tickSize: opportunity.tickSize || 0.01,
                    negRisk: opportunity.negRisk || false,
                    arbSide: opportunity.arbSide,
                    quantity: qty,
                    entryCost: opportunity.entryCostPerShare * qty,
                    feeRateBps: opportunity.feeRateBps,
                    polymarketMinBid: dynamicMinPolyBid,
                    strategy: 'MAKER',
                    predictPrice: mtAskPrice,  // Maker 挂单价格
                    polymarketMaxAsk: 0,
                    minProfitBuffer: 0.001,
                    orderTimeout: 300000,
                    maxHedgeRetries: 3,
                };

                // 1. 创建任务
                const createRes = await fetch(`${API_BASE_URL}/api/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (!createRes.ok) {
                    const errData = await createRes.json().catch(() => ({ message: `HTTP ${createRes.status}` }));
                    throw new Error(errData.message || errData.error || `HTTP ${createRes.status}`);
                }

                const { data: task } = await createRes.json();
                console.log('M-T 平仓任务已创建:', task.id);

                // 2. 自动启动任务
                const startRes = await fetch(`${API_BASE_URL}/api/tasks/${task.id}/start`, {
                    method: 'POST',
                });

                if (!startRes.ok) {
                    const errData = await startRes.json().catch(() => ({ message: `HTTP ${startRes.status}` }));
                    throw new Error(`任务创建成功但启动失败: ${errData.message || errData.error}`);
                }

                console.log('M-T 平仓任务已启动:', task.id);
                setMtConfirming(false);
                onTaskCreated?.();
            } catch (e) {
                setMtError(e.message);
            } finally {
                setMtSubmitting(false);
            }
        } else {
            setMtConfirming(true);
            setMtError(null);
        }
    };

    const formatPrice = (p) => (p * 100).toFixed(1) + '¢';
    const formatProfit = (p) => p >= 0 ? `+$${p.toFixed(2)}` : `-$${Math.abs(p).toFixed(2)}`;
    const formatPct = (p) => p >= 0 ? `+${p.toFixed(1)}%` : `${p.toFixed(1)}%`;

    const bestMode = tt.estProfitTotal >= mt.estProfitTotal ? 'TT' : 'MT';
    const bestProfit = Math.max(tt.estProfitTotal, mt.estProfitTotal);
    const isProfitable = bestProfit > 0;

    // M-T 动态计算
    const mtDynamicProfit = calcMtProfit();
    const mtDynamicMinPolyBid = calcMtMinPolyBid();
    const mtIsValid = mtDynamicProfit > 0;

    // 任务标签
    const hasActiveTask = !!activeTask;
    const taskStatus = activeTask?.status;
    const isExecuting = ['PREDICT_SUBMITTED', 'PARTIALLY_FILLED', 'HEDGING', 'HEDGE_PENDING', 'HEDGE_RETRY'].includes(taskStatus);
    const isPaused = taskStatus === 'PAUSED';
    const isPending = taskStatus === 'PENDING';

    // 任务状态简短标签
    const getTaskLabel = () => {
        if (isPending) return '待启动';
        if (isPaused) return '暂停中';
        if (isExecuting) return '执行中';
        if (taskStatus === 'VALIDATING') return '校验中';
        return 'SELL';
    };

    // 任务状态颜色
    const getTaskColor = () => {
        if (isPending) return '#f59e0b';    // amber
        if (isPaused) return '#6366f1';     // indigo
        if (isExecuting) return '#ef4444';  // red
        return '#ef4444';
    };

    return (
        <div className={`glass-card rounded-xl border transition-all overflow-hidden relative ${isProfitable ? 'border-emerald-500/30' : 'border-rose-500/20'}`}>
            {/* 活跃任务标签 (斜角丝带) */}
            {hasActiveTask && (
                <div
                    className={`absolute top-2 -left-7 transform -rotate-45 text-[9px] font-semibold uppercase tracking-wider text-white px-8 py-0.5 z-10 pointer-events-none ${isExecuting ? 'animate-pulse' : ''}`}
                    style={{ background: getTaskColor() }}
                    title={`任务 #${activeTask.id?.slice(0, 8)} - ${taskStatus}`}
                >
                    {getTaskLabel()}
                </div>
            )}

            {/* Header */}
            <div className="p-4 border-b border-zinc-800/50">
                <div className="flex items-start justify-between gap-2">
                    <h4 className="text-sm font-medium text-white leading-tight line-clamp-2 flex-1">
                        {opportunity.title}
                    </h4>
                    <div className="flex gap-1.5 shrink-0">
                        <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${opportunity.arbSide === 'YES' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-700 text-zinc-300'}`}>
                            {opportunity.arbSide}
                        </span>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${isProfitable ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}`}>
                            {isProfitable ? 'PROFIT' : 'LOSS'}
                        </span>
                    </div>
                </div>
            </div>

            <div className="p-4 space-y-4">
                {/* 持仓概要 */}
                <div className="grid grid-cols-3 gap-3 text-xs">
                    <div>
                        <div className="text-zinc-500 mb-1">持仓</div>
                        <div className="font-mono text-white">{opportunity.matchedShares.toFixed(1)} shares</div>
                    </div>
                    <div>
                        <div className="text-zinc-500 mb-1">成本</div>
                        <div className="font-mono text-white">{formatPrice(opportunity.entryCostPerShare)}/share</div>
                    </div>
                    <div>
                        <div className="text-zinc-500 mb-1">最佳收益</div>
                        <div className={`font-mono font-medium ${isProfitable ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {formatProfit(bestProfit)}
                        </div>
                    </div>
                </div>

                {/* T-T vs M-T 对比 */}
                <div className="grid grid-cols-2 gap-3">
                    {/* T-T Mode */}
                    <div className={`p-3 rounded-lg border ${tt.isValid ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5'}`}>
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-white">T-T (Taker)</span>
                            {bestMode === 'TT' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">Best</span>}
                        </div>
                        <div className="space-y-1.5 text-[11px]">
                            <div className="flex justify-between">
                                <span className="text-zinc-500">Predict Bid</span>
                                <span className="font-mono text-zinc-300">{formatPrice(tt.predictBid)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-zinc-500">Poly Bid</span>
                                <span className="font-mono text-zinc-300">{formatPrice(tt.polyBid)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-zinc-500">Fee</span>
                                <span className="font-mono text-rose-400">-${(tt.predictFee * opportunity.matchedShares).toFixed(2)}</span>
                            </div>
                            {/* 多档深度摘要 */}
                            {opportunity.depthAnalysis && (
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">可盈利深度</span>
                                    <span className={`font-mono ${opportunity.depthAnalysis.maxProfitableShares > 0 ? 'text-emerald-400' : 'text-zinc-400'}`}>
                                        {opportunity.depthAnalysis.maxProfitableShares.toFixed(1)} shares
                                    </span>
                                </div>
                            )}
                            <div className={`flex justify-between font-medium pt-1 border-t border-zinc-800/50 ${tt.isValid ? 'text-emerald-400' : 'text-rose-400'}`}>
                                <span>Profit</span>
                                <span>{formatProfit(opportunity.depthAnalysis?.totalProfit || tt.estProfitTotal)} ({formatPct(tt.estProfitPct)})</span>
                            </div>
                        </div>

                        {/* 多档深度展示 */}
                        {opportunity.depthAnalysis?.predictLevels?.length > 1 && (
                            <div className="mt-2 pt-2 border-t border-zinc-800/30">
                                <div className="text-[10px] text-zinc-500 mb-1.5">深度档位</div>
                                <div className="space-y-1 max-h-20 overflow-y-auto">
                                    {opportunity.depthAnalysis.predictLevels.slice(0, 5).map((level, i) => (
                                        <div key={i} className={`flex justify-between text-[10px] ${level.isProfitable ? 'text-emerald-400/80' : 'text-rose-400/60'}`}>
                                            <span className="font-mono">{formatPrice(level.price)} × {level.size.toFixed(0)}</span>
                                            <span className="font-mono">{level.isProfitable ? '+' : ''}{(level.profitPerShare * 100).toFixed(2)}¢</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* T-T 按钮与数量输入 */}
                        {tt.isValid && (
                            <div className="mt-3 space-y-2">
                                <div className="flex items-center justify-between text-[10px] text-zinc-500">
                                    <span>Shares</span>
                                    <span>Max {opportunity.maxCloseShares.toFixed(1)}</span>
                                </div>
                                <input
                                    type="number"
                                    className="w-full px-2 py-1.5 text-xs font-mono bg-zinc-900 border border-zinc-700 rounded text-white focus:border-amber-500 focus:outline-none"
                                    value={ttQuantity}
                                    min={0}
                                    max={opportunity.maxCloseShares}
                                    step={0.1}
                                    onChange={(e) => {
                                        const next = parseFloat(e.target.value);
                                        setTtQuantity(Number.isFinite(next) ? next : 0);
                                        setTtConfirming(false);
                                        setTtError(null);
                                    }}
                                />
                                {ttQuantity > opportunity.maxCloseShares && (
                                    <div className="text-[10px] text-rose-400">超过深度限制</div>
                                )}
                                <button
                                    className={`w-full py-2 text-xs font-medium rounded-lg transition-all ${
                                        ttConfirming
                                            ? 'bg-rose-500 text-white animate-pulse'
                                            : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
                                    } ${(ttSubmitting || ttQuantity <= 0 || ttQuantity > opportunity.maxCloseShares) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    onClick={handleTtClick}
                                    disabled={ttSubmitting || ttQuantity <= 0 || ttQuantity > opportunity.maxCloseShares}
                                >
                                    {ttSubmitting ? '提交中...' : ttConfirming ? '确认执行 (3s)' : 'T-T 平仓'}
                                </button>
                                {ttError && (
                                    <div className="text-[10px] text-rose-400 truncate" title={ttError}>{ttError}</div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* M-T Mode */}
                    <div className={`p-3 rounded-lg border ${mtIsValid ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5'}`}>
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-white">M-T (Maker)</span>
                            {bestMode === 'MT' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">Best</span>}
                        </div>
                        <div className="space-y-1.5 text-[11px]">
                            <div className="flex justify-between">
                                <span className="text-zinc-500">Predict Ask</span>
                                <span className="font-mono text-zinc-300">{formatPrice(mt.predictAsk)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-zinc-500">Poly Bid</span>
                                <span className="font-mono text-zinc-300">{formatPrice(mt.polyBid)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-zinc-500">Fee</span>
                                <span className="font-mono text-emerald-400">0¢ (Maker)</span>
                            </div>
                            <div className={`flex justify-between font-medium pt-1 border-t border-zinc-800/50 ${mtIsValid ? 'text-emerald-400' : 'text-rose-400'}`}>
                                <span>Profit</span>
                                <span>{formatProfit(mtDynamicProfit)}</span>
                            </div>
                        </div>

                        {/* M-T 表单 */}
                        <div className="mt-3 space-y-2">
                            <div className="flex items-center justify-between text-[10px] text-zinc-500">
                                <span>挂单价 (美分 ¢)</span>
                                <span>当前 Ask: {formatPrice(mt.predictAsk)}</span>
                            </div>
                            <div className="relative">
                                <input
                                    type="number"
                                    className="w-full px-2 py-1.5 pr-6 text-xs font-mono bg-zinc-900 border border-zinc-700 rounded text-white focus:border-amber-500 focus:outline-none"
                                    value={mtAskPriceCents}
                                    min={0.1}
                                    max={99.9}
                                    step={0.1}
                                    onChange={(e) => {
                                        const next = parseFloat(e.target.value);
                                        // 保留一位小数，避免浮点精度问题
                                        const rounded = Number.isFinite(next) ? Math.round(next * 10) / 10 : 0;
                                        setMtPriceEdited(true);
                                        setMtAskPriceCents(rounded);
                                        setMtConfirming(false);
                                        setMtError(null);
                                    }}
                                />
                                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500">¢</span>
                            </div>
                            <div className="flex items-center justify-between text-[10px] text-zinc-500">
                                <span>Shares</span>
                                <span>Max {(mt?.maxCloseShares || opportunity.matchedShares).toFixed(1)}</span>
                            </div>
                            <input
                                type="number"
                                className="w-full px-2 py-1.5 text-xs font-mono bg-zinc-900 border border-zinc-700 rounded text-white focus:border-amber-500 focus:outline-none"
                                value={mtQuantity}
                                min={0}
                                max={mt?.maxCloseShares || opportunity.matchedShares}
                                step={0.1}
                                onChange={(e) => {
                                    const next = parseFloat(e.target.value);
                                    setMtQuantity(Number.isFinite(next) ? next : 0);
                                    setMtConfirming(false);
                                    setMtError(null);
                                }}
                            />
                            <div className="text-[10px] text-zinc-500">
                                Min Poly Bid: {formatPrice(mtDynamicMinPolyBid)}
                            </div>
                            {mtQuantity > (mt?.maxCloseShares || opportunity.matchedShares) && (
                                <div className="text-[10px] text-rose-400">超过深度限制</div>
                            )}
                            <button
                                className={`w-full py-2 text-xs font-medium rounded-lg transition-all ${
                                    mtConfirming
                                        ? 'bg-rose-500 text-white animate-pulse'
                                        : mtIsValid
                                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
                                            : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                                } ${(mtSubmitting || mtQuantity <= 0 || mtQuantity > (mt?.maxCloseShares || opportunity.matchedShares)) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                onClick={handleMtClick}
                                disabled={mtSubmitting || mtQuantity <= 0 || mtQuantity > (mt?.maxCloseShares || opportunity.matchedShares)}
                            >
                                {mtSubmitting ? '提交中...' : mtConfirming ? '确认执行 (3s)' : 'M-T 平仓'}
                            </button>
                            {mtError && (
                                <div className="text-[10px] text-rose-400 truncate" title={mtError}>{mtError}</div>
                            )}
                        </div>
                    </div>
                </div>

                {/* 展开详情 */}
                {expanded && (
                    <div className="text-[11px] space-y-1.5 pt-3 border-t border-zinc-800/50">
                        <div className="flex justify-between">
                            <span className="text-zinc-500">Market ID</span>
                            <span className="font-mono text-zinc-300">{opportunity.predictMarketId}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-zinc-500">可卖深度</span>
                            <span className="font-mono text-zinc-300">{opportunity.maxCloseShares.toFixed(1)} shares</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-zinc-500">T-T Min Poly Bid</span>
                            <span className="font-mono text-zinc-300">{formatPrice(tt.minPolyBid)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-zinc-500">M-T Min Poly Bid</span>
                            <span className="font-mono text-zinc-300">{formatPrice(mtDynamicMinPolyBid)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-zinc-500">isInverted</span>
                            <span className="font-mono text-zinc-300">{opportunity.isInverted ? 'true' : 'false'}</span>
                        </div>
                    </div>
                )}

                <button
                    className="w-full py-2 text-[11px] text-zinc-500 hover:text-white transition-colors"
                    onClick={() => setExpanded(!expanded)}
                >
                    {expanded ? '收起' : '展开详情'}
                </button>
            </div>
        </div>
    );
};

// ============================================================================
// ClosePositionTab - 平仓管理标签页
// ============================================================================
const ClosePositionTab = ({ onSwitchToTasks, tasks = [] }) => {
    const [opportunities, setOpportunities] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastRefresh, setLastRefresh] = useState(null);
    const [isCached, setIsCached] = useState(false);

    // forceRefresh: true 强制刷新，false 使用缓存
    const fetchOpportunities = useCallback(async (forceRefresh = false) => {
        setLoading(true);
        setError(null);
        try {
            const url = forceRefresh
                ? `${API_BASE_URL}/api/close-opportunities?refresh=true`
                : `${API_BASE_URL}/api/close-opportunities`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setOpportunities(data.opportunities || []);
            setIsCached(data.cached || false);
            // 使用服务端返回的更新时间
            setLastRefresh(data.lastUpdate ? new Date(data.lastUpdate) : new Date());
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // 初始加载使用缓存
        fetchOpportunities(false);
        // 定时刷新也使用缓存（后台定时器会更新缓存）
        const interval = setInterval(() => fetchOpportunities(false), 30000);
        return () => clearInterval(interval);
    }, [fetchOpportunities]);

    // 手动刷新强制重新计算
    const handleManualRefresh = () => {
        fetchOpportunities(true);
    };

    const handleTaskCreated = () => {
        // 任务创建后使用缓存刷新（后台定时器会更新缓存）
        fetchOpportunities(false);
    };

    const profitableCount = opportunities.filter(o => o.tt?.isValid || o.mt?.isValid).length;
    const totalPotentialProfit = opportunities.reduce((sum, o) =>
        sum + Math.max(o.tt?.estProfitTotal || 0, o.mt?.estProfitTotal || 0), 0
    );

    return (
        <div className="space-y-6">
            {/* 统计摘要 */}
            <div className="glass-card rounded-xl border border-zinc-800/50 p-5">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-display text-sm font-medium text-white flex items-center gap-2">
                        <Icon name="briefcase" size={16} className="text-amber-500" />
                        平仓机会
                    </h3>
                    <button
                        onClick={handleManualRefresh}
                        disabled={loading}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                            loading
                                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                                : 'bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20'
                        }`}
                    >
                        <Icon name={loading ? "loader" : "refresh-cw"} size={12} className={loading ? 'animate-spin' : ''} />
                        {loading ? '刷新中...' : '刷新'}
                    </button>
                </div>
                <div className="grid grid-cols-4 gap-6">
                    <div>
                        <div className="text-zinc-500 text-xs mb-1">持仓数</div>
                        <div className="text-2xl font-display font-semibold text-white">{opportunities.length}</div>
                    </div>
                    <div>
                        <div className="text-zinc-500 text-xs mb-1">可盈利</div>
                        <div className="text-2xl font-display font-semibold text-emerald-400">{profitableCount}</div>
                    </div>
                    <div>
                        <div className="text-zinc-500 text-xs mb-1">潜在收益</div>
                        <div className={`text-2xl font-display font-semibold ${totalPotentialProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {totalPotentialProfit >= 0 ? '+' : ''}${totalPotentialProfit.toFixed(2)}
                        </div>
                    </div>
                    <div>
                        <div className="text-zinc-500 text-xs mb-1">最后更新</div>
                        <div className="text-sm font-mono text-zinc-300">
                            {lastRefresh ? lastRefresh.toLocaleTimeString() : '-'}
                        </div>
                    </div>
                </div>
            </div>

            {/* 错误提示 */}
            {error && (
                <div className="glass-card rounded-xl border border-rose-500/30 p-4">
                    <p className="text-rose-400 text-sm">加载失败: {error}</p>
                </div>
            )}

            {/* 机会列表 */}
            {opportunities.length === 0 && !loading && !error ? (
                <div className="flex flex-col items-center justify-center py-20 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30">
                    <Icon name="inbox" size={48} className="text-zinc-600 mb-4" strokeWidth={1} />
                    <p className="text-zinc-400">暂无可平仓的持仓</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {opportunities.map((opp) => {
                        // 查找该市场的活跃 SELL 任务
                        const activeTask = tasks.find(t =>
                            t.marketId === opp.predictMarketId &&
                            t.type === 'SELL' &&
                            !['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'].includes(t.status)
                        );
                        return (
                            <ClosePositionCard
                                key={`${opp.predictMarketId}-${opp.arbSide}`}
                                opportunity={opp}
                                onTaskCreated={handleTaskCreated}
                                activeTask={activeTask}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
};

// 导出组件
Preview.Components = Preview.Components || {};
Preview.Components.ClosePositionTab = ClosePositionTab;
Preview.Components.ClosePositionCard = ClosePositionCard;
