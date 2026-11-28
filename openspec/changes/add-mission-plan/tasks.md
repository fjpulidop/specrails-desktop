## 1. Server

- [x] 1.1 Plan model, normalization, TodoWrite reader, in-place update vs new plan, latest plan read (with tests)
- [x] 1.2 Publish from TodoWrite in Core session turns and native turns
- [x] 1.3 `GET /api/agent/conversations/:id/plan`
- [x] 1.4 MCP: v1 `specrails_missions(plan)` for in-app agents (own mission, read tier), alias to v2 `get` field `plan`; v2 `get` field `plan`
- [x] 1.5 Intent persona: keep the plan with one of the two

## 2. Client

- [x] 2.1 `MissionPlanPill` (progress ring, steps with state, current step) beside Processes; plan rows silent in the transcript; 8 locales

## 3. Verification

- [x] 3.1 Suites, typecheck, audits
- [x] 3.2 Live in the dev app: an Intent turn with a plan shows the pill and its progress
