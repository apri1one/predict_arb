# API Testing Plan (Docs Phase)

This document defines what to test before building any trading modules.

## 0. Setup

1) Copy `./.env.example` to `./.env` and fill values.
2) Run scripts in `scripts/api-test/`.

## 1. Predict (REST)

Predict base: `https://api.predict.fun`

OpenAPI: `https://api.predict.fun/docs/openapi.json`

### 1.1 Connectivity and rate limits

Measure RTT and error rate for:
- `GET /v1/markets?first=50`
- `GET /v1/markets/{id}`
- `GET /v1/markets/{id}/orderbook`
- `GET /v1/markets/{id}/last-sale`

Capture:
- average / p95 latency
- responses per minute before `429`
- stability under burst (e.g. 5 req/s for 60s)

Script:
- `scripts/api-test/predict_bench.ps1`

### 1.2 Critical unknown: YES vs NO orderbooks

We must determine how to obtain **both YES and NO orderbook depth**.

Hypotheses to test:

H1: `/v1/markets/{id}/orderbook` returns a single outcome book (e.g. YES), and NO must be derived.
- Disprove/confirm by comparing:
  - last-sale outcome (`/last-sale` returns `outcome: Yes|No`)
  - orderbook prices vs observed last-sale price when `outcome=No`

H2: a “market” id is actually outcome-specific; i.e. YES and NO have distinct market ids.
- Check by:
  - listing `GET /v1/markets` and seeing whether “the same question” appears twice with different ids/outcomes

H3: orderbook includes both outcomes implicitly in bids/asks (platform-specific encoding).
- Check by:
  - verifying whether you can execute both YES and NO trades against the same market id (later, once trading is implemented)

Until this is resolved, we cannot implement depth-aware arbitrage correctly on Predict.

## 2. Polymarket (REST + WS)

### 2.1 CLOB REST (orderbook + pricing)

OpenAPI YAML: `https://docs.polymarket.com/api-reference/clob-subset-openapi.yaml`

Base URL (from OpenAPI):
- `https://clob.polymarket.com/`

Key endpoints for testing:
- `GET /book?token_id=...`
- `POST /books` (batch)
- `GET /price?token_id=...`

Measure:
- RTT distribution
- rate limit behavior
- payload sizes for full depth

Script:
- `scripts/api-test/polymarket_clob_bench.ps1`

### 2.2 CLOB WebSocket

WS quickstart: `https://docs.polymarket.com/quickstart/websocket/WSS-Quickstart`

WS URL (from quickstart page):
- `wss://ws-subscriptions-clob.polymarket.com`

Test goals:
- handshake success rate
- subscription correctness (message types, sequencing)
- message lag vs server timestamp (if present)

Script:
- `scripts/api-test/polymarket_ws_smoke.ps1` (connectivity only)

### 2.3 Data API + Gamma API (mapping)

OpenAPI:
- Data API YAML: `https://docs.polymarket.com/api-reference/data-api-openapi.yaml`
  - base: `https://data-api.polymarket.com`
- Gamma API JSON: `https://docs.polymarket.com/api-reference/gamma-openapi.json`
  - base: `https://gamma-api.polymarket.com`

Goal:
- Determine how to map a conditionId to the **YES/NO token_id** used by the CLOB orderbook.

Script:
- `scripts/api-test/polymarket_condition_to_tokens.ps1` (start from a conditionId and print `clob_token_ids`)
- `scripts/api-test/polymarket_mapping_notes.md` (fill during exploration)
