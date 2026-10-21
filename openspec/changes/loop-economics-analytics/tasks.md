## 1. Aggregation

- [x] 1.1 `accounting/runtime/loop-economics.ts`: pure `isDelivered`, `summarizeInvocationCost`, `countLoopRounds`, `aggregateLoopEconomics`
- [x] 1.2 Effectful `getLoopEconomics` (deliveries, attributed invocations, loop_step events, regression links, known loops) and `listRecentDeliveries`
- [x] 1.3 Boundary manifest + accounting README

## 2. Escaped defects

- [x] 2.1 `metadata.regressionOf` type + `normalizeRegressionOfMetadata` validation in ticket-store (no schema bump)
- [x] 2.2 Validate on ticket POST/PATCH; `null` clears
- [x] 2.3 Client `RegressionOfPicker` in create and detail modals for bug-labelled tickets

## 3. Exposure

- [x] 3.1 `GET /analytics/loop-economics` and `/analytics/loop-economics/deliveries`
- [x] 3.2 MCP `specrails_analytics(loop_economics)` + guide
- [x] 3.3 Client `LoopEconomicsCard` on the Analytics page; 8 locales

## 4. Verification and docs

- [x] 4.1 Tests: mixed cost, rounds, regressionOf counting, empty states, API/MCP shape, ticket validation, client render with/without data
- [x] 4.2 Docs: tracking-cost, api-reference, MCP guide, accounting README, source map
