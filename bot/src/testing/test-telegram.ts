/**
 * Telegram Integration Test
 * 
 * Tests sending various alert types to your Telegram bot.
 * 
 * Before running:
 * 1. Create a Telegram bot via @BotFather and get the token
 * 2. Get your chat ID (message the bot, then check https://api.telegram.org/bot<TOKEN>/getUpdates)
 * 3. Add to .env:
 *    TELEGRAM_BOT_TOKEN=your_bot_token
 *    TELEGRAM_CHAT_ID=your_chat_id
 */

import * as fs from 'fs';
import * as path from 'path';
import { TelegramNotifier, type TelegramConfig } from '../notification/telegram.js';

// Load env
function loadEnv() {
    const envPath = path.join(process.cwd(), '..', '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

async function main() {
    console.log('='.repeat(60));
    console.log('           TELEGRAM INTEGRATION TEST');
    console.log('='.repeat(60));

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
        console.log('\n❌ Missing Telegram configuration!');
        console.log('\nPlease add to your .env file:');
        console.log('  TELEGRAM_BOT_TOKEN=your_bot_token');
        console.log('  TELEGRAM_CHAT_ID=your_chat_id');
        console.log('\nTo get these:');
        console.log('  1. Create a bot via @BotFather on Telegram');
        console.log('  2. Start a chat with your bot');
        console.log(`  3. Visit: https://api.telegram.org/bot<TOKEN>/getUpdates`);
        console.log('  4. Look for "chat":{"id":XXXXXX} in the response');
        return;
    }

    console.log(`\n✓ Bot Token: ${botToken.slice(0, 10)}...`);
    console.log(`✓ Chat ID: ${chatId}`);

    const config: TelegramConfig = {
        botToken,
        chatId,
        enabled: true,
    };

    const notifier = new TelegramNotifier(config);

    console.log('\n[1] Sending startup notification...');
    await notifier.alertStartup('PAPER_TRADING', 5);
    console.log('    ✓ Sent');

    await sleep(1000);

    console.log('\n[2] Sending arbitrage alert...');
    await notifier.alertArbitrage({
        marketName: 'Jake Paul vs Anthony Joshua',
        predictMarketId: 539,
        mode: 'MAKER',
        predictYesPrice: 0.11,
        polymarketNoPrice: 0.885,
        totalCost: 0.995,
        profitPercent: 0.50,
        maxQuantity: 500,
    });
    console.log('    ✓ Sent');

    await sleep(1000);

    console.log('\n[3] Sending order placed alert...');
    await notifier.alertOrder({
        type: 'PLACED',
        platform: 'PREDICT',
        marketName: 'Jake Paul',
        action: 'BUY',
        side: 'YES',
        price: 0.11,
        quantity: 500,
    });
    console.log('    ✓ Sent');

    await sleep(1000);

    console.log('\n[4] Sending order filled alert...');
    await notifier.alertOrder({
        type: 'FILLED',
        platform: 'PREDICT',
        marketName: 'Jake Paul',
        action: 'BUY',
        side: 'YES',
        price: 0.11,
        quantity: 500,
        filledQuantity: 500,
        orderId: '0x1234567890abcdef',
    });
    console.log('    ✓ Sent');

    await sleep(1000);

    console.log('\n[5] Sending price change warning...');
    await notifier.alertPriceChange(
        'Jake Paul',
        0.995,
        1.02,
        'ORDER CANCELLED - Arbitrage disappeared'
    );
    console.log('    ✓ Sent');

    await sleep(1000);

    console.log('\n[6] Sending execution error...');
    await notifier.alertError({
        operation: 'Buy NO @ Polymarket',
        platform: 'POLYMARKET',
        marketName: 'Jake Paul',
        error: 'Insufficient balance: 450 USDC required, 100 USDC available',
        requiresManualIntervention: true,
    });
    console.log('    ✓ Sent');

    await sleep(1000);

    console.log('\n[7] Sending statistics...');
    await notifier.alertStatistics({
        period: 'HOURLY',
        tradesExecuted: 12,
        totalProfit: 5.67,
        totalVolume: 1250.00,
        successRate: 0.92,
        opportunitiesFound: 15,
    });
    console.log('    ✓ Sent');

    console.log('\n' + '='.repeat(60));
    console.log('           TEST COMPLETE');
    console.log('='.repeat(60));
    console.log('\nCheck your Telegram for the messages!');
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
