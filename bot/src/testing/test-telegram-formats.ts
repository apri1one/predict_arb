/**
 * Telegram 消息格式测试
 *
 * 模拟所有消息类型，展示统一的格式标准：
 * - 🟠 Predict (橙色)
 * - 🔵 Polymarket (蓝色)
 */

import { config } from 'dotenv';
config({ path: '../.env' });

import { createTelegramNotifier, TelegramNotifier } from '../notification/telegram.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID');
    process.exit(1);
}

const tg = createTelegramNotifier({
    botToken: TELEGRAM_BOT_TOKEN,
    chatId: TELEGRAM_CHAT_ID,
    enabled: true,
});

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// 新版消息格式模板
// ============================================================================

/**
 * 格式化时间戳
 */
function formatTime(ts?: number): string {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 转义 HTML
 */
function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================================
// 消息模板 - 统一格式
// ============================================================================

const messages = {
    // ========== 1. 套利机会发现 ==========
    arbOpportunityTaker: () => `🔥 <b>发现套利机会</b> ⚡ TAKER
<b>利润:</b> $2.56 (2.56%)  <b>占用:</b> $100
📅 结算: 2027/1/1 (348天后)

<b>市场:</b> Metamask FDV above $700M one day after launch?
<b>Predict ID:</b> 881

<b>方向:</b> NO→YES (买Predict NO + 买Poly YES)
<b>深度:</b> 1,760 股
<b>总成本:</b> 97.4¢  pr:$19  pm:$78
<b>费用:</b> 2.00% ($0.38)

⏱️ ${formatTime()}`,

    arbOpportunityMaker: () => `💰 <b>发现套利机会</b> 📌 MAKER
<b>利润:</b> $1.20 (1.20%)  <b>占用:</b> $100
📅 结算: 2026/2/16 (29天后)

<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?
<b>Predict ID:</b> 706

<b>方向:</b> YES→NO (买Predict YES + 买Poly NO)
<b>深度:</b> 500 股
<b>总成本:</b> 98.8¢  pr:$52  pm:$47

⏱️ ${formatTime()}`,

    // ========== 2. Predict 订单事件 (链上 BSC) ==========
    predictOrderFilled: () => `🟠 ✅ <b>Predict 订单成交</b> (链上确认)

<b>类型:</b> 📈 买入开仓
<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?
<b>方向:</b> YES
<b>角色:</b> Taker
<b>成交价:</b> 52.0¢
<b>成交量:</b> 100.00 股
<b>成交额:</b> $52.00
<b>手续费:</b> $0.1040

<b>订单:</b> <code>0xc4bde053ce8327...</code>
<b>交易:</b> <a href="https://bscscan.com/tx/0x8f66b7c9...">查看</a>
<b>区块:</b> #75865239
<b>时间:</b> ${formatTime()}

📡 <i>via BSC WebSocket</i>`,

    predictOrderFilledMaker: () => `🟠 ✅ <b>Predict 订单成交</b> (链上确认)

<b>类型:</b> 📉 卖出平仓
<b>市场:</b> Metamask FDV above $700M one day after launch?
<b>方向:</b> NO
<b>角色:</b> Maker
<b>成交价:</b> 81.0¢
<b>成交量:</b> 50.00 股
<b>成交额:</b> $40.50
<b>手续费:</b> $0.0000

<b>订单:</b> <code>0xa1b2c3d4e5f678...</code>
<b>交易:</b> <a href="https://bscscan.com/tx/0x1234abcd...">查看</a>
<b>区块:</b> #75865300
<b>时间:</b> ${formatTime()}

📡 <i>via BSC WebSocket</i>`,

    // ========== 3. Predict 订单事件 (API) ==========
    predictOrderPlaced: () => `🟠 📝 <b>Predict 订单已挂单</b>

<b>类型:</b> 📈 买入开仓
<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?
<b>方向:</b> YES
<b>角色:</b> Maker (挂单)
<b>挂单价:</b> 51.5¢
<b>数量:</b> 100 股
<b>金额:</b> $51.50

<b>订单:</b> <code>0xabc123def456...</code>
<b>时间:</b> ${formatTime()}

📡 <i>via REST API</i>`,

    predictOrderCancelled: () => `🟠 ❌ <b>Predict 订单已取消</b>

<b>类型:</b> 📈 买入开仓
<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?
<b>方向:</b> YES
<b>角色:</b> Maker
<b>挂单价:</b> 51.5¢
<b>数量:</b> 0/100 股 (已取消)

<b>订单:</b> <code>0xabc123def456...</code>
<b>时间:</b> ${formatTime()}

📡 <i>via REST API</i>`,

    predictOrderPartialFill: () => `🟠 🔄 <b>Predict 订单部分成交</b>

<b>类型:</b> 📈 买入开仓
<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?
<b>方向:</b> YES
<b>角色:</b> Maker
<b>成交价:</b> 51.5¢
<b>数量:</b> 30/100 股 (+30)
<b>成交额:</b> $15.45

<b>订单:</b> <code>0xabc123def456...</code>
<b>时间:</b> ${formatTime()}

📡 <i>via REST API</i>`,

    // ========== 4. Polymarket 订单事件 (WS) ==========
    polymarketOrderPlaced: () => `🔵 📝 <b>Polymarket 订单已挂单</b>

<b>类型:</b> 📈 买入
<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?
<b>方向:</b> NO
<b>角色:</b> Maker (挂单)
<b>挂单价:</b> 47.0¢
<b>数量:</b> 100 股
<b>金额:</b> $47.00

<b>订单:</b> <code>0x9f8e7d6c5b4a...</code>
<b>时间:</b> ${formatTime()}

📡 <i>via Polymarket WS</i>`,

    polymarketOrderFilled: () => `🔵 ✅ <b>Polymarket 订单成交</b>

<b>类型:</b> 📈 买入
<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?
<b>方向:</b> NO
<b>角色:</b> Taker
<b>成交价:</b> 47.5¢
<b>成交量:</b> 100 股
<b>成交额:</b> $47.50

<b>订单:</b> <code>0x9f8e7d6c5b4a...</code>
<b>时间:</b> ${formatTime()}

📡 <i>via Polymarket WS</i>`,

    polymarketOrderPartialFill: () => `🔵 🔄 <b>Polymarket 订单部分成交</b>

<b>类型:</b> 📈 买入
<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?
<b>方向:</b> NO
<b>角色:</b> Maker
<b>成交价:</b> 47.0¢
<b>数量:</b> 60/100 股 (+20)
<b>成交额:</b> $28.20

<b>订单:</b> <code>0x9f8e7d6c5b4a...</code>
<b>时间:</b> ${formatTime()}

📡 <i>via Polymarket WS</i>`,

    polymarketOrderCancelled: () => `🔵 ❌ <b>Polymarket 订单已取消</b>

<b>类型:</b> 📈 买入
<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?
<b>方向:</b> NO
<b>角色:</b> Maker
<b>挂单价:</b> 47.0¢
<b>数量:</b> 60/100 股 (已取消)

<b>订单:</b> <code>0x9f8e7d6c5b4a...</code>
<b>时间:</b> ${formatTime()}

📡 <i>via Polymarket WS</i>`,

    polymarketTradeFailed: () => `🔵 🚨 <b>Polymarket 交易失败</b>

<b>类型:</b> 📈 买入
<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?
<b>方向:</b> NO
<b>角色:</b> Taker
<b>价格:</b> 47.5¢
<b>数量:</b> 100 股
<b>状态:</b> FAILED

<b>订单:</b> <code>0x9f8e7d6c5b4a...</code>
<b>错误:</b> <code>Insufficient balance</code>
<b>时间:</b> ${formatTime()}

📡 <i>via Polymarket WS</i>`,

    // ========== 5. 任务状态通知 ==========
    taskStarted: () => `🚀 <b>套利任务开始</b>

<b>任务:</b> <code>taker-test-1768683722</code>
<b>策略:</b> ⚡ TAKER
<b>市场:</b> Metamask FDV above $700M one day after launch?

<b>目标:</b>
  🟠 Predict 买 NO @ 19.1¢ × 25 股
  🔵 Polymarket 买 YES @ 78.0¢ × 25 股
<b>预期利润:</b> $0.64 (2.56%)

<b>时间:</b> ${formatTime()}`,

    taskCompleted: () => `✅ <b>套利任务完成</b>

<b>任务:</b> <code>taker-test-1768683722</code>
<b>策略:</b> ⚡ TAKER
<b>市场:</b> Metamask FDV above $700M one day after launch?

<b>执行结果:</b>
  🟠 Predict: 25/25 股 @ 19.1¢ ($4.78)
  🔵 Polymarket: 25/25 股 @ 78.0¢ ($19.50)
<b>实际利润:</b> $0.62 (2.48%)

<b>⏱️ 延迟统计:</b>
  Predict 下单: 650ms
  Predict 成交检测: 1.8s (BSC WSS)
  Polymarket 对冲: 420ms
  任务总耗时: 3.2s

<b>时间:</b> ${formatTime()}`,

    taskFailed: () => `🚨 <b>套利任务失败</b>

<b>任务:</b> <code>taker-test-1768683722</code>
<b>策略:</b> ⚡ TAKER
<b>市场:</b> Metamask FDV above $700M one day after launch?

<b>执行状态:</b>
  🟠 Predict: 25/25 股 @ 19.1¢ ✅
  🔵 Polymarket: 0/25 股 ❌

<b>❌ 错误:</b>
<code>对冲失败: 价格滑点超限 (ask=82.5¢ > max=78.5¢)</code>

<b>⚠️ 需要手动处理未对冲仓位</b>

<b>时间:</b> ${formatTime()}`,

    taskCancelled: () => `🛑 <b>套利任务取消</b>

<b>任务:</b> <code>taker-test-1768683722</code>
<b>策略:</b> ⚡ TAKER
<b>市场:</b> Metamask FDV above $700M one day after launch?

<b>取消原因:</b> 用户手动取消
<b>执行状态:</b>
  🟠 Predict: 0/25 股
  🔵 Polymarket: 未执行

<b>时间:</b> ${formatTime()}`,

    // ========== 6. 系统通知 ==========
    systemStartup: () => `🚀 <b>套利机器人已启动</b>

<b>模式:</b> Dashboard (TAKER + MAKER)
<b>监控市场:</b> 226 个
<b>账户:</b> Main

<b>通知服务:</b>
  🟠 Predict BSC 监控: ✅ 已启动
  🔵 Polymarket WS 监控: ✅ 已启动

<b>时间:</b> ${formatTime()}`,

    systemShutdown: () => `🛑 <b>套利机器人已停止</b>

<b>原因:</b> 正常关闭
<b>运行时长:</b> 4小时23分钟
<b>执行任务:</b> 12 个
<b>成功率:</b> 91.7%

<b>时间:</b> ${formatTime()}`,

    // ========== 7. 错误告警 ==========
    errorAlert: () => `🚨 <b>严重: 执行错误</b> 🚨

<b>操作:</b> Polymarket 对冲下单
<b>平台:</b> 🔵 POLYMARKET
<b>市场:</b> Will the Buffalo Bills win Super Bowl 2026?

<b>错误信息:</b>
<code>API Error 429: Rate limit exceeded</code>

<b>堆栈:</b>
<code>at PolymarketTrader.placeOrder (trader.ts:156)
at TakerExecutor.hedge (executor.ts:234)</code>

<b>⚡ 需要人工介入 ⚡</b>

<b>时间:</b> ${formatTime()}`,

    priceChangeWarning: () => `⚠️ <b>价格变动警告</b>

<b>市场:</b> Metamask FDV above $700M one day after launch?

<b>原成本:</b> 97.4¢ (利润 2.6%)
<b>新成本:</b> 100.2¢ (利润 -0.2%)

<b>操作:</b> 套利机会已消失，跳过执行

<b>时间:</b> ${formatTime()}`,

    // ========== 8. 统计摘要 ==========
    hourlyStats: () => `📊 <b>每小时统计</b>

<b>交易次数:</b> 5
<b>发现机会:</b> 23
<b>成功率:</b> 100.0%
<b>交易量:</b> $245.80
<b>利润:</b> $6.12

<b>平台分布:</b>
  🟠 Predict: 5 笔 / $122.90
  🔵 Polymarket: 5 笔 / $122.90

<b>时间:</b> ${formatTime()}`,

    // ========== 9. 监控状态 ==========
    bscMonitorStarted: () => `🟠 🔗 <b>Predict 链上订单监控已启动</b>

实时推送订单成交通知

<b>数据源:</b> BSC WebSocket
<b>钱包:</b> <code>0x1234...abcd</code>
<b>时间:</b> ${formatTime()}`,

    bscMonitorStopped: () => `🟠 🛑 <b>Predict 链上订单监控已停止</b>

<b>时间:</b> ${formatTime()}`,

    polymarketMonitorConnected: () => `🔵 🔗 <b>Polymarket 订单监控已连接</b>

实时推送订单状态变更

<b>数据源:</b> Polymarket User WS
<b>时间:</b> ${formatTime()}`,

    polymarketMonitorDisconnected: () => `🔵 ⚠️ <b>Polymarket 订单监控断开</b>

<b>代码:</b> 1006
<b>原因:</b> Connection reset

<b>时间:</b> ${formatTime()}`,
};

// ============================================================================
// 主程序
// ============================================================================

async function main(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Telegram 消息格式测试');
    console.log('='.repeat(60));
    console.log('\n将发送所有消息类型到 Telegram...\n');

    const messageList = [
        { name: '1. 套利机会 (TAKER)', fn: messages.arbOpportunityTaker },
        { name: '2. 套利机会 (MAKER)', fn: messages.arbOpportunityMaker },
        { name: '3. Predict 成交 (Taker)', fn: messages.predictOrderFilled },
        { name: '4. Predict 成交 (Maker)', fn: messages.predictOrderFilledMaker },
        { name: '5. Predict 挂单', fn: messages.predictOrderPlaced },
        { name: '6. Predict 部分成交', fn: messages.predictOrderPartialFill },
        { name: '7. Predict 取消', fn: messages.predictOrderCancelled },
        { name: '8. Polymarket 挂单', fn: messages.polymarketOrderPlaced },
        { name: '9. Polymarket 成交', fn: messages.polymarketOrderFilled },
        { name: '10. Polymarket 部分成交', fn: messages.polymarketOrderPartialFill },
        { name: '11. Polymarket 取消', fn: messages.polymarketOrderCancelled },
        { name: '12. Polymarket 失败', fn: messages.polymarketTradeFailed },
        { name: '13. 任务开始', fn: messages.taskStarted },
        { name: '14. 任务完成', fn: messages.taskCompleted },
        { name: '15. 任务失败', fn: messages.taskFailed },
        { name: '16. 任务取消', fn: messages.taskCancelled },
        { name: '17. 系统启动', fn: messages.systemStartup },
        { name: '18. 系统关闭', fn: messages.systemShutdown },
        { name: '19. 错误告警', fn: messages.errorAlert },
        { name: '20. 价格变动', fn: messages.priceChangeWarning },
        { name: '21. 小时统计', fn: messages.hourlyStats },
        { name: '22. BSC 监控启动', fn: messages.bscMonitorStarted },
        { name: '23. BSC 监控停止', fn: messages.bscMonitorStopped },
        { name: '24. Poly 监控连接', fn: messages.polymarketMonitorConnected },
        { name: '25. Poly 监控断开', fn: messages.polymarketMonitorDisconnected },
    ];

    for (const { name, fn } of messageList) {
        console.log(`发送: ${name}`);
        await tg.sendText(fn());
        await sleep(500); // 避免速率限制
    }

    console.log('\n✅ 所有消息已发送完成!');
    console.log('请检查 Telegram 查看效果。\n');

    process.exit(0);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
