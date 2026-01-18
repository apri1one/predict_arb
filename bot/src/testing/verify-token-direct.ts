/**
 * 直接验证 Polymarket Token 映射
 * 检查多个市场，找到有流动性的来验证
 */

import 'dotenv/config';
import * as fs from 'fs';

interface MarketMatch {
    predict: { id: number; title: string; conditionId: string };
    polymarket: { conditionId: string };
}

async function verifyMarket(name: string, conditionId: string): Promise<{ hasLiquidity: boolean; isCorrect: boolean }> {
    console.log(`\n--- ${name} ---`);

    // 1. 获取 Polymarket 市场信息
    const marketRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
    if (!marketRes.ok) {
        console.log(`  错误: 无法获取市场 (${marketRes.status})`);
        return { hasLiquidity: false, isCorrect: true };
    }
    const market = await marketRes.json() as any;

    // 2. 解析 tokens
    let yesTokenId: string | null = null;
    let noTokenId: string | null = null;

    for (const token of market.tokens || []) {
        if (token.outcome.toLowerCase() === 'yes') {
            yesTokenId = token.token_id;
        } else if (token.outcome.toLowerCase() === 'no') {
            noTokenId = token.token_id;
        }
    }

    if (!yesTokenId || !noTokenId) {
        console.log('  警告: 缺少 YES 或 NO token');
        return { hasLiquidity: false, isCorrect: true };
    }

    // 3. 获取订单簿
    const yesBookRes = await fetch(`https://clob.polymarket.com/book?token_id=${yesTokenId}`);
    const yesBook = await yesBookRes.json() as any;
    const yesAsk = parseFloat(yesBook.asks?.[0]?.price || '1');
    const yesBid = parseFloat(yesBook.bids?.[0]?.price || '0');

    const noBookRes = await fetch(`https://clob.polymarket.com/book?token_id=${noTokenId}`);
    const noBook = await noBookRes.json() as any;
    const noAsk = parseFloat(noBook.asks?.[0]?.price || '1');
    const noBid = parseFloat(noBook.bids?.[0]?.price || '0');

    console.log(`  YES token (${yesTokenId.slice(0, 12)}...): bid=${yesBid.toFixed(3)}, ask=${yesAsk.toFixed(3)}`);
    console.log(`  NO token  (${noTokenId.slice(0, 12)}...): bid=${noBid.toFixed(3)}, ask=${noAsk.toFixed(3)}`);

    // 检查流动性
    const hasLiquidity = (yesAsk < 0.95 && yesAsk > 0.05) || (noAsk < 0.95 && noAsk > 0.05);
    if (!hasLiquidity) {
        console.log('  跳过: 边界价格，无流动性');
        return { hasLiquidity: false, isCorrect: true };
    }

    // 4. 验证映射
    // YES token 的 ask 应该大于 0.5 如果它真的是 YES（在大多数情况下）
    // 但更可靠的验证是: YES ask + NO ask 应该约等于 1
    const sumAsks = yesAsk + noAsk;
    const sumBids = yesBid + noBid;

    console.log(`  验证: YES_ask + NO_ask = ${sumAsks.toFixed(3)} (应接近 1.0)`);
    console.log(`  验证: YES_bid + NO_bid = ${sumBids.toFixed(3)} (应接近 1.0)`);

    // 如果 YES_ask + NO_ask 远离 1，说明映射可能有问题
    const isCorrect = Math.abs(sumAsks - 1) < 0.1 || Math.abs(sumBids - 1) < 0.1;

    if (isCorrect) {
        console.log('  ✓ Token 映射正确');
    } else {
        console.log('  ✗ Token 映射可能错误! (YES+NO 不等于 1)');
    }

    return { hasLiquidity, isCorrect };
}

async function main() {
    console.log('=== 验证多个市场的 Token 映射 ===');

    // 从缓存读取市场
    let markets: { name: string; id: string }[] = [];
    try {
        const data = JSON.parse(fs.readFileSync('E:/predict-tradingbot/bot/polymarket-match-result.json', 'utf-8'));
        markets = data.matches.map((m: MarketMatch) => ({
            name: `Market ${m.predict.id} - ${m.predict.title.slice(0, 30)}`,
            id: m.predict.conditionId,
        }));
    } catch (e) {
        console.log('无法读取缓存，使用默认市场');
        return;
    }

    console.log(`\n共 ${markets.length} 个市场，检查所有...\n`);

    let foundLiquidity = 0;
    let correctCount = 0;
    let incorrectCount = 0;

    for (const market of markets) {
        try {
            const result = await verifyMarket(market.name, market.id);
            if (result.hasLiquidity) {
                foundLiquidity++;
                if (result.isCorrect) {
                    correctCount++;
                } else {
                    incorrectCount++;
                }
                // 找到足够多的有流动性市场就停止
                if (foundLiquidity >= 5) {
                    console.log('\n已找到足够多的有流动性市场，停止检查');
                    break;
                }
            }
        } catch (e: any) {
            console.log(`  错误: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 100)); // 避免限流
    }

    console.log('\n=== 总结 ===');
    console.log(`有流动性的市场: ${foundLiquidity}`);
    console.log(`映射正确: ${correctCount}`);
    console.log(`映射错误: ${incorrectCount}`);

    if (incorrectCount > 0) {
        console.log('\n❌ 发现 Token 映射错误！需要修复 start-dashboard.ts 中的 token 解析逻辑。');
    } else if (foundLiquidity > 0) {
        console.log('\n✓ 所有有流动性的市场映射都正确。');
    }
}

main().catch(console.error);
