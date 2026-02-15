#!/bin/bash
# 从 AWS Secrets Manager 拉取 .env 到项目根目录，然后启动 Dashboard
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -f "$PROJECT_ROOT/package.json" ] && [ -f "$(cd "$(dirname "$0")" && pwd)/package.json" ]; then
    PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
fi
SECRET_ID="${AWS_SECRET_ID:-predict-engine/bot/env}"
ENV_PATH="$PROJECT_ROOT/.env"

echo "[start.sh] 从 Secrets Manager 拉取配置: $SECRET_ID"
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text > "$ENV_PATH"
echo "[start.sh] 已写入 $ENV_PATH"

exec node node_modules/tsx/dist/cli.cjs src/dashboard/start-dashboard.ts "$@"
