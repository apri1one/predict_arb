var Preview = window.Preview || (window.Preview = {});
var { useState, useEffect, useMemo, useRef, useCallback } = Preview.ReactHooks;
var { Icon } = Preview;
var { useNotifications, useArbScanner, API_BASE_URL } = Preview;
var {
    OpportunityCard,
    FilterBar,
    TasksTab,
    HistoryTable,
    AnalyticsDashboard,
    TaskModal,
    TaskLogModal,
    NotificationToast,
    OrderToastContainer,
    useOrderToasts,
    SettingsPanel,
    AccountCard,
    ClosePositionTab,
    SportsCard,
} = Preview.Components;

// --- Main App ---
const App = () => {
    const { notifications, settings, setSettings, addNotification, dismissNotification } = useNotifications();
    const { toasts: orderToasts, addOrderToast } = useOrderToasts();
    const { opportunities, history, chartData, stats, accounts, tasks, sports, isConnected } = useArbScanner(addNotification, addOrderToast);
    const [taskModalOpen, setTaskModalOpen] = useState(false);
    const [taskModalData, setTaskModalData] = useState(null); // { opp, type: 'BUY' | 'SELL' }
    const [logModalOpen, setLogModalOpen] = useState(false);
    const [logModalTaskId, setLogModalTaskId] = useState(null);
    const [activeTab, setActiveTab] = useState('LIVE');
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [filters, setFilters] = useState({ strategy: 'ALL', minProfit: 0, sortBy: 'ID' }); // 默认按 ID 排序，位置稳定
    const [isScanning, setIsScanning] = useState(false);
    const [isRefreshingAccounts, setIsRefreshingAccounts] = useState(false);

    // 刷新账户数据
    const handleRefreshAccounts = async () => {
        if (isRefreshingAccounts) return;

        setIsRefreshingAccounts(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/account/refresh`, { method: 'POST' });
            const data = await res.json();
            if (!data.success) {
                console.error('刷新账户失败:', data.error);
            }
        } catch (error) {
            console.error('刷新账户请求失败:', error.message);
        } finally {
            setIsRefreshingAccounts(false);
        }
    };

    // 触发市场重新扫描
    const handleRescan = async () => {
        if (isScanning) return;

        setIsScanning(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/rescan`, { method: 'POST' });
            if (res.ok) {
                // 扫描成功后刷新页面
                setTimeout(() => window.location.reload(), 2000);
            } else {
                alert('扫描失败,请查看后端日志');
                setIsScanning(false);
            }
        } catch (error) {
            alert('扫描请求失败: ' + error.message);
            setIsScanning(false);
        }
    };

    // 打开任务配置模态框
    const handleOpenTaskModal = (opp, type) => {
        setTaskModalData({ opp, type });
        setTaskModalOpen(true);
    };

    // 关闭任务配置模态框
    const handleCloseTaskModal = () => {
        setTaskModalOpen(false);
        setTaskModalData(null);
    };

    // 创建任务
    const handleCreateTask = async (taskInput) => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(taskInput),
            });
            const data = await res.json();
            if (data.success) {
                handleCloseTaskModal();
                setActiveTab('TASKS'); // 切换到任务标签页
            } else {
                alert('创建任务失败: ' + data.error);
            }
        } catch (error) {
            alert('创建任务失败: ' + error.message);
        }
    };

    // 创建体育市场 Taker 任务 (直接创建并启动)
    const handleCreateSportsTakerTask = async (taskParams) => {
        try {
            // 1. 创建任务
            const createRes = await fetch(`${API_BASE_URL}/api/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(taskParams),
            });
            const createData = await createRes.json();

            if (!createData.success) {
                alert('创建任务失败: ' + createData.error);
                return;
            }

            // 后端返回格式: { success: true, data: task }
            const taskId = createData.data?.id;
            if (!taskId) {
                alert('创建任务失败: 未返回任务ID');
                return;
            }

            // 2. 立即启动任务
            const startRes = await fetch(`${API_BASE_URL}/api/tasks/${taskId}/start`, { method: 'POST' });
            const startData = await startRes.json();

            if (startData.success) {
                setActiveTab('TASKS'); // 切换到任务标签页
            } else {
                alert('启动任务失败: ' + startData.error);
            }
        } catch (error) {
            alert('创建 Taker 任务失败: ' + error.message);
        }
    };

    // 启动任务
    const handleStartTask = async (taskId) => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/tasks/${taskId}/start`, { method: 'POST' });
            const data = await res.json();
            if (!data.success) {
                alert('启动任务失败: ' + data.error);
            }
        } catch (error) {
            alert('启动任务失败: ' + error.message);
        }
    };

    // 取消/删除任务
    const handleCancelTask = async (taskId) => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/tasks/${taskId}`, { method: 'DELETE' });
            const data = await res.json();
            if (!data.success) {
                alert('操作失败: ' + data.error);
            }
        } catch (error) {
            alert('操作失败: ' + error.message);
        }
    };

    // 查看任务日志
    const handleViewLogs = (taskId) => {
        setLogModalTaskId(taskId);
        setLogModalOpen(true);
    };

    // 关闭日志弹窗
    const handleCloseLogModal = () => {
        setLogModalOpen(false);
        setLogModalTaskId(null);
    };

    // Shared expansion state for Account Cards
    const [accountsExpanded, setAccountsExpanded] = useState(false);

    // 从 SSE 获取的账户数据
    const predictAccount = {
        balance: {
            total: accounts.predict?.total || 0,
            available: accounts.predict?.available || 0,
            portfolio: accounts.predict?.portfolio || 0
        },
        positions: accounts.predict?.positions || [],
        openOrders: accounts.predict?.openOrders || []
    };

    const polymarketAccount = {
        balance: {
            total: accounts.polymarket?.total || 0,
            available: accounts.polymarket?.available || 0,
            portfolio: accounts.polymarket?.portfolio || 0
        },
        positions: accounts.polymarket?.positions || [],
        openOrders: accounts.polymarket?.openOrders || []
    };

    // 调试:检查账户数据
    useEffect(() => {
        console.log('💰 账户状态更新:', { predictAccount, polymarketAccount, rawAccounts: accounts });
    }, [accounts]);

    const filteredOpps = useMemo(() => {
        let result = [...opportunities];
        if (filters.strategy !== 'ALL') result = result.filter(o => o.strategy === filters.strategy);
        if (filters.minProfit > 0) result = result.filter(o => o.profitPercent >= filters.minProfit);
        result.sort((a, b) => {
            if (filters.sortBy === 'PROFIT') return b.estimatedProfit - a.estimatedProfit;
            if (filters.sortBy === 'PROFIT_PCT') return b.profitPercent - a.profitPercent;
            if (filters.sortBy === 'TIME') return b.lastUpdate - a.lastUpdate;
            if (filters.sortBy === 'SETTLEMENT') {
                // 按结算时间升序 (最早结算的在前面)
                const aEnd = a.endDate ? new Date(a.endDate).getTime() : Infinity;
                const bEnd = b.endDate ? new Date(b.endDate).getTime() : Infinity;
                return aEnd - bEnd;
            }
            if (filters.sortBy === 'DEPTH') return (b.depth.predict + b.depth.polymarket) - (a.depth.predict + a.depth.polymarket);
            if (filters.sortBy === 'ID') return a.marketId - b.marketId; // 按 ID 排序，位置稳定
            return 0;
        });
        return result;
    }, [opportunities, filters]);

    return (
        <div className="min-h-screen font-sans selection:bg-amber-500 selection:text-black pb-20">

            {/* Order Toast Container (左上角订单状态浮窗) */}
            <OrderToastContainer toasts={orderToasts} />

            {/* Settings Panel */}
            <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} setSettings={setSettings} />

            {/* Header */}
            <header className="fixed top-0 left-0 right-0 h-16 bg-black/80 backdrop-blur-md border-b border-zinc-800/50 z-40">
                <div className="max-w-7xl mx-auto px-6 h-full flex items-center justify-between">
                    <div className="flex items-center gap-10">
                        <div className="flex items-center gap-4">
                            <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shadow-glow-sm">
                                <Icon name="layers" size={18} className="text-amber-500" strokeWidth={2} />
                            </div>
                            <div>
                                <h1 className="font-display font-semibold text-lg tracking-tight text-white leading-none">Arb<span className="text-zinc-500">Scanner</span></h1>
                                <div className="flex items-center gap-2 text-[9px] font-medium tracking-wide uppercase text-zinc-500 mt-1">
                                    <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]' : 'bg-rose-500'}`}></span>
                                    {isConnected ? 'Online' : 'Reconnecting...'}
                                </div>
                            </div>
                        </div>

                        {/* Separated & Enlarged Network Status */}
                        <div className="hidden lg:flex items-center gap-6 border-l border-zinc-800/50 pl-8">
                            {/* Polymarket Status */}
                            <div className="flex flex-col gap-1.5 min-w-[100px]">
                                <div className="flex items-center justify-between text-[11px] font-medium leading-none">
                                    <span className="text-zinc-400">Polymarket</span>
                                    <span className={`font-mono ${stats.latency.polymarket < 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
                                        {stats.latency.polymarket}ms
                                    </span>
                                </div>
                                <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full ${stats.latency.polymarket < 50 ? 'bg-emerald-500' : 'bg-amber-500'} rounded-full transition-all duration-300`}
                                        style={{ width: `${Math.min(100, stats.latency.polymarket)}%` }}
                                    />
                                </div>
                            </div>

                            {/* Predict Status */}
                            <div className="flex flex-col gap-1.5 min-w-[100px]">
                                <div className="flex items-center justify-between text-[11px] font-medium leading-none">
                                    <span className="text-zinc-400">Predict</span>
                                    <span className={`font-mono ${stats.latency.predict < 100 ? 'text-emerald-400' : 'text-amber-400'}`}>
                                        {stats.latency.predict}ms
                                    </span>
                                </div>
                                <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full ${stats.latency.predict < 100 ? 'bg-emerald-500' : 'bg-amber-500'} rounded-full transition-all duration-300`}
                                        style={{ width: `${Math.min(100, stats.latency.predict / 5)}%` }}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-6">
                        <div className="hidden md:flex items-center gap-1 text-[10px] font-mono text-zinc-500 bg-zinc-900 px-2 py-1 rounded border border-zinc-800">
                            <Icon name="clock" size={10} />
                            <span>{new Date().toLocaleTimeString()}</span>
                        </div>
                        <div className="h-6 w-px bg-zinc-800"></div>
                        <button
                            onClick={handleRescan}
                            disabled={isScanning}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                isScanning
                                    ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20'
                            }`}
                            title="重新扫描市场">
                            <Icon name={isScanning ? "loader" : "refresh-cw"} size={14} className={isScanning ? 'animate-spin' : ''} />
                            {isScanning ? '扫描中...' : '扫描市场'}
                        </button>
                        <div className="h-6 w-px bg-zinc-800"></div>
                        <button className="relative text-zinc-500 hover:text-white transition-colors">
                            <Icon name="bell" size={18} />
                            {notifications.length > 0 && (
                                <span className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 rounded-full border-2 border-black text-[9px] font-bold text-white flex items-center justify-center">
                                    {notifications.length}
                                </span>
                            )}
                        </button>
                        <button onClick={() => setSettingsOpen(true)} className="text-zinc-500 hover:text-white transition-colors">
                            <Icon name="settings" size={18} />
                        </button>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-4 md:px-6 pt-24">
                {/* Top Row: Account Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <AccountCard
                        platform="Predict.fun"
                        balance={predictAccount.balance}
                        positions={predictAccount.positions}
                        openOrders={predictAccount.openOrders}
                        icon="predict"
                        color="bg-blue-600"
                        expanded={accountsExpanded}
                        onToggle={() => setAccountsExpanded(!accountsExpanded)}
                        onRefresh={handleRefreshAccounts}
                        refreshing={isRefreshingAccounts}
                    />
                    <AccountCard
                        platform="Polymarket"
                        balance={polymarketAccount.balance}
                        positions={polymarketAccount.positions}
                        openOrders={polymarketAccount.openOrders}
                        icon="polymarket"
                        color="bg-purple-600"
                        expanded={accountsExpanded}
                        onToggle={() => setAccountsExpanded(!accountsExpanded)}
                        onRefresh={handleRefreshAccounts}
                        refreshing={isRefreshingAccounts}
                    />
                </div>

                {/* Tabs */}
                <div className="flex gap-6 mb-6 border-b border-zinc-800/50">
                    {['LIVE', 'SPORTS', 'TASKS', 'CLOSE', 'HISTORY', 'ANALYTICS'].map((tab) => (
                        <button key={tab} onClick={() => setActiveTab(tab)}
                            className={`pb-3 text-sm font-medium tracking-wide transition-all relative ${activeTab === tab ? 'text-amber-500' : 'text-zinc-500 hover:text-white'}`}>
                            {tab === 'CLOSE' ? '平仓' : tab === 'SPORTS' ? '体育' : tab}
                            {activeTab === tab && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500 shadow-glow-sm"></div>}
                        </button>
                    ))}
                </div>

                {activeTab === 'ANALYTICS' ? (
                    <AnalyticsDashboard stats={stats} chartData={chartData} />
                ) : activeTab === 'CLOSE' ? (
                    <ClosePositionTab onSwitchToTasks={() => setActiveTab('TASKS')} />
                ) : activeTab === 'SPORTS' ? (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between mb-4 px-1">
                            <h3 className="font-display text-sm font-medium text-white flex items-center gap-2">
                                <Icon name="activity" size={16} className="text-amber-500" />
                                体育市场套利
                            </h3>
                            <div className="text-xs text-zinc-500 font-mono">
                                {sports.stats?.withArbitrage || 0} / {sports.stats?.totalMatched || 0} 场有套利
                            </div>
                        </div>
                        {(!sports.markets || sports.markets.length === 0) ? (
                            <div className="flex flex-col items-center justify-center py-32 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30">
                                {isConnected ? (
                                    <>
                                        <Icon name="search" size={48} className="text-amber-500 opacity-80 mb-6" strokeWidth={1} />
                                        <p className="font-display text-xl text-white mb-2">暂无体育市场</p>
                                        <p className="text-sm text-zinc-500">正在扫描匹配的体育赛事...</p>
                                    </>
                                ) : (
                                    <>
                                        <Icon name="refresh-cw" size={48} className="text-amber-500 animate-spin opacity-50 mb-6" strokeWidth={1} />
                                        <p className="font-display text-lg text-white">正在连接...</p>
                                    </>
                                )}
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {sports.markets.map(market => (
                                    <SportsCard
                                        key={`${market.predictMarketId}-${market.polymarketConditionId}`}
                                        market={market}
                                        onOpenTaskModal={handleOpenTaskModal}
                                        onCreateTakerTask={handleCreateSportsTakerTask}
                                        accounts={accounts}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                ) : activeTab === 'MARKETS' ? (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between mb-4 px-1">
                            <h3 className="font-display text-sm font-medium text-white flex items-center gap-2">
                                <Icon name="list" size={16} className="text-amber-500" />
                                监控市场列表
                            </h3>
                            <div className="text-xs text-zinc-500 font-mono">{markets.length} 个市场</div>
                        </div>
                        {markets.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-32 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30">
                                <Icon name="inbox" size={48} className="text-zinc-600 mb-6" strokeWidth={1} />
                                <p className="font-display text-lg text-zinc-400">暂无市场数据</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {markets.map((m, idx) => (
                                    <div key={`${m.predictId}-${idx}`} className="glass-card rounded-xl p-4 border border-zinc-800/50 hover:border-zinc-700/50 transition-all">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className="text-xs font-mono text-zinc-500">ID {m.predictId}</span>
                                                    {m.predictTitle !== m.predictQuestion && (
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-400 font-medium">{m.predictTitle}</span>
                                                    )}
                                                    {m.isInverted && (
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 font-medium">INVERTED</span>
                                                    )}
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">{(m.feeRateBps / 100).toFixed(2)}%</span>
                                                </div>
                                                <h4 className="text-sm text-white font-medium leading-tight mb-1">{m.predictQuestion || m.predictTitle}</h4>
                                                <div className="text-xs text-zinc-500 font-mono truncate" title={m.polymarketConditionId}>
                                                    Condition: {m.polymarketConditionId.substring(0, 16)}...
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : activeTab === 'TASKS' ? (
                    <TasksTab tasks={tasks} onStart={handleStartTask} onCancel={handleCancelTask} onViewLogs={handleViewLogs} apiBaseUrl={API_BASE_URL} />
                ) : (
                    <>
                        {activeTab === 'HISTORY' ? (
                            <HistoryTable history={history} />
                        ) : (
                            <>
                                <FilterBar filters={filters} setFilters={setFilters} onReset={() => setFilters({ strategy: 'ALL', minProfit: 0, sortBy: 'ID' })} />

                                <div className="flex items-center justify-between mb-4 px-1">
                                    <h3 className="font-display text-sm font-medium text-white flex items-center gap-2">
                                        <Icon name="activity" size={16} className="text-amber-500" />
                                        Scanning Results
                                    </h3>
                                    <div className="text-xs text-zinc-500 font-mono">{filteredOpps.length} Opportunities</div>
                                </div>

                                {filteredOpps.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-32 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30">
                                        {isConnected ? (
                                            <>
                                                <Icon name="search" size={48} className="text-amber-500 opacity-80 mb-6" strokeWidth={1} />
                                                <p className="font-display text-xl text-white mb-2">No Matches Found</p>
                                                <p className="text-sm text-zinc-500">Try adjusting your filters.</p>
                                            </>
                                        ) : (
                                            <>
                                                <Icon name="refresh-cw" size={48} className="text-amber-500 animate-spin opacity-50 mb-6" strokeWidth={1} />
                                                <p className="font-display text-lg text-white">Initializing...</p>
                                            </>
                                        )}
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 transition-opacity duration-300">
                                        {filteredOpps.map(opp => {
                                            // 查找该市场的活跃任务 (非终态: COMPLETED/FAILED/CANCELLED)
                                            const activeTask = tasks.find(t =>
                                                t.marketId === opp.marketId &&
                                                !['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'].includes(t.status)
                                            );
                                            return <OpportunityCard key={opp.id} opp={opp} onOpenTaskModal={handleOpenTaskModal} activeTask={activeTask} />;
                                        })}
                                    </div>
                                )}
                            </>
                        )}
                    </>
                )}
            </main>

            {/* 任务配置模态框 */}
            <TaskModal
                isOpen={taskModalOpen}
                onClose={handleCloseTaskModal}
                data={taskModalData}
                onSubmit={handleCreateTask}
                accounts={accounts}
                apiBaseUrl={API_BASE_URL}
            />

            {/* 任务日志弹窗 */}
            <TaskLogModal
                isOpen={logModalOpen}
                onClose={handleCloseLogModal}
                taskId={logModalTaskId}
                apiBaseUrl={API_BASE_URL}
            />
        </div>
    );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
