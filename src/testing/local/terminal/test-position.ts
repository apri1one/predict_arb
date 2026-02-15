/**
 * 测试脚本：验证持仓查询
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { createTradingClient } from '../market-maker/trading-client.js';

const MARKET_ID = 521;

async function main() {
    console.log('初始化 TradingClient...');
    const client = createTradingClient();
    await client.init();
    console.log('初始化成功\n');

    // 获取 YES 和 NO 的 tokenId
    console.log('获取 TokenID...');
    const yesTokenId = await client.getTokenId(MARKET_ID, 'YES');
    const noTokenId = await client.getTokenId(MARKET_ID, 'NO');

    console.log(`YES TokenID: ${yesTokenId}`);
    console.log(`NO TokenID: ${noTokenId}`);

    // 获取市场信息
    const marketRes = await fetch(`https://api.predict.fun/v1/markets/${MARKET_ID}`, {
        headers: { 'x-api-key': process.env.PREDICT_API_KEY! }
    });
    const marketData = await marketRes.json() as { data: { isNegRisk: boolean; isYieldBearing: boolean } };
    const isNegRisk = marketData.data.isNegRisk;
    const isYieldBearing = marketData.data.isYieldBearing;
    console.log(`\n市场属性: isNegRisk=${isNegRisk}, isYieldBearing=${isYieldBearing}`);

    // 查询 YES 和 NO 持仓
    console.log('\n查询持仓...');

    // 使用 fetchTokenPosition
    const deps = client.createDependencies();

    const yesPosition = await deps.fetchPosition(MARKET_ID, yesTokenId, { isNegRisk, isYieldBearing });
    const noPosition = await deps.fetchPosition(MARKET_ID, noTokenId, { isNegRisk, isYieldBearing });

    console.log(`YES 持仓: ${yesPosition}`);
    console.log(`NO 持仓: ${noPosition}`);

    // 显示配置文件中的 tokenId
    console.log('\n配置文件中的 tokenId:');
    console.log('65007387828745292541803234697216370022860744045592391005849696422923641719057');
    console.log(`是 YES? ${yesTokenId === '65007387828745292541803234697216370022860744045592391005849696422923641719057'}`);
    console.log(`是 NO? ${noTokenId === '65007387828745292541803234697216370022860744045592391005849696422923641719057'}`);
}

main().catch(console.error);
