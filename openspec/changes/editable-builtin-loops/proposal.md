## Why
Built-in loops (Implement, Freestyle, SDD Quick) were code-only, read-only entries. Changing how a built-in behaves meant "Fork to edit", which created a separate loop that rails, agent-chat launch cards, MCP and the companion never used. The owner decided that built-ins must be real, editable loops by default: editing one changes the built-in everywhere it is used, and a Restore original action resets it.

## What Changes
- Desktop migration 31 adds `builtin_id` (unique when set), `builtin_default_hash` and `published_graph` to the app-global `loops` table, and backfills `published_graph` for published loops.
- A seeding coordinator creates one Published row per built-in whose id is the canonical factory id (`factory:implement`, `factory:freestyle` when a provider supports Freestyle, `factory:sdd-quick-openspec`). It refreshes unedited rows when the Core-dependent default changes and never overwrites user edits. `factory:batch` and the retired aliases are not seeded.
- Every `factory:*` launch resolves the built-in row: an edited Published row runs its graph, an edited Draft runs its last Published snapshot, and an unedited or missing row runs the code default. Edited graphs pass validation and engine-support checks.
- Built-ins are edited through the normal builder and `PUT`/publish flow, including while a run uses them. They cannot be deleted or unpublished (`409 builtin_loop`). `POST /api/loops/:id/restore-builtin` resets one. `POST /api/loops/factory/:id/fork` becomes an alias of duplicate, and `GET /api/loops/factory` reports the effective built-ins.
- The Loops page lists built-ins as editable cards (Edit, Duplicate, Restore original; no Delete or Fork). The builder explains the in-place semantics and offers Restore original. The rail picker never lists a built-in twice. MCP `specrails_loops` gains `restore_builtin`.
- Fixes: agent-chat loop references read the real `factoryLoops` response, and the dashboard adopts real (UUID) user loop ids from server-side loop runs.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `factory-loops`: built-ins become editable, seeded rows with restore.
- `loops-library`: built-in rows cannot be deleted; running built-ins stay editable; publication snapshots.
- `rail-loop-execution`: factory-id launches resolve the edited built-in.

## Impact
Desktop DB (migration 31), loops module (`builtin-loops.ts`, store, router), rails launch route, MCP loops tool and operator guidance, Loops page, builder, rail picker, agent-chat loop preview, dashboard rail adoption, i18n in 8 locales, and the user guide. Factory ids, the factory-to-mode mapping, bare-`mode` launches and the companion contract are unchanged.
