import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
    Activity,
    Zap,
    Server,
    RefreshCw,
    TrendingUp,
    DollarSign,
    Clock,
    Wifi,
    ChevronDown,
    ChevronUp,
    Search,
    Layers,
    ArrowRight,
    Maximize2,
    BarChart3,
    SlidersHorizontal,
    ArrowUpDown,
    History,
    AlertTriangle,
    ArrowLeftRight,
    Filter,
    Bell,
    Settings,
    X
} from 'lucide-react';

// --- Types ---

interface Market {
    id: string;
    title: string;
    category: string;
}

interface RiskMetrics {
    level: 'LOW' | 'MED' | 'HIGH';
    score: number; // 0-100
    slippage: number; // %
}

interface FeeBreakdown {
    predict: number;
    polymarket: number;
    gas: number;
    total: number;
}

interface Opportunity {
    id: string;
    marketId: string;
    title: string;
    strategy: 'MAKER' | 'TAKER';
    profitPercent: number;
    maxQuantity: number;
    estimatedProfit: number;
    predictPrice: number;
    polymarketPrice: number;
    depth: {
        predict: number;
        polymarket: number;
    };
    lastUpdate: number;
    isInverted: boolean;
    // New Fields
    risk: RiskMetrics;
    fees: FeeBreakdown;
    costs: {
        makerLeg: number;
        takerLeg: number;
        total: number;
    };
}

interface HistoryRecord extends Opportunity {
    timestamp: number;
    status: 'EXECUTED' | 'EXPIRED' | 'FAILED';
    realizedProfit?: number;
}

interface SystemStats {
    makerCount: number;
    takerCount: number;
    avgProfit: number;
    maxProfit: number;
    totalDepthUsd: number;
    latency: {
        predict: number;
        polymarket: number;
        compute: number;
    };
}

// --- Mock Data & Simulation ---

const MOCK_MARKETS: Market[] = [
    { id: '542', title: 'Bitcoin to hit $100k by 2024?', category: 'Crypto' },
    { id: '691', title: 'Ethereum above $4k on Dec 31?', category: 'Crypto' },
    { id: '772', title: 'Fed to cut rates in Jan?', category: 'Economics' },
    { id: '881', title: 'SpaceX Starship orbital launch success?', category: 'Science' },
    { id: '902', title: 'Oil prices > $90/bbl?', category: 'Economics' },
    { id: '104', title: '2024 Election: Candidate X wins?', category: 'Politics' },
];

const generateHistory = (count: number): HistoryRecord[] => {
    return Array.from({ length: count }).map((_, i) => {
        const isWin = Math.random() > 0.2;
        return {
            id: `hist-${i}`,
            marketId: MOCK_MARKETS[i % MOCK_MARKETS.length].id,
            title: MOCK_MARKETS[i % MOCK_MARKETS.length].title,
            strategy: (Math.random() > 0.5 ? 'MAKER' : 'TAKER') as 'MAKER' | 'TAKER',
            profitPercent: Number((Math.random() * 5).toFixed(2)),
            maxQuantity: Math.floor(Math.random() * 500),
            estimatedProfit: Math.random() * 20,
            predictPrice: 0.5,
            polymarketPrice: 0.55,
            depth: { predict: 1000, polymarket: 1000 },
            lastUpdate: Date.now() - Math.random() * 10000000,
            isInverted: Math.random() > 0.8,
            risk: { level: 'LOW' as const, score: 10, slippage: 0.1 },
            fees: { predict: 0.1, polymarket: 0, gas: 0.05, total: 0.15 },
            costs: { makerLeg: 50, takerLeg: 50, total: 100 },
            timestamp: Date.now() - Math.random() * 86400000,
            status: (isWin ? 'EXECUTED' : (Math.random() > 0.5 ? 'EXPIRED' : 'FAILED')) as 'EXECUTED' | 'EXPIRED' | 'FAILED',
            realizedProfit: isWin ? Math.random() * 20 : 0
        };
    }).sort((a, b) => b.timestamp - a.timestamp);
};

// SSE 数据映射函数
const mapOpportunity = (raw: any): Opportunity => {
    const profitPercent = Number(raw?.profitPercent || 0);
    const maxQuantity = Number(raw?.maxQuantity || 0);
    const predictPrice = Number(raw?.predictPrice || 0);
    const polymarketPrice = Number(raw?.polymarketPrice || 0);
    const estimatedProfit = Number(raw?.estimatedProfit || 0);
    const depthPredict = Number(raw?.depth?.predict || 0);
    const depthPolymarket = Number(raw?.depth?.polymarket || 0);
    const totalCost = Number(raw?.totalCost || 0);

    const notional = Math.max(0, (predictPrice + polymarketPrice) * maxQuantity);
    const predictFee = notional * 0.02;
    const gas = Math.min(1.5, 0.2 + notional * 0.001);

    const riskLevel: RiskMetrics['level'] = profitPercent < 1 || maxQuantity < 20
        ? 'HIGH'
        : (profitPercent < 2.5 || maxQuantity < 60 ? 'MED' : 'LOW');
    const slippage = Math.max(0.2, Math.min(2.5, profitPercent < 1 ? 1.8 : profitPercent < 2 ? 1.1 : 0.6));
    const riskScore = riskLevel === 'LOW' ? 20 : riskLevel === 'MED' ? 50 : 80;

    return {
        id: `${raw?.marketId || 'm'}-${raw?.strategy || 'UNK'}`,
        marketId: String(raw?.marketId || 0),
        title: raw?.title || 'Unknown Market',
        strategy: (raw?.strategy || 'MAKER') as 'MAKER' | 'TAKER',
        profitPercent,
        maxQuantity,
        estimatedProfit,
        predictPrice,
        polymarketPrice,
        depth: {
            predict: depthPredict,
            polymarket: depthPolymarket,
        },
        lastUpdate: raw?.lastUpdate || Date.now(),
        isInverted: Boolean(raw?.isInverted),
        risk: {
            level: riskLevel,
            score: riskScore,
            slippage,
        },
        fees: {
            predict: predictFee,
            polymarket: 0,
            gas,
            total: predictFee + gas,
        },
        costs: {
            makerLeg: totalCost * 0.5,
            takerLeg: totalCost * 0.5,
            total: totalCost,
        },
    };
};

const useArbScanner = () => {
    const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
    const [history, setHistory] = useState<HistoryRecord[]>([]);
    const [stats, setStats] = useState<SystemStats>({
        makerCount: 0,
        takerCount: 0,
        avgProfit: 0,
        maxProfit: 0,
        totalDepthUsd: 0,
        latency: { predict: 150, polymarket: 25, compute: 5 }
    });
    const [isConnected, setIsConnected] = useState(false);
    const eventSourceRef = useRef<EventSource | null>(null);
    const reconnectTimeoutRef = useRef<number | null>(null);

    // 检测 API 基础 URL
    const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:3003'
        : '';

    // SSE 连接函数
    const connectSSE = React.useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        console.log('📡 正在连接后端 SSE...');
        const es = new EventSource(`${API_BASE_URL}/api/stream`);
        eventSourceRef.current = es;

        es.onopen = () => {
            console.log('✅ SSE 已连接');
            setIsConnected(true);
        };

        es.onerror = () => {
            console.log('❌ SSE 错误，3 秒后重连...');
            setIsConnected(false);
            es.close();

            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = setTimeout(connectSSE, 3000);
        };

        // 处理套利机会更新
        es.addEventListener('opportunity', (e) => {
            try {
                const rawOpps = JSON.parse(e.data);
                const opps = Array.isArray(rawOpps) ? rawOpps.map(mapOpportunity) : [];
                setOpportunities(opps);
            } catch (err) {
                console.error('解析 opportunity 数据错误:', err);
            }
        });

        // 处理统计信息更新
        es.addEventListener('stats', (e) => {
            try {
                const data = JSON.parse(e.data);
                setStats({
                    makerCount: data.arbStats?.makerCount || 0,
                    takerCount: data.arbStats?.takerCount || 0,
                    avgProfit: data.arbStats?.avgProfit || 0,
                    maxProfit: data.arbStats?.maxProfit || 0,
                    totalDepthUsd: data.arbStats?.totalDepth || 0,
                    latency: {
                        predict: Math.round(data.latency?.predict || 0),
                        polymarket: Math.round(data.latency?.polymarket || 0),
                        compute: Math.round(data.refreshInterval || 0) / 1000
                    }
                });
            } catch (err) {
                console.error('解析 stats 数据错误:', err);
            }
        });
    }, [API_BASE_URL]);

    // 初始化
    useEffect(() => {
        setHistory(generateHistory(15));
        connectSSE();

        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
            }
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
        };
    }, [connectSSE]);

    return { opportunities, history, stats, isConnected };
};

// --- Components ---

const Badge = ({ children, variant = 'default', icon: Icon }: { children: React.ReactNode, variant?: 'default' | 'success' | 'warning' | 'danger' | 'inverted', icon?: any }) => {
    const styles = {
        default: "bg-surface text-muted border-border",
        success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
        warning: "bg-accent-dim text-accent border-accent/20",
        danger: "bg-rose-500/10 text-rose-400 border-rose-500/20",
        inverted: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    };

    return (
        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-medium tracking-wide border ${styles[variant]} backdrop-blur-sm flex items-center gap-1`}>
            {Icon && <Icon size={10} />}
            {children}
        </span>
    );
};

const Card = ({ children, className = '', noPadding = false }: { children: React.ReactNode, className?: string, noPadding?: boolean }) => (
    <div className={`glass-card rounded-xl transition-all duration-300 hover:border-borderHover hover:shadow-lg ${className}`}>
        <div className={`${noPadding ? '' : 'p-6'}`}>
            {children}
        </div>
    </div>
);

const RiskIndicator = ({ level, score }: { level: RiskMetrics['level'], score: number }) => {
    const colors = {
        LOW: 'bg-emerald-500',
        MED: 'bg-yellow-500',
        HIGH: 'bg-rose-500'
    };

    return (
        <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted">
                <span>Risk Score</span>
                <span className={level === 'LOW' ? 'text-emerald-400' : level === 'MED' ? 'text-yellow-400' : 'text-rose-400'}>{level} ({score})</span>
            </div>
            <div className="h-1.5 w-24 bg-surface rounded-full overflow-hidden border border-border">
                <div
                    className={`h-full ${colors[level]} transition-all duration-500`}
                    style={{ width: `${score}%` }}
                />
            </div>
        </div>
    );
};

const StatCard = ({ title, value, subValue, icon: Icon }: any) => (
    <Card className="flex flex-col justify-between h-full group hover:bg-surface/80">
        <div className="flex justify-between items-start mb-4">
            <div className="text-muted text-xs font-medium tracking-wide uppercase">{title}</div>
            <div className="p-2 rounded-lg bg-surface border border-border group-hover:border-accent/30 transition-colors">
                <Icon size={18} strokeWidth={1.5} className="text-muted group-hover:text-accent transition-colors" />
            </div>
        </div>
        <div>
            <div className="text-3xl font-display font-medium text-foreground tracking-tight mb-1">{value}</div>
            {subValue && (
                <div className="flex items-center gap-2">
                    <div className="text-xs font-sans text-muted">{subValue}</div>
                </div>
            )}
        </div>
    </Card>
);

const OpportunityCard = ({ opp }: { opp: Opportunity }) => {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="group mb-4">
            <div
                className={`glass-card rounded-xl border border-border transition-all duration-300 overflow-hidden 
        ${expanded ? 'border-accent/30 shadow-glow-sm bg-surface/80' : 'hover:border-white/10 hover:scale-[1.005]'}`}
            >
                {/* Header Summary */}
                <div
                    className="p-5 cursor-pointer flex items-center justify-between"
                    onClick={() => setExpanded(!expanded)}
                >
                    <div className="flex items-center gap-5 min-w-0 flex-1">
                        {/* ID & Status */}
                        <div className="flex flex-col items-center justify-center w-12 h-12 rounded-full bg-surface border border-border group-hover:border-accent/40 transition-colors shrink-0">
                            <span className="text-[10px] font-mono text-muted group-hover:text-accent transition-colors">#{opp.marketId}</span>
                        </div>

                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 mb-1.5">
                                <Badge variant={opp.strategy === 'MAKER' ? 'default' : 'default'}>{opp.strategy}</Badge>
                                {opp.isInverted && <Badge variant="inverted" icon={ArrowLeftRight}>INVERTED</Badge>}
                                {opp.profitPercent > 2.5 && <Badge variant="warning">HOT</Badge>}
                                {opp.risk.level === 'HIGH' && <Badge variant="danger" icon={AlertTriangle}>HIGH RISK</Badge>}
                            </div>
                            <h3 className="text-base font-medium font-sans text-foreground truncate pr-4">{opp.title}</h3>
                        </div>
                    </div>

                    <div className="flex items-center gap-6 md:gap-10 text-right flex-shrink-0">
                        {/* Risk Mini-Display (Desktop) */}
                        <div className="hidden lg:block">
                            <RiskIndicator level={opp.risk.level} score={opp.risk.score} />
                        </div>

                        <div className="hidden md:block">
                            <div className="text-[10px] text-muted uppercase tracking-wide mb-1">Profit</div>
                            <div className="text-emerald-400 font-mono font-medium">+${opp.estimatedProfit.toFixed(2)}</div>
                        </div>
                        <div className="min-w-[80px]">
                            <div className="text-[10px] text-muted uppercase tracking-wide mb-1">Spread</div>
                            <div className={`text-xl font-display font-semibold tracking-tight ${opp.profitPercent > 1 ? 'text-accent drop-shadow-[0_0_8px_rgba(245,158,11,0.3)]' : 'text-foreground'}`}>
                                {opp.profitPercent}%
                            </div>
                        </div>
                        <div className={`text-muted transition-transform duration-300 ${expanded ? 'rotate-180 text-accent' : ''}`}>
                            <ChevronDown size={20} strokeWidth={1.5} />
                        </div>
                    </div>
                </div>

                {/* Expanded Details */}
                <div
                    className={`grid transition-all duration-300 ease-out bg-black/20 ${expanded ? 'grid-rows-[1fr] opacity-100 border-t border-border' : 'grid-rows-[0fr] opacity-0'}`}
                >
                    <div className="min-h-0">
                        <div className="p-6">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

                                {/* Legs Information */}
                                <div className="space-y-3">
                                    <h4 className="text-[10px] font-medium uppercase tracking-wide text-muted">Execution Legs</h4>
                                    {[
                                        { label: 'Long (Predict)', price: opp.predictPrice, depth: opp.depth.predict, color: 'bg-blue-400' },
                                        { label: 'Short (Polymarket)', price: opp.polymarketPrice, depth: opp.depth.polymarket, color: 'bg-rose-400' }
                                    ].map((leg, idx) => (
                                        <div key={idx} className="p-3 rounded-lg border border-border bg-surface/50 flex justify-between items-center">
                                            <div>
                                                <div className="text-[10px] text-muted mb-1 flex items-center gap-2">
                                                    <div className={`w-1.5 h-1.5 rounded-full ${leg.color}`}></div>
                                                    {leg.label}
                                                </div>
                                                <div className="text-lg font-display font-medium text-foreground">{(leg.price * 100).toFixed(1)}¢</div>
                                            </div>
                                            <div className="text-right">
                                                <div className="text-[10px] text-muted mb-1">Available Depth</div>
                                                <div className="font-mono text-sm text-foreground">${leg.depth}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {/* Risk & Fees Breakdown */}
                                <div className="space-y-3">
                                    <h4 className="text-[10px] font-medium uppercase tracking-wide text-muted">Risk & Cost Analysis</h4>
                                    <div className="p-4 rounded-lg border border-border bg-surface/30 space-y-3">
                                        <div className="flex justify-between text-xs">
                                            <span className="text-muted">Slippage Est.</span>
                                            <span className={opp.risk.slippage > 1 ? 'text-rose-400' : 'text-foreground'}>{opp.risk.slippage}%</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-muted">Predict Fee</span>
                                            <span className="text-foreground">${opp.fees.predict.toFixed(2)}</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-muted">Network Gas</span>
                                            <span className="text-foreground">${opp.fees.gas.toFixed(2)}</span>
                                        </div>
                                        <div className="h-px bg-border my-2"></div>
                                        <div className="flex justify-between text-xs font-medium">
                                            <span className="text-muted">Total Cost Basis</span>
                                            <span className="text-foreground">${opp.costs.total.toFixed(2)}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Execution Actions */}
                                <div className="flex flex-col justify-end gap-3">
                                    <div className="flex justify-between text-xs font-mono text-muted">
                                        <span>MAX QTY</span>
                                        <span className="text-foreground">{opp.maxQuantity} SHARES</span>
                                    </div>
                                    <div className="flex justify-between text-xs font-mono text-muted mb-2">
                                        <span>EST. NET PROFIT</span>
                                        <span className="text-emerald-400">+${opp.estimatedProfit.toFixed(2)}</span>
                                    </div>
                                    <button className="w-full h-11 rounded-lg bg-accent text-background font-medium text-sm hover:brightness-110 hover:shadow-glow-button active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                                        <Zap size={16} strokeWidth={2} />
                                        Execute Trade
                                    </button>
                                    <div className="text-[10px] text-center text-muted">
                                        Last updated {Date.now() - opp.lastUpdate}ms ago
                                    </div>
                                </div>

                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const LatencyBar = ({ label, ms, max = 300 }: { label: string, ms: number, max?: number }) => {
    const pct = Math.min(100, (ms / max) * 100);
    const color = ms < 100 ? 'bg-emerald-500' : ms < 300 ? 'bg-accent' : 'bg-rose-500';

    return (
        <div className="mb-5">
            <div className="flex justify-between text-[11px] font-medium uppercase tracking-wide mb-2">
                <span className="text-muted">{label}</span>
                <span className={`font-mono ${ms < 100 ? 'text-emerald-400' : ms < 300 ? 'text-accent' : 'text-rose-400'}`}>{ms}ms</span>
            </div>
            <div className="h-1.5 w-full bg-surface rounded-full overflow-hidden">
                <div
                    className={`h-full ${color} shadow-[0_0_10px_rgba(var(--tw-shadow-color),0.5)] rounded-full transition-all duration-300 ease-out`}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
};

const FilterBar = ({
    filters,
    setFilters,
    onReset
}: {
    filters: { strategy: string, minProfit: number, sortBy: string },
    setFilters: Function,
    onReset: () => void
}) => (
    <div className="flex flex-col md:flex-row gap-4 items-center justify-between mb-6 p-4 rounded-xl border border-border bg-surface/30 backdrop-blur-sm">
        <div className="flex items-center gap-4 w-full md:w-auto overflow-x-auto pb-2 md:pb-0">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-background/50 text-xs font-medium text-muted whitespace-nowrap">
                <Filter size={14} />
                <span>Strategy:</span>
                <select
                    value={filters.strategy}
                    onChange={(e) => setFilters({ ...filters, strategy: e.target.value })}
                    className="bg-transparent border-none outline-none text-foreground cursor-pointer"
                >
                    <option value="ALL">All Strategies</option>
                    <option value="MAKER">Maker</option>
                    <option value="TAKER">Taker</option>
                </select>
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-background/50 text-xs font-medium text-muted whitespace-nowrap">
                <ArrowUpDown size={14} />
                <span>Sort:</span>
                <select
                    value={filters.sortBy}
                    onChange={(e) => setFilters({ ...filters, sortBy: e.target.value })}
                    className="bg-transparent border-none outline-none text-foreground cursor-pointer"
                >
                    <option value="PROFIT">Highest Profit</option>
                    <option value="TIME">Newest</option>
                    <option value="DEPTH">Highest Depth</option>
                </select>
            </div>

            <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg border border-border bg-background/50 text-xs font-medium text-muted whitespace-nowrap min-w-[200px]">
                <SlidersHorizontal size={14} />
                <span>Min Profit: <span className="text-foreground">{filters.minProfit}%</span></span>
                <input
                    type="range"
                    min="0"
                    max="5"
                    step="0.1"
                    value={filters.minProfit}
                    onChange={(e) => setFilters({ ...filters, minProfit: parseFloat(e.target.value) })}
                    className="w-24 accent-accent h-1 bg-surface rounded-lg appearance-none cursor-pointer"
                />
            </div>
        </div>

        <button
            onClick={onReset}
            className="text-xs text-muted hover:text-foreground underline decoration-dotted transition-colors whitespace-nowrap"
        >
            Reset Filters
        </button>
    </div>
);

const HistoryTable = ({ history }: { history: HistoryRecord[] }) => (
    <Card className="overflow-hidden" noPadding>
        <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
                <thead>
                    <tr className="border-b border-border bg-surface/50 text-[10px] uppercase tracking-wide text-muted">
                        <th className="p-4 font-medium">Time</th>
                        <th className="p-4 font-medium">Market</th>
                        <th className="p-4 font-medium">Strategy</th>
                        <th className="p-4 font-medium text-right">PnL</th>
                        <th className="p-4 font-medium">Status</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {history.map((record) => (
                        <tr key={record.id} className="hover:bg-white/5 transition-colors group">
                            <td className="p-4 text-xs font-mono text-muted whitespace-nowrap">
                                {new Date(record.timestamp).toLocaleTimeString()}
                            </td>
                            <td className="p-4">
                                <div className="text-xs font-medium text-foreground truncate max-w-[200px]">{record.title}</div>
                                <div className="text-[10px] text-muted">#{record.marketId}</div>
                            </td>
                            <td className="p-4">
                                <Badge variant="default">{record.strategy}</Badge>
                            </td>
                            <td className="p-4 text-right">
                                <div className={`text-sm font-mono font-medium ${record.realizedProfit && record.realizedProfit > 0 ? 'text-emerald-400' : 'text-muted'}`}>
                                    {record.realizedProfit && record.realizedProfit > 0 ? '+' : ''}${record.realizedProfit?.toFixed(2)}
                                </div>
                            </td>
                            <td className="p-4">
                                <span className={`text-[10px] font-bold uppercase tracking-wide 
                                    ${record.status === 'EXECUTED' ? 'text-emerald-400' :
                                        record.status === 'FAILED' ? 'text-rose-400' : 'text-muted'}`}>
                                    {record.status}
                                </span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    </Card>
);

const AnalyticsDashboard = ({ stats }: { stats: SystemStats }) => (
    <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="p-6">
                <h3 className="text-sm font-medium text-foreground mb-4">Profit Trend (24h)</h3>
                <div className="h-48 flex items-end justify-between gap-1">
                    {[30, 45, 35, 50, 40, 60, 55, 70, 65, 80, 75, 60, 50, 45, 55, 65, 70, 85, 90, 80].map((h, i) => (
                        <div key={i} className="w-full bg-surface hover:bg-emerald-500/20 transition-colors relative group" style={{ height: `${h}%` }}>
                            <div className="absolute inset-0 bg-emerald-500 opacity-20 group-hover:opacity-40 transition-opacity rounded-t-sm"></div>
                        </div>
                    ))}
                </div>
            </Card>
            <Card className="p-6">
                <h3 className="text-sm font-medium text-foreground mb-4">Depth vs Spread</h3>
                <div className="h-48 relative border-l border-b border-border">
                    {Array.from({ length: 15 }).map((_, i) => (
                        <div
                            key={i}
                            className="absolute w-2 h-2 rounded-full bg-accent opacity-60 hover:opacity-100 hover:scale-150 transition-all cursor-pointer shadow-glow-sm"
                            style={{
                                left: `${Math.random() * 90}%`,
                                bottom: `${Math.random() * 90}%`
                            }}
                            title="Opportunity"
                        ></div>
                    ))}
                </div>
                <div className="text-[10px] text-muted text-center mt-2">Spread %</div>
            </Card>
        </div>
    </div>
);

// --- Main App ---

const App = () => {
    const { opportunities, history, stats, isConnected } = useArbScanner();
    const [activeTab, setActiveTab] = useState<'LIVE' | 'HISTORY' | 'ANALYTICS'>('LIVE');
    const [filters, setFilters] = useState({
        strategy: 'ALL',
        minProfit: 0,
        sortBy: 'PROFIT'
    });

    const filteredOpps = useMemo(() => {
        let result = [...opportunities];

        // Filter
        if (filters.strategy !== 'ALL') {
            result = result.filter(o => o.strategy === filters.strategy);
        }
        if (filters.minProfit > 0) {
            result = result.filter(o => o.profitPercent >= filters.minProfit);
        }

        // Sort
        result.sort((a, b) => {
            if (filters.sortBy === 'PROFIT') return b.profitPercent - a.profitPercent;
            if (filters.sortBy === 'TIME') return b.lastUpdate - a.lastUpdate;
            if (filters.sortBy === 'DEPTH') return (b.depth.predict + b.depth.polymarket) - (a.depth.predict + a.depth.polymarket);
            return 0;
        });

        return result;
    }, [opportunities, filters]);

    return (
        <div className="min-h-screen font-sans selection:bg-accent selection:text-background pb-20">

            {/* Header */}
            <header className="fixed top-0 left-0 right-0 h-16 bg-background/80 backdrop-blur-md border-b border-border z-50 transition-all duration-300">
                <div className="max-w-7xl mx-auto px-6 h-full flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center shadow-glow-sm">
                            <Layers size={18} className="text-accent" strokeWidth={2} />
                        </div>
                        <div>
                            <h1 className="font-display font-semibold text-lg tracking-tight text-foreground leading-none">Arb<span className="text-muted">Scanner</span></h1>
                            <div className="flex items-center gap-2 text-[9px] font-medium tracking-wide uppercase text-muted mt-1">
                                <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-accent shadow-[0_0_8px_rgba(245,158,11,0.6)]' : 'bg-rose-500'}`}></span>
                                {isConnected ? 'Online' : 'Reconnecting...'}
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-6">
                        <div className="hidden md:flex items-center gap-1 text-[10px] font-mono text-muted bg-surface px-2 py-1 rounded border border-border">
                            <Clock size={10} />
                            <span>{new Date().toLocaleTimeString()}</span>
                        </div>

                        <div className="h-6 w-px bg-border"></div>

                        <button className="relative text-muted hover:text-foreground transition-colors">
                            <Bell size={18} />
                            <span className="absolute top-0 right-0 w-2 h-2 bg-rose-500 rounded-full border border-background"></span>
                        </button>
                        <button className="text-muted hover:text-foreground transition-colors">
                            <Settings size={18} />
                        </button>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-4 md:px-6 pt-24">

                {/* Navigation Tabs */}
                <div className="flex gap-6 mb-8 border-b border-border">
                    {['LIVE', 'HISTORY', 'ANALYTICS'].map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab as any)}
                            className={`pb-3 text-sm font-medium tracking-wide transition-all relative ${activeTab === tab ? 'text-accent' : 'text-muted hover:text-foreground'
                                }`}
                        >
                            {tab}
                            {activeTab === tab && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent shadow-glow-sm"></div>
                            )}
                        </button>
                    ))}
                </div>

                {activeTab === 'ANALYTICS' ? (
                    <AnalyticsDashboard stats={stats} />
                ) : (
                    <>
                        {/* Statistics Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-8">
                            <StatCard
                                title="Active Signals"
                                value={opportunities.length}
                                subValue={`${stats.makerCount} Maker / ${stats.takerCount} Taker`}
                                icon={Zap}
                            />
                            <StatCard
                                title="Avg. Spread"
                                value={`${stats.avgProfit}%`}
                                subValue={`Peak: ${stats.maxProfit}%`}
                                icon={TrendingUp}
                            />
                            <StatCard
                                title="Liquidity Depth"
                                value={`$${(stats.totalDepthUsd / 1000).toFixed(1)}k`}
                                subValue="Available across markets"
                                icon={DollarSign}
                            />
                            <StatCard
                                title="System Latency"
                                value={`${stats.latency.polymarket}ms`}
                                subValue="Optimal performance"
                                icon={Server}
                            />
                        </div>

                        {activeTab === 'HISTORY' ? (
                            <HistoryTable history={history} />
                        ) : (
                            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

                                {/* Main Feed Column */}
                                <div className="lg:col-span-8 space-y-4">

                                    <FilterBar
                                        filters={filters}
                                        setFilters={setFilters}
                                        onReset={() => setFilters({ strategy: 'ALL', minProfit: 0, sortBy: 'PROFIT' })}
                                    />

                                    <div className="flex items-center justify-between mb-2 px-1">
                                        <h3 className="font-display text-sm font-medium text-foreground flex items-center gap-2">
                                            <Activity size={16} className="text-accent" />
                                            Scanning Results
                                        </h3>
                                        <div className="text-xs text-muted font-mono">
                                            {filteredOpps.length} Opportunities
                                        </div>
                                    </div>

                                    {filteredOpps.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center py-32 rounded-2xl border border-dashed border-border bg-surface/30">
                                            {isConnected ? (
                                                <>
                                                    <div className="relative mb-6">
                                                        <div className="absolute inset-0 bg-accent/20 blur-xl rounded-full"></div>
                                                        <Search size={48} className="text-accent relative z-10 opacity-80" strokeWidth={1} />
                                                    </div>
                                                    <p className="font-display text-xl text-foreground mb-2">No Matches Found</p>
                                                    <p className="text-sm text-muted">Try adjusting your filters.</p>
                                                </>
                                            ) : (
                                                <>
                                                    <RefreshCw size={48} className="mb-6 text-accent animate-spin opacity-50" strokeWidth={1} />
                                                    <p className="font-display text-lg text-foreground">Initializing...</p>
                                                </>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="space-y-4">
                                            {filteredOpps.map(opp => (
                                                <OpportunityCard key={opp.id} opp={opp} />
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Sidebar */}
                                <div className="lg:col-span-4 space-y-6">

                                    {/* Latency Monitor */}
                                    <Card className="p-6">
                                        <h3 className="font-display text-sm font-medium text-foreground mb-6 flex items-center gap-2">
                                            <Wifi size={16} className="text-accent" />
                                            Network Status
                                        </h3>
                                        <LatencyBar label="Polymarket (WS)" ms={stats.latency.polymarket} max={100} />
                                        <LatencyBar label="Predict (REST)" ms={stats.latency.predict} max={1000} />
                                        <LatencyBar label="Engine Loop" ms={stats.latency.compute} max={50} />

                                        <div className="mt-6 pt-4 border-t border-border flex justify-between text-xs text-muted">
                                            <span>Connection Quality</span>
                                            <span className="text-emerald-400 font-medium">Optimal</span>
                                        </div>
                                    </Card>

                                    {/* Watchlist */}
                                    <Card noPadding className="overflow-hidden">
                                        <div className="p-4 border-b border-border bg-surface/50 backdrop-blur-md">
                                            <h3 className="font-display text-sm font-medium text-foreground">Watchlist</h3>
                                        </div>
                                        <div className="divide-y divide-border max-h-[300px] overflow-y-auto">
                                            {MOCK_MARKETS.map(m => (
                                                <div key={m.id} className="p-4 hover:bg-white/5 transition-colors flex justify-between items-center group cursor-default">
                                                    <div>
                                                        <div className="text-[10px] font-mono text-muted mb-1">#{m.id}</div>
                                                        <div className="text-sm text-foreground truncate max-w-[180px]">{m.title}</div>
                                                    </div>
                                                    <ArrowRight size={14} className="text-muted opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300" />
                                                </div>
                                            ))}
                                        </div>
                                    </Card>

                                    {/* Profit Distribution */}
                                    <Card className="p-6">
                                        <h3 className="font-display text-sm font-medium text-foreground mb-6 flex items-center gap-2">
                                            <BarChart3 size={16} className="text-accent" />
                                            Spread Distribution
                                        </h3>
                                        <div className="flex items-end justify-between h-32 gap-1.5 pb-1">
                                            {[10, 25, 45, 30, 15, 5, 2].map((h, i) => (
                                                <div key={i} className="w-full bg-surface hover:bg-accent transition-colors duration-300 rounded-sm relative group" style={{ height: `${h}%` }}>
                                                    <div className="absolute -top-8 left-1/2 -translate-x-1/2 text-[10px] bg-surface border border-border px-1.5 py-0.5 rounded text-foreground opacity-0 group-hover:opacity-100 transition-opacity font-mono pointer-events-none">
                                                        {h}%
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                        <div className="flex justify-between mt-3 text-[10px] font-mono text-muted border-t border-border pt-2">
                                            <span>0.5%</span>
                                            <span>2.0%+</span>
                                        </div>
                                    </Card>

                                </div>
                            </div>
                        )}
                    </>
                )}
            </main>
        </div>
    );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);