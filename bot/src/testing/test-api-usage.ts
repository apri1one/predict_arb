/**
 * API 用量统计脚本
 *
 * 统计各模块的 API 调用频率，帮助排查限频问题
 */

// API 调用计数器
const apiCounts: Record<string, { count: number; lastMinute: number; history: number[] }> = {};

// 记录 API 调用
function recordApiCall(endpoint: string): void {
    if (!apiCounts[endpoint]) {
        apiCounts[endpoint] = { count: 0, lastMinute: 0, history: [] };
    }
    apiCounts[endpoint].count++;
    apiCounts[endpoint].lastMinute++;
}

// 每分钟重置 lastMinute 并记录历史
setInterval(() => {
    for (const [endpoint, data] of Object.entries(apiCounts)) {
        data.history.push(data.lastMinute);
        if (data.history.length > 60) data.history.shift();  // 保留 60 分钟历史
        data.lastMinute = 0;
    }
}, 60000);

// 打印统计
function printStats(): void {
    console.clear();
    console.log('='.repeat(80));
    console.log('API 用量统计 (每分钟调用次数)');
    console.log('='.repeat(80));
    console.log('');

    const now = new Date().toLocaleTimeString();
    console.log(`时间: ${now}`);
    console.log('');

    // 按调用次数排序
    const sorted = Object.entries(apiCounts)
        .sort((a, b) => b[1].count - a[1].count);

    console.log('端点'.padEnd(50) + '总计'.padStart(10) + '本分钟'.padStart(10) + '平均/分'.padStart(10));
    console.log('-'.repeat(80));

    for (const [endpoint, data] of sorted) {
        const avg = data.history.length > 0
            ? (data.history.reduce((a, b) => a + b, 0) / data.history.length).toFixed(1)
            : '0';
        console.log(
            endpoint.padEnd(50) +
            String(data.count).padStart(10) +
            String(data.lastMinute).padStart(10) +
            avg.padStart(10)
        );
    }

    console.log('');
    console.log('='.repeat(80));
}

// ============================================================================
// 估算当前配置的 API 调用频率
// ============================================================================

function estimateApiUsage(): void {
    console.log('\n📊 API 用量估算 (基于当前配置)\n');
    console.log('='.repeat(70));

    const POLL_INTERVAL_MS = 1000;  // 主轮询 1 秒
    const CLOSE_INTERVAL_MS = 1000;  // 平仓轮询 1 秒
    const SPORTS_POLY_INTERVAL_MS = 100;  // 体育 Polymarket 0.1 秒
    const SPORTS_PREDICT_INTERVAL_MS = 500;  // 体育 Predict 0.5 秒
    const ENABLE_SPORTS = false;  // 体育市场开关 (当前已关闭)

    // 假设值 (需要根据实际情况调整)
    const LIVE_MARKETS = 50;  // LIVE 市场数量
    const CLOSE_POSITIONS = 5;  // 平仓持仓数量
    const SPORTS_MARKETS = 20;  // 体育市场数量
    const SCAN_KEYS = 7;  // SCAN API keys 数量

    console.log('\n配置参数:');
    console.log(`  主轮询间隔: ${POLL_INTERVAL_MS}ms`);
    console.log(`  平仓轮询间隔: ${CLOSE_INTERVAL_MS}ms`);
    console.log(`  体育市场: ${ENABLE_SPORTS ? '启用' : '禁用'}`);
    if (ENABLE_SPORTS) {
        console.log(`  体育 Poly 刷新: ${SPORTS_POLY_INTERVAL_MS}ms`);
        console.log(`  体育 Predict 刷新: ${SPORTS_PREDICT_INTERVAL_MS}ms`);
    }
    console.log(`  SCAN API Keys: ${SCAN_KEYS}`);

    console.log('\n假设市场数量:');
    console.log(`  LIVE 市场: ${LIVE_MARKETS}`);
    console.log(`  平仓持仓: ${CLOSE_POSITIONS}`);
    if (ENABLE_SPORTS) {
        console.log(`  体育市场: ${SPORTS_MARKETS}`);
    }

    console.log('\n' + '-'.repeat(70));
    console.log('模块'.padEnd(25) + 'Predict API/分'.padStart(15) + 'Polymarket API/分'.padStart(20));
    console.log('-'.repeat(70));

    // LIVE 套利
    const livePredict = (60000 / POLL_INTERVAL_MS) * LIVE_MARKETS;
    const livePoly = 0;  // 使用 WS 缓存
    console.log('LIVE 套利'.padEnd(25) + String(livePredict).padStart(15) + String(livePoly).padStart(20) + '  (Poly 用 WS)');

    // 平仓服务 (已优化后)
    const closePredict = 0;  // 使用缓存
    const closePoly = 0;  // 使用 WS 缓存
    const closePositions = (60000 / CLOSE_INTERVAL_MS) * 2;  // 持仓查询
    console.log('平仓服务 (订单簿)'.padEnd(25) + String(closePredict).padStart(15) + String(closePoly).padStart(20) + '  (都用缓存)');
    console.log('平仓服务 (持仓)'.padEnd(25) + String(closePositions).padStart(15) + String(closePositions).padStart(20));

    // 体育市场 (仅当启用时)
    const sportsPoly = 0;  // 使用 WS
    const sportsPredict = ENABLE_SPORTS ? (60000 / SPORTS_PREDICT_INTERVAL_MS) * SPORTS_MARKETS : 0;
    if (ENABLE_SPORTS) {
        console.log('体育市场'.padEnd(25) + String(sportsPredict).padStart(15) + String(sportsPoly).padStart(20) + '  (Poly 用 WS)');
    } else {
        console.log('体育市场'.padEnd(25) + '0'.padStart(15) + '0'.padStart(20) + '  (已禁用)');
    }

    // 任务执行 (已优化后)
    const taskPredict = 0;  // 使用缓存
    const taskPoly = 0;  // 使用 WS 缓存
    console.log('任务执行'.padEnd(25) + String(taskPredict).padStart(15) + String(taskPoly).padStart(20) + '  (都用缓存)');

    console.log('-'.repeat(70));

    const totalPredict = livePredict + closePositions + sportsPredict;
    const totalPoly = closePositions;
    console.log('总计'.padEnd(25) + String(totalPredict).padStart(15) + String(totalPoly).padStart(20));

    console.log('\n' + '='.repeat(70));

    // 按 key 分配
    const perKeyPerMin = Math.ceil(totalPredict / SCAN_KEYS);
    const perKeyPerSec = (perKeyPerMin / 60).toFixed(2);
    console.log(`\nPredict API 分配 (${SCAN_KEYS} keys):`);
    console.log(`  每 key 每分钟: ${perKeyPerMin} 次`);
    console.log(`  每 key 每秒: ${perKeyPerSec} 次`);

    // 限频提示
    console.log('\n⚠️  Predict API 限制 (估计):');
    console.log('  - 通常限制: 60-120 次/分钟/key');
    console.log('  - 严格限制: 30-60 次/分钟/key');

    if (perKeyPerMin > 60) {
        console.log('\n❌ 警告: 当前配置可能超过限额!');
        console.log('   建议:');
        console.log('   - 增加 SCAN API keys');
        console.log('   - 减少轮询频率');
        console.log('   - 减少监控市场数量');
    } else {
        console.log('\n✅ 当前配置在安全范围内');
    }
}

// 主函数
async function main() {
    console.log('📊 API 用量分析工具\n');

    // 先打印估算
    estimateApiUsage();

    console.log('\n\n注意: 实际用量需要在运行 dashboard 时通过日志统计');
    console.log('可以通过搜索 "[扫描]" 日志来观察实际调用频率');
}

main().catch(console.error);
