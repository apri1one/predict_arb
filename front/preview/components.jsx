var Preview = window.Preview || (window.Preview = {});
var { useState, useEffect, useMemo, useRef, useCallback } = Preview.ReactHooks;
var { Icon } = Preview;

// --- Components ---

/**
 * FlashValue - 值变化时闪烁的组件
 * 价格/深度上涨显示绿色闪烁，下跌显示红色闪烁
 */
const FlashValue = ({ value, children, className = '' }) => {
    const [flashClass, setFlashClass] = useState('');
    const prevValueRef = useRef(value);
    const flashKeyRef = useRef(0);

    useEffect(() => {
        const prevValue = prevValueRef.current;
        // 值变化且差异超过阈值才触发闪烁 (避免浮点精度噪音)
        const hasChanged = prevValue !== undefined && Math.abs(prevValue - value) > 0.0001;

        if (hasChanged) {
            // 值变化，触发闪烁
            const direction = value > prevValue ? 'flash-up' : 'flash-down';
            flashKeyRef.current += 1;
            setFlashClass(direction);

            // 动画结束后清除 class
            const timer = setTimeout(() => {
                setFlashClass('');
            }, 1500);

            // 更新 prevValueRef (修复：无论如何都要更新)
            prevValueRef.current = value;
            return () => clearTimeout(timer);
        }

        // 首次渲染或无变化时也更新
        prevValueRef.current = value;
    }, [value]);

    // 使用 key 强制重新创建元素以重新触发动画
    return (
        <span key={flashKeyRef.current} className={`${className} ${flashClass}`}>
            {children}
        </span>
    );
};

const Badge = ({ children, variant = 'default', icon }) => {
    const styles = {
        default: "bg-zinc-800/50 text-zinc-400 border-zinc-700/50",
        success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
        warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
        danger: "bg-rose-500/10 text-rose-400 border-rose-500/20",
        inverted: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    };
    return (
        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-medium tracking-wide border ${styles[variant]} backdrop-blur-sm flex items-center gap-1`}>
            {icon && <Icon name={icon} size={10} />}
            {children}
        </span>
    );
};

/**
 * ExpiryCountdown - 显示任务倒计时 (时:分:秒)
 */
const ExpiryCountdown = ({ expiresAt, compact = false }) => {
    const [remaining, setRemaining] = useState('');

    useEffect(() => {
        if (!expiresAt) return;

        const update = () => {
            const diff = expiresAt - Date.now();
            if (diff <= 0) {
                setRemaining('00:00:00');
                return;
            }
            const hours = Math.floor(diff / (1000 * 60 * 60));
            const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const secs = Math.floor((diff % (1000 * 60)) / 1000);
            // 格式: HH:MM:SS
            const pad = (n) => String(n).padStart(2, '0');
            setRemaining(`${pad(hours)}:${pad(mins)}:${pad(secs)}`);
        };

        update();
        const interval = setInterval(update, 1000);
        return () => clearInterval(interval);
    }, [expiresAt]);

    if (!expiresAt) return null;

    const isExpiring = expiresAt - Date.now() < 10 * 60 * 1000; // < 10 minutes

    return (
        <span className={`font-mono ${compact ? 'text-[10px]' : 'text-xs'} ${isExpiring ? 'text-rose-400' : 'text-amber-400'}`}>
            {remaining}
        </span>
    );
};

/**
 * ExpirySelector - 任务过期时间选择器
 * 闹钟图标 + 倒计时显示，点击设置/取消定时
 */
const ExpirySelector = ({ taskId, currentExpiresAt, onUpdate, apiBaseUrl }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [hours, setHours] = useState('');
    const [loading, setLoading] = useState(false);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const inputRef = useRef(null);

    // 自动聚焦输入框
    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    // 设置定时
    const handleSetExpiry = async () => {
        const h = parseFloat(hours);
        if (isNaN(h) || h <= 0 || h > 72) {
            setIsEditing(false);
            setHours('');
            return;
        }
        setLoading(true);
        try {
            const expiresAt = Date.now() + h * 60 * 60 * 1000;
            const res = await fetch(`${apiBaseUrl}/api/tasks/${taskId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expiresAt }),
            });
            if (res.ok && onUpdate) {
                onUpdate({ expiresAt });
            }
        } catch (e) {
            console.error('Failed to set expiry:', e);
        } finally {
            setLoading(false);
            setIsEditing(false);
            setHours('');
        }
    };

    // 取消定时
    const handleCancelExpiry = async () => {
        if (!confirmCancel) {
            setConfirmCancel(true);
            // 3秒后自动取消确认状态
            setTimeout(() => setConfirmCancel(false), 3000);
            return;
        }
        setLoading(true);
        try {
            const res = await fetch(`${apiBaseUrl}/api/tasks/${taskId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expiresAt: null }),
            });
            if (res.ok && onUpdate) {
                onUpdate({ expiresAt: null });
            }
        } catch (e) {
            console.error('Failed to cancel expiry:', e);
        } finally {
            setLoading(false);
            setConfirmCancel(false);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleSetExpiry();
        } else if (e.key === 'Escape') {
            setIsEditing(false);
            setHours('');
        }
    };

    // 编辑模式：显示输入框
    if (isEditing) {
        return (
            <div className="flex flex-col items-start">
                <span className="text-zinc-500 text-[10px] mb-0.5">定时</span>
                <div className="flex items-center gap-1">
                    <input
                        ref={inputRef}
                        type="number"
                        min="0.1"
                        max="72"
                        step="0.5"
                        value={hours}
                        onChange={(e) => setHours(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onBlur={() => { if (!hours) setIsEditing(false); }}
                        placeholder="H"
                        className="w-10 px-1 py-0.5 rounded bg-zinc-800 border border-zinc-600 text-white text-[10px] font-mono text-center focus:outline-none focus:border-amber-500"
                        disabled={loading}
                    />
                    <button
                        onClick={handleSetExpiry}
                        disabled={loading || !hours}
                        className="px-1 py-0.5 rounded bg-amber-500 text-black text-[10px] font-medium hover:brightness-110 disabled:opacity-50"
                    >
                        ✓
                    </button>
                </div>
            </div>
        );
    }

    // 已有定时：计时器图标 + 倒计时，点击取消
    if (currentExpiresAt) {
        return (
            <div className="flex flex-col items-start">
                <span className="text-zinc-500 text-[10px] mb-0.5">定时</span>
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleCancelExpiry}
                        disabled={loading}
                        className={`text-base hover:scale-110 transition-transform ${
                            confirmCancel ? 'animate-pulse' : ''
                        }`}
                        title={confirmCancel ? '再次点击确认取消' : '点击取消定时'}
                    >
                        {confirmCancel ? '❌' : '⏲'}
                    </button>
                    <ExpiryCountdown expiresAt={currentExpiresAt} compact />
                </div>
                {confirmCancel && (
                    <span className="text-[10px] text-rose-400 mt-0.5">点击确认取消</span>
                )}
            </div>
        );
    }

    // 默认：显示计时器图标
    return (
        <div className="flex flex-col items-start">
            <span className="text-zinc-500 text-[10px] mb-0.5">定时</span>
            <button
                onClick={() => setIsEditing(true)}
                className="text-base hover:scale-110 transition-transform"
                title="设置定时 (0-72小时)"
            >
                ⏲
            </button>
        </div>
    );
};

const Card = ({ children, className = '', noPadding = false }) => (
    <div className={`glass-card rounded-xl transition-all duration-300 hover:border-white/10 ${className}`}>
        <div className={noPadding ? '' : 'p-6'}>{children}</div>
    </div>
);

const RiskIndicator = ({ level, score }) => {
    const colors = { LOW: 'bg-emerald-500', MED: 'bg-yellow-500', HIGH: 'bg-rose-500' };
    const textColors = { LOW: 'text-emerald-400', MED: 'text-yellow-400', HIGH: 'text-rose-400' };
    return (
        <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[10px] uppercase tracking-wide text-zinc-500">
                <span>Risk</span>
                <span className={textColors[level]}>{level} ({score})</span>
            </div>
            <div className="h-1.5 w-24 bg-zinc-800 rounded-full overflow-hidden border border-zinc-700/50">
                <div className={`h-full ${colors[level]} transition-all duration-500`} style={{ width: `${score}%` }} />
            </div>
        </div>
    );
};

const DepthIndicator = ({ depth }) => (
    <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Depth:</span>
        <FlashValue value={depth}>
            <span className="text-xs font-mono text-blue-400">{depth} shares</span>
        </FlashValue>
    </div>
);

const StatCard = ({ title, value, subValue, icon }) => (
    <Card className="flex flex-col justify-between h-full group hover:bg-zinc-900/50">
        <div className="flex justify-between items-start mb-4">
            <div className="text-zinc-500 text-xs font-medium tracking-wide uppercase">{title}</div>
            <div className="p-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50 group-hover:border-amber-500/30 transition-colors">
                <Icon name={icon} size={18} className="text-zinc-500 group-hover:text-amber-500 transition-colors" />
            </div>
        </div>
        <div>
            <div className="text-3xl font-display font-medium text-white tracking-tight mb-1">{value}</div>
            {subValue && <div className="text-xs text-zinc-500">{subValue}</div>}
        </div>
    </Card>
);

/**
 * 生成 Predict URL slug
 * 规则: 转小写 -> 移除特殊字符 -> 空格转连字符
 */
const generatePredictSlug = (title) => {
    if (!title) return null;
    return title
        .toLowerCase()
        .replace(/@/g, 'at')           // @ 转 at (体育比赛格式)
        .replace(/[^a-z0-9 -]/g, '')   // 移除所有特殊字符，保留字母、数字、空格、连字符
        .replace(/ +/g, '-')            // 空格转连字符
        .replace(/-+/g, '-')            // 合并多个连字符
        .replace(/^-|-$/g, '');         // 移除首尾连字符
};

// Predict 图标 base64 (PNG 格式)
const PREDICT_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADkAAAA5CAMAAAC7xnO3AAAAgVBMVEVuV/kfKjcgKzptVvZ0Wv9tV/gZJykcKDByWf8aJyweKTVwWP5vWPxEP5NJQqBrVfIYJiZnU+hMQ6VCPo8pMFEiLEBgT9g0NmsxNGQtMllkUeFbTMpUSLpQRrA7Onw5OXhTR7ZNRalIQZs3N3IkLURpVOxdTdA/PIYoL00mLklbTMcw7QOKAAAB20lEQVRIx+3VyXKjMBAGYFB3q7WZJQaMF7zbceb9H3DwSCGcjDjMIVX+L1hV/mghWiJ5553/EgIgf/E/YgNgERU8L31UEouJFG66j6Y35S7Lujuhg6iCSm0PQkpxWFxqLaU01TlXEZTUfcU6FSLVUhvRJ2X52CJMVzyx7v/d54l8BPNxipJt2HgwjjC8nZgwYCbFSPQJVas8odfyWPxII1lyoDJ7PV9KqB2K8tfpT1cFyhW8LkouX3OgokGFtwf7wfSTqiY4uceccuyk8MMzQjJBV1oMT0aurE240aTET+nlB0LSUz97oVeKpuRiLEFd/BS4tTMlHvxQt2q21F5eFMySNCzYEmNl6BqoOP1Xcxct9QoBALfsO7EuI1eoD58QsVyziHudQXrafu6v7AemsRQlA5XS+N4rFn3JGXLYnsXKEU3L5SCDN8XFb7FoKcIBJjLbwxmStZZSm2q5QaJkhuT1rjtnxwbQQoQb77ITqjkfBwLV8nff5gBAMS6cft8Hz3qDlESH7JnTEE4zFU1B7YrRe9R3C7ES91r8UJlhvFwU9QCF3EVLcptrwWyeYS7aOSukNofq61rX9fWxXuZuDrVI+a0sy1vu0MNoColz1lrnQvPMwj7JO78vfwHSjxmwHfr8iwAAAABJRU5ErkJggg==';

// Polymarket 图标 base64
const POLYMARKET_ICON = 'data:image/x-icon;base64,AAABAAEAMDAAAAEAIACoJQAAFgAAACgAAAAwAAAAYAAAAAEAIAAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAAD/XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XDD//1ww//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XTD//l4y//5fMf//XC3//1su//1dL//+XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9dMP//XjH//18z//9dMP//Vyr//FIi//hSIv/0XTT/9F80//taLP/+XS///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9dMf//XjL//10y//9bLf//VCX//FAg//pYLP/2b0f/85R2//fEs//55uD/9OXc//ZrQv//WCv//10w//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///10w//9eMf//XjL//10w//9WKP/+USL/+lQl//VgOP/zhGP/86+X//fXyv/5+Pb/+v////7//////v7//P////R/Xf//VCX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///10x//9eM//+XjH//1or//5UJP/8USH/91gr//h3UP/1mHz/98m4//ns6P/7/f3//P////z////9/////f////39/f///fz//f////J+Xf//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XTD//14y//9eMv//XC///1Yo//xPIf/1VCX/9WY+//OEZf/1uKH/9dzS//f6+f/7////////////////////+/////n18v/439P/8qKL//PJu////////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///l4w//9eMf/+WCv//VMj//tRIv/5Wy//9nZT//Sih//0ybv/+/Lt//z//v/+/////f////3//////////P78//ns5P/zv6//9pl7//VtRv/7Wy7/9kUS//SwnP///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL//+XS///VYo//hTJf/0a0T/8o5u//a4pf/55dz/+fr3//z////9/////f/////////9////+PTx//bUx//1q5P/83tZ//ZiN//3UiP//FIi//9YKv//XzP/+FMj//S1ov///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9dMf//Vyj/9YFd//XTxv/68/D//v///////v/9//////////v////7+/r/+ubf//W9qv/0jnH/925G//lUJ//9USH//1Um//9aLf/+XzL//l8y//9dMP//XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/8UCL/9L2t//z//////Pz///39///9/f/7+ff/8ca3//Saf//1dE3/+lwx//lUJv/9VCT//1kr//9eMf//XzL//14x//9dMP//XC///1wv//9cL///XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9eMv/7USH/8bys/////////Pv//v38///9/f/7+fb/8MW2//SNbv/4ckr/91ku//tUJP/9VyX//los//9eMf//XjP//10x//9cL///XC///1wv//9cL///XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8L6u/////////fz//////////////////f////v////6/Pn/9N7T//W7pv/zh2n/92g+//pUJv/+UCD//1Yn//9bLv//XjL//14y//9dMP//XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////69vT/7aSN//a5p//46eP/+/78//z////9/////v////7////8////+/Tv//TMvv/0pYv/83lU//ddLv/6UyP//VIi//5YKf//YDT/+FMk//S1ov///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////59vP/7mc+//lMHP/2YjX/9HtW//apj//20cP/9vLu//3///////7///////7////7////+fv5//nm3f/1vKv/9I9w//ZtRf/6Vyr/90US//SwnP///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////59/P/8XJM//9aLP//XC///1Yn//5RIv/5VCb/82tD//WMb//2uaX/+eXc//v69//9/////f////7//////////f////f08v/41Mj/8aKJ//HGt////////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////49/T/8nBJ//9XKf//XjH//10x//9fMv//XjH//lgq//1TIv/5UiL/+Fww//V4Uf/zo4r/88q7//v07//+/////v////7////9////+f////3//v///v7//f////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////49/T/8nBJ//9XKf//XTD//1wv//9cL///XC///10x//9eMv//XjL//1wv//9XKf/+UyP/+1Yn//hkOv/1f1v/9KuV//DZzv/7+/r///38///+/v///v7//f////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////49/T/8nBJ//9XKf//XTD//1wv//9cL///XC///10w//9eMv//XjL//1wv//9YKf/+UyP/+1Yn//hkOv/0flr/9KuV//DZz//6+/r///38///+/v///v7//f////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////49/T/8nBJ//9XKf//XjH//14x//9eMv//XjH//1gq//1TIf/4UiL/+Fww//V4UP/zo4n/88q6//r07//+/////v////7////9////+v////3//v///v7//f////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////49/P/8XJM//9aLP//XC///1Un//5RIv/6VCb/9WtE//SMb//1uaX/+eXd//v6+P/9/////f////7//////////f////f08v/31cn/8KGH//HGuP///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////59vP/7mY9//lMG//3YjX/9HlW//apj//30sT/9vLt//3///////////////7////8////+vv5//rm3f/0u6r/9I9w//VtRP/5Vyr/90YS//SwnP///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////69vX/7KWN//e5p//56eL/+/38//z////+/////v////3////8/////PTv//TMvv/1poz/83lV//hdLv/6UyP//VIi//9YKf/+YDT/+FMk//S1ov///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8L6u/////////fz//////////////////P////v////6/Pr/897U//S6pP/zhmj/9mg+//pUJv/+UCD//1Yn//9bL///XjL//14y//9dMP//XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9eMv/7USH/8bys/////////Pv//v38///9/f/7+fb/8MW2//SNbv/4ckr/9lkt//xUI//9Vib//Vot//9eMf//XjP//10x//9cL///XC///1wv//9cL///XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7UCH/9L2t//3//////Pz///39///9/f/7+ff/8cW3//SagP/2dE7/+V0w//pVJf/9VCT//1kr//9eMf//XzL//14x//9dMP//XC///1wv//9cL///XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9dMf/+Vyf/9YFd//bTx//79PD//v///////v/9/////v////v////7+/n/+ubf//a8qv/0j3H/925G//hUJ//9UCH//1Um//9aLf/+XzL//l8y//9dMP//XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XTD//lYp//hTJv/0a0T/8Y5u//a5pf/45dv/+fr3//z////9/////f/////////8////+PTx//bUx//2qpL/83tZ//ZiNv/4UiL//VEi//9YKv//XzP/+FMj//S1ov///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///l0x//5eMf/+WCv//VMj//xSIv/5Wy//93VS//Wih//0ybv/+/Lt//z//v/9/////f////7////+/////P79//rr4//yvq7/9pl7//VsR//7Wy7/9kUS//SwnP///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XTD//14y//9eMv//XC///1Yo//1QIf/2VCX/9mY+//OEZf/1uKL/9tvS//f6+f/7////////////////////+v////n18v/43tT/8qKM//LJu////////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///10x//9fM///XjH//1or//5UJP/9USH/91gs//d2UP/0l3z/98m5//ns5//8/Pz//f////z////9/////f////z9/f///fz//P////J+Xf//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///10w//9eMf//XzL//10v//9WKP/9USH/+VMk//dgN//0g2L/866X//bYy//4+PX/+f////7//////v7//f////R/Xf//VCX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9dMf//XjL//l0y//9bLf//VCX//FAh//pYLP/3b0f/8pR1//fEs//45t//9Obc//ZsQ//+WCv//10w//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cMP//XjH//18y//9dL///Vyr//FIi//lSIv/0XTT/9F81//paLP/+XS///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XTD//l4y//5fMf//XC3//1su//5dL//+XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XDD//1ww//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * ViewLinks - 平台导航按钮组件
 * 提供 Predict 和 Polymarket 的外链按钮
 * @param predictSlug - 后端提供的验证过的 slug（优先使用）
 * @param sportsTeams - 体育市场专用搜索词（球队名，如 "Bulls Rockets"）
 */
const ViewLinks = ({ predictId, predictSlug: backendSlug, polymarketSlug, polymarketConditionId, title, sportsTeams, size = 'sm' }) => {
    // Predict URL: 优先使用后端缓存的 slug，否则从标题生成
    // 格式: https://predict.fun/market/{slug}
    const predictSlug = backendSlug || generatePredictSlug(title);
    const predictUrl = predictSlug
        ? `https://predict.fun/market/${predictSlug}`
        : null;

    // Polymarket URL: 优先使用后端提供的 slug，否则回退到搜索
    // 格式: https://polymarket.com/event/{slug}
    let polymarketUrl = null;
    if (polymarketSlug) {
        polymarketUrl = `https://polymarket.com/event/${polymarketSlug}`;
    } else {
        // Fallback: 使用搜索
        const searchTerm = sportsTeams || title;
        polymarketUrl = searchTerm
            ? `https://polymarket.com/markets?_q=${encodeURIComponent(searchTerm.substring(0, 50))}`
            : (polymarketConditionId ? `https://polymarket.com/markets?_q=${polymarketConditionId.substring(0, 16)}` : null);
    }

    // 图标尺寸: 放大 30% (原 16px -> 21px)
    const iconSize = size === 'sm' ? 21 : 26;
    const buttonClass = 'p-1 rounded-md bg-zinc-800/50 border border-zinc-700/30 hover:border-zinc-600/50 hover:bg-zinc-700/50 transition-all group';

    return (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {/* Predict Link */}
            {predictUrl && (
                <a
                    href={predictUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass}
                    title="View on Predict.fun"
                >
                    <img
                        src={PREDICT_ICON}
                        alt="Predict"
                        style={{ width: iconSize, height: iconSize }}
                        className="opacity-80 group-hover:opacity-100 transition-opacity"
                    />
                </a>
            )}
            {/* Polymarket Link */}
            {polymarketUrl && (
                <a
                    href={polymarketUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass}
                    title="View on Polymarket"
                >
                    <img
                        src={POLYMARKET_ICON}
                        alt="Polymarket"
                        style={{ width: iconSize, height: iconSize }}
                        className="opacity-80 group-hover:opacity-100 transition-opacity"
                    />
                </a>
            )}
        </div>
    );
};

const OpportunityCard = ({ opp, onOpenTaskModal, activeTask }) => {
    const [expanded, setExpanded] = useState(false);
    const timeSinceUpdate = Math.floor((Date.now() - opp.lastUpdate) / 1000);
    // FIX: 所有套利开仓都应该是 BUY 类型任务
    // arbSide 字段控制买 YES 还是 NO (YES端: 买YES, NO端: 买NO)
    // SELL 类型仅用于平仓现有持仓，不用于套利开仓
    const primaryTaskType = 'BUY';
    const primaryIsBuy = true;

    // 任务标签颜色: BUY=绿色, CLOSE=红色
    const ribbonColor = activeTask?.type === 'CLOSE' ? '#ef4444' : '#10b981';
    const ribbonText = activeTask?.type === 'CLOSE' ? 'CLOSE' : 'BUY';

    return (
        <div className="group">
            <div className={`glass-card rounded-xl border border-zinc-800/50 transition-all duration-300 overflow-hidden h-full relative
                ${expanded ? 'border-amber-500/30 shadow-glow-sm bg-zinc-900/80' : 'hover:border-white/10 hover:scale-[1.005]'}`}>

                {/* 任务标签 (斜角丝带) */}
                {activeTask && (
                    <div
                        className="absolute top-2 -left-7 transform -rotate-45 text-[9px] font-semibold uppercase tracking-wider text-white px-8 py-0.5 z-10 pointer-events-none"
                        style={{ background: ribbonColor }}
                    >
                        {ribbonText}
                    </div>
                )}

                {/* Header */}
                <div className="p-5 cursor-pointer" onClick={() => setExpanded(!expanded)}>
                    {/* Top Row: Badges + Settlement + P/M | Profit + Expand */}
                    <div className="flex items-center justify-between mb-2">
                        {/* 左侧: badges + 结算时间 + P/M 按钮 */}
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={opp.strategy === 'MAKER' ? 'success' : 'default'}>{opp.strategy}</Badge>
                            <Badge variant={opp.side === 'YES' ? 'inverted' : 'warning'}>{opp.side === 'YES' ? 'YES→NO' : 'NO→YES'}</Badge>
                            {opp.isInverted && <Badge variant="inverted" icon="arrow-left-right">INV</Badge>}
                            {opp.profitPercent > 2.5 && <Badge variant="warning">HOT</Badge>}
                            {opp.risk.level === 'HIGH' && <Badge variant="danger" icon="alert-triangle">RISK</Badge>}
                            {opp.endDate && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 font-mono">
                                    <Icon name="clock" size={10} className="inline mr-1" />
                                    {new Date(opp.endDate).toLocaleDateString()}
                                </span>
                            )}
                            {/* P/M 按钮 */}
                            <ViewLinks
                                predictId={opp.marketId}
                                predictSlug={opp.predictSlug}
                                polymarketSlug={opp.polymarketSlug}
                                polymarketConditionId={opp.polymarketConditionId}
                                title={opp.title}
                            />
                        </div>
                        {/* 右侧: profit + 展开按钮 */}
                        <div className="flex items-center gap-3 flex-shrink-0">
                            <FlashValue value={opp.estimatedProfit}>
                                <div className={`text-xl font-display font-semibold tracking-tight ${opp.estimatedProfit > 1 ? 'text-emerald-400' : 'text-white'}`}>
                                    +${opp.estimatedProfit.toFixed(2)}
                                    <span className="text-xs ml-1 opacity-70">({opp.profitPercent.toFixed(1)}%)</span>
                                </div>
                            </FlashValue>
                            <div className={`text-zinc-500 transition-transform duration-300 ${expanded ? 'rotate-180 text-amber-500' : ''}`}>
                                <Icon name="chevron-down" size={20} />
                            </div>
                        </div>
                    </div>
                    {/* Title */}
                    <h3 className="text-base font-medium text-white line-clamp-2 mb-3">{opp.title}</h3>

                    {/* Price Cards Row - Always Visible */}
                    <div className="grid grid-cols-2 gap-3 mb-3">
                        {/* Predict Card */}
                        <div className="p-3 rounded-lg border border-zinc-800/50 bg-zinc-900/50">
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <div className="w-5 h-5 rounded bg-blue-500/20 flex items-center justify-center">
                                        <span className="text-[10px] font-bold text-blue-400">P</span>
                                    </div>
                                    <span className="text-xs text-zinc-400">Predict</span>
                                </div>
                                {opp.predictVolume ? (
                                    <div className="text-right">
                                        <span className="text-[10px] text-zinc-500 font-mono">vol: </span>
                                        <span className="font-mono text-xs text-zinc-400">${opp.predictVolume >= 1000000 ? (opp.predictVolume / 1_000_000).toFixed(1) + 'M' : opp.predictVolume >= 1000 ? (opp.predictVolume / 1000).toFixed(1) + 'K' : opp.predictVolume.toFixed(0)}</span>
                                    </div>
                                ) : null}
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between items-center gap-2">
                                    <span className={`text-[10px] ${opp.strategy === 'TAKER' ? 'text-amber-500' : 'text-zinc-500'}`}>{opp.side === 'NO' ? 'NO_ASK' : 'YES_ASK'}</span>
                                    <FlashValue value={opp.depth.predictAskDepth}>
                                        <span className="text-[10px] text-zinc-600 font-mono">{opp.depth.predictAskDepth.toFixed(0)}sh</span>
                                    </FlashValue>
                                    <FlashValue value={opp.predictAsk}>
                                        <span className={`font-mono text-sm ${opp.strategy === 'TAKER' ? 'text-amber-400' : 'text-zinc-400'}`}>{(opp.predictAsk * 100).toFixed(1)}¢</span>
                                    </FlashValue>
                                </div>
                                <div className="flex justify-between items-center gap-2">
                                    <span className={`text-[10px] ${opp.strategy === 'MAKER' ? 'text-amber-500' : 'text-zinc-500'}`}>{opp.side === 'NO' ? 'NO_BID' : 'YES_BID'}</span>
                                    <FlashValue value={opp.depth.predictBidDepth}>
                                        <span className="text-[10px] text-zinc-600 font-mono">{opp.depth.predictBidDepth.toFixed(0)}sh</span>
                                    </FlashValue>
                                    <FlashValue value={opp.predictBid}>
                                        <span className={`font-mono text-sm ${opp.strategy === 'MAKER' ? 'text-amber-400' : 'text-zinc-400'}`}>{(opp.predictBid * 100).toFixed(1)}¢</span>
                                    </FlashValue>
                                </div>
                            </div>
                        </div>

                        {/* Polymarket Card */}
                        <div className="p-3 rounded-lg border border-zinc-800/50 bg-zinc-900/50">
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <div className="w-5 h-5 rounded bg-purple-500/20 flex items-center justify-center">
                                        <span className="text-[10px] font-bold text-purple-400">M</span>
                                    </div>
                                    <span className="text-xs text-zinc-400">Polymarket</span>
                                </div>
                                {opp.polyVolume ? (
                                    <div className="text-right">
                                        <span className="text-[10px] text-zinc-500 font-mono">vol: </span>
                                        <span className="font-mono text-xs text-zinc-400">${(opp.polyVolume / 1_000_000).toFixed(1)}M</span>
                                    </div>
                                ) : null}
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between items-center gap-2">
                                    <span className="text-[10px] text-blue-400">{opp.side === 'NO' ? 'ASK (YES)' : 'ASK (NO)'}</span>
                                    <FlashValue value={opp.depth.polymarketNoAskDepth}>
                                        <span className="text-[10px] text-zinc-600 font-mono">{opp.depth.polymarketNoAskDepth.toFixed(0)}sh</span>
                                    </FlashValue>
                                    <FlashValue value={opp.polymarketPrice}>
                                        <span className="font-mono text-sm text-blue-400">{(opp.polymarketPrice * 100).toFixed(1)}¢</span>
                                    </FlashValue>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Bottom Row: Meta Info */}
                    {(() => {
                        // 后端 arb-service.ts 已经把 makerCost/takerCost 转换为美分单位
                        // 例如 95.0 = 95.0¢ = $0.95，不需要再乘以100
                        const makerTotal = opp.makerCost || 0;
                        const takerTotal = opp.takerCost || 0;
                        const getColorClass = (val) => val < 100 ? 'text-emerald-400' : val === 100 ? 'text-amber-400' : 'text-rose-400';
                        return (
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-6 font-mono">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-zinc-500">Maker Total:</span>
                                        <FlashValue value={makerTotal}>
                                            <span className={`text-base font-semibold ${getColorClass(makerTotal)}`}>{makerTotal.toFixed(1)}¢</span>
                                        </FlashValue>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-zinc-500">Taker Total:</span>
                                        <FlashValue value={takerTotal}>
                                            <span className={`text-base font-semibold ${getColorClass(takerTotal)}`}>{takerTotal.toFixed(1)}¢</span>
                                        </FlashValue>
                                    </div>
                                    <span className="text-zinc-600">|</span>
                                    <span className="text-xs text-zinc-500">{timeSinceUpdate}s ago</span>
                                </div>
                                <div className="hidden md:flex items-center">
                                    <DepthIndicator depth={opp.maxQuantity} />
                                </div>
                            </div>
                        );
                    })()}

                    {/* Buy/Sell Buttons - Always Visible */}
                    <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                        <button
                            onClick={() => onOpenTaskModal && onOpenTaskModal(opp, primaryTaskType)}
                            className={`flex-1 h-10 rounded-lg text-white font-medium text-sm hover:brightness-110 hover:shadow-glow-button active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 ${primaryIsBuy ? 'bg-emerald-500' : 'bg-rose-500'}`}>
                            <Icon name={primaryIsBuy ? "arrow-down-circle" : "arrow-up-circle"} size={16} strokeWidth={2} />
                            {primaryIsBuy ? 'Buy' : 'Sell'}
                        </button>
                        {/* TAKER 策略不支持 SELL，隐藏按钮 */}
                        {opp.strategy !== 'TAKER' && (
                            <button
                                onClick={() => onOpenTaskModal && onOpenTaskModal(opp, 'SELL')}
                                className="flex-1 h-10 rounded-lg bg-rose-500 text-white font-medium text-sm hover:brightness-110 hover:shadow-glow-button active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2">
                                <Icon name="arrow-up-circle" size={16} strokeWidth={2} />
                                Sell
                            </button>
                        )}
                    </div>
                </div>

                {/* Expanded */}
                <div className={`grid transition-all duration-300 ease-out bg-black/20 ${expanded ? 'grid-rows-[1fr] opacity-100 border-t border-zinc-800/50' : 'grid-rows-[0fr] opacity-0'}`}>
                    <div className="min-h-0">
                        <div className="p-6">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                {/* Legs */}
                                <div className="space-y-3">
                                    <h4 className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Execution Legs</h4>
                                    {[
                                        { label: 'Long (Predict)', price: opp.predictPrice, depth: opp.depth.predict, color: 'bg-blue-400' },
                                        { label: 'Short (Polymarket)', price: opp.polymarketPrice, depth: opp.depth.polymarket, color: 'bg-rose-400' }
                                    ].map((leg, idx) => (
                                        <div key={idx} className="p-3 rounded-lg border border-zinc-800/50 bg-zinc-900/50 flex justify-between items-center">
                                            <div>
                                                <div className="text-[10px] text-zinc-500 mb-1 flex items-center gap-2">
                                                    <div className={`w-1.5 h-1.5 rounded-full ${leg.color}`}></div>
                                                    {leg.label}
                                                </div>
                                                <div className="text-lg font-display font-medium text-white">{(leg.price * 100).toFixed(1)}¢</div>
                                            </div>
                                            <div className="text-right">
                                                <div className="text-[10px] text-zinc-500 mb-1">Depth</div>
                                                <div className="font-mono text-sm text-white">${leg.depth}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {/* Fees */}
                                <div className="space-y-3">
                                    <h4 className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Cost Analysis</h4>
                                    <div className="p-4 rounded-lg border border-zinc-800/50 bg-zinc-900/30 space-y-3">
                                        <div className="flex justify-between text-xs">
                                            <span className="text-zinc-500">Slippage Est.</span>
                                            <span className={opp.risk.slippage > 1 ? 'text-rose-400' : 'text-white'}>{opp.risk.slippage}%</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-zinc-500">Predict Fee</span>
                                            <span className="text-white">${opp.fees.predict.toFixed(2)}</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-zinc-500">Network Gas</span>
                                            <span className="text-white">${opp.fees.gas.toFixed(2)}</span>
                                        </div>
                                        <div className="h-px bg-zinc-800 my-2"></div>
                                        <div className="flex justify-between text-xs font-medium">
                                            <span className="text-zinc-500">Total Cost</span>
                                            <span className="text-white">${opp.costs.total.toFixed(2)}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Actions */}
                                <div className="flex flex-col justify-end gap-3">
                                    <div className="flex justify-between text-xs font-mono text-zinc-500">
                                        <span>MAX QTY</span>
                                        <span className="text-white">{opp.maxQuantity} SHARES</span>
                                    </div>
                                    <div className="flex justify-between text-xs font-mono text-zinc-500 mb-2">
                                        <span>NET PROFIT</span>
                                        <span className="text-emerald-400">+${opp.estimatedProfit.toFixed(2)} ({opp.profitPercent.toFixed(2)}%)</span>
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => onOpenTaskModal && onOpenTaskModal(opp, primaryTaskType)}
                                            className={`flex-1 h-11 rounded-lg text-white font-medium text-sm hover:brightness-110 hover:shadow-glow-button active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 ${primaryIsBuy ? 'bg-emerald-500' : 'bg-rose-500'}`}>
                                            <Icon name={primaryIsBuy ? "arrow-down-circle" : "arrow-up-circle"} size={16} strokeWidth={2} />
                                            {primaryIsBuy ? 'Buy' : 'Sell'}
                                        </button>
                                        {opp.strategy !== 'TAKER' && (
                                            <button
                                                onClick={() => onOpenTaskModal && onOpenTaskModal(opp, 'SELL')}
                                                className="flex-1 h-11 rounded-lg bg-rose-500 text-white font-medium text-sm hover:brightness-110 hover:shadow-glow-button active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2">
                                                <Icon name="arrow-up-circle" size={16} strokeWidth={2} />
                                                Sell
                                            </button>
                                        )}
                                    </div>
                                    <div className="text-[10px] text-center text-zinc-500">
                                        Updated {timeSinceUpdate}s ago
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

const FilterBar = ({ filters, setFilters, onReset }) => (
    <div className="flex flex-col md:flex-row gap-4 items-center justify-between mb-6 p-4 rounded-xl border border-zinc-800/50 bg-zinc-900/30 backdrop-blur-sm">
        <div className="flex items-center gap-4 w-full md:w-auto overflow-x-auto pb-2 md:pb-0">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-700/50 bg-black/50 text-xs font-medium text-zinc-500 whitespace-nowrap">
                <Icon name="filter" size={14} />
                <span>Strategy:</span>
                <select value={filters.strategy} onChange={(e) => setFilters({ ...filters, strategy: e.target.value })}
                    className="bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 outline-none text-white cursor-pointer"
                    style={{ colorScheme: 'dark' }}>
                    <option value="ALL" className="bg-zinc-900 text-white">All</option>
                    <option value="MAKER" className="bg-zinc-900 text-white">Maker</option>
                    <option value="TAKER" className="bg-zinc-900 text-white">Taker</option>
                </select>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-700/50 bg-black/50 text-xs font-medium text-zinc-500 whitespace-nowrap">
                <Icon name="arrow-up-down" size={14} />
                <span>Sort:</span>
                <select value={filters.sortBy} onChange={(e) => setFilters({ ...filters, sortBy: e.target.value })}
                    className="bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 outline-none text-white cursor-pointer"
                    style={{ colorScheme: 'dark' }}>
                    <option value="ID" className="bg-zinc-900 text-white">ID (稳定)</option>
                    <option value="PROFIT" className="bg-zinc-900 text-white">利润$ ↓</option>
                    <option value="PROFIT_PCT" className="bg-zinc-900 text-white">利润% ↓</option>
                    <option value="TIME" className="bg-zinc-900 text-white">更新时间 ↓</option>
                    <option value="SETTLEMENT" className="bg-zinc-900 text-white">结算时间 ↑</option>
                    <option value="DEPTH" className="bg-zinc-900 text-white">深度 ↓</option>
                </select>
            </div>
            <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg border border-zinc-700/50 bg-black/50 text-xs font-medium text-zinc-500 whitespace-nowrap min-w-[200px]">
                <Icon name="sliders-horizontal" size={14} />
                <span>Min: <span className="text-white">{filters.minProfit}%</span></span>
                <input type="range" min="0" max="5" step="0.1" value={filters.minProfit}
                    onChange={(e) => setFilters({ ...filters, minProfit: parseFloat(e.target.value) })}
                    className="w-24 accent-amber-500 h-1 bg-zinc-800 rounded-lg cursor-pointer" />
            </div>
        </div>
        <button onClick={onReset} className="text-xs text-zinc-500 hover:text-white underline decoration-dotted transition-colors whitespace-nowrap">
            Reset
        </button>
    </div>
);

const HistoryTable = ({ history }) => (
    <Card className="overflow-hidden" noPadding>
        <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
                <thead>
                    <tr className="border-b border-zinc-800/50 bg-zinc-900/50 text-[10px] uppercase tracking-wide text-zinc-500">
                        <th className="p-4 font-medium">Time</th>
                        <th className="p-4 font-medium">Market</th>
                        <th className="p-4 font-medium">Strategy</th>
                        <th className="p-4 font-medium text-right">PnL</th>
                        <th className="p-4 font-medium">Status</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                    {history.map((record) => (
                        <tr key={record.id} className="hover:bg-white/5 transition-colors">
                            <td className="p-4 text-xs font-mono text-zinc-500 whitespace-nowrap">
                                {new Date(record.timestamp).toLocaleTimeString()}
                            </td>
                            <td className="p-4">
                                <div className="text-xs font-medium text-white truncate max-w-[200px]">{record.title}</div>
                                <div className="text-[10px] text-zinc-500">#{record.marketId}</div>
                            </td>
                            <td className="p-4"><Badge>{record.strategy}</Badge></td>
                            <td className="p-4 text-right">
                                <div className={`text-sm font-mono font-medium ${record.realizedProfit > 0 ? 'text-emerald-400' : 'text-zinc-500'}`}>
                                    {record.realizedProfit > 0 ? '+' : ''}${record.realizedProfit?.toFixed(2)}
                                </div>
                            </td>
                            <td className="p-4">
                                <span className={`text-[10px] font-bold uppercase tracking-wide
                                    ${record.status === 'EXECUTED' ? 'text-emerald-400' : record.status === 'FAILED' ? 'text-rose-400' : 'text-zinc-500'}`}>
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

// Task Status Badge
const TaskStatusBadge = ({ status }) => {
    const colors = {
        'PENDING': 'bg-zinc-800 text-zinc-400 border-zinc-700',
        'VALIDATING': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        'PREDICT_SUBMITTED': 'bg-amber-500/10 text-amber-400 border-amber-500/20',
        'PARTIALLY_FILLED': 'bg-amber-500/10 text-amber-400 border-amber-500/20',
        'PAUSED': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
        'HEDGING': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        'HEDGE_PENDING': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
        'HEDGE_RETRY': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
        'HEDGE_FAILED': 'bg-rose-500/10 text-rose-400 border-rose-500/20',
        'LOSS_HEDGE': 'bg-orange-500/20 text-orange-400 border-orange-500/30 animate-pulse',
        'COMPLETED': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        'FAILED': 'bg-rose-500/10 text-rose-400 border-rose-500/20',
        'CANCELLED': 'bg-zinc-800 text-zinc-500 border-zinc-700',
        'TIMEOUT_CANCELLED': 'bg-zinc-800 text-zinc-500 border-zinc-700',
        'UNWINDING': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
        'UNWIND_PENDING': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
        'UNWIND_COMPLETED': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    };

    // 状态中文映射
    const statusLabels = {
        'PENDING': '待执行',
        'VALIDATING': '校验中',
        'PREDICT_SUBMITTED': 'Predict 已挂单',
        'PARTIALLY_FILLED': '部分成交',
        'PAUSED': '已暂停',
        'HEDGING': '对冲中',
        'HEDGE_PENDING': '对冲等待',
        'HEDGE_RETRY': '对冲重试',
        'HEDGE_FAILED': '对冲失败',
        'LOSS_HEDGE': '⚠️ 亏损对冲',
        'COMPLETED': '已完成',
        'FAILED': '失败',
        'CANCELLED': '已取消',
        'TIMEOUT_CANCELLED': '超时取消',
        'UNWINDING': '反向平仓中',
        'UNWIND_PENDING': '准备平仓',
        'UNWIND_COMPLETED': '平仓完成',
    };

    return (
        <span className={`text-[10px] px-2 py-1 rounded border font-medium ${colors[status] || colors['PENDING']}`}>
            {statusLabels[status] || status}
        </span>
    );
};

// Tasks Tab Component
const TasksTab = ({ tasks, onStart, onCancel, onViewLogs, onUpdateTask, apiBaseUrl }) => {
    const activeTasks = tasks.filter(t => !['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'].includes(t.status));
    const completedTasks = tasks.filter(t => ['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'].includes(t.status));

    return (
        <div className="space-y-6">
            {/* Active Tasks */}
            <div>
                <div className="flex items-center justify-between mb-4 px-1">
                    <h3 className="font-display text-sm font-medium text-white flex items-center gap-2">
                        <Icon name="play-circle" size={16} className="text-amber-500" />
                        活跃任务
                    </h3>
                    <div className="text-xs text-zinc-500 font-mono">{activeTasks.length} 个任务</div>
                </div>

                {activeTasks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30">
                        <Icon name="inbox" size={40} className="text-zinc-600 mb-4" strokeWidth={1} />
                        <p className="text-sm text-zinc-400">暂无活跃任务</p>
                        <p className="text-xs text-zinc-500 mt-1">在机会卡片上点击 Buy/Sell 创建任务</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {activeTasks.map(task => (
                            <div key={task.id} className="glass-card rounded-xl p-4 border border-zinc-800/50 hover:border-zinc-700/50 transition-all">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className={`text-xs font-bold ${task.type === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                {task.type}
                                            </span>
                                            <TaskStatusBadge status={task.status} />
                                            <span className="text-xs font-mono text-zinc-500">#{task.marketId}</span>
                                            <ViewLinks
                                                predictId={task.marketId}
                                                predictSlug={task.predictSlug}
                                                polymarketSlug={task.polymarketSlug}
                                                polymarketConditionId={task.polymarketConditionId}
                                                title={task.title}
                                            />
                                        </div>
                                        <h4 className="text-sm text-white font-medium leading-tight mb-2" title={task.title}>{task.title}</h4>
                                        <div className="grid grid-cols-4 gap-4 text-xs">
                                            <div>
                                                <span className="text-zinc-500">Predict</span>
                                                <div className="text-white font-mono">{(task.predictPrice * 100).toFixed(1)}¢</div>
                                            </div>
                                            <div>
                                                <span className="text-zinc-500">数量</span>
                                                <div className="text-white font-mono">{task.quantity}</div>
                                            </div>
                                            <div>
                                                <ExpirySelector
                                                    taskId={task.id}
                                                    currentExpiresAt={task.expiresAt}
                                                    onUpdate={(update) => onUpdateTask && onUpdateTask(task.id, update)}
                                                    apiBaseUrl={apiBaseUrl}
                                                />
                                            </div>
                                            <div>
                                                <span className="text-zinc-500">已成交</span>
                                                <div className="text-white font-mono">{task.predictFilledQty || 0}</div>
                                            </div>
                                        </div>
                                        {task.error && (
                                            <div className="mt-2 text-xs text-rose-400 bg-rose-500/10 rounded px-2 py-1">
                                                {task.error}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        {task.status === 'PENDING' && (
                                            <button
                                                onClick={() => onStart(task.id)}
                                                className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-xs font-medium hover:brightness-110 transition-all">
                                                启动
                                            </button>
                                        )}
                                        <button
                                            onClick={() => onViewLogs && onViewLogs(task.id)}
                                            className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-400 text-xs font-medium hover:bg-amber-500/20 hover:text-amber-400 transition-all flex items-center gap-1">
                                            <Icon name="file-text" size={12} />
                                            日志
                                        </button>
                                        <button
                                            onClick={() => onCancel(task.id)}
                                            className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-400 text-xs font-medium hover:bg-zinc-700 hover:text-white transition-all">
                                            取消
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Completed Tasks */}
            {completedTasks.length > 0 && (
                <div>
                    <div className="flex items-center justify-between mb-4 px-1">
                        <h3 className="font-display text-sm font-medium text-zinc-400 flex items-center gap-2">
                            <Icon name="check-circle" size={16} className="text-zinc-500" />
                            历史任务
                        </h3>
                        <div className="text-xs text-zinc-500 font-mono">{completedTasks.length} 个任务</div>
                    </div>
                    <div className="space-y-2">
                        {completedTasks.slice(0, 10).map(task => (
                            <div key={task.id} className="glass-card rounded-xl p-3 border border-zinc-800/30 hover:border-zinc-700/50 transition-all group">
                                <div className="flex items-center justify-between gap-4">
                                    <div className="flex items-center gap-3 min-w-0 flex-1">
                                        <span className={`text-xs font-bold ${task.type === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {task.type}
                                        </span>
                                        <span className="text-xs text-zinc-300 truncate" title={task.title}>{task.title}</span>
                                        <ViewLinks
                                            predictId={task.marketId}
                                            predictSlug={task.predictSlug}
                                            polymarketSlug={task.polymarketSlug}
                                            polymarketConditionId={task.polymarketConditionId}
                                            title={task.title}
                                        />
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {task.actualProfit !== undefined && (
                                            <span className={`text-xs font-mono ${task.actualProfit > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                {task.actualProfit > 0 ? '+' : ''}${task.actualProfit.toFixed(2)}
                                            </span>
                                        )}
                                        <TaskStatusBadge status={task.status} />
                                        <button
                                            onClick={() => onViewLogs && onViewLogs(task.id)}
                                            className="px-2 py-1 rounded bg-zinc-800 text-zinc-400 text-[10px] font-medium hover:bg-amber-500/20 hover:text-amber-400 transition-all flex items-center gap-1"
                                            title="查看日志">
                                            <Icon name="file-text" size={12} />
                                            日志
                                        </button>
                                        <button
                                            onClick={() => onCancel(task.id)}
                                            className="p-1 rounded text-zinc-600 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                                            title="删除">
                                            <Icon name="trash-2" size={14} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

// Task Modal Component
const TaskModal = ({ isOpen, onClose, data, onSubmit, accounts, apiBaseUrl }) => {
    const [quantity, setQuantity] = useState(10);
    const [predictPriceCents, setPredictPriceCents] = useState(0); // 使用美分单位避免精度问题
    const [priceEdited, setPriceEdited] = useState(false);
    const [isVisible, setIsVisible] = useState(false);
    const [isAnimating, setIsAnimating] = useState(false);
    // 两步创建流程状态
    const [createdTaskId, setCreatedTaskId] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState(null);

    // 处理打开动画
    useEffect(() => {
        if (isOpen) {
            setIsAnimating(true);
            // 小延迟后开始动画
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setIsVisible(true);
                });
            });
            // 重置两步流程状态
            setCreatedTaskId(null);
            setSubmitError(null);
            setPriceEdited(false);
        }
    }, [isOpen]);

    // 处理关闭动画
    const handleClose = () => {
        setIsVisible(false);
        setTimeout(() => {
            setIsAnimating(false);
            onClose();
        }, 200); // 等待动画完成
    };

    useEffect(() => {
        if (data?.opp) {
            setQuantity(Math.min(data.opp.maxQuantity || 10, 100));
            // 转换为美分并四舍五入，避免浮点精度问题
            // TAKER BUY 使用 ask 价格，MAKER BUY 使用 bid 价格
            const isTaker = data.opp.strategy === 'TAKER';
            const rawPrice = data.type === 'BUY'
                ? (isTaker ? data.opp.predictAsk : data.opp.predictBid)
                : data.opp.predictAsk;
            if (!priceEdited) {
                setPredictPriceCents(Math.round(rawPrice * 1000) / 10); // 精确到0.1美分
            }
        }
    }, [data]);

    // 转换回小数形式用于计算
    const predictPrice = predictPriceCents / 100;

    if (!isOpen && !isAnimating) return null;
    if (!data) return null;

    const { opp, type } = data;
    const isTaker = opp.strategy === 'TAKER';
    // 始终使用 opp.polymarketPrice，这是对冲方向的 ASK 价格
    // YES 端套利: polymarketPrice = NO ASK (买 NO 对冲)
    // NO 端套利: polymarketPrice = YES ASK (买 YES 对冲)
    const polyPrice = opp.polymarketPrice;
    // 对冲方向标签
    const polyTokenLabel = opp.side === 'YES' ? 'NO' : 'YES';
    // 用于计算的安全数量值 (空值时视为0)
    const safeQuantity = quantity === '' ? 0 : (parseInt(quantity) || 0);
    const estimatedProfit = (1 - predictPrice - polyPrice) * safeQuantity;
    const profitPercent = (1 - predictPrice - polyPrice) * 100;  // 利润百分比

    // 资金占用计算
    // BUY 任务: Predict 买入 YES (需要 predictPrice * qty USDT), Polymarket 买入 NO (需要 polyPrice * qty USDC)
    // SELL 任务: Predict 卖出 YES (需要持仓), Polymarket 卖出 NO (需要持仓)
    const needsFunds = type === 'BUY' || (isTaker && type === 'SELL'); // TAKER+SELL(NO 端套利) 仍然需要资金/保证金
    const predictRequired = needsFunds ? predictPrice * safeQuantity : 0;
    const polymarketRequired = needsFunds ? polyPrice * safeQuantity : 0;
    // TAKER 模式: Predict 手续费 = feeRate * min(price, 1-price) * quantity
    const feeRateBps = opp.feeRateBps || 200; // 默认 2%
    const feeRate = feeRateBps / 10000;
    const predictFee = (isTaker && needsFunds) ? feeRate * Math.min(predictPrice, 1 - predictPrice) * safeQuantity : 0;

    // 获取账户余额
    const predictBalance = accounts?.predict?.available || 0;
    const polymarketBalance = accounts?.polymarket?.available || 0;

    // 检查资金是否充足 (Predict 需要包含手续费)
    const predictTotalRequired = predictRequired + predictFee;
    const predictInsufficient = needsFunds && predictTotalRequired > predictBalance;
    const polymarketInsufficient = needsFunds && polymarketRequired > polymarketBalance;
    // Polymarket 最小订单限制: $1
    const POLYMARKET_MIN_ORDER = 1.0;
    const polymarketBelowMinimum = needsFunds && polymarketRequired > 0 && polymarketRequired < POLYMARKET_MIN_ORDER;
    const hasSufficientFunds = !predictInsufficient && !polymarketInsufficient && !polymarketBelowMinimum;

    // 验证必需字段
    const missingFields = [];
    if (!opp.polymarketConditionId) missingFields.push('polymarketConditionId');
    if (!opp.polymarketNoTokenId) missingFields.push('polymarketNoTokenId');
    if (!opp.polymarketYesTokenId) missingFields.push('polymarketYesTokenId');
    const hasRequiredFields = missingFields.length === 0;

    // 验证数量有效
    const hasValidQuantity = safeQuantity > 0;

    // 两步流程：第一步创建任务，第二步启动任务
    const handleSubmit = async () => {
        if (submitting) return;

        // 第二步：启动已创建的任务
        if (createdTaskId) {
            setSubmitting(true);
            setSubmitError(null);
            try {
                const res = await fetch(`${apiBaseUrl}/api/tasks/${createdTaskId}/start`, { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    handleClose();  // 关闭 Modal
                } else {
                    setSubmitError(data.error || 'Failed to start task');
                }
            } catch (error) {
                setSubmitError(error.message);
            } finally {
                setSubmitting(false);
            }
            return;
        }

        // 第一步：创建任务
        if (!hasRequiredFields) {
            alert(`缺少必需字段: ${missingFields.join(', ')}`);
            return;
        }

        // 基础任务参数
        // MAKER BUY: 套利条件 predictBid + polyAsk < 1.0
        // polymarketMaxAsk = 1.0 - predictBid，超过此价格无套利空间
        // MAKER SELL: polymarketMinBid = predictAsk，低于此价格亏损
        const taskParams = {
            type,
            marketId: opp.marketId,
            title: opp.title,
            predictSlug: opp.predictSlug,
            polymarketSlug: opp.polymarketSlug,
            polymarketConditionId: opp.polymarketConditionId,
            polymarketNoTokenId: opp.polymarketNoTokenId,
            polymarketYesTokenId: opp.polymarketYesTokenId,
            isInverted: opp.isInverted ?? false,
            tickSize: opp.tickSize ?? 0.01,
            negRisk: opp.negRisk ?? false,
            predictPrice,
            polymarketMaxAsk: type === 'BUY' ? (1.0 - predictPrice) : 0,
            polymarketMinBid: type === 'SELL' ? predictPrice : 0,
            quantity: safeQuantity,
            minProfitBuffer: 0.005,
            orderTimeout: isTaker ? 10000 : 60000,  // TAKER 默认 10 秒超时
            maxHedgeRetries: 3,
            idempotencyKey: `${type}-${opp.marketId}-${Date.now()}`,
            // 策略类型
            strategy: opp.strategy,
            // 套利方向 (YES端: Predict买YES+Poly买NO, NO端: Predict买NO+Poly买YES)
            arbSide: opp.side || 'YES',
        };

        // TAKER 模式专用字段
        if (isTaker) {
            // 计算 fee (与后端一致)
            const feeRateBps = opp.feeRateBps || 200;
            const baseFeePercent = feeRateBps / 10000;
            const minPrice = Math.min(predictPrice, 1 - predictPrice);
            const predictFee = baseFeePercent * minPrice;

            // maxTotalCost: 固定为 1（只要 totalCost < 1 就是盈利的）
            // 套利原理: predict 赢 + poly 赢 = 1，所以 totalCost < 1 即可保证盈利
            const maxTotalCost = 1;

            taskParams.predictAskPrice = predictPrice;
            taskParams.maxTotalCost = maxTotalCost;
            taskParams.feeRateBps = feeRateBps;
        }

        setSubmitting(true);
        setSubmitError(null);
        try {
            const res = await fetch(`${apiBaseUrl}/api/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(taskParams),
            });
            const data = await res.json();
            if (data.success) {
                const taskId = data.data?.id;
                if (taskId) {
                    setCreatedTaskId(taskId);  // 保存任务 ID，等待启动
                } else {
                    setSubmitError('Task created but no ID returned');
                }
            } else {
                setSubmitError(data.error || 'Failed to create task');
            }
        } catch (error) {
            setSubmitError(error.message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className={`fixed inset-0 z-50 flex items-center justify-center transition-all duration-200 ${isVisible ? 'bg-black/70 backdrop-blur-sm' : 'bg-black/0'}`}>
            <div className={`w-full max-w-md mx-4 glass-card rounded-2xl border border-zinc-700/50 shadow-2xl transition-all duration-200 ${isVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-4'}`}>
                <div className="p-6 border-b border-zinc-800">
                    <div className="flex items-center justify-between">
                        <h2 className="font-display text-lg font-semibold text-white flex items-center gap-2">
                            <span className={type === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}>{type}</span>
                            任务配置
                        </h2>
                        <button
                            onClick={handleClose}
                            className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-400 transition-all flex items-center justify-center"
                            title="关闭">
                            <Icon name="x" size={18} />
                        </button>
                    </div>
                    <p className="text-sm text-zinc-400 mt-1 truncate">{opp.title}</p>
                </div>

                <div className="p-6 space-y-4">
                    {/* Predict Price - 使用美分单位 */}
                    <div>
                        <label className="block text-xs text-zinc-500 mb-1">
                            Predict {type === 'BUY' ? 'Bid' : 'Ask'} 价格 (美分)
                        </label>
                        <div className="flex items-center gap-2">
                            <input
                                type="number"
                                value={predictPriceCents}
                                onChange={(e) => {
                                    setPriceEdited(true);
                                    setPredictPriceCents(Math.round(parseFloat(e.target.value) * 10) / 10 || 0);
                                }}
                                step="0.1"
                                min="1"
                                max="99"
                                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-amber-500"
                            />
                            <span className="text-amber-400 text-sm font-mono">¢</span>
                        </div>
                        <div className="text-[10px] text-zinc-600 mt-1">= ${predictPrice.toFixed(4)}</div>
                    </div>

                    {/* Quantity */}
                    <div>
                        <label className="block text-xs text-zinc-500 mb-1">数量 (Shares)</label>
                        <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={quantity}
                            onChange={(e) => {
                                const val = e.target.value;
                                // 允许空输入和纯数字
                                if (val === '' || /^\d+$/.test(val)) {
                                    setQuantity(val === '' ? '' : parseInt(val));
                                }
                            }}
                            onBlur={(e) => {
                                // 失焦时如果为空则设为1
                                if (e.target.value === '' || parseInt(e.target.value) < 1) {
                                    setQuantity(1);
                                }
                            }}
                            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-amber-500"
                        />
                        <div className="text-xs text-zinc-500 mt-1">最大深度: {opp.maxQuantity?.toFixed(0) || '-'} shares</div>
                    </div>

                    {/* 资金占用提示 */}
                    {needsFunds && (
                        <div className="bg-zinc-900/50 rounded-lg p-3 border border-zinc-800 space-y-2">
                            <div className="text-xs text-zinc-500 font-medium mb-2">资金占用</div>

                            {/* Predict 资金占用 */}
                            <div className="flex justify-between items-center">
                                <div className="flex items-center gap-2">
                                    <div className="w-4 h-4 rounded bg-blue-500/20 flex items-center justify-center">
                                        <span className="text-[8px] font-bold text-blue-400">P</span>
                                    </div>
                                    <span className="text-xs text-zinc-400">Predict</span>
                                    {isTaker && predictFee > 0 && (
                                        <span className="text-[10px] text-zinc-500">
                                            (含fee ${predictFee.toFixed(2)})
                                        </span>
                                    )}
                                </div>
                                <div className="text-right">
                                    <span className={`font-mono text-sm ${predictInsufficient ? 'text-rose-400' : 'text-white'}`}>
                                        ${predictTotalRequired.toFixed(2)}
                                    </span>
                                    <span className="text-xs text-zinc-500 ml-1">
                                        / ${predictBalance.toFixed(2)}
                                    </span>
                                    {predictInsufficient && (
                                        <span className="text-[10px] text-rose-400 ml-1">不足</span>
                                    )}
                                </div>
                            </div>

                            {/* Polymarket 资金占用 */}
                            <div className="flex justify-between items-center">
                                <div className="flex items-center gap-2">
                                    <div className="w-4 h-4 rounded bg-purple-500/20 flex items-center justify-center">
                                        <span className="text-[8px] font-bold text-purple-400">M</span>
                                    </div>
                                    <span className="text-xs text-zinc-400">Polymarket</span>
                                </div>
                                <div className="text-right">
                                    <span className={`font-mono text-sm ${(polymarketInsufficient || polymarketBelowMinimum) ? 'text-rose-400' : 'text-white'}`}>
                                        ${polymarketRequired.toFixed(2)}
                                    </span>
                                    <span className="text-xs text-zinc-500 ml-1">
                                        / ${polymarketBalance.toFixed(2)}
                                    </span>
                                    {polymarketInsufficient && (
                                        <span className="text-[10px] text-rose-400 ml-1">不足</span>
                                    )}
                                    {polymarketBelowMinimum && (
                                        <span className="text-[10px] text-rose-400 ml-1">最小$1</span>
                                    )}
                                </div>
                            </div>

                            {/* 总计 */}
                            <div className="flex justify-between items-center pt-2 border-t border-zinc-800">
                                <span className="text-xs text-zinc-400">总计</span>
                                <span className={`font-mono text-sm font-medium ${!hasSufficientFunds ? 'text-rose-400' : 'text-amber-400'}`}>
                                    ${(predictTotalRequired + polymarketRequired).toFixed(2)}
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Polymarket Price (readonly) */}
                    <div>
                        <label className="block text-xs text-zinc-500 mb-1">
                            Polymarket {polyTokenLabel} ASK (对冲买入价)
                        </label>
                        <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-400 font-mono text-sm">
                            {(polyPrice * 100).toFixed(1)}¢
                        </div>
                    </div>

                    {/* Estimated Profit */}
                    <div className="bg-zinc-900/50 rounded-lg p-3 border border-zinc-800">
                        <div className="flex justify-between text-sm">
                            <span className="text-zinc-500">预估利润</span>
                            <span className={estimatedProfit > 0 ? 'text-emerald-400 font-medium' : 'text-rose-400'}>
                                {estimatedProfit > 0 ? '+' : ''}${estimatedProfit.toFixed(2)} ({profitPercent.toFixed(2)}%)
                            </span>
                        </div>
                    </div>
                </div>

                {/* 错误提示 */}
                {submitError && (
                    <div className="px-6 py-2 bg-rose-500/10 border-t border-rose-500/30">
                        <p className="text-sm text-rose-400">{submitError}</p>
                    </div>
                )}

                <div className="p-6 border-t border-zinc-800 flex gap-3">
                    <button
                        onClick={handleClose}
                        disabled={submitting}
                        className="flex-1 py-2.5 rounded-lg bg-zinc-800 text-zinc-400 font-medium text-sm hover:bg-zinc-700 hover:text-white transition-all disabled:opacity-50">
                        取消
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={submitting || (!createdTaskId && (!hasRequiredFields || !hasValidQuantity || (needsFunds && !hasSufficientFunds)))}
                        className={`flex-1 py-2.5 rounded-lg font-medium text-sm text-white transition-all ${
                            submitting || (!createdTaskId && (!hasRequiredFields || !hasValidQuantity || (needsFunds && !hasSufficientFunds)))
                                ? 'bg-zinc-600 cursor-not-allowed opacity-50'
                                : createdTaskId
                                    ? 'bg-amber-500 hover:brightness-110'  // 启动按钮使用金色
                                    : type === 'BUY'
                                        ? 'bg-emerald-500 hover:brightness-110'
                                        : 'bg-rose-500 hover:brightness-110'
                        }`}>
                        {submitting
                            ? (createdTaskId ? '启动中...' : '创建中...')
                            : createdTaskId
                                ? '▶ 启动'
                                : !hasRequiredFields
                                    ? '数据不完整'
                                    : !hasValidQuantity
                                        ? '请输入数量'
                                        : (needsFunds && !hasSufficientFunds)
                                            ? '资金不足'
                                            : '创建任务'
                        }
                    </button>
                </div>
            </div>
        </div>
    );
};

// New: Enhanced Analytics Dashboard
const AnalyticsDashboard = ({ stats, chartData }) => (
    <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Profit Trend */}
            <Card className="p-6">
                <h3 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
                    <Icon name="trending-up" size={16} className="text-amber-500" />
                    Profit Trend (24h)
                </h3>
                <div className="h-48 flex items-end justify-between gap-1">
                    {chartData.profitTrend.map((d, i) => (
                        <div key={i} className="w-full relative group">
                            <div className="bg-zinc-800 hover:bg-emerald-500/20 transition-colors rounded-t-sm"
                                style={{ height: `${(d.avgProfit / 3) * 100}%` }}>
                                <div className="absolute inset-0 bg-emerald-500 opacity-30 group-hover:opacity-50 transition-opacity rounded-t-sm"></div>
                            </div>
                            <div className="absolute -top-8 left-1/2 -translate-x-1/2 text-[9px] bg-zinc-900 border border-zinc-700 px-1.5 py-0.5 rounded text-white opacity-0 group-hover:opacity-100 transition-opacity font-mono pointer-events-none whitespace-nowrap">
                                {d.avgProfit.toFixed(1)}%
                            </div>
                        </div>
                    ))}
                </div>
                <div className="flex justify-between mt-2 text-[10px] text-zinc-500 font-mono">
                    <span>0h</span>
                    <span>24h</span>
                </div>
            </Card>

            {/* Strategy Distribution Pie Chart */}
            <Card className="p-6">
                <h3 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
                    <Icon name="pie-chart" size={16} className="text-amber-500" />
                    Strategy Distribution
                </h3>
                <div className="flex items-center justify-center h-48">
                    <div className="relative">
                        <div className="w-32 h-32 rounded-full pie-chart"
                            style={{ '--maker-pct': chartData.strategyDistribution.maker }}>
                        </div>
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="w-20 h-20 rounded-full bg-zinc-900 flex flex-col items-center justify-center">
                                <span className="text-2xl font-display font-bold text-white">{stats.makerCount + stats.takerCount}</span>
                                <span className="text-[10px] text-zinc-500">Total</span>
                            </div>
                        </div>
                    </div>
                    <div className="ml-8 space-y-3">
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded bg-emerald-500"></div>
                            <span className="text-xs text-zinc-400">Maker</span>
                            <span className="text-xs font-mono text-white ml-2">{chartData.strategyDistribution.maker}%</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded bg-blue-500"></div>
                            <span className="text-xs text-zinc-400">Taker</span>
                            <span className="text-xs font-mono text-white ml-2">{chartData.strategyDistribution.taker}%</span>
                        </div>
                    </div>
                </div>
            </Card>

            {/* Opportunity Count Over Time */}
            <Card className="p-6">
                <h3 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
                    <Icon name="bar-chart-3" size={16} className="text-amber-500" />
                    Opportunity Count (24h)
                </h3>
                <div className="h-48 flex items-end justify-between gap-0.5">
                    {chartData.opportunityCounts.map((d, i) => (
                        <div key={i} className="w-full flex flex-col-reverse">
                            <div className="bg-emerald-500/50 rounded-t-sm transition-all" style={{ height: `${d.maker * 8}px` }}></div>
                            <div className="bg-blue-500/50 transition-all" style={{ height: `${d.taker * 8}px` }}></div>
                        </div>
                    ))}
                </div>
                <div className="flex justify-between mt-2 text-[10px] text-zinc-500 font-mono">
                    <span>0h</span>
                    <span>24h</span>
                </div>
                <div className="flex justify-center gap-4 mt-3">
                    <div className="flex items-center gap-1 text-[10px] text-zinc-500">
                        <div className="w-2 h-2 rounded bg-emerald-500/50"></div>
                        Maker
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-zinc-500">
                        <div className="w-2 h-2 rounded bg-blue-500/50"></div>
                        Taker
                    </div>
                </div>
            </Card>

            {/* Depth vs Spread Scatter */}
            <Card className="p-6">
                <h3 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
                    <Icon name="scatter-chart" size={16} className="text-amber-500" />
                    Depth vs Spread
                </h3>
                <div className="h-48 relative border-l border-b border-zinc-700/50">
                    {Array.from({ length: 15 }).map((_, i) => (
                        <div key={i}
                            className="absolute w-2 h-2 rounded-full bg-amber-500 opacity-60 hover:opacity-100 hover:scale-150 transition-all cursor-pointer shadow-glow-sm"
                            style={{ left: `${Math.random() * 90}%`, bottom: `${Math.random() * 90}%` }}
                            title="Opportunity">
                        </div>
                    ))}
                    <span className="absolute -left-6 top-1/2 -rotate-90 text-[10px] text-zinc-500 origin-center">Depth</span>
                </div>
                <div className="text-[10px] text-zinc-500 text-center mt-2">Spread %</div>
            </Card>
        </div>
    </div>
);

// Notification Toast
const NotificationToast = ({ notification, onDismiss }) => (
    <div className="notification-toast glass-card rounded-lg p-4 mb-2 border-l-4 border-amber-500 max-w-sm">
        <div className="flex justify-between items-start">
            <div>
                <div className="text-sm font-medium text-white">{notification.title}</div>
                <div className="text-xs text-zinc-400 mt-1 truncate max-w-[200px]">{notification.message}</div>
                <div className="text-xs text-emerald-400 mt-1 font-mono">+${notification.profit.toFixed(2)}</div>
            </div>
            <button onClick={() => onDismiss(notification.id)} className="text-zinc-500 hover:text-white transition-colors">
                <Icon name="x" size={14} />
            </button>
        </div>
    </div>
);

// ============================================================================
// Order Toast (订单状态浮窗通知)
// ============================================================================

// 事件类型配置
const ORDER_EVENT_CONFIG = {
    'TASK_STARTED': { emoji: '🚀', label: '任务启动', color: 'border-blue-500', bg: 'bg-blue-500/10' },
    'TASK_COMPLETED': { emoji: '✅', label: '任务完成', color: 'border-emerald-500', bg: 'bg-emerald-500/10' },
    'TASK_FAILED': { emoji: '❌', label: '任务失败', color: 'border-rose-500', bg: 'bg-rose-500/10' },
    'TASK_CANCELLED': { emoji: '🛑', label: '任务取消', color: 'border-zinc-500', bg: 'bg-zinc-500/10' },
    'TASK_PAUSED': { emoji: '⏸️', label: '任务暂停', color: 'border-amber-500', bg: 'bg-amber-500/10' },
    'TASK_RESUMED': { emoji: '▶️', label: '任务恢复', color: 'border-blue-500', bg: 'bg-blue-500/10' },
    'ORDER_SUBMITTED': { emoji: '📤', label: '订单提交', color: 'border-blue-400', bg: 'bg-blue-400/10' },
    'ORDER_FILLED': { emoji: '💰', label: '订单成交', color: 'border-emerald-400', bg: 'bg-emerald-400/10' },
    'ORDER_PARTIAL_FILL': { emoji: '🔄', label: '部分成交', color: 'border-amber-400', bg: 'bg-amber-400/10' },
    'ORDER_CANCELLED': { emoji: '❌', label: '订单取消', color: 'border-rose-400', bg: 'bg-rose-400/10' },
    'ORDER_EXPIRED': { emoji: '⏰', label: '订单过期', color: 'border-zinc-400', bg: 'bg-zinc-400/10' },
    'HEDGE_SUBMITTED': { emoji: '🔗', label: '对冲提交', color: 'border-purple-400', bg: 'bg-purple-400/10' },
    'HEDGE_FILLED': { emoji: '🎯', label: '对冲成交', color: 'border-purple-400', bg: 'bg-purple-400/10' },
    'HEDGE_FAILED': { emoji: '⚠️', label: '对冲失败', color: 'border-rose-400', bg: 'bg-rose-400/10' },
    'PRICE_GUARD_TRIGGERED': { emoji: '🛡️', label: '价格守护', color: 'border-amber-500', bg: 'bg-amber-500/10' },
    'COST_INVALID': { emoji: '💸', label: '成本失效', color: 'border-rose-500', bg: 'bg-rose-500/10' },
};

// 单个 Toast 组件
const OrderToast = ({ toast, isExiting }) => {
    const config = ORDER_EVENT_CONFIG[toast.type] || { emoji: '📋', label: toast.type, color: 'border-zinc-500', bg: 'bg-zinc-500/10' };
    const platformLabel = toast.platform === 'predict' ? 'Predict' : toast.platform === 'polymarket' ? 'Polymarket' : '';
    const sideLabel = toast.side === 'YES' ? 'YES 🟢' : toast.side === 'NO' ? 'NO 🔴' : '';
    const time = toast.timestamp ? new Date(toast.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '';

    return (
        <div
            className={`order-toast glass-card rounded-xl p-4 mb-3 border-l-4 ${config.color} ${config.bg} w-80 shadow-xl backdrop-blur-md transition-all duration-300 ${isExiting ? 'opacity-0 translate-x-[-20px]' : 'opacity-100 translate-x-0'}`}
            style={{ animation: isExiting ? 'none' : 'slideIn 0.3s ease-out' }}
        >
            <div className="flex items-start gap-3">
                <span className="text-2xl">{config.emoji}</span>
                <div className="flex-1 min-w-0">
                    {/* 标题行 */}
                    <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm font-semibold text-white">{config.label}</span>
                        {platformLabel && (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${toast.platform === 'predict' ? 'bg-blue-500/30 text-blue-300' : 'bg-purple-500/30 text-purple-300'}`}>
                                {platformLabel}
                            </span>
                        )}
                    </div>
                    {/* 方向和价格 */}
                    {(sideLabel || toast.price !== undefined) && (
                        <div className="flex items-center gap-3 text-sm text-zinc-200 mb-1">
                            {sideLabel && <span className="font-medium">{sideLabel}</span>}
                            {toast.price !== undefined && <span>@ {(Number(toast.price) * 100).toFixed(1)}¢</span>}
                        </div>
                    )}
                    {/* 成交信息 */}
                    {(toast.filledQty !== undefined || toast.quantity !== undefined) && (
                        <div className="text-sm text-zinc-300 mb-1">
                            {toast.filledQty !== undefined && (
                                <span>成交: {Number(toast.filledQty).toFixed(0)}</span>
                            )}
                            {toast.quantity !== undefined && toast.filledQty !== undefined && (
                                <span className="text-zinc-500">/{Number(toast.quantity).toFixed(0)}</span>
                            )}
                            {toast.avgPrice !== undefined && (
                                <span className="ml-2">均价: {(Number(toast.avgPrice) * 100).toFixed(1)}¢</span>
                            )}
                        </div>
                    )}
                    {/* 错误信息 */}
                    {toast.error && (
                        <div className="text-xs text-rose-400 mt-1 break-words">{toast.error}</div>
                    )}
                    {toast.reason && (
                        <div className="text-xs text-amber-400 mt-1">{toast.reason}</div>
                    )}
                    {/* 底部：任务ID和时间 */}
                    <div className="flex items-center justify-between mt-2 text-xs text-zinc-500">
                        <span className="font-mono">{toast.taskId?.slice(0, 12)}...</span>
                        {time && <span>{time}</span>}
                    </div>
                </div>
            </div>
        </div>
    );
};

// Toast 容器组件 (左上角，向下堆叠)
const OrderToastContainer = ({ toasts }) => {
    if (!toasts || toasts.length === 0) return null;

    return (
        <div className="fixed top-20 left-4 z-50 flex flex-col pointer-events-none">
            {toasts.map((toast) => (
                <OrderToast key={toast.id} toast={toast} isExiting={toast.isExiting} />
            ))}
        </div>
    );
};

// useOrderToasts Hook
const useOrderToasts = () => {
    const [toasts, setToasts] = useState([]);
    const toastIdRef = useRef(0);

    const addOrderToast = useCallback((event) => {
        const id = ++toastIdRef.current;
        const newToast = { ...event, id, isExiting: false };

        setToasts(prev => {
            // 最多保留 5 个 toast
            const updated = [newToast, ...prev].slice(0, 5);
            return updated;
        });

        // 5秒后开始渐隐
        setTimeout(() => {
            setToasts(prev => prev.map(t => t.id === id ? { ...t, isExiting: true } : t));
            // 渐隐动画后移除
            setTimeout(() => {
                setToasts(prev => prev.filter(t => t.id !== id));
            }, 300);
        }, 5000);
    }, []);

    return { toasts, addOrderToast };
};

// Settings Panel
const SettingsPanel = ({ isOpen, onClose, settings, setSettings }) => {
    const [notifPermission, setNotifPermission] = useState(
        'Notification' in window ? Notification.permission : 'denied'
    );

    if (!isOpen) return null;

    const handleDesktopToggle = async () => {
        if (!settings.desktop) {
            // Turning ON - request permission if needed
            if ('Notification' in window && Notification.permission === 'default') {
                const permission = await Notification.requestPermission();
                setNotifPermission(permission);
                if (permission === 'granted') {
                    setSettings(s => ({ ...s, desktop: true }));
                }
            } else if (Notification.permission === 'granted') {
                setSettings(s => ({ ...s, desktop: true }));
            }
        } else {
            // Turning OFF
            setSettings(s => ({ ...s, desktop: false }));
        }
    };

    const getPermissionStatus = () => {
        if (!('Notification' in window)) return { text: 'Not supported', color: 'text-zinc-500' };
        if (notifPermission === 'granted') return { text: 'Allowed', color: 'text-emerald-400' };
        if (notifPermission === 'denied') return { text: 'Blocked', color: 'text-rose-400' };
        return { text: 'Not set', color: 'text-zinc-400' };
    };

    const permStatus = getPermissionStatus();

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div className="glass-card rounded-2xl w-full max-w-md m-4 border border-zinc-700/50" onClick={e => e.stopPropagation()}>
                <div className="p-6 border-b border-zinc-800/50 flex justify-between items-center">
                    <h2 className="text-lg font-display font-medium text-white flex items-center gap-2">
                        <Icon name="settings" size={20} className="text-amber-500" />
                        Settings
                    </h2>
                    <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
                        <Icon name="x" size={20} />
                    </button>
                </div>

                <div className="p-6 space-y-6">
                    {/* Notifications Section */}
                    <div>
                        <h3 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
                            <Icon name="bell" size={16} />
                            Notifications
                        </h3>
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <span className="text-sm text-zinc-400">Enable Notifications</span>
                                <button
                                    onClick={() => setSettings(s => ({ ...s, enabled: !s.enabled }))}
                                    className={`w-12 h-6 rounded-full transition-colors ${settings.enabled ? 'bg-amber-500' : 'bg-zinc-700'}`}>
                                    <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${settings.enabled ? 'translate-x-6' : 'translate-x-0.5'}`}></div>
                                </button>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-sm text-zinc-400">Sound Alert</span>
                                <button
                                    onClick={() => setSettings(s => ({ ...s, sound: !s.sound }))}
                                    className={`w-12 h-6 rounded-full transition-colors ${settings.sound ? 'bg-amber-500' : 'bg-zinc-700'}`}>
                                    <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${settings.sound ? 'translate-x-6' : 'translate-x-0.5'}`}></div>
                                </button>
                            </div>
                            <div className="flex items-center justify-between">
                                <div>
                                    <span className="text-sm text-zinc-400">Desktop Notifications</span>
                                    <div className={`text-[10px] ${permStatus.color}`}>Browser: {permStatus.text}</div>
                                </div>
                                <button
                                    onClick={handleDesktopToggle}
                                    disabled={notifPermission === 'denied'}
                                    className={`w-12 h-6 rounded-full transition-colors ${settings.desktop && notifPermission === 'granted' ? 'bg-amber-500' : 'bg-zinc-700'} ${notifPermission === 'denied' ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                    <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${settings.desktop && notifPermission === 'granted' ? 'translate-x-6' : 'translate-x-0.5'}`}></div>
                                </button>
                            </div>
                            {notifPermission === 'denied' && (
                                <div className="text-[11px] text-rose-400 bg-rose-500/10 rounded-lg p-2">
                                    Desktop notifications are blocked. Please enable them in your browser settings.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Threshold Section */}
                    <div>
                        <h3 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
                            <Icon name="target" size={16} />
                            Alert Threshold
                        </h3>
                        <div className="space-y-4">
                            <div>
                                <div className="flex justify-between text-sm mb-2">
                                    <span className="text-zinc-400">Min Profit for Alert</span>
                                    <span className="text-amber-500 font-mono">{settings.minProfit}%</span>
                                </div>
                                <input
                                    type="range"
                                    min="0.5"
                                    max="5"
                                    step="0.5"
                                    value={settings.minProfit}
                                    onChange={(e) => setSettings(s => ({ ...s, minProfit: parseFloat(e.target.value) }))}
                                    className="w-full accent-amber-500 h-2 bg-zinc-800 rounded-lg cursor-pointer"
                                />
                            </div>
                            <div>
                                <div className="text-sm text-zinc-400 mb-2">Alert Strategies</div>
                                <div className="flex gap-2">
                                    {['MAKER', 'TAKER'].map(s => (
                                        <button
                                            key={s}
                                            onClick={() => setSettings(prev => ({
                                                ...prev,
                                                strategies: prev.strategies.includes(s)
                                                    ? prev.strategies.filter(x => x !== s)
                                                    : [...prev.strategies, s]
                                            }))}
                                            className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${settings.strategies.includes(s)
                                                ? 'bg-amber-500 text-black'
                                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                                                }`}>
                                            {s}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Test Button */}
                    <button
                        onClick={() => {
                            if (settings.sound) {
                                const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleNBHK3Th/M50RwBTqP7/mWBJPH7h+P+8dVs2e+D4/7t1WzZ74Pj/u3VbNnvg+P+7dVs2e+D4/7t1WzZ74Pj/u3VbNnvg+P+7dVs2e+D4/7t1WzZ74Pj/u3VbNnvg+P+7dVs2');
                                audio.play().catch(() => { });
                            }
                            if (settings.desktop && 'Notification' in window && Notification.permission === 'granted') {
                                new Notification('Test Notification', { body: 'Notifications are working!' });
                            }
                        }}
                        className="w-full py-3 rounded-lg bg-zinc-800 text-white hover:bg-zinc-700 transition-colors text-sm font-medium">
                        Test Notification
                    </button>
                </div>
            </div>
        </div>
    );
};

const LatencyBar = ({ label, ms, max = 300 }) => {
    const pct = Math.min(100, (ms / max) * 100);
    const color = ms < 100 ? 'bg-emerald-500' : ms < 300 ? 'bg-amber-500' : 'bg-rose-500';
    return (
        <div className="mb-5">
            <div className="flex justify-between text-[11px] font-medium uppercase tracking-wide mb-2">
                <span className="text-zinc-500">{label}</span>
                <span className={`font-mono ${ms < 100 ? 'text-emerald-400' : ms < 300 ? 'text-amber-400' : 'text-rose-400'}`}>{ms}ms</span>
            </div>
            <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                <div className={`h-full ${color} rounded-full transition-all duration-300 ease-out`} style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
};

// Account Balance Card Component
const AccountCard = ({ platform, balance, positions, openOrders = [], icon, color, expanded, onToggle, onRefresh, refreshing }) => {
    const handleRefresh = (e) => {
        e.stopPropagation();  // 防止触发 onToggle
        onRefresh?.();
    };

    return (
        <div className={`glass-card rounded-xl border border-zinc-800/50 hover:border-zinc-700/50 transition-all duration-300 ${expanded ? 'bg-zinc-900/40' : ''}`}>
            <div className="p-4 cursor-pointer" onClick={onToggle}>
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center">
                            <img
                                src={icon === 'predict' ? PREDICT_ICON : POLYMARKET_ICON}
                                alt={platform}
                                className="w-full h-full object-cover"
                            />
                        </div>
                        <div>
                            <div className="text-sm font-medium text-white">{platform}</div>
                            <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Account</div>
                        </div>
                        {/* 刷新按钮 */}
                        <button
                            onClick={handleRefresh}
                            disabled={refreshing}
                            className={`ml-2 p-1 rounded-md transition-all ${refreshing ? 'text-zinc-600 cursor-not-allowed' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'}`}
                            title="刷新账户数据"
                        >
                            <Icon name="refresh-cw" size={12} className={refreshing ? 'animate-spin' : ''} />
                        </button>
                    </div>
                    <div className="text-right">
                        <div className="text-lg font-display font-semibold text-white flex items-center justify-end gap-2">
                            ${balance.available.toFixed(2)}
                            <Icon name="chevron-down" size={14} className={`text-zinc-600 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
                        </div>
                        <div className="text-[10px] text-zinc-500">Available</div>
                    </div>
                </div>

                {/* Balance Details - Visible when collapsed too, as per user request to show 'info in picture' which likely includes these totals */}
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                    <div className="bg-zinc-900/50 rounded px-2 py-1.5">
                        <span className="text-zinc-500">Total: </span>
                        <span className="text-zinc-300 font-mono">${balance.total.toFixed(2)}</span>
                    </div>
                    <div className="bg-zinc-900/50 rounded px-2 py-1.5">
                        <span className="text-zinc-500">Portfolio: </span>
                        <span className="text-amber-400 font-mono">${balance.portfolio.toFixed(2)}</span>
                    </div>
                    <div className="bg-zinc-900/50 rounded px-2 py-1.5">
                        <span className="text-zinc-500">Orders: </span>
                        <span className="text-cyan-400 font-mono">{openOrders.length}</span>
                    </div>
                </div>
            </div>

            {/* Positions & Orders - Collapsible */}
            <div className={`grid transition-all duration-300 ease-out border-t border-zinc-800/50 overflow-hidden ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 border-none'}`}>
                <div className="min-h-0">
                    <div className="p-4 pt-3">
                        {/* Open Orders Section */}
                        <div className="mb-4">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Open Orders</span>
                                <span className="text-[10px] font-mono text-cyan-400">{openOrders.length} pending</span>
                            </div>
                            <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                {openOrders.length > 0 ? openOrders.map((order, idx) => (
                                    <div key={idx} className="flex items-center justify-between text-[11px] bg-cyan-950/20 border border-cyan-900/30 rounded px-2 py-1.5 hover:bg-cyan-900/30 transition-colors">
                                        <div className="flex items-center gap-2 min-w-0 flex-1">
                                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${order.side === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                                                {order.side}
                                            </span>
                                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${order.outcome === 'YES' ? 'bg-blue-500/20 text-blue-400' : 'bg-orange-500/20 text-orange-400'}`}>
                                                {order.outcome}
                                            </span>
                                            <span className="text-zinc-400 text-[10px]" title={order.market}>{order.market}</span>
                                        </div>
                                        <div className="text-right flex-shrink-0 ml-2">
                                            <span className="font-mono text-zinc-300">{order.filled}/{order.qty}</span>
                                            <span className="text-zinc-500 ml-1">@</span>
                                            <span className="font-mono text-cyan-300">{(order.price * 100).toFixed(1)}¢</span>
                                        </div>
                                    </div>
                                )) : (
                                    <div className="text-[11px] text-zinc-600 text-center py-2">No open orders</div>
                                )}
                            </div>
                        </div>

                        {/* Open Positions Section */}
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Open Positions</span>
                            <span className="text-[10px] font-mono text-zinc-400">{positions.length} active</span>
                        </div>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                            {positions.length > 0 ? positions.map((pos, idx) => (
                                <div key={idx} className="flex items-center justify-between text-[11px] bg-zinc-900/30 rounded px-2 py-1.5 hover:bg-zinc-800/50 transition-colors">
                                    <div className="flex items-center gap-2 min-w-0 flex-1">
                                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${pos.side === 'YES' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                                            {pos.side}
                                        </span>
                                        <span className="text-zinc-400 text-[10px]" title={pos.market}>{pos.market}</span>
                                    </div>
                                    <div className="text-right flex-shrink-0 ml-2">
                                        <span className="font-mono text-zinc-300">{pos.qty}</span>
                                        <span className="text-zinc-500 ml-1">@</span>
                                        <span className="font-mono text-zinc-300">{pos.avgPrice}¢</span>
                                    </div>
                                </div>
                            )) : (
                                <div className="text-[11px] text-zinc-600 text-center py-2">No open positions</div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// Task Log Modal Component - 任务日志查看弹窗
const TaskLogModal = ({ isOpen, onClose, taskId, apiBaseUrl }) => {
    const [timeline, setTimeline] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && taskId) {
            setLoading(true);
            setError(null);
            fetch(`${apiBaseUrl}/api/logs/tasks/${taskId}/timeline`)
                .then(res => res.json())
                .then(data => {
                    if (data.success) {
                        setTimeline(data.data);
                    } else {
                        setError(data.error || '加载失败');
                    }
                })
                .catch(err => setError(err.message))
                .finally(() => setLoading(false));
        }
    }, [isOpen, taskId, apiBaseUrl]);

    if (!isOpen) return null;

    const formatTime = (ts) => {
        const d = new Date(ts);
        return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    };

    const formatDuration = (ms) => {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${(ms / 60000).toFixed(1)}m`;
    };

    const getEventIcon = (type) => {
        if (type.includes('CREATED') || type.includes('STARTED')) return { icon: 'play', color: 'text-emerald-400' };
        if (type.includes('COMPLETED')) return { icon: 'check-circle', color: 'text-emerald-400' };
        if (type.includes('FAILED')) return { icon: 'x-circle', color: 'text-rose-400' };
        if (type.includes('ORDER')) return { icon: 'file-text', color: 'text-blue-400' };
        if (type.includes('HEDGE')) return { icon: 'shield', color: 'text-amber-400' };
        if (type.includes('PRICE_GUARD')) return { icon: 'alert-triangle', color: 'text-amber-400' };
        if (type.includes('PAUSED')) return { icon: 'pause', color: 'text-yellow-400' };
        if (type.includes('CANCELLED')) return { icon: 'x', color: 'text-zinc-400' };
        return { icon: 'circle', color: 'text-zinc-400' };
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-2xl max-h-[80vh] mx-4 glass-card rounded-2xl border border-zinc-700/50 shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="p-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
                    <div>
                        <h2 className="font-display text-lg font-semibold text-white flex items-center gap-2">
                            <Icon name="file-text" size={18} className="text-amber-500" />
                            任务日志
                        </h2>
                        {timeline && (
                            <p className="text-xs text-zinc-500 mt-1 font-mono">{taskId}</p>
                        )}
                    </div>
                    <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors p-1">
                        <Icon name="x" size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4">
                    {loading && (
                        <div className="flex items-center justify-center py-12">
                            <div className="animate-spin rounded-full h-8 w-8 border-2 border-amber-500 border-t-transparent"></div>
                        </div>
                    )}

                    {error && (
                        <div className="text-center py-12">
                            <Icon name="alert-circle" size={40} className="text-rose-400 mx-auto mb-4" />
                            <p className="text-rose-400">{error}</p>
                        </div>
                    )}

                    {timeline && !loading && (
                        <div className="space-y-4">
                            {/* Summary */}
                            <div className="grid grid-cols-4 gap-3 mb-6">
                                <div className="glass-card rounded-lg p-3 border border-zinc-800/50">
                                    <div className="text-[10px] text-zinc-500 uppercase mb-1">类型</div>
                                    <div className={`text-sm font-bold ${timeline.type === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        {timeline.type}
                                    </div>
                                </div>
                                <div className="glass-card rounded-lg p-3 border border-zinc-800/50">
                                    <div className="text-[10px] text-zinc-500 uppercase mb-1">状态</div>
                                    <div className="text-sm text-white">{timeline.status}</div>
                                </div>
                                <div className="glass-card rounded-lg p-3 border border-zinc-800/50">
                                    <div className="text-[10px] text-zinc-500 uppercase mb-1">耗时</div>
                                    <div className="text-sm text-white font-mono">{formatDuration(timeline.durationMs)}</div>
                                </div>
                                <div className="glass-card rounded-lg p-3 border border-zinc-800/50">
                                    <div className="text-[10px] text-zinc-500 uppercase mb-1">利润</div>
                                    <div className={`text-sm font-mono ${timeline.actualProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        {timeline.actualProfit >= 0 ? '+' : ''}${timeline.actualProfit.toFixed(2)}
                                    </div>
                                </div>
                            </div>

                            {/* Timeline Events */}
                            <div className="relative">
                                <div className="absolute left-4 top-0 bottom-0 w-px bg-zinc-800"></div>
                                <div className="space-y-3">
                                    {timeline.events.map((event, idx) => {
                                        const { icon, color } = getEventIcon(event.type);
                                        return (
                                            <div key={idx} className="relative pl-10">
                                                <div className={`absolute left-2 w-5 h-5 rounded-full bg-zinc-900 border border-zinc-700 flex items-center justify-center`}>
                                                    <Icon name={icon} size={12} className={color} />
                                                </div>
                                                <div className="glass-card rounded-lg p-3 border border-zinc-800/50 hover:border-zinc-700/50 transition-colors">
                                                    <div className="flex items-center justify-between gap-4 mb-1">
                                                        <span className="text-xs font-mono text-amber-400">{event.type}</span>
                                                        <span className="text-[10px] font-mono text-zinc-500">{formatTime(event.timestamp)}</span>
                                                    </div>
                                                    {event.detail && (
                                                        <p className="text-xs text-zinc-400">{event.detail}</p>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// --- Sports Card ---
const SportsCard = ({ market, onOpenTaskModal, onCreateTakerTask, accounts }) => {
    const [expanded, setExpanded] = useState(false);
    const [takerConfirm, setTakerConfirm] = useState(null); // { direction: 'away'|'home', opp: SportsArbOpportunity }
    const [takerQuantity, setTakerQuantity] = useState(100); // Taker 数量输入

    // 体育图标映射
    const sportIcons = {
        nba: '🏀',
        nfl: '🏈',
        nhl: '🏒',
        mlb: '⚾',
        epl: '⚽',
        mma: '🥊',
        lol: '🎮',
    };

    const sportIcon = sportIcons[market.sport] || '🏅';
    const orderbook = market.orderbook || {};
    const pred = orderbook.predict || {};
    const poly = orderbook.polymarket || {};

    // 找到最佳机会
    const bestOpp = market.bestOpportunity;
    const hasArb = bestOpp && bestOpp.profitPercent > 0;

    // 获取套利信息
    // 后端字段名: awayMT, awayTT, homeMT, homeTT
    const getOppInfo = (direction, mode) => {
        const modeKey = mode === 'MAKER' ? 'MT' : 'TT';
        const key = `${direction}${modeKey}`;
        return market[key] || null;
    };

    // 创建 MAKER 任务时转换为标准格式
    const handleCreateMakerTask = (direction) => {
        const opp = getOppInfo(direction, 'MAKER');
        if (!opp || !opp.isValid) return;

        // 转换为 OpportunityCard 期望的格式
        const taskData = {
            marketId: market.predictMarketId,
            title: market.predictTitle,
            strategy: 'MAKER',
            side: direction === 'away' ? 'YES' : 'NO',
            arbSide: direction === 'away' ? 'YES' : 'NO',
            predictPrice: opp.predictPrice,
            polymarketPrice: opp.polyHedgePrice,
            profitPercent: opp.profitPercent,
            maxQuantity: opp.maxQuantity,
            estimatedProfit: opp.profit * opp.maxQuantity,
            polymarketConditionId: market.polymarketConditionId,
            polymarketYesTokenId: market.polymarketAwayTokenId,
            polymarketNoTokenId: market.polymarketHomeTokenId,
            negRisk: market.negRisk,
            tickSize: market.tickSize,
            feeRateBps: market.feeRateBps,
            isInverted: false,
            predictBid: direction === 'away' ? pred.awayBid : pred.homeBid,
            predictAsk: direction === 'away' ? pred.awayAsk : pred.homeAsk,
        };

        onOpenTaskModal(taskData, 'BUY');
    };

    // 显示 TAKER 确认弹窗
    const handleTakerClick = (direction) => {
        const opp = getOppInfo(direction, 'TAKER');
        if (!opp || !opp.isValid) return;
        // 初始化数量为最大可用量的一半，最小 5
        const initialQty = Math.max(5, Math.min(Math.floor(opp.maxQuantity / 2), 500));
        setTakerQuantity(initialQty);
        setTakerConfirm({ direction, opp });
    };

    // 确认 TAKER 任务
    const handleConfirmTaker = () => {
        if (!takerConfirm) return;

        const { direction, opp } = takerConfirm;
        const teamName = direction === 'away' ? market.awayTeam : market.homeTeam;

        // 计算手续费 (与 depth-calculator 一致)
        const feeRateBps = market.feeRateBps || 200;
        const baseFeePercent = feeRateBps / 10000;
        const minPrice = Math.min(opp.predictPrice, 1 - opp.predictPrice);
        const predictFee = Number((baseFeePercent * minPrice * 0.9).toFixed(6)); // 10% 返点

        // maxTotalCost: 固定为 1（只要 totalCost < 1 就是盈利的）
        const maxTotalCost = 1;

        // 使用用户输入的数量 (最小 5 shares，向下取整到 tickSize)
        const tickSize = market.tickSize || 1;
        const alignedQuantity = Math.floor(takerQuantity / tickSize) * tickSize;
        const quantity = Math.max(alignedQuantity, 5); // 最小 5 shares

        // 构建任务参数 (与 dashboard taker 模式一致)
        const taskParams = {
            type: 'BUY',
            strategy: 'TAKER',
            marketId: market.predictMarketId,
            title: `${market.predictTitle} - Buy ${teamName}`,
            arbSide: direction === 'away' ? 'YES' : 'NO',
            // TAKER BUY 必需字段
            predictAskPrice: Number(opp.predictPrice.toFixed(4)),
            maxTotalCost: maxTotalCost,
            // 对冲价格上限 (加点滑点保护，会被 task-service 重新计算覆盖)
            polymarketMaxAsk: Number((opp.polyHedgePrice + 0.02).toFixed(4)),
            // Token 映射
            polymarketConditionId: market.polymarketConditionId,
            polymarketYesTokenId: market.polymarketAwayTokenId,
            polymarketNoTokenId: market.polymarketHomeTokenId,
            // 数量
            quantity: quantity,
            // 配置
            negRisk: market.negRisk,
            tickSize: tickSize,
            feeRateBps: feeRateBps,
            isInverted: false,
        };

        // 调用 Taker 任务创建函数
        if (onCreateTakerTask) {
            onCreateTakerTask(taskParams);
        }

        setTakerConfirm(null);
    };

    // 渲染 M-T 按钮
    const renderMakerButton = (direction) => {
        const opp = getOppInfo(direction, 'MAKER');
        const teamName = direction === 'away' ? market.awayTeam : market.homeTeam;

        if (!opp || !opp.isValid) {
            return (
                <button disabled className="flex-1 px-2 py-1.5 rounded-lg bg-zinc-800/30 text-zinc-600 text-[10px] cursor-not-allowed">
                    <span className="font-medium">{teamName}</span>
                    <span className="ml-1 opacity-70">(M-T)</span>
                    <span className="block">--</span>
                </button>
            );
        }

        return (
            <button
                onClick={() => handleCreateMakerTask(direction)}
                className="flex-1 px-2 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10px] hover:bg-emerald-500/20 transition-all"
            >
                <span className="font-medium">{teamName}</span>
                <span className="ml-1 opacity-70">(M-T)</span>
                <span className="block font-mono">+{opp.profitPercent.toFixed(2)}%</span>
            </button>
        );
    };

    // 渲染 T-T 按钮
    const renderTakerButton = (direction) => {
        const opp = getOppInfo(direction, 'TAKER');
        const teamName = direction === 'away' ? market.awayTeam : market.homeTeam;

        if (!opp || !opp.isValid) {
            return (
                <button disabled className="flex-1 px-2 py-1.5 rounded-lg bg-zinc-800/30 text-zinc-600 text-[10px] cursor-not-allowed">
                    <span className="font-medium">{teamName}</span>
                    <span className="ml-1 opacity-70">(T-T)</span>
                    <span className="block">--</span>
                </button>
            );
        }

        return (
            <button
                onClick={() => handleTakerClick(direction)}
                className="flex-1 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[10px] hover:bg-amber-500/20 transition-all"
            >
                <span className="font-medium">{teamName}</span>
                <span className="ml-1 opacity-70">(T-T)</span>
                <span className="block font-mono">+{opp.profitPercent.toFixed(2)}%</span>
            </button>
        );
    };

    return (
        <div className="group">
            <div className={`glass-card rounded-xl border border-zinc-800/50 transition-all duration-300 overflow-hidden h-full
                ${expanded ? 'border-amber-500/30 shadow-glow-sm bg-zinc-900/80' : 'hover:border-white/10 hover:scale-[1.005]'}
                ${hasArb ? 'ring-1 ring-emerald-500/20' : ''}`}>

                {/* Header */}
                <div className="p-5 cursor-pointer" onClick={() => setExpanded(!expanded)}>
                    {/* Top Row */}
                    <div className="flex items-start justify-between mb-4">
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 mb-1.5">
                                <span className="text-lg">{sportIcon}</span>
                                <Badge variant="default">{market.sport?.toUpperCase()}</Badge>
                                {hasArb && <Badge variant="success">ARB</Badge>}
                                {!market.consistency?.isValid && <Badge variant="danger" icon="alert-triangle">异常</Badge>}
                            </div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-base font-medium text-white">{market.awayTeam} @ {market.homeTeam}</h3>
                                <ViewLinks
                                    predictId={market.predictMarketId}
                                    predictSlug={market.predictSlug}
                                    polymarketSlug={market.polymarketSlug}
                                    polymarketConditionId={market.polymarketConditionId}
                                    title={market.predictTitle}
                                    sportsTeams={`${market.awayTeam} ${market.homeTeam}`}
                                />
                            </div>
                            <div className="flex items-center gap-3 text-xs text-zinc-500 mt-1">
                                {market.gameStartTime && (
                                    <span>
                                        <Icon name="clock" size={12} className="inline mr-1" />
                                        {new Date(market.gameStartTime).toLocaleString()}
                                    </span>
                                )}
                                {(market.predictVolume > 0 || market.polymarketVolume > 0) && (
                                    <span>
                                        <Icon name="activity" size={12} className="inline mr-1" />
                                        Vol: ${(market.predictVolume / 1000).toFixed(0)}K | ${(market.polymarketVolume / 1000).toFixed(0)}K
                                    </span>
                                )}
                            </div>
                        </div>
                        {hasArb && (
                            <div className="text-right flex-shrink-0">
                                <div className="text-xl font-display font-semibold text-emerald-400">
                                    +{bestOpp.profitPercent.toFixed(2)}%
                                </div>
                                <div className="text-[10px] text-zinc-500">{bestOpp.direction === 'away' ? market.awayTeam : market.homeTeam} {bestOpp.mode}</div>
                            </div>
                        )}
                        <div className={`ml-2 text-zinc-500 transition-transform duration-300 ${expanded ? 'rotate-180 text-amber-500' : ''}`}>
                            <Icon name="chevron-down" size={20} />
                        </div>
                    </div>

                    {/* Price Table */}
                    <div className="grid grid-cols-3 gap-2 text-xs font-mono mb-3">
                        <div className="text-zinc-500"></div>
                        <div className="text-center text-zinc-400">{market.awayTeam}</div>
                        <div className="text-center text-zinc-400">{market.homeTeam}</div>

                        <div className="text-zinc-500">P.Bid</div>
                        <FlashValue value={pred.awayBid || 0} className="text-center text-blue-400 block">
                            {((pred.awayBid || 0) * 100).toFixed(1)}¢
                        </FlashValue>
                        <FlashValue value={pred.homeBid || 0} className="text-center text-blue-400 block">
                            {((pred.homeBid || 0) * 100).toFixed(1)}¢
                        </FlashValue>

                        <div className="text-zinc-500">P.Ask</div>
                        <FlashValue value={pred.awayAsk || 0} className="text-center text-blue-400 block">
                            {((pred.awayAsk || 0) * 100).toFixed(1)}¢
                        </FlashValue>
                        <FlashValue value={pred.homeAsk || 0} className="text-center text-blue-400 block">
                            {((pred.homeAsk || 0) * 100).toFixed(1)}¢
                        </FlashValue>

                        <div className="text-zinc-500">M.Ask</div>
                        <FlashValue value={poly.awayAsk || 0} className="text-center text-purple-400 block">
                            {((poly.awayAsk || 0) * 100).toFixed(1)}¢
                        </FlashValue>
                        <FlashValue value={poly.homeAsk || 0} className="text-center text-purple-400 block">
                            {((poly.homeAsk || 0) * 100).toFixed(1)}¢
                        </FlashValue>
                    </div>

                    {/* Arbitrage Stats - M-T & T-T profits and depths */}
                    <div className="grid grid-cols-2 gap-2 text-[10px] mb-3">
                        {/* M-T Stats */}
                        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-2">
                            <div className="text-emerald-400 font-medium mb-1">M-T</div>
                            <div className="space-y-1">
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">{market.awayTeam}</span>
                                    <span className={market.awayMT?.isValid ? 'text-emerald-400' : 'text-zinc-600'}>
                                        {market.awayMT?.isValid ? `+${market.awayMT.profitPercent.toFixed(2)}%` : '--'}
                                        {market.awayMT?.isValid && <span className="text-zinc-500 ml-1">({Math.floor(market.awayMT.maxQuantity)})</span>}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">{market.homeTeam}</span>
                                    <span className={market.homeMT?.isValid ? 'text-emerald-400' : 'text-zinc-600'}>
                                        {market.homeMT?.isValid ? `+${market.homeMT.profitPercent.toFixed(2)}%` : '--'}
                                        {market.homeMT?.isValid && <span className="text-zinc-500 ml-1">({Math.floor(market.homeMT.maxQuantity)})</span>}
                                    </span>
                                </div>
                            </div>
                        </div>
                        {/* T-T Stats */}
                        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-2">
                            <div className="text-amber-400 font-medium mb-1">T-T</div>
                            <div className="space-y-1">
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">{market.awayTeam}</span>
                                    <span className={market.awayTT?.isValid ? 'text-amber-400' : 'text-zinc-600'}>
                                        {market.awayTT?.isValid ? `+${market.awayTT.profitPercent.toFixed(2)}%` : '--'}
                                        {market.awayTT?.isValid && <span className="text-zinc-500 ml-1">({Math.floor(market.awayTT.maxQuantity)})</span>}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">{market.homeTeam}</span>
                                    <span className={market.homeTT?.isValid ? 'text-amber-400' : 'text-zinc-600'}>
                                        {market.homeTT?.isValid ? `+${market.homeTT.profitPercent.toFixed(2)}%` : '--'}
                                        {market.homeTT?.isValid && <span className="text-zinc-500 ml-1">({Math.floor(market.homeTT.maxQuantity)})</span>}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Arb Buttons - 4 buttons in 2x2 grid */}
                    <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
                        {/* M-T Row */}
                        <div className="grid grid-cols-2 gap-1.5">
                            {renderMakerButton('away')}
                            {renderMakerButton('home')}
                        </div>
                        {/* T-T Row */}
                        <div className="grid grid-cols-2 gap-1.5">
                            {renderTakerButton('away')}
                            {renderTakerButton('home')}
                        </div>
                    </div>
                </div>

                {/* Taker Confirmation Modal - 使用 Portal 渲染到 body，避免被 overflow-hidden 裁切 */}
                {takerConfirm && ReactDOM.createPortal((() => {
                    // 计算资金占用
                    const opp = takerConfirm.opp;
                    const feeRateBps = market.feeRateBps || 200;
                    const baseFeePercent = feeRateBps / 10000;
                    const minPrice = Math.min(opp.predictPrice, 1 - opp.predictPrice);
                    const predictFee = baseFeePercent * minPrice * 0.9;
                    const predictRequired = opp.predictPrice * takerQuantity + predictFee * takerQuantity;
                    const polyRequired = opp.polyHedgePrice * takerQuantity;
                    const predictBalance = accounts?.predict?.available || 0;
                    const polyBalance = accounts?.polymarket?.available || 0;
                    const predictInsufficient = predictRequired > predictBalance;
                    const polyInsufficient = polyRequired > polyBalance;
                    const polyBelowMin = polyRequired > 0 && polyRequired < 1;
                    const canSubmit = !predictInsufficient && !polyInsufficient && !polyBelowMin && takerQuantity >= 5;

                    return (
                        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
                            <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 max-w-md w-full mx-4 shadow-xl">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-2">
                                        <Icon name="zap" size={20} className="text-amber-400" />
                                        <h3 className="text-lg font-medium text-white">Taker 套利 - {takerConfirm.direction === 'away' ? market.awayTeam : market.homeTeam}</h3>
                                    </div>
                                    <button
                                        onClick={() => setTakerConfirm(null)}
                                        className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-400 transition-all flex items-center justify-center"
                                        title="关闭">
                                        <Icon name="x" size={18} />
                                    </button>
                                </div>

                                {/* 价格信息 */}
                                <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
                                    <div className="bg-zinc-800/50 rounded-lg p-3">
                                        <div className="text-zinc-500 text-xs mb-1">Predict Ask</div>
                                        <div className="text-blue-400 font-mono text-lg">
                                            {(opp.predictPrice * 100).toFixed(2)}¢
                                        </div>
                                    </div>
                                    <div className="bg-zinc-800/50 rounded-lg p-3">
                                        <div className="text-zinc-500 text-xs mb-1">Poly 对冲</div>
                                        <div className="text-purple-400 font-mono text-lg">
                                            {(opp.polyHedgePrice * 100).toFixed(2)}¢
                                        </div>
                                    </div>
                                </div>

                                {/* 数量输入 */}
                                <div className="mb-4">
                                    <label className="block text-xs text-zinc-500 mb-1">买入数量 (Shares)</label>
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        value={takerQuantity}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            if (val === '' || /^\d+$/.test(val)) {
                                                setTakerQuantity(val === '' ? '' : parseInt(val));
                                            }
                                        }}
                                        onBlur={(e) => {
                                            if (e.target.value === '' || parseInt(e.target.value) < 5) {
                                                setTakerQuantity(5);
                                            }
                                        }}
                                        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-amber-500"
                                    />
                                    <div className="text-xs text-zinc-500 mt-1">最大深度: {opp.maxQuantity?.toFixed(0) || '-'} shares</div>
                                </div>

                                {/* 利润预估 */}
                                <div className="flex justify-between items-center mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                                    <span className="text-zinc-400 text-sm">预估利润</span>
                                    <div className="text-right">
                                        <span className="text-emerald-400 font-mono text-lg">+{opp.profitPercent.toFixed(2)}%</span>
                                        <span className="text-emerald-400/70 text-sm ml-2">
                                            (${(opp.profitPercent / 100 * takerQuantity).toFixed(2)})
                                        </span>
                                    </div>
                                </div>

                                {/* 资金占用 */}
                                <div className="bg-zinc-800/50 rounded-lg p-3 mb-4 space-y-2">
                                    <div className="text-xs text-zinc-500 font-medium">资金占用</div>
                                    <div className="flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <div className="w-4 h-4 rounded bg-blue-500/20 flex items-center justify-center">
                                                <span className="text-[8px] font-bold text-blue-400">P</span>
                                            </div>
                                            <span className="text-xs text-zinc-400">Predict</span>
                                        </div>
                                        <div className="text-right">
                                            <span className={`font-mono text-sm ${predictInsufficient ? 'text-rose-400' : 'text-white'}`}>
                                                ${predictRequired.toFixed(2)}
                                            </span>
                                            <span className="text-xs text-zinc-500 ml-1">/ ${predictBalance.toFixed(2)}</span>
                                            {predictInsufficient && <span className="text-[10px] text-rose-400 ml-1">不足</span>}
                                        </div>
                                    </div>
                                    <div className="flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <div className="w-4 h-4 rounded bg-purple-500/20 flex items-center justify-center">
                                                <span className="text-[8px] font-bold text-purple-400">M</span>
                                            </div>
                                            <span className="text-xs text-zinc-400">Polymarket</span>
                                        </div>
                                        <div className="text-right">
                                            <span className={`font-mono text-sm ${(polyInsufficient || polyBelowMin) ? 'text-rose-400' : 'text-white'}`}>
                                                ${polyRequired.toFixed(2)}
                                            </span>
                                            <span className="text-xs text-zinc-500 ml-1">/ ${polyBalance.toFixed(2)}</span>
                                            {polyInsufficient && <span className="text-[10px] text-rose-400 ml-1">不足</span>}
                                            {polyBelowMin && <span className="text-[10px] text-rose-400 ml-1">最小$1</span>}
                                        </div>
                                    </div>
                                </div>

                                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg mb-4 text-xs text-amber-300">
                                    <Icon name="alert-triangle" size={14} className="inline mr-1" />
                                    Taker 模式将立即以当前 Ask 价格买入，请确认价格和深度！
                                </div>

                                <div className="flex gap-3">
                                    <button
                                        onClick={() => setTakerConfirm(null)}
                                        className="flex-1 px-4 py-2 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={handleConfirmTaker}
                                        disabled={!canSubmit}
                                        className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
                                            canSubmit
                                                ? 'bg-amber-500 text-black hover:bg-amber-400'
                                                : 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
                                        }`}
                                    >
                                        确认买入
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })(), document.body)}

                {/* Expanded Details */}
                {expanded && (
                    <div className="px-5 pb-5 border-t border-zinc-800/50 pt-4">
                        <div className="grid grid-cols-2 gap-4 text-xs">
                            <div>
                                <div className="text-zinc-500 mb-1">Predict ID</div>
                                <div className="font-mono text-zinc-300">{market.predictMarketId}</div>
                            </div>
                            <div>
                                <div className="text-zinc-500 mb-1">Volume (P|M)</div>
                                <div className="font-mono text-zinc-300">${(market.predictVolume || 0).toLocaleString()} | ${(market.polymarketVolume || 0).toLocaleString()}</div>
                            </div>
                            <div className="col-span-2">
                                <div className="text-zinc-500 mb-1">Condition ID</div>
                                <div className="font-mono text-zinc-400 text-[10px] truncate">{market.polymarketConditionId}</div>
                            </div>
                            {market.consistency?.warning && (
                                <div className="col-span-2 p-2 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px]">
                                    ⚠️ {market.consistency.warning}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

Preview.Components = {
    Badge,
    Card,
    RiskIndicator,
    DepthIndicator,
    StatCard,
    OpportunityCard,
    FilterBar,
    HistoryTable,
    TaskStatusBadge,
    TasksTab,
    TaskModal,
    TaskLogModal,
    AnalyticsDashboard,
    NotificationToast,
    OrderToastContainer,
    useOrderToasts,
    SettingsPanel,
    LatencyBar,
    AccountCard,
    SportsCard,
};
