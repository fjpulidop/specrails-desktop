## 1. Server

- [x] 1.1 Project settings: `reviewWipLimit` (domain validation 1–100 or null, SQLite `config.review_wip_limit`, HTTP via the existing PATCH)
- [x] 1.2 Delivery domain `review-wip.ts` (`listPendingReview`, `countPendingReview`, `launchAddsReviewWip`, `evaluateReviewWip`, 409 body); SQLite snapshot adapter; per-project gate with reservations; core rules and manifest
- [x] 1.3 Registry binds `ProjectContext.reviewWipGate`; rails launch/relaunch gate after the budget gate; `GET /rails` exposes `reviewWip`
- [x] 1.4 MCP `launch_all` `review-wip-limit` skip and tool description; mobile relays the 409; operator prompt rule

## 2. Client

- [x] 2.1 `lib/review-wip.ts` (mirror count, 409 parsing, copy, settings event, `useReviewWipLimit`)
- [x] 2.2 Board badge + pending list; Play disabled with tooltip; Launch all capacity and dialog notice; per-launch 409 handling
- [x] 2.3 Settings section (page + dialog) suggesting 5; mission launch card and Relaunch copy; locales ×8

## 3. Verification

- [x] 3.1 Server tests: count over every decision, children, exemptions, gate reservations and fail-open, settings validation/persistence/HTTP, every launch door (rails route, relaunch, revision, MCP launch/launch_all, mobile relay), operator prompt
- [x] 3.2 Client tests: mirror lib, badge/tooltip/Launch all (dashboard), settings section, mission launch card, locale parity
- [x] 3.3 Typecheck, architecture audit, source map and docs (configuration, safe PR flow, API reference, user docs)
