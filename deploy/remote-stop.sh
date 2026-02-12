#!/bin/bash
# 远程停止 Dashboard
# 用法: bash deploy/remote-stop.sh <server-ip> <pem-file>

SERVER="${1:?用法: bash deploy/remote-stop.sh <server-ip> <pem-file>}"
PEM="${2:?缺少 pem 文件路径}"
USER="ubuntu"

ssh -i "$PEM" -o StrictHostKeyChecking=no "$USER@$SERVER" << 'REMOTE'
    PID=$(pgrep -f "start-dashboard")
    if [ -n "$PID" ]; then
        kill $PID
        echo "✅ Dashboard 已停止 (PID: $PID)"
    else
        echo "⚠️  Dashboard 未在运行"
    fi
REMOTE
