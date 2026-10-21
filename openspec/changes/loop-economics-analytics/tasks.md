## 1. Aggregation

- [ ] 1.1 `accounting/runtime/loop-economics.ts`: pure `isDelivered`, `summarizeInvocationCost`, `countLoopRounds`, `aggregateLoopEconomics`
- [ ] 1.2 Effectful `getLoopEconomics` (deliveries, attributed invocations, loop_step events, regression links, known loops) and `listRecentDeliveries`
- [ ] 1.3 Boundary manifest + accounting README

## 2. Escaped defects

- [ ] 2.1 `metadata.regressionOf` type + `normalizeRegressionOfMetadata` validation in ticket-store (no schema bump)
- [ ] 2.2 Validate on ticket POST/PATCH; `null` clears
- [ ] 2.3 Client `RegressionOfPicker` in create and detail modals for bug-labelled tickets

## 3. Exposure

- [ ] 3.1 `GET /analytics/loop-economics` and `/analytics/loop-economics/deliveries`
- [ ] 3.2 MCP `specrails_analytics(loop_economics)` + guide
- [ ] 3.3 Client `LoopEconomicsCard` on the Analytics page; 8 locales

## 4. Verification and docs

- [ ] 4.1 Tests: mixed cost, rounds, regressionOf counting, empty states, API/MCP shape, ticket validation, client render with/without data
- [ ] 4.2 Docs: tracking-cost, api-reference, MCP guide, accounting README, source map
