/**
 * 使用官方 @polymarket/clob-client SDK 测试下单
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// 使用 ethers5 因为 SDK 使用 v5
import { Wallet } from 'ethers5';
import { ClobClient } from '@polymarket/clob-client';

async function main() {
    console.log('=== Polymarket SDK 下单测试 ===\n');

    const privateKey = process.env.POLYMARKET_TRADER_PRIVATE_KEY!;
    const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS!;
    const apiKey = process.env.POLYMARKET_API_KEY!;
    const apiSecret = process.env.POLYMARKET_API_SECRET!;
    const passphrase = process.env.POLYMARKET_PASSPHRASE!;

    console.log(`Proxy: ${proxyAddress.slice(0, 10)}...`);

    // 使用 ethers v5 wallet
    const wallet = new Wallet(privateKey);
    console.log(`Signer: ${wallet.address.slice(0, 10)}...`);

    // 创建 CLOB 客户端
    const client = new ClobClient(
        'https://clob.polymarket.com',
        137,  // Polygon chainId
        wallet,
        {
            key: apiKey,
            secret: apiSecret,
            passphrase: passphrase,
        },
        1,  // SignatureType.POLY_PROXY
        proxyAddress
    );

    // 获取市场信息
    const conditionId = '0x77399fdf6c5097661705ee1fcf8ad615721ea5dd695871dcae2c9eb192a3d75b';
    console.log('\n📖 获取市场信息...');
    const market = await client.getMarket(conditionId);
    console.log(`  Market: ${market.question}`);
    console.log(`  Tick Size: ${market.minimum_tick_size}`);
    console.log(`  Neg Risk: ${market.neg_risk}`);

    // NO token ID
    const noToken = market.tokens.find((t: any) => t.outcome === 'No');
    if (!noToken) {
        console.log('❌ 找不到 NO token');
        return;
    }
    const tokenId = noToken.token_id;
    console.log(`  NO Token: ${tokenId.slice(0, 20)}...`);

    // 获取订单簿
    console.log('\n📖 获取订单簿...');
    const book = await client.getOrderBook(tokenId);
    const bestBid = book.bids?.[0];
    const bestAsk = book.asks?.[0];
    console.log(`  Best Bid: ${bestBid?.price ?? 'N/A'}`);
    console.log(`  Best Ask: ${bestAsk?.price ?? 'N/A'}`);

    if (!bestAsk) {
        console.log('❌ 没有卖单');
        return;
    }

    // 创建订单
    console.log('\n📝 创建订单...');
    const orderArgs = {
        tokenID: tokenId,
        price: parseFloat(bestAsk.price),
        size: 1,
        side: 'BUY' as const,
    };
    console.log(`  Order: BUY 1 @ ${orderArgs.price}`);

    try {
        const signedOrder = await client.createOrder(orderArgs, {
            tickSize: market.minimum_tick_size,
            negRisk: market.neg_risk,
        });
        console.log('\n✅ 订单签名成功!');
        console.log(`  Salt: ${signedOrder.salt}`);
        console.log(`  Signature: ${signedOrder.signature?.slice(0, 30)}...`);

        // 提交订单
        console.log('\n📤 提交订单...');
        const result = await client.postOrder(signedOrder, 'GTC');
        console.log(`✅ 下单成功! OrderID: ${result.orderID}`);

        // 取消订单
        console.log('\n⏳ 取消订单...');
        await new Promise(r => setTimeout(r, 500));
        const cancelled = await client.cancelOrder({ orderID: result.orderID });
        console.log(cancelled ? '✅ 订单已取消' : '⚠️ 取消失败');

    } catch (error: any) {
        console.log(`\n❌ 失败: ${error.message}`);
        if (error.response?.data) {
            console.log(`  Response: ${JSON.stringify(error.response.data)}`);
        }
    }
}

main().catch(console.error);
