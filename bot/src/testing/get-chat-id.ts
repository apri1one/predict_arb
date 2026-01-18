/**
 * Get Telegram Chat ID Helper
 * Helps you find the chat ID for your bot
 */

import * as fs from 'fs';
import * as path from 'path';

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
    console.log('        TELEGRAM CHAT ID FINDER');
    console.log('='.repeat(60));

    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
        console.log('\n❌ TELEGRAM_BOT_TOKEN not found in .env');
        console.log('\nPlease add your bot token to .env:');
        console.log('  TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmnOPQ...');
        return;
    }

    console.log(`\n✓ Token found: ${botToken.slice(0, 15)}...`);

    // Test the token first
    console.log('\n[1] Testing bot token...');

    try {
        const meUrl = `https://api.telegram.org/bot${botToken}/getMe`;
        const meRes = await fetch(meUrl);
        const meData = await meRes.json() as { ok: boolean; result?: { username: string }; description?: string };

        if (!meData.ok) {
            console.log(`\n❌ Invalid token: ${meData.description}`);
            console.log('\nPlease check your TELEGRAM_BOT_TOKEN in .env');
            return;
        }

        console.log(`    ✓ Bot is valid: @${meData.result?.username}`);
    } catch (e) {
        console.log(`\n❌ Network error: ${e}`);
        return;
    }

    // Get updates
    console.log('\n[2] Fetching chat updates...');
    console.log('    (Make sure you sent a message to the bot or group first!)');

    const updatesUrl = `https://api.telegram.org/bot${botToken}/getUpdates`;
    const updatesRes = await fetch(updatesUrl);
    const updatesData = await updatesRes.json() as { ok: boolean; result?: any[] };

    if (!updatesData.ok || !updatesData.result) {
        console.log('\n❌ Failed to get updates');
        return;
    }

    if (updatesData.result.length === 0) {
        console.log('\n⚠️ No messages found!');
        console.log('\nPlease:');
        console.log('  1. Send a message directly to your bot, OR');
        console.log('  2. Add the bot to a group and send @YourBotName hi');
        console.log('  3. Run this script again');
        return;
    }

    console.log(`    ✓ Found ${updatesData.result.length} update(s)`);

    // Extract unique chats
    const chats = new Map<string, { id: number; type: string; title?: string; username?: string }>();

    for (const update of updatesData.result) {
        let chat = update.message?.chat || update.my_chat_member?.chat || update.channel_post?.chat;
        if (chat) {
            chats.set(String(chat.id), {
                id: chat.id,
                type: chat.type,
                title: chat.title,
                username: chat.username,
            });
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('        FOUND CHAT IDs');
    console.log('='.repeat(60));

    for (const [id, chat] of chats) {
        console.log(`\n  Chat ID: ${chat.id}`);
        console.log(`  Type: ${chat.type}`);
        if (chat.title) console.log(`  Title: ${chat.title}`);
        if (chat.username) console.log(`  Username: @${chat.username}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('\nAdd the Chat ID to your .env:');
    console.log(`  TELEGRAM_CHAT_ID=${[...chats.values()][0]?.id || 'YOUR_CHAT_ID'}`);
    console.log('='.repeat(60));
}

main().catch(console.error);
