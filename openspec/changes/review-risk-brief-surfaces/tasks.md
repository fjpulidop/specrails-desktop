## 1. Server
- [x] 1.1 `review-brief.ts`: tolerant normalizer, record parser, reviewer-output reader, risk summary, unit merge (+ tests)
- [x] 1.2 Settle harvest of `reviewBrief` gated on `reviewBrief: 1`; heal for older rows (+ tests: with, without, partial, malformed, definition, confidence-score, capability absent)
- [x] 1.3 Packet `whatToLookAt` + `riskSummary` (+ tests: full, partial, none, diagnostic)
- [x] 1.4 PR body block under the summary; cost footer unchanged (+ tests with/without)
- [x] 1.5 `riskSummary` on snapshots, `rail.pr_state` and the mission card envelope (+ test)

## 2. Client
- [x] 2.1 Packet "What to look at" section first, fixed order, diagnostic note, hidden without brief (+ tests)
- [x] 2.2 `TopRiskLine` on the mission card and the dashboard strip; wire coercion (+ tests)
- [x] 2.3 `packet.brief.*` copy in all 8 locales (locale parity test)

## 3. Docs and verification
- [x] 3.1 `review-packet.md`, `safe-pr-review-flow.md`, delivery README, in-app guide (8 locales)
- [x] 3.2 Typecheck, delivery/module tests, client delivery/missions tests, architecture audit, source map
