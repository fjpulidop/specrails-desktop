## 1. Remove Batch (server)

- [x] 1.1 Drop `factory:batch` from `FACTORY_LOOPS`, alias it to Implement, map `batch-implement`/`batch` modes to Implement, remove the Batch core-factory graph
- [x] 1.2 Remove `batch` from the listed command catalog; keep `{{cmd:batch}}` as a hidden implement alias; delete the Codex implement→batch-implement rewrite
- [x] 1.3 Convert legacy Batch steps to a single aggregate implementation node
- [x] 1.4 Normalize `batch-implement`/`batch` in the rails router (launch, `PUT /tickets`) and validate `PUT /tickets` mode; legacy QueueManager path always uses implement
- [x] 1.5 Append project migration 70 rewriting stored Batch rails; add a migration test
- [x] 1.6 Stop requiring `batch-implement` in Core compatibility; keep older Cores compatible
- [x] 1.7 CLI: remove `batch-implement` from known verbs/help; map it to `implement`
- [x] 1.8 MCP enum/descriptions, MCP guide, operator prompt (3-specs-per-rail guidance moved to implement), worktree overlay text
- [x] 1.9 Delete the stale `server/command-grid-logic.test.ts` (its CommandGrid source was removed in #695)

## 2. Remove Batch (client)

- [x] 2.1 Remove Batch from the rail loop picker, `RailMode`, loops API types and ProfileEditor
- [x] 2.2 Normalize persisted rails (`batch-implement` mode, `factory:batch` loop) and wire modes on load
- [x] 2.3 Fold `batch`/`batch-implement` into `implement` in the byte-identical rail launch parser pair
- [x] 2.4 Remove `railControls.batch` and `loops.factory_batch` in 8 locales; fix settings/agentstudio/setup copy

## 3. Project Builder

- [x] 3.1 One spec per rail, mode `implement`, rails named `M<n> · #<id>`
- [x] 3.2 Dependency order via `prerequisites` / `execution_order`
- [x] 3.3 Sequential only: remove Parallel path, kill switch and client toggle; accept `mode: 'parallel'` as sequential
- [x] 3.4 Auto-continue ON by default (server and client)
- [x] 3.5 Reuse free builder rails; `rail_limit_reached` pause/refusal with localized copy
- [x] 3.6 Update builder copy in 8 locales and `docs/internals/project-builder.md`

## 4. Docs and verification

- [x] 4.1 Delete `docs/guide/<locale>/pipeline/3-batch-implement-and-multi-feature.md` and fix links/mentions
- [x] 4.2 Update docs/*.md and docs/internals references
- [x] 4.3 Tests for aliases, normalization, migration, ordering, rail reuse and rail limit
