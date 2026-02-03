/**
 * Telegram Notification Module
 * 
 * Sends alerts for:
 * - Arbitrage opportunities found
 * - Order placed / cancelled
 * - Order filled
 * - Execution errors
 * - Daily/hourly statistics
 */

import TelegramBot from 'node-telegram-bot-api';

export interface TelegramConfig {
    botToken: string;
    chatId: string;
    enabled?: boolean;
}

export interface ArbitrageAlert {
    marketName: string;
    predictMarketId: number;
    mode: 'TAKER' | 'MAKER';
    side?: 'YES' | 'NO';      // YES→NO 或 NO→YES 套利方向
    predictYesPrice: number;
    polymarketNoPrice: number;
    predictFee?: number;
    totalCost: number;
    profitPercent: number;
    maxQuantity?: number;
    estimatedProfit?: number;   // 预估利润 (USD)

    // 资金占用明细
    predictCost?: number;       // Predict 端资金占用 (USD)
    polymarketCost?: number;    // Polymarket 端资金占用 (USD)

    // 吃单模式费用明细
    feeRateBps?: number;        // 费率 (基点, 1 bps = 0.01%)
    feeTotal?: number;          // 总费用 (USD)

    // 结算时间
    endDate?: string | null;    // ISO 格式的结算时间
}

export interface OrderAlert {
    type: 'PLACED' | 'CANCELLED' | 'FILLED' | 'PARTIAL_FILL' | 'FAILED';
    platform: 'PREDICT' | 'POLYMARKET';
    marketName: string;
    action: 'BUY' | 'SELL';             // 买入/卖出
    side: 'YES' | 'NO';                 // YES/NO 方向
    outcome?: string;                   // 多选市场的选项名（如 "Trump"），二元市场可省略
    price: number;
    quantity: number;
    filledQuantity?: number;
    filledDelta?: number;               // 本次成交增量（用于分批成交显示）
    timestamp?: number;                 // 下单时间戳 (ms)
    error?: string;                     // 错误信息 (用于 FAILED 类型)
    role?: 'Maker' | 'Taker';           // 角色：挂单方/吃单方
    orderHash?: string;                 // 订单哈希
    dataSource?: string;                // 数据来源 (如 "BSC WebSocket", "REST API")
    // 延迟统计 (ms)
    latency?: {
        submitToFirstStatus?: number;   // 下单到首次获取状态
        submitToFill?: number;          // 下单到成交
        statusFetchAttempts?: number;   // 状态获取尝试次数
        taskTotalMs?: number;           // 任务总耗时（Predict 下单 → Polymarket 获取到成交）
    };
}

export interface ExecutionErrorAlert {
    operation: string;
    platform: 'PREDICT' | 'POLYMARKET' | 'BOTH';
    marketName: string;
    error: string;
    stack?: string;
    requiresManualIntervention: boolean;
}

export interface StatisticsAlert {
    period: 'HOURLY' | 'DAILY';
    tradesExecuted: number;
    totalProfit: number;
    totalVolume: number;
    successRate: number;
    opportunitiesFound: number;
}

export class TelegramNotifier {
    private bot: TelegramBot | null = null;
    private chatId: string;
    private enabled: boolean;
    private messageQueue: string[] = [];
    private isSending = false;

    constructor(config: TelegramConfig) {
        this.chatId = config.chatId;
        this.enabled = config.enabled ?? true;

        if (this.enabled && config.botToken) {
            try {
                this.bot = new TelegramBot(config.botToken, { polling: false });
                console.log('[TG] Telegram notifier initialized');
            } catch (error) {
                console.error('[TG] Failed to initialize Telegram bot:', error);
                this.enabled = false;
            }
        }
    }

    // ============================================================================
    // Public Alert Methods
    // ============================================================================

    /**
     * Send arbitrage opportunity alert
     */
    async alertArbitrage(alert: ArbitrageAlert): Promise<void> {
        // 区分吃单/挂单的图标
        const modeIcon = alert.mode === 'MAKER' ? '📌' : '⚡';
        const modeText = alert.mode === 'MAKER' ? '挂单' : '吃单';
        const profitEmoji = alert.profitPercent >= 0.5 ? '🔥' : '💰';
        const sideText = alert.side === 'NO' ? 'NO→YES' : 'YES→NO';

        // 计算资金占用 (如果没有提供，用价格 * 数量估算)
        const qty = alert.maxQuantity || 0;
        const predictCost = alert.predictCost ?? (alert.predictYesPrice * qty);
        const polyCost = alert.polymarketCost ?? (alert.polymarketNoPrice * qty);

        // 计算预估利润 (如果没提供，用百分比 * 资金占用估算)
        const totalFunds = predictCost + polyCost;
        const estProfit = alert.estimatedProfit ?? (totalFunds * alert.profitPercent / 100);

        // 格式化结算时间
        let settlementText = '';
        if (alert.endDate) {
            const endDateObj = new Date(alert.endDate);
            const now = new Date();
            const daysLeft = Math.ceil((endDateObj.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            const dateStr = `${endDateObj.getFullYear()}/${endDateObj.getMonth() + 1}/${endDateObj.getDate()}`;
            settlementText = `\n📅 结算: ${dateStr} (${daysLeft}天后)`;
        }

        // 基础信息 - 紧凑格式，关键信息在前
        let message = `${profitEmoji} <b>发现套利机会</b> ${modeIcon} ${modeText}
<b>利润:</b> $${estProfit.toFixed(2)} (${alert.profitPercent.toFixed(2)}%)  <b>占用:</b> $${totalFunds.toFixed(0)}${settlementText}

<b>市场:</b> ${this.escapeHtml(alert.marketName)}
<b>Predict ID:</b> ${alert.predictMarketId}

<b>方向:</b> ${sideText}
<b>深度:</b> ${qty.toFixed(0)} 股
<b>总成本:</b> ${(alert.totalCost * 100).toFixed(1)}¢  pr:$${predictCost.toFixed(0)}  pm:$${polyCost.toFixed(0)}`;

        // 吃单模式显示费用信息 (TAKER 有手续费，MAKER 无手续费)
        if (alert.mode === 'TAKER' && alert.feeRateBps !== undefined) {
            const feePercent = (alert.feeRateBps / 100).toFixed(2);
            const feeTotal = alert.feeTotal ?? 0;
            message += `
<b>费用:</b> ${feePercent}% ($${feeTotal.toFixed(4)})`;
        }

        await this.send(message);
    }

    /**
     * Send order status alert
     *
     * 新格式：平台标识 + 状态 + 角色 + 数据来源
     * 🟠 Predict / 🔵 Polymarket
     */
    async alertOrder(alert: OrderAlert): Promise<void> {
        // 平台图标
        const platformIcon = alert.platform === 'PREDICT' ? '🟠' : '🔵';
        const emoji = this.getOrderEmoji(alert.type);
        const statusText = this.getOrderStatusText(alert.type);

        // 操作类型图标
        const actionIcon = alert.action === 'BUY' ? '📈' : '📉';
        const actionText = alert.action === 'BUY' ? '买入开仓' : '卖出平仓';

        // 角色
        const roleText = alert.role || (alert.type === 'PLACED' ? 'Maker' : 'Taker');
        const roleDesc = roleText === 'Maker' ? '(挂单)' : '';

        // 多选市场显示选项名
        const outcomeText = alert.outcome
            ? `[${this.escapeHtml(alert.outcome)}] ${alert.side}`
            : alert.side;

        // 数量格式根据状态不同
        const filled = alert.filledQuantity ?? 0;
        const delta = alert.filledDelta;
        const deltaText = delta !== undefined && delta > 0 ? ` (+${delta.toFixed(0)})` : '';

        let quantityText: string;
        let priceLabel: string;
        let amountText: string = '';

        switch (alert.type) {
            case 'PLACED':
                quantityText = `${alert.quantity.toFixed(0)} 股`;
                priceLabel = '挂单价';
                amountText = `\n<b>金额:</b> $${(alert.price * alert.quantity).toFixed(2)}`;
                break;
            case 'FILLED':
                quantityText = `${filled.toFixed(0)} 股`;
                priceLabel = '成交价';
                amountText = `\n<b>成交额:</b> $${(alert.price * filled).toFixed(2)}`;
                break;
            case 'PARTIAL_FILL':
                quantityText = `${filled.toFixed(0)}/${alert.quantity.toFixed(0)} 股${deltaText}`;
                priceLabel = '成交价';
                amountText = `\n<b>成交额:</b> $${(alert.price * filled).toFixed(2)}`;
                break;
            case 'CANCELLED':
                quantityText = filled > 0
                    ? `${filled.toFixed(0)}/${alert.quantity.toFixed(0)} 股 (已取消)`
                    : `${alert.quantity.toFixed(0)} 股 (已取消)`;
                priceLabel = '挂单价';
                break;
            case 'FAILED':
                quantityText = `${filled.toFixed(0)}/${alert.quantity.toFixed(0)} 股`;
                priceLabel = '价格';
                break;
            default:
                quantityText = `${filled.toFixed(0)}/${alert.quantity.toFixed(0)} 股`;
                priceLabel = '价格';
        }

        // 下单时间
        const timeText = alert.timestamp
            ? new Date(alert.timestamp).toLocaleString('zh-CN', { hour12: false })
            : new Date().toLocaleString('zh-CN', { hour12: false });

        // 数据来源
        const dataSource = alert.dataSource || (alert.platform === 'PREDICT' ? 'REST API' : 'Polymarket WS');

        let message = `${platformIcon} ${emoji} <b>${alert.platform} 订单${statusText}</b>

<b>类型:</b> ${actionIcon} ${actionText}
<b>市场:</b> ${this.escapeHtml(alert.marketName)}
<b>方向:</b> ${outcomeText}
<b>角色:</b> ${roleText} ${roleDesc}
<b>${priceLabel}:</b> ${(alert.price * 100).toFixed(1)}¢
<b>数量:</b> ${quantityText}${amountText}`;

        // 订单哈希
        if (alert.orderHash) {
            message += `\n\n<b>订单:</b> <code>${alert.orderHash.slice(0, 18)}...</code>`;
        }

        message += `\n<b>时间:</b> ${timeText}`;

        // 添加延迟信息
        if (alert.latency) {
            message += `\n\n<b>⏱️ 延迟统计:</b>`;
            if (alert.latency.submitToFirstStatus !== undefined) {
                message += `\n  首次状态: ${(alert.latency.submitToFirstStatus / 1000).toFixed(2)}s`;
            }
            if (alert.latency.submitToFill !== undefined) {
                message += `\n  下单到成交: ${(alert.latency.submitToFill / 1000).toFixed(2)}s`;
            }
            if (alert.latency.taskTotalMs !== undefined) {
                message += `\n  任务总耗时: ${(alert.latency.taskTotalMs / 1000).toFixed(2)}s`;
            }
            if (alert.latency.statusFetchAttempts !== undefined) {
                message += `\n  轮询次数: ${alert.latency.statusFetchAttempts}`;
            }
        }

        // 添加错误信息 (用于 FAILED 类型)
        if (alert.error) {
            message += `\n\n<b>❌ 错误:</b>\n<code>${this.escapeHtml(alert.error)}</code>`;
        }

        message += `\n\n📡 <i>via ${dataSource}</i>`;
        await this.send(message);
    }

    /**
     * Send execution error alert
     */
    async alertError(alert: ExecutionErrorAlert): Promise<void> {
        const emoji = alert.requiresManualIntervention ? '🚨' : '⚠️';
        const urgency = alert.requiresManualIntervention ? '严重' : '警告';

        const message = `
${emoji} <b>${urgency}: 执行错误</b> ${emoji}

<b>操作:</b> ${alert.operation}
<b>平台:</b> ${alert.platform}
<b>市场:</b> ${this.escapeHtml(alert.marketName)}

<b>错误信息:</b>
<code>${this.escapeHtml(alert.error)}</code>

${alert.stack ? `<b>堆栈:</b>\n<code>${this.escapeHtml(alert.stack.slice(0, 500))}</code>` : ''}

${alert.requiresManualIntervention ? '<b>⚡ 需要人工介入 ⚡</b>' : ''}
`;
        await this.send(message);
    }

    /**
     * Send price change warning (arb disappeared)
     */
    async alertPriceChange(marketName: string, oldCost: number, newCost: number, action: string): Promise<void> {
        const message = `
⚠️ <b>价格变动警告</b>

<b>市场:</b> ${this.escapeHtml(marketName)}
<b>原成本:</b> ${(oldCost * 100).toFixed(1)}¢
<b>新成本:</b> ${(newCost * 100).toFixed(1)}¢
<b>操作:</b> ${action}
`;
        await this.send(message);
    }

    /**
     * Send statistics summary
     */
    async alertStatistics(stats: StatisticsAlert): Promise<void> {
        const emoji = stats.successRate >= 0.9 ? '📈' : stats.successRate >= 0.7 ? '📊' : '📉';
        const periodText = stats.period === 'HOURLY' ? '每小时' : '每日';

        const message = `
${emoji} <b>${periodText}统计</b>

<b>交易次数:</b> ${stats.tradesExecuted}
<b>发现机会:</b> ${stats.opportunitiesFound}
<b>成功率:</b> ${(stats.successRate * 100).toFixed(1)}%
<b>交易量:</b> $${stats.totalVolume.toFixed(2)}
<b>利润:</b> $${stats.totalProfit.toFixed(2)}
`;
        await this.send(message);
    }

    /**
     * Send startup notification
     */
    async alertStartup(mode: string, markets: number): Promise<void> {
        const message = `
🚀 <b>套利机器人已启动</b>

<b>模式:</b> ${mode}
<b>市场数:</b> ${markets}
<b>时间:</b> ${new Date().toLocaleString('zh-CN')}
`;
        await this.send(message);
    }

    /**
     * Send shutdown notification
     */
    async alertShutdown(reason: string): Promise<void> {
        const message = `
🛑 <b>套利机器人已停止</b>

<b>原因:</b> ${reason}
<b>时间:</b> ${new Date().toLocaleString('zh-CN')}
`;
        await this.send(message);
    }

    /**
     * Send simple text message
     */
    async sendText(text: string): Promise<void> {
        await this.send(text);
    }

    /**
     * 发送消息并置顶
     * @returns messageId 用于后续取消置顶
     */
    async sendAndPin(text: string): Promise<number | null> {
        if (!this.enabled || !this.bot) return null;
        try {
            const msg = await this.bot.sendMessage(this.chatId, text.trim(), {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
            try {
                await this.bot.pinChatMessage(this.chatId, msg.message_id, {
                    disable_notification: false,
                });
            } catch (e: any) {
                console.warn(`[TG] Pin message failed: ${e.message}`);
            }
            return msg.message_id;
        } catch (e: any) {
            console.error(`[TG] Send+pin failed: ${e.message}`);
            return null;
        }
    }

    /**
     * 取消置顶消息
     */
    async unpinMessage(messageId: number): Promise<void> {
        if (!this.enabled || !this.bot) return;
        try {
            await this.bot.unpinChatMessage(this.chatId, { message_id: messageId });
        } catch (e: any) {
            console.warn(`[TG] Unpin failed: ${e.message}`);
        }
    }

    // ============================================================================
    // Private Methods
    // ============================================================================

    private async send(message: string): Promise<void> {
        if (!this.enabled || !this.bot) {
            console.log('[TG] (disabled)', message.slice(0, 100));
            return;
        }

        this.messageQueue.push(message);
        await this.processQueue();
    }

    private async processQueue(): Promise<void> {
        if (this.isSending || this.messageQueue.length === 0) return;

        this.isSending = true;

        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift()!;
            let retries = 0;
            const maxRetries = 3;

            while (retries < maxRetries) {
                try {
                    await this.bot!.sendMessage(this.chatId, message.trim(), {
                        parse_mode: 'HTML',
                        disable_web_page_preview: true,
                    });
                    // Rate limit: max 30 messages per second
                    await this.sleep(100);
                    break; // 成功则跳出重试循环
                } catch (error: any) {
                    // 检查是否是 429 Too Many Requests
                    if (error?.response?.statusCode === 429 || error?.code === 'ETELEGRAM' && error?.message?.includes('429')) {
                        // 从错误响应中提取 retry_after
                        let retryAfter = 30; // 默认 30 秒
                        try {
                            if (error?.response?.body?.parameters?.retry_after) {
                                retryAfter = error.response.body.parameters.retry_after;
                            }
                        } catch { }
                        console.warn(`[TG] 429 Too Many Requests, waiting ${retryAfter}s before retry...`);
                        await this.sleep(retryAfter * 1000);
                        retries++;
                        continue;
                    }
                    console.error('[TG] Failed to send message:', error?.message || error);
                    break; // 其他错误不重试
                }
            }
        }

        this.isSending = false;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    private getOrderEmoji(type: OrderAlert['type']): string {
        switch (type) {
            case 'PLACED': return '📝';
            case 'CANCELLED': return '❌';
            case 'FILLED': return '✅';
            case 'PARTIAL_FILL': return '🔄';
            case 'FAILED': return '🚨';
            default: return '📋';
        }
    }

    private getOrderStatusText(type: OrderAlert['type']): string {
        switch (type) {
            case 'PLACED': return '已挂单';
            case 'CANCELLED': return '已取消';
            case 'FILLED': return '已成交';
            case 'PARTIAL_FILL': return '部分成交';
            case 'FAILED': return '失败';
            default: return '更新';
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Factory function
export function createTelegramNotifier(config: TelegramConfig): TelegramNotifier {
    return new TelegramNotifier(config);
}

/**
 * 模拟推送测试 - 打印两种模式的套利通知样例
 */
export function simulateArbNotifications(): void {
    console.log('\n' + '='.repeat(60));
    console.log('📱 Telegram 套利通知模拟预览');
    console.log('='.repeat(60));

    // 模拟 TAKER (吃单) 通知 - 有手续费
    const takerExample: ArbitrageAlert = {
        marketName: 'Will Bitcoin reach $100k by end of 2024?',
        predictMarketId: 289,
        mode: 'TAKER',
        side: 'YES',
        predictYesPrice: 0.52,
        polymarketNoPrice: 0.46,
        totalCost: 0.98,
        profitPercent: 2.04,
        maxQuantity: 150,
        predictCost: 78.00,  // 0.52 * 150
        polymarketCost: 69.00, // 0.46 * 150
        estimatedProfit: 3.00, // 预估利润 $3.00
        feeRateBps: 50,      // 0.5% Taker 费率
        feeTotal: 0.39,      // 预估费用 (78 * 0.5%)
        endDate: '2026-07-01T04:00:00Z', // 结算时间
    };

    // 模拟 MAKER (挂单) 通知 - 无手续费
    const makerExample: ArbitrageAlert = {
        marketName: 'Will ETH flip BTC market cap in 2025?',
        predictMarketId: 456,
        mode: 'MAKER',
        side: 'NO',
        predictYesPrice: 0.35,
        polymarketNoPrice: 0.62,
        totalCost: 0.97,
        profitPercent: 3.09,
        maxQuantity: 200,
        predictCost: 70.00,  // 0.35 * 200
        polymarketCost: 124.00, // 0.62 * 200
        estimatedProfit: 6.00, // 预估利润 $6.00
        endDate: '2026-12-31T23:59:00Z', // 结算时间
        // MAKER 模式无手续费，不设置 feeRateBps
    };

    // 格式化输出
    const formatTaker = formatArbMessage(takerExample);
    const formatMaker = formatArbMessage(makerExample);

    console.log('\n【吃单模式 TAKER 示例】');
    console.log('-'.repeat(60));
    console.log(formatTaker.replace(/<\/?b>/g, '**').replace(/<\/?code>/g, '`'));

    console.log('\n【挂单模式 MAKER 示例】');
    console.log('-'.repeat(60));
    console.log(formatMaker.replace(/<\/?b>/g, '**').replace(/<\/?code>/g, '`'));

    console.log('\n' + '='.repeat(60));
}

/**
 * 格式化套利消息 (用于模拟和实际发送)
 */
function formatArbMessage(alert: ArbitrageAlert): string {
    const modeIcon = alert.mode === 'MAKER' ? '📌' : '⚡';
    const modeText = alert.mode === 'MAKER' ? '挂单' : '吃单';
    const profitEmoji = alert.profitPercent >= 0.5 ? '🔥' : '💰';
    const sideText = alert.side === 'NO' ? 'NO→YES' : 'YES→NO';

    const qty = alert.maxQuantity || 0;
    const predictCost = alert.predictCost ?? (alert.predictYesPrice * qty);
    const polyCost = alert.polymarketCost ?? (alert.polymarketNoPrice * qty);
    const totalFunds = predictCost + polyCost;
    const estProfit = alert.estimatedProfit ?? (totalFunds * alert.profitPercent / 100);

    // 格式化结算时间
    let settlementText = '';
    if (alert.endDate) {
        const endDateObj = new Date(alert.endDate);
        const now = new Date();
        const daysLeft = Math.ceil((endDateObj.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const dateStr = `${endDateObj.getFullYear()}/${endDateObj.getMonth() + 1}/${endDateObj.getDate()}`;
        settlementText = `\n📅 结算: ${dateStr} (${daysLeft}天后)`;
    }

    let message = `${profitEmoji} <b>发现套利机会</b> ${modeIcon} ${modeText}
<b>利润:</b> $${estProfit.toFixed(2)} (${alert.profitPercent.toFixed(2)}%)  <b>占用:</b> $${totalFunds.toFixed(0)}${settlementText}

<b>市场:</b> ${alert.marketName}
<b>Predict ID:</b> ${alert.predictMarketId}

<b>方向:</b> ${sideText}
<b>深度:</b> ${qty.toFixed(0)} 股
<b>总成本:</b> ${(alert.totalCost * 100).toFixed(1)}¢  pr:$${predictCost.toFixed(0)}  pm:$${polyCost.toFixed(0)}`;

    // 吃单模式显示费用信息 (TAKER 有手续费，MAKER 无手续费)
    if (alert.mode === 'TAKER' && alert.feeRateBps !== undefined) {
        const feePercent = (alert.feeRateBps / 100).toFixed(2);
        const feeTotal = alert.feeTotal ?? 0;
        message += `
<b>费用:</b> ${feePercent}% ($${feeTotal.toFixed(4)})`;
    }

    return message;
}
