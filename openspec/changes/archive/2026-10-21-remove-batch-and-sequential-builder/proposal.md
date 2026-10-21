## Why

The Batch rail mode (`factory:batch`, rail mode `batch-implement`, command
`{{cmd:batch}}`, Core command `batch-implement`) duplicates what `implement`
already does: `implement` runs every ticket on a rail in ONE aggregate run
(ticket scope `all`). Core removes its `batch-implement` template in the same
release, so Desktop must stop offering or invoking it. Users who want
parallelism use several rails, each isolated in its own worktree.

The Project Builder launched milestones in ≤3-spec Batch chunks, offered a
Parallel option and defaulted auto-continue OFF. The owner decided that a
milestone launches ONE spec per rail, in dependency order, sequentially, with
auto-continue ON by default.

## What Changes

- Remove Batch from every user- and agent-facing surface: factory loop list,
  command catalog, rail loop picker, `RailMode`, MCP enum/descriptions, operator
  prompt, CLI help, worktree overlay text, docs and the 8 locales.
- Keep backward-compatible aliases so nothing stored breaks:
  `factory:batch` → `factory:implement`; rail mode `batch-implement` / `batch` →
  `implement` at the HTTP boundary (launch body, `PUT /rails/:i/tickets`) and in
  the client (persisted rails, agent rail-launch cards); `{{cmd:batch}}` stays a
  hidden alias that expands exactly like `{{cmd:implement}}`; legacy graphs with a
  Batch step convert to one aggregate `implementation` node (no map/join);
  historical `batch-implement` text is still recognized in run records.
- **BREAKING (internal)**: the Codex rewrite of multi-ticket `implement` to
  `$batch-implement` is removed.
- Project migration 70: `UPDATE rails SET mode='implement' WHERE mode IN ('batch-implement','batch')`.
- `PUT /rails/:i/tickets` now validates `mode` (400 for unknown values).
- Core compatibility no longer requires a `batch-implement` workflow; Cores that
  still ship it stay compatible. The CLI maps `batch-implement` to `implement`.
- Project Builder: one spec per rail (`M<n> · #<id>`), mode `implement`,
  topological order over `prerequisites` (ties by `execution_order`, then id),
  always sequential (the Parallel option and `SPECRAILS_MILESTONE_CHAIN=false`
  kill switch are removed; a `mode: 'parallel'` request runs sequentially),
  auto-continue ON by default, reuse of free builder rails before creating a
  new one, and a `rail_limit_reached` pause/refusal when every rail holds
  undecided work.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `factory-loops`: Batch factory loop and catalog command removed; aliases kept.
- `rail-loop-execution`: routing and derived mode no longer include Batch.
- `rail-loop-mode`: the rail modes are `implement`, `freestyle`, `loop`.
- `loop-execution`: watchdog scenario refers to the Implement factory loop.
- `loop-step-idle-watchdog`: watchdog scenario refers to the Implement factory loop.
- `milestone-launch-chain`: one spec per rail, dependency order, sequential only,
  auto-continue default on, rail reuse and `rail_limit_reached`; kill switch removed.
- `milestone-lifecycle`: Launch Milestone 1 CTA uses the new chain.

## Impact

- Server: `server/modules/loops/runtime/*` (factory, core factory, catalog,
  compat), `server/modules/delivery/runtime/rails-router.ts`,
  `rail-launch-parser.ts`, `server/db/migrations.ts`, `server/core-compat.ts`,
  `server/modules/builder/runtime/milestone-chain.ts`, `server/project-registry.ts`,
  `server/project-router.ts`, MCP rails tool/guide, operator prompt,
  `server/worktree-overlay.ts`, `cli/args.ts`, `cli/help.ts`.
- Client: rails loop picker/helpers, `DashboardPage`, `RailControls`,
  `rail-launch-draft.ts`, `ProfileEditor`, builder launch surfaces, locales.
- Docs: guide page `pipeline/3-batch-implement-and-multi-feature.md` deleted in
  all 8 locales; links and mentions updated.
- Paired change: specrails-core removes the `batch-implement` template.
