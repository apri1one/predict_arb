# Predict 余额查询功能实现总结

## 实现日期
2025-12-25

## 背景

Predict API **不提供余额查询端点**，需要通过直接查询 BSC 链上合约获取智能钱包余额。

## 完成的工作

### 1. 环境配置更新

#### `.env` 文件
添加智能钱包地址配置：
```bash
PREDICT_SMART_WALLET_ADDRESS=0xbD58EDACc3358FC2A841a291014380b55F6a6E2f
```

#### `.env.example` 文件
添加配置说明：
```bash
PREDICT_SMART_WALLET_ADDRESS=  # Your Predict smart wallet address (for balance queries)
```

### 2. PredictRestClient 功能扩展

文件：`bot/src/predict/rest-client.ts`

#### 新增方法 1: `getSmartWalletBalance()`

**功能**：查询智能钱包在 BSC 上的余额

**参数**：
- `smartWalletAddress`: 智能钱包地址（默认从环境变量读取）
- `provider`: 可选的 ethers Provider（默认 BSC mainnet）

**返回值**：
```typescript
{
  address: string;                    // 智能钱包地址
  balances: {
    USDT: string;                     // USDT 余额
    USDC: string;                     // USDC 余额
    BUSD: string;                     // BUSD 余额
    BNB: string;                      // BNB 余额
  };
  totalUSD: number;                   // 总价值（USD）
}
```

**实现原理**：
- 直接调用 BSC 上 ERC20 代币合约的 `balanceOf()` 方法
- 查询 USDT、USDC、BUSD 三种稳定币余额
- 同时查询 BNB 余额（用于 Gas 费估算）

#### 新增方法 2: `getExchangeAuthorizations()`

**功能**：检查智能钱包是否授权给 Predict Exchange 合约

**参数**：
- `smartWalletAddress`: 智能钱包地址（默认从环境变量读取）
- `provider`: 可选的 ethers Provider

**返回值**：
```typescript
{
  CTF_EXCHANGE: { USDT: boolean; USDC: boolean; BUSD: boolean };
  YIELD_BEARING_CTF_EXCHANGE: { USDT: boolean; USDC: boolean; BUSD: boolean };
  NEG_RISK_CTF_EXCHANGE: { USDT: boolean; USDC: boolean; BUSD: boolean };
  YIELD_BEARING_NEG_RISK_CTF_EXCHANGE: { USDT: boolean; USDC: boolean; BUSD: boolean };
}
```

**实现原理**：
- 调用 ERC20 代币合约的 `allowance()` 方法
- 检查 4 个 Exchange 合约的授权状态
- 对每个合约检查 USDT、USDC、BUSD 三种代币

### 3. 测试脚本

#### `bot/src/testing/test-balance-client.ts`
测试 PredictRestClient 的余额查询功能

**测试内容**：
1. 查询智能钱包余额
2. 查询 Exchange 授权状态

**测试结果**：
```
✅ 余额查询成功
智能钱包地址: 0xbD58EDACc3358FC2A841a291014380b55F6a6E2f

余额:
  USDT: 111.2061
  USDC: 0.0
  BUSD: 0.0
  BNB:  0.0

总计约: $111.21 USD

✅ 授权查询成功
所有 Exchange 合约的 USDT 授权状态: ✅ 已授权
```

## 使用方法

### 方法 1: 直接使用客户端

```typescript
import { PredictRestClient } from './predict/rest-client.js';

const client = new PredictRestClient();

// 查询余额
const balance = await client.getSmartWalletBalance();
console.log(`USDT 余额: ${balance.balances.USDT}`);
console.log(`总计: $${balance.totalUSD} USD`);

// 查询授权状态
const auth = await client.getExchangeAuthorizations();
console.log(`CTF_EXCHANGE USDT 授权: ${auth.CTF_EXCHANGE.USDT ? '已授权' : '未授权'}`);
```

### 方法 2: 指定自定义地址

```typescript
const balance = await client.getSmartWalletBalance('0x...');
```

### 方法 3: 使用自定义 Provider

```typescript
import { ethers } from 'ethers';

const customProvider = new ethers.JsonRpcProvider('https://bsc-testnet-dataseed.bnbchain.org/');
const balance = await client.getSmartWalletBalance(undefined, customProvider);
```

## 关键发现

### 1. Predict 资金架构

```
用户登录方式: Web3 钱包 (Binance Wallet)
  └── 签名地址: 0x5ce3ad19376344d0017af25bd3cbc87e8f544256
      └── 用于: 认证签名、订单签名

Predict Smart Wallet (托管资金)
  └── 智能钱包: 0xbD58EDACc3358FC2A841a291014380b55F6a6E2f
      └── 用于: 存储资金、执行交易
```

### 2. API 限制

- **无余额查询端点**：Predict API 不提供 `/v1/balance` 或类似端点
- **网页端实现**：网页端可能使用内部 API、GraphQL 或直接查询合约
- **解决方案**：直接查询 BSC 链上合约

### 3. 合约地址（BSC Mainnet）

| 类型 | 地址 |
|------|------|
| USDT | `0x55d398326f99059fF775485246999027B3197955` |
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` |
| BUSD | `0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56` |
| CTF_EXCHANGE | `0x8BC070BEdAB741406F4B1Eb65A72bee27894B689` |
| YIELD_BEARING_CTF_EXCHANGE | `0x6bEb5a40C032AFc305961162d8204CDA16DECFa5` |
| NEG_RISK_CTF_EXCHANGE | `0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A` |
| YIELD_BEARING_NEG_RISK_CTF_EXCHANGE | `0x8A289d458f5a134bA40015085A8F50Ffb681B41d` |

## 下一步

现在已经确认：
- ✅ 智能钱包地址: `0xbD58EDACc3358FC2A841a291014380b55F6a6E2f`
- ✅ 可用余额: **111.21 USDT**
- ✅ 授权状态: 已授权给所有 Exchange 合约
- ✅ 认证状态: JWT Token 正常

**可以开始实现真实交易功能！**
