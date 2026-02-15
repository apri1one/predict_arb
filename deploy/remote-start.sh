#!/bin/bash
# 远程启动脚本 — 从本地 .env 注入环境变量到服务器进程
# 用法: bash deploy/remote-start.sh [server-ip] [pem-file]
#
# 原理: 读取本地 .env，通过 SSH 以 env 命令注入到远程进程
# 服务器磁盘上不会保存任何密钥/API Key

SERVER="${1:?用法: bash deploy/remote-start.sh <server-ip> <pem-file>}"
PEM="${2:?缺少 pem 文件路径}"
USER="ubuntu"
REMOTE_DIR="predict_arb/bot"
ENV_FILE="$(dirname "$0")/../.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ 找不到 .env 文件: $ENV_FILE"
    exit 1
fi

if [ ! -f "$PEM" ]; then
    echo "❌ 找不到 PEM 文件: $PEM"
    exit 1
fi

echo "════════════════════════════════════════════════"
echo "  远程启动 Dashboard"
echo "  服务器: $SERVER"
echo "  .env: $ENV_FILE (仅注入内存，不上传)"
echo "════════════════════════════════════════════════"

# 读取 .env，构建 env 命令参数
ENV_VARS=""
while IFS= read -r line; do
    # 跳过空行和注释
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    # 去掉行内注释和前后空格
    clean=$(echo "$line" | sed 's/#.*//' | xargs)
    [[ -z "$clean" ]] && continue
    ENV_VARS="$ENV_VARS export $clean;"
done < "$ENV_FILE"

# SSH 连接并启动
ssh -i "$PEM" -o StrictHostKeyChecking=no "$USER@$SERVER" << REMOTE
    cd $REMOTE_DIR || exit 1

    # 注入环境变量 (仅存在于当前 shell 进程)
    $ENV_VARS

    # 用 nohup 后台运行，日志输出到文件
    echo "🚀 启动 Dashboard..."
    nohup npx tsx src/dashboard/start-dashboard.ts > /tmp/dashboard.log 2>&1 &

    sleep 2
    if pgrep -f "start-dashboard" > /dev/null; then
        echo "✅ Dashboard 已启动 (PID: \$(pgrep -f start-dashboard))"
        echo "📋 日志: ssh -i $PEM $USER@$SERVER 'tail -f /tmp/dashboard.log'"
    else
        echo "❌ 启动失败，查看日志:"
        tail -20 /tmp/dashboard.log
    fi
REMOTE
