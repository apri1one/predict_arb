# Polymarket mapping notes (fill during exploration)

Goal: given a Predict market (`polymarketConditionIds[]`) find the **YES token_id** and **NO token_id** for Polymarket CLOB orderbooks.

Known endpoints/specs:
- Gamma API OpenAPI: `https://docs.polymarket.com/api-reference/gamma-openapi.json`
  - base: `https://gamma-api.polymarket.com`
- Data API OpenAPI: `https://docs.polymarket.com/api-reference/data-api-openapi.yaml`
  - base: `https://data-api.polymarket.com`
- CLOB OpenAPI: `https://docs.polymarket.com/api-reference/clob-subset-openapi.yaml`
  - base: `https://clob.polymarket.com`
  - orderbook: `GET /book?token_id=...`

To complete:
- [ ] Which Gamma/Data endpoint accepts `conditionId` and returns token identifiers?
- [ ] Confirm whether token_id corresponds to “YES” or “NO” via returned metadata (outcome name).

