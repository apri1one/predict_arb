# Predict × Polymarket Arbitrage Bot — PRD (v0)

This repository is currently in a **documentation + API testing** phase. We are *not* implementing trading modules yet.

Related:
- Architecture diagram: `docs/ARCHITECTURE.md`
- API testing plan + scripts: `docs/API_TESTING.md`

## 1. Goal

Monitor orderbooks on Predict and Polymarket for the **same event and same outcome**, and identify depth-aware arbitrage opportunities.

Primary arbitrage condition (per share):
- If you can buy `YES` on one venue and buy `NO` on the other venue such that:
  - `YES_all_in_cost + NO_all_in_cost <= 1.0`
  - then the pair is (resolution-)hedged and non-negative PnL.

User constraints:
- `minProfit = 0` (break-even is acceptable; Predict points are treated as extra edge but **not** valued).
- Need **both YES and NO books** on both venues (do not assume symmetry; depth differences determine executable size).
- Event/outcome mapping must be **strict** (no fuzzy matching).

## 2. Strategy ideas (for later implementation)

1) **Two-sided taker** (fast, rare opportunities, highest leg risk)
2) **Predict maker fill → Polymarket taker hedge** (core candidate due to Predict lower liquidity)
3) **Predict single-venue market making** (points + spread), optionally hedge inventory on Polymarket

This PRD only defines requirements and testing.

## 3. Depth-aware opportunity definition

Top-of-book is insufficient; opportunity must be computed over depth.

For target size `Q` shares:
- `avgCostYES(Q)` = average fill cost to buy YES up to size `Q` using the ask ladder of the chosen venue.
- `avgCostNO(Q)` = average fill cost to buy NO up to size `Q` using the ask ladder of the chosen venue.
- Predict taker fee is included in `avgCost*(Q)` when Predict is the taker leg.

Executable opportunity if:
- `avgCostYES(Q) + avgCostNO(Q) <= 1.0`

Outputs required per opportunity:
- direction (where to buy YES, where to buy NO)
- max executable size `Q*` given current depth and constraints
- expected profit per share and total profit at `Q*` (can be 0)

## 4. Fees

### 4.1 Predict

From `https://docs.predict.fun/the-basics/predict-fees-and-limits.md`:
- Maker fee: 0
- Taker fee:
  - `RawFee = BaseFee% * min(Price, 1 - Price) * Shares`
  - If the 10% discount is active: `RawFee *= 0.9`

Engineering assumption (to validate with live API responses):
- `feeRateBps` from `GET /v1/markets` is the market's `BaseFee` in bps (e.g. 200 = 2%).

### 4.2 Polymarket

You state maker/taker fees are 0. Still validate hidden costs (deposits/withdrawals, gas, min tick/size).

## 5. Data sources & mapping

### 5.1 Predict

Base: `https://api.predict.fun`

From OpenAPI (`https://api.predict.fun/docs/openapi.json`):
- Markets: `GET /v1/markets` (includes `feeRateBps`, `outcomes`, `polymarketConditionIds`)
- Market: `GET /v1/markets/{id}`
- Orderbook: `GET /v1/markets/{id}/orderbook`
- Last sale: `GET /v1/markets/{id}/last-sale` (includes `outcome: Yes|No`)
- Matches (fills): `GET /v1/orders/matches` (cursor)

### 5.2 Polymarket

From Polymarket docs:
- CLOB REST base: `https://clob.polymarket.com/` (OpenAPI: `https://docs.polymarket.com/api-reference/clob-subset-openapi.yaml`)
- CLOB WS: `wss://ws-subscriptions-clob.polymarket.com` (from `https://docs.polymarket.com/quickstart/websocket/WSS-Quickstart`)
- Data API base: `https://data-api.polymarket.com` (OpenAPI: `https://docs.polymarket.com/api-reference/data-api-openapi.yaml`)
- Gamma API base: `https://gamma-api.polymarket.com` (OpenAPI: `https://docs.polymarket.com/api-reference/gamma-openapi.json`)

### 5.3 Mapping requirements

- Event mapping:
  - Prefer Predict's `polymarketConditionIds` as the primary key.
  - Maintain a manual override table for exceptions.
- Outcome mapping:
  - Must match the same outcome on both venues (strict string match + manual overrides if needed).

## 6. API discovery tasks (must resolve before building)

You already clarified product requirements:
- Need YES+NO orderbooks on both venues (depth matters).
- Mapping must be strict.
- `minProfit = 0` (do not model points).
- Multi-outcome markets are allowed as long as outcomes can be matched strictly.

The remaining items below are *implementation blockers* we must verify via APIs.

1) Predict: how to obtain **both YES and NO orderbooks** for a market in a depth-correct way?
   - `/v1/markets/{id}/orderbook` is keyed only by `id` and has no outcome parameter in the OpenAPI.
   - Hypotheses to test are listed in `docs/API_TESTING.md`.
2) Polymarket: how to map a conditionId to **YES/NO token_id** (for `/book?token_id=...` and WS subscriptions) strictly and reproducibly?
3) Multi-outcome events: define the “hedged set” rule (binary only at first, or full outcome-set hedging) so the depth model matches reality.
