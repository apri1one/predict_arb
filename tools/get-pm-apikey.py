from py_clob_client.client import ClobClient
import os
from dotenv import load_dotenv

# 加载 .env 文件
load_dotenv()

# ============ 配置区域 ============
# 从 .env 读取配置
PRIVATE_KEY = os.getenv("POLYMARKET_TRADER_PRIVATE_KEY")
WALLET_ADDRESS = os.getenv("POLYMARKET_TRADER_ADDRESS")

if not PRIVATE_KEY or not WALLET_ADDRESS:
    raise ValueError("请在 .env 中配置 POLYMARKET_TRADER_PRIVATE_KEY 和 POLYMARKET_TRADER_ADDRESS")

# ============ 初始化客户端 ============
client = ClobClient(
    host="https://clob.polymarket.com",
    chain_id=137,           # Polygon 主网
    key=PRIVATE_KEY,
    signature_type=0,       # 0 = EOA 钱包（MetaMask、硬件钱包等）
    funder=WALLET_ADDRESS   # EOA 时，funder 就是您自己的钱包地址
)

# ============ 创建或派生 API 凭证 ============
print("正在生成 API 凭证...")
api_creds = client.create_or_derive_api_creds()

# ============ 输出结果 ============
print("\n" + "=" * 50)
print("✅ API 凭证生成成功！请妥善保存以下信息：")
print("=" * 50)
print(f"API_KEY      = {api_creds.api_key}")
print(f"API_SECRET   = {api_creds.api_secret}")
print(f"API_PASSPHRASE = {api_creds.api_passphrase}")
print("=" * 50)

# ============ 验证凭证有效性 ============
client.set_api_creds(api_creds)
print("\n正在验证凭证...")

try:
    # 尝试获取 API Keys 列表来验证
    keys = client.get_api_keys()
    print(f"✅ 验证成功！当前账户共有 {len(keys)} 个 API Key")
except Exception as e:
    print(f"⚠️ 验证失败: {e}")