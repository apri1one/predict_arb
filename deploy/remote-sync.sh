#!/bin/bash
# 同步代码到服务器 (不含 .env 和敏感文件)
# 用法: bash deploy/remote-sync.sh <server-ip> <pem-file>

SERVER="${1:?用法: bash deploy/remote-sync.sh <server-ip> <pem-file>}"
PEM="${2:?缺少 pem 文件路径}"
USER="ubuntu"

echo "📦 同步代码到服务器..."
ssh -i "$PEM" -o StrictHostKeyChecking=no "$USER@$SERVER" << 'REMOTE'
    cd predict_arb 2>/dev/null || { echo "首次部署，克隆仓库..."; git clone https://github.com/apri1one/predict_arb.git && cd predict_arb; }
    cd predict_arb 2>/dev/null
    git pull
    cd bot && npm install --production
    echo "✅ 代码同步完成"
REMOTE
