#!/bin/bash
# 服务器延迟测试脚本
# 用法: curl -sL https://raw.githubusercontent.com/apri1one/predict_arb/main/bot/src/testing/server-latency-test.sh | bash
# 或: bash server-latency-test.sh

N=10
POLY_TOKEN="71321045679252212594626385532706912750332728571942532289631379312455583992563"

echo "════════════════════════════════════════════════════════"
echo "  服务器延迟测试"
echo "  $(date)"
echo "  $(curl -s ifconfig.me) | $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '"')"
echo "════════════════════════════════════════════════════════"

test_latency() {
    local name="$1"
    local url="$2"
    shift 2
    local extra_args=("$@")
    local samples=()
    local total=0
    local min=999999
    local max=0

    for i in $(seq 1 $N); do
        t=$(curl -o /dev/null -s -w "%{time_total}" "${extra_args[@]}" "$url")
        ms=$(echo "$t * 1000" | bc | cut -d. -f1)
        samples+=($ms)
        total=$((total + ms))
        [ $ms -lt $min ] && min=$ms
        [ $ms -gt $max ] && max=$ms
    done

    # 排序取 P50
    sorted=($(printf '%s\n' "${samples[@]}" | sort -n))
    p50=${sorted[$((N/2))]}
    avg=$((total / N))

    printf "  %-30s Avg: %4dms  P50: %4dms  Min: %4dms  Max: %4dms\n" "$name" "$avg" "$p50" "$min" "$max"
}

echo ""
echo "[1] Polymarket"
echo "────────────────────────────────────────────────────────"
test_latency "CLOB (orderbook)" "https://clob.polymarket.com/book?token_id=$POLY_TOKEN"
test_latency "Gamma (markets)" "https://gamma-api.polymarket.com/markets?closed=false&limit=1"

echo ""
echo "[2] Predict"
echo "────────────────────────────────────────────────────────"
test_latency "REST (markets)" "https://api.predict.fun/v1/markets?_limit=1&status=active"

echo ""
echo "[3] BSC RPC"
echo "────────────────────────────────────────────────────────"
test_latency "Ankr" "https://rpc.ankr.com/bsc" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
test_latency "PublicNode" "https://bsc-rpc.publicnode.com" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
test_latency "BSC Official" "https://bsc-dataseed.bnbchain.org/" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

echo ""
echo "[4] Polygon RPC (Polymarket 链)"
echo "────────────────────────────────────────────────────────"
test_latency "Ankr Polygon" "https://rpc.ankr.com/polygon" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
test_latency "PublicNode Polygon" "https://polygon-bor-rpc.publicnode.com" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

echo ""
echo "════════════════════════════════════════════════════════"
echo "  测试完成 (每项 ${N} 次采样)"
echo "════════════════════════════════════════════════════════"
