/**
 * 测试交易 API Key 获取 Predict 和 Polymarket 余额与持仓
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers, getCreate2Address, keccak256, solidityPacked } from 'ethers';
import * as crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

// ============================================================================
// Polymarket 代理钱包派生 (CREATE2)
// 参考: https://github.com/Polymarket/magic-proxy-builder-example
// 参考: https://github.com/Polymarket/proxy-factories
// ============================================================================

// Polymarket 使用两种代理工厂:
// 1. Magic/Email 用户: Proxy Factory 0xaB45c5A4B0c941a2F231C04C3f49182e1A254052
// 2. MetaMask 用户: Safe Factory 0xaacfeea03eb1561c4e67d661e40682bd20e3541b

// Magic Proxy (EIP-1167 minimal proxy)
const MAGIC_PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';
const MAGIC_PROXY_IMPLEMENTATION = '0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f';

// Gnosis Safe Factory (用于 MetaMask)
const SAFE_FACTORY = '0xaacfeea03eb1561c4e67d661e40682bd20e3541b';
const SAFE_SINGLETON = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552'; // Safe v1.3.0

/**
 * 派生 Magic Proxy 钱包地址 (EIP-1167)
 * 用于 Magic/Email 登录的用户
 */
function deriveMagicProxyAddress(eoaAddress: string): string {
    try {
        // EIP-1167 minimal proxy bytecode
        // 0x3d602d80600a3d3981f3363d3d373d3d3d363d73 + implementation + 0x5af43d82803e903d91602b57fd5bf3
        const initCode = ethers.concat([
            '0x3d602d80600a3d3981f3363d3d373d3d3d363d73',
            MAGIC_PROXY_IMPLEMENTATION,
            '0x5af43d82803e903d91602b57fd5bf3'
        ]);
        const initCodeHash = keccak256(initCode);

        // Salt = keccak256(eoaAddress)
        const salt = keccak256(solidityPacked(['address'], [eoaAddress]));

        return getCreate2Address(MAGIC_PROXY_FACTORY, salt, initCodeHash);
    } catch (error) {
        return '';
    }
}

/**
 * 派生 Gnosis Safe 代理钱包地址
 * 用于 MetaMask 登录的用户
 * 注意: Safe 代理的派生更复杂，需要 initializer 数据
 */
function deriveSafeProxyAddress(eoaAddress: string): string {
    try {
        // Gnosis Safe 使用更复杂的初始化，这里使用简化版本
        // 实际需要知道具体的 initializer 调用数据和 saltNonce
        // 这里我们只能尝试常见的 nonce 值

        // Safe proxy creation code (from Safe v1.3.0)
        // 实际值需要从合约获取
        const creationCode = '0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441a64736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564';

        // 部署数据 = creationCode + singleton地址 (padded to 32 bytes)
        const deploymentData = ethers.concat([
            creationCode,
            ethers.zeroPadValue(SAFE_SINGLETON, 32)
        ]);
        const initCodeHash = keccak256(deploymentData);

        // Safe 使用 keccak256(initializer + saltNonce) 作为 salt
        // 由于我们不知道确切的 initializer，这里使用简化方式
        const salt = keccak256(solidityPacked(['address', 'uint256'], [eoaAddress, 0]));

        return getCreate2Address(SAFE_FACTORY, salt, initCodeHash);
    } catch (error) {
        return '';
    }
}

// ============================================================================
// 配置检查
// ============================================================================

interface EnvConfig {
    // Predict
    predictApiKey: string;
    predictTradeKey: string;
    predictSmartWallet: string;
    predictSignerKey: string;
    // Polymarket
    polyTraderAddress: string;
    polyTraderPrivateKey: string;
    polyApiKey: string;
    polyApiSecret: string;
    polyPassphrase: string;
    polyProxyAddress: string;  // 手动配置的代理钱包地址
}

function loadConfig(): EnvConfig {
    return {
        predictApiKey: process.env.PREDICT_API_KEY || '',
        predictTradeKey: process.env.PREDICT_API_KEY_TRADE || process.env.PREDICT_API_KEY || '',
        predictSmartWallet: process.env.PREDICT_SMART_WALLET_ADDRESS || '',
        predictSignerKey: process.env.PREDICT_SIGNER_PRIVATE_KEY || '',
        polyTraderAddress: process.env.POLYMARKET_TRADER_ADDRESS || '',
        polyTraderPrivateKey: process.env.POLYMARKET_TRADER_PRIVATE_KEY || '',
        polyApiKey: process.env.POLYMARKET_API_KEY || '',
        polyApiSecret: process.env.POLYMARKET_API_SECRET || '',
        polyPassphrase: process.env.POLYMARKET_PASSPHRASE || '',
        polyProxyAddress: process.env.POLYMARKET_PROXY_ADDRESS || '',
    };
}

function printConfig(cfg: EnvConfig): void {
    console.log('\n📋 配置检查:');
    console.log('─'.repeat(50));

    // Predict
    console.log('\n[Predict]');
    console.log(`  API Key:        ${cfg.predictApiKey ? '✅ 已配置' : '❌ 未配置'}`);
    console.log(`  Trade Key:      ${cfg.predictTradeKey ? '✅ 已配置' : '❌ 未配置'}`);
    console.log(`  Smart Wallet:   ${cfg.predictSmartWallet ? `✅ ${cfg.predictSmartWallet.slice(0, 10)}...` : '❌ 未配置'}`);
    console.log(`  Signer Key:     ${cfg.predictSignerKey ? '✅ 已配置' : '❌ 未配置'}`);

    // Polymarket
    console.log('\n[Polymarket]');
    console.log(`  Trader Address: ${cfg.polyTraderAddress ? `✅ ${cfg.polyTraderAddress.slice(0, 10)}...` : '❌ 未配置'}`);
    console.log(`  Private Key:    ${cfg.polyTraderPrivateKey ? '✅ 已配置' : '❌ 未配置'}`);
    console.log(`  API Key:        ${cfg.polyApiKey ? '✅ 已配置' : '❌ 未配置'}`);
    console.log(`  API Secret:     ${cfg.polyApiSecret ? '✅ 已配置' : '❌ 未配置'}`);
    console.log(`  Passphrase:     ${cfg.polyPassphrase ? '✅ 已配置' : '❌ 未配置'}`);
    console.log(`  Proxy Address:  ${cfg.polyProxyAddress ? `✅ ${cfg.polyProxyAddress.slice(0, 10)}...` : '⚠️ 未配置 (将尝试派生)'}`);
}

// ============================================================================
// Predict 余额查询
// ============================================================================

async function getPredictBalance(smartWalletAddress: string): Promise<void> {
    console.log('\n\n🔵 Predict 余额查询');
    console.log('─'.repeat(50));

    if (!smartWalletAddress) {
        console.log('❌ 未配置 PREDICT_SMART_WALLET_ADDRESS');
        return;
    }

    const rpcProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org/');

    // Token addresses on BSC
    const tokens = {
        USDT: '0x55d398326f99059fF775485246999027B3197955',
        USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    };

    const erc20ABI = [
        'function balanceOf(address account) view returns (uint256)',
        'function decimals() view returns (uint8)',
    ];

    try {
        // BNB balance
        const bnbBalance = await rpcProvider.getBalance(smartWalletAddress);
        const bnbFormatted = ethers.formatEther(bnbBalance);
        console.log(`\n  BNB:  ${parseFloat(bnbFormatted).toFixed(6)}`);

        // Stablecoin balances
        let totalUSD = 0;
        for (const [symbol, address] of Object.entries(tokens)) {
            try {
                const contract = new ethers.Contract(address, erc20ABI, rpcProvider);
                const balance = await contract.balanceOf(smartWalletAddress);
                const decimals = await contract.decimals();
                const balanceFormatted = ethers.formatUnits(balance, decimals);
                const balanceNum = parseFloat(balanceFormatted);
                totalUSD += balanceNum;
                console.log(`  ${symbol}: ${balanceNum.toFixed(2)}`);
            } catch (error: any) {
                console.log(`  ${symbol}: 查询失败 - ${error.message}`);
            }
        }

        console.log(`\n  💰 总计 (稳定币): $${totalUSD.toFixed(2)}`);
    } catch (error: any) {
        console.log(`❌ 查询失败: ${error.message}`);
    }
}

// ============================================================================
// Polymarket 余额查询 (使用 L2 API Key)
// ============================================================================

function buildPolymarketHeaders(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    method: string,
    path: string,
    body: string = '',
    address: string = ''
): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Message format: timestamp + method + path + body
    // Body: replace single quotes with double quotes for compatibility
    const normalizedBody = body.replace(/'/g, '"');
    const message = timestamp + method + path + normalizedBody;

    // Decode secret using URL-safe base64
    const secretBuffer = Buffer.from(apiSecret, 'base64');

    // Create HMAC-SHA256 signature
    const signature = crypto
        .createHmac('sha256', secretBuffer)
        .update(message, 'utf-8')
        .digest('base64');

    // URL-safe base64 encoding (replace + with -, / with _)
    const urlSafeSignature = signature.replace(/\+/g, '-').replace(/\//g, '_');

    const headers: Record<string, string> = {
        'POLY_API_KEY': apiKey,
        'POLY_SIGNATURE': urlSafeSignature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': passphrase,
        'Content-Type': 'application/json',
    };

    // Add address header if provided
    if (address) {
        headers['POLY_ADDRESS'] = address;
    }

    return headers;
}

async function getPolymarketBalance(cfg: EnvConfig): Promise<void> {
    console.log('\n\n🟣 Polymarket 余额查询');
    console.log('─'.repeat(50));

    // 方法 1: 使用 L2 API 凭证
    if (cfg.polyApiKey && cfg.polyApiSecret && cfg.polyPassphrase) {
        console.log('\n📡 使用 L2 API 凭证查询...');

        // 获取余额和授权状态
        // Polymarket 使用 USDC.e (bridged USDC) 地址: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
        // 注意: asset_type 应该是 COLLATERAL 或 CONDITIONAL
        try {
            const path = '/balance-allowance?asset_type=COLLATERAL';
            // API 认证必须使用 EOA 地址（API 凭证是从 EOA 私钥派生的）
            const headers = buildPolymarketHeaders(
                cfg.polyApiKey,
                cfg.polyApiSecret,
                cfg.polyPassphrase,
                'GET',
                '/balance-allowance',  // 签名时不包含查询参数
                '',
                cfg.polyTraderAddress  // 必须使用 EOA 地址
            );

            const res = await fetch(`https://clob.polymarket.com${path}`, {
                method: 'GET',
                headers,
            });

            if (res.ok) {
                const data = await res.json() as any;
                console.log('\n  📊 账户余额与授权 (API 原始响应):');
                console.log(`  ${JSON.stringify(data, null, 2)}`);

                // 解析余额 (可能是字符串格式的微单位)
                const balance = data.balance ? parseFloat(data.balance) / 1e6 : 0;
                const allowance = data.allowance ? parseFloat(data.allowance) / 1e6 : 0;

                console.log(`\n  💰 USDC 余额: $${balance.toFixed(2)}`);
                console.log(`  📝 Allowance: $${allowance.toFixed(2)}`);
            } else {
                const errorText = await res.text();
                console.log(`  ❌ API 错误 (${res.status}): ${errorText}`);
            }
        } catch (error: any) {
            console.log(`  ❌ 请求失败: ${error.message}`);
        }

        // 获取订单历史 (通过 /data/orders 端点)
        try {
            const path = '/data/orders';
            const headers = buildPolymarketHeaders(
                cfg.polyApiKey,
                cfg.polyApiSecret,
                cfg.polyPassphrase,
                'GET',
                path,
                '',
                cfg.polyTraderAddress
            );

            const res = await fetch(`https://clob.polymarket.com${path}`, {
                method: 'GET',
                headers,
            });

            if (res.ok) {
                const orders = await res.json() as any;
                const orderList = Array.isArray(orders) ? orders : (orders.orders || []);
                if (orderList.length > 0) {
                    console.log(`\n  📋 订单 (${orderList.length} 个):`);
                    for (const order of orderList.slice(0, 5)) {
                        const side = order.side === 'BUY' ? '买' : '卖';
                        console.log(`    - ${side} ${order.size || order.original_size} @ $${order.price} (${order.status || 'unknown'})`);
                    }
                    if (orderList.length > 5) {
                        console.log(`    ... 还有 ${orderList.length - 5} 个订单`);
                    }
                } else {
                    console.log('\n  📋 订单: 无');
                }
            } else {
                const errorText = await res.text();
                console.log(`  ❌ 获取订单失败 (${res.status}): ${errorText.slice(0, 100)}`);
            }
        } catch (error: any) {
            console.log(`  ❌ 获取订单失败: ${error.message}`);
        }

        // 获取交易历史
        try {
            const path = '/data/trades';
            const headers = buildPolymarketHeaders(
                cfg.polyApiKey,
                cfg.polyApiSecret,
                cfg.polyPassphrase,
                'GET',
                path,
                '',
                cfg.polyTraderAddress
            );

            const res = await fetch(`https://clob.polymarket.com${path}`, {
                method: 'GET',
                headers,
            });

            if (res.ok) {
                const trades = await res.json() as any;
                const tradeList = Array.isArray(trades) ? trades : (trades.trades || []);
                if (tradeList.length > 0) {
                    console.log(`\n  📈 交易记录 (${tradeList.length} 笔):`);
                    for (const trade of tradeList.slice(0, 5)) {
                        const side = trade.side === 'BUY' ? '买' : '卖';
                        console.log(`    - ${side} ${trade.size} @ $${trade.price}`);
                    }
                    if (tradeList.length > 5) {
                        console.log(`    ... 还有 ${tradeList.length - 5} 笔交易`);
                    }
                } else {
                    console.log('\n  📈 交易记录: 无');
                }
            } else {
                const errorText = await res.text();
                console.log(`  ❌ 获取交易记录失败 (${res.status}): ${errorText.slice(0, 100)}`);
            }
        } catch (error: any) {
            console.log(`  ❌ 获取交易记录失败: ${error.message}`);
        }
    } else {
        console.log('  ⚠️ 未配置完整的 L2 API 凭证 (API_KEY, API_SECRET, PASSPHRASE)');
    }

    // 方法 2: 通过链上查询余额 (Polygon)
    if (cfg.polyTraderAddress || cfg.polyProxyAddress) {
        console.log('\n📡 通过链上查询 Polygon 余额...');

        try {
            const polygonRpc = new ethers.JsonRpcProvider('https://polygon-rpc.com/');

            // USDC.e on Polygon
            const usdceAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
            const erc20ABI = [
                'function balanceOf(address account) view returns (uint256)',
                'function decimals() view returns (uint8)',
            ];

            const contract = new ethers.Contract(usdceAddress, erc20ABI, polygonRpc);
            const decimals = await contract.decimals();

            let totalUSDC = 0;

            // 如果配置了代理钱包地址，优先使用
            if (cfg.polyProxyAddress) {
                console.log(`\n  [代理钱包 (已配置): ${cfg.polyProxyAddress}]`);

                const proxyBalance = await contract.balanceOf(cfg.polyProxyAddress);
                const proxyBalanceFormatted = ethers.formatUnits(proxyBalance, decimals);
                const proxyMaticBalance = await polygonRpc.getBalance(cfg.polyProxyAddress);
                const proxyMaticFormatted = ethers.formatEther(proxyMaticBalance);

                console.log(`    USDC.e: $${parseFloat(proxyBalanceFormatted).toFixed(2)}`);
                console.log(`    MATIC:  ${parseFloat(proxyMaticFormatted).toFixed(4)}`);

                const proxyCode = await polygonRpc.getCode(cfg.polyProxyAddress);
                if (proxyCode === '0x') {
                    console.log(`    ⚠️  合约未部署 - 请检查地址是否正确`);
                } else {
                    console.log(`    ✅ 合约已部署`);
                }

                totalUSDC = parseFloat(proxyBalanceFormatted);
            }

            // 查询 EOA 余额
            if (cfg.polyTraderAddress) {
                console.log(`\n  [EOA 钱包: ${cfg.polyTraderAddress}]`);
                const eoaBalance = await contract.balanceOf(cfg.polyTraderAddress);
                const eoaBalanceFormatted = ethers.formatUnits(eoaBalance, decimals);
                const eoaMaticBalance = await polygonRpc.getBalance(cfg.polyTraderAddress);
                const eoaMaticFormatted = ethers.formatEther(eoaMaticBalance);

                console.log(`    USDC.e: $${parseFloat(eoaBalanceFormatted).toFixed(2)}`);
                console.log(`    MATIC:  ${parseFloat(eoaMaticFormatted).toFixed(4)}`);

                // 如果没有配置代理地址，尝试派生
                if (!cfg.polyProxyAddress) {
                    totalUSDC = parseFloat(eoaBalanceFormatted);

                    // 派生 Magic Proxy 钱包地址
                    const magicProxyAddress = deriveMagicProxyAddress(cfg.polyTraderAddress);
                    if (magicProxyAddress) {
                        console.log(`\n  [Magic Proxy (派生): ${magicProxyAddress}]`);

                        const proxyBalance = await contract.balanceOf(magicProxyAddress);
                        const proxyBalanceFormatted = ethers.formatUnits(proxyBalance, decimals);

                        console.log(`    USDC.e: $${parseFloat(proxyBalanceFormatted).toFixed(2)}`);

                        const proxyCode = await polygonRpc.getCode(magicProxyAddress);
                        if (proxyCode !== '0x') {
                            totalUSDC += parseFloat(proxyBalanceFormatted);
                        }
                    }

                    // 派生 Gnosis Safe 钱包地址
                    const safeProxyAddress = deriveSafeProxyAddress(cfg.polyTraderAddress);
                    if (safeProxyAddress) {
                        console.log(`\n  [Gnosis Safe (派生): ${safeProxyAddress}]`);

                        const safeBalance = await contract.balanceOf(safeProxyAddress);
                        const safeBalanceFormatted = ethers.formatUnits(safeBalance, decimals);

                        console.log(`    USDC.e: $${parseFloat(safeBalanceFormatted).toFixed(2)}`);

                        const safeCode = await polygonRpc.getCode(safeProxyAddress);
                        if (safeCode !== '0x') {
                            totalUSDC += parseFloat(safeBalanceFormatted);
                        }
                    }
                }
            }

            console.log(`\n  💰 总计 USDC.e: $${totalUSDC.toFixed(2)}`);

            // 如果没有配置代理地址且余额为0，提示如何获取
            if (!cfg.polyProxyAddress && totalUSDC === 0) {
                console.log(`\n  💡 提示: 派生地址可能不正确`);
                console.log(`     请在 .env 中设置 POLYMARKET_PROXY_ADDRESS`);
                console.log(`     在 Polymarket.com 钱包页面可以找到您的代理钱包地址`);
            }

        } catch (error: any) {
            console.log(`  ❌ 链上查询失败: ${error.message}`);
        }
    }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    console.log('═'.repeat(50));
    console.log('  交易 API Key 余额测试');
    console.log('═'.repeat(50));

    const cfg = loadConfig();
    printConfig(cfg);

    // Predict 余额
    await getPredictBalance(cfg.predictSmartWallet);

    // Polymarket 余额
    await getPolymarketBalance(cfg);

    console.log('\n' + '═'.repeat(50));
    console.log('  测试完成');
    console.log('═'.repeat(50) + '\n');
}

main().catch(console.error);
