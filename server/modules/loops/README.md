# loops

## Legacy retirement observations

`runtime/legacy-launch-telemetry.ts` is a focused public SQLite adapter consumed
by Loop Manager, Queue Manager and isolated delivery. Migration 66 records
admission to legacy graph traversal, slash-command process launch and merge-back.
Run-scoped observations are idempotent; timestamps are normalized to UTC.
`GET /api/projects/:projectId/analytics/legacy-launches?since=<ISO timestamp>`
returns per-kind counts and the latest observation. Invalid windows return 400;
unavailable storage returns 503 rather than a fabricated zero. These are local
observations, not proof that two published releases have zero legacy usage.
Project Analytics displays these all-time counters with explicit refresh. Raw
Codex `$skill` commands are counted alongside slash commands at spawn admission.

This module owns the loops capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/builtin-loops.ts](runtime/builtin-loops.ts)
- [runtime/loop-command-catalog.ts](runtime/loop-command-catalog.ts)
- [runtime/loop-constants.ts](runtime/loop-constants.ts)
- [runtime/loop-definition-recovery.ts](runtime/loop-definition-recovery.ts)
- [runtime/loop-effect.ts](runtime/loop-effect.ts)
- [runtime/loop-executors.ts](runtime/loop-executors.ts)
- [runtime/loop-factory.ts](runtime/loop-factory.ts)
- [runtime/loop-graph.ts](runtime/loop-graph.ts)
- [runtime/loop-role-engines.ts](runtime/loop-role-engines.ts)
- [runtime/loop-run-manager.ts](runtime/loop-run-manager.ts)
- [runtime/loop-runs-store.ts](runtime/loop-runs-store.ts)
- [runtime/loops-router.ts](runtime/loops-router.ts)
- [runtime/loops-store.ts](runtime/loops-store.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/loops` and any affected consumers.

Quick SDD owns delivery changes and addenda. It seeds a distinct delta target,
briefs each AI phase, and requires per-addendum coverage before validation/archive.
The retired `factory:revision` id is a compatibility alias, absent from the gallery.

When the selected Core advertises both `engineV2: 1` and `workflowDefinitions: 1`,
the same factory IDs resolve through `loop-core-factory.ts` to editable Core
definitions. Implement uses the native implementation subgraph; Batch maps frozen
tickets to isolated implementations and verifies the whole candidate after join.
Quick SDD and Freestyle prompts explicitly pause on `LOOP_BLOCKED` questions;
resume forwards the answer without replaying completed phases.
Quick SDD uses two native skill prompts plus real validation, archive and host
verification before and after archive. Freestyle alternates verified edits with
an evidence-based decision and preserves the no-progress bound. Every successful
factory exit requires verified delivery. Empty configured checks cannot fabricate
a verification receipt. Older retained Core packages receive the legacy graphs.

Legacy Quick SDD also implements full specs without addenda or a PR. Its normal path is
prepare → strict preflight → apply/tests → strict validation → archive (two AI
phases). `failureRecovery` allows one in-run phase retry or an artifact-only repair
followed by revalidation; it never resets run budgets or changes the frozen target.
See [scope, recovery and metrics](../../../docs/internals/spec-addenda.md#quick-sdd-scope-and-efficiency).

## Editable built-in loops

Desktop migration 31 adds `builtin_id`, `builtin_default_hash` and
`published_graph` to `loops`. `runtime/builtin-loops.ts` (effectful coordinator)
seeds one Published row per built-in whose id IS the canonical factory id
(`factory:implement`, `factory:freestyle` when a provider supports Freestyle,
`factory:sdd-quick-openspec`). `factory:batch` and the retired aliases are never
seeded. Seeding runs when the desktop router registers the loops routes (startup)
and again on `GET /loops` and `GET /loops/factory`; it is idempotent
(`INSERT OR IGNORE` in an immediate transaction).

- A row is **unedited** while the hash of its name, description and graph equals
  `builtin_default_hash`. When Core capabilities are known and the default variant
  changed (Core upgraded or an older package retained), unedited rows are refreshed.
  User edits are never overwritten. If Core cannot be loaded, missing rows get the
  legacy variant and existing rows stay as they are. A Freestyle row is kept when
  the capability disappears; launch then fails with the existing provider check.
- `publishLoop` writes `published_graph` for every loop, and migration 31
  backfills it for loops that are already published.
- `resolveBuiltinLoop` is used by every factory-id launch (`rails-router`) and by
  `GET /loops/factory`. An edited Published row runs its graph. An edited Draft
  runs its `published_graph`, so rails keep working during an edit. An unedited or
  missing row runs the current code default. Edited graphs pass graph validation
  and `assertEngineSupport` before any run or worktree is allocated.
- Built-ins are edited through the normal `PUT`/`publish` flow. `PUT` is allowed
  while a run uses a built-in: `LoopRunManager._run` clones the request graph and
  definition runs resume from their frozen request, so an edit cannot reach a live
  run. Other loops keep the running guard. `DELETE` and `unpublish` return
  `409 builtin_loop`. `POST /loops/:id/restore-builtin` resets a built-in to the
  current default and publishes it (409 while running). `POST
  /loops/factory/:id/fork` duplicates the built-in's current content.

## Core definition authoring

`loop-definition.ts` is a pure adapter from persisted visual graphs to Core JSON.
It resolves host tokens once, preserves component interfaces and derives a bounded
transition budget. `loops-router` obtains the authoritative piece and definition
schemas from the selected Core CLI and performs structural validation before
publication. Launch must bind and validate the actual project configuration again.
`loop-effect` conservatively isolates Core writes before role bindings are known.
The builder never mixes Core pieces with legacy Desktop execution nodes.

The client schema forms, outcome handles and component navigation consume this
catalog. Saved legacy graphs continue to use their existing editor and execution
path. See the [authoring protocol](../../../openspec/changes/core-agent-engine/desktop-authoring-protocol.md)
for publication identity and nested-budget decisions.

Catalog version 3 adds `assign`, a non-AI scoped variable update. Its inspector
offers typed JSON values and signed integer counter adjustments. Core validates
variable names and commits the entire update atomically; invalid counters cannot
partially apply companion assignments. Publication rejects this piece when the
selected Core catalog does not support it. Assignments inside mapped components
remain local to that component scope.

## Definition recovery ownership

`loop-definition-recovery.ts` probes the retained Core CLI using frozen host inputs with four subprocesses at most, a 15-second timeout per run and bounded output. Startup waits for these observations before orphan reconciliation and worktree recovery. If the frozen mounts are unavailable, read-only inspection uses the owned retained
journal via `status --run-dir`; redirected journals are rejected. It preserves
Core's actual terminal/pause state and reports `runtime_scope_unavailable` with
resume disabled. Execution still requires the original validated host scope.
An unavailable probe is not evidence that implementation failed. Completed Core work remains pending Desktop settlement, and restart-paused v2 deliveries retain their building state and worktrees.

The manager acquires a durable per-project execution claim before asynchronous admission. Claims fence overlapping checkout paths across distinct runs and forks, canonicalize existing symlinks and are released on errors and terminal completion. A human pause releases the claim; continuation reacquires it. Startup clears pre-allocation/terminal dead claims, preserves live or uninspectable Core owners, and keeps the exact recoverable attempt IDs supplied by Core. The per-run Core lease and the host's cross-run worktree claim enforce different ownership boundaries.

After fork adoption, the parent is immutable history. Startup reconciles the
child's ownership and clears obsolete parent host claims without rewriting the
parent run or job. Live-run lists, edit guards and repository references exclude
adopted parents; historical run listing continues to include them.

Definition resume admission is synchronous through `beginDefinitionResume`;
the returned promise represents execution completion, so HTTP can acknowledge
admission without waiting for a human question. `resumeDefinition` retains the
promise-rejection contract for existing callers. `loop-definition-controls.ts`
validates pending question/approval IDs and exact recoverable attempt IDs from
the retained Core journal. Resuming clears the restart marker so a later
recovery request cannot release an active writer's claim.

`runtime/definition-cancellation.ts` coordinates cancellation acknowledgement
and terminal settlement through narrow observation/control/settlement/clock
ports. It waits for Core's lease, reissues the same idempotent request when an
expired writer leaves unfinished work, and defers to startup recovery on shutdown.
Project HTTP composition owns observer deduplication and durable diagnostics.

## Original graph preservation

Desktop database migration 30 adds an original-graph snapshot. On the first save
from legacy execution nodes to Core pieces, `updateLoop` preserves the exact
stored JSON and its timestamp in the same immediate transaction as the edit.
The result is Draft; later edits and conversion retries cannot overwrite the
original. New Core definitions and incomplete drafts have no invented backup.

`GET /api/loops/:id/legacy-graph` exposes an existing backup without modifying or
publishing the loop. The library offers **Export original graph** only when a
backup exists. Importing that export creates a separate draft under the existing
import rules. This protection does not automatically migrate saved graphs or
permit removal of the legacy engine before the measured rollout gate.

Publication freezes the content that Core validated. The final immediate
transaction refuses a changed name, description, graph or publication state
with `409 loop_changed`; the newer edit remains Draft. Second-resolution edit
timestamps are not used as a concurrency token.

## Reviewable legacy conversion

`POST /api/loops/:id/convert` runs the pure `runtime/loop-compat.ts` projection,
then the existing compiler and Core structural validator (catalog version 5 or
newer). The optional `repositoryId` supplies an explicit scope for unbound legacy
shell nodes. Running loops and concurrent content changes return conflicts.
Successful conversion saves a Draft and its immutable original in one transaction;
retrying that conversion returns the same saved draft. Publication stays explicit.

The projection uses ordinary Core assignments and conditions to preserve sticky
failed-pass state, iteration/step bounds and single-use repair allowances. Decider
provider choices are frozen through the bridge's declared-role binding port.
Native batch work uses ticket maps; canonical OpenSpec validation/archive commands
use pinned pieces with exact archived-target support. Arbitrary shell commands
retain their selected repository and are not rewritten by substring matching.
All converted writers require host verification. The policy stops after two
consecutive failed AI attempts; successful AI attempts reset that counter.

## Migration assessment

`GET /api/loops/migration` ([loop-migration.ts](runtime/loop-migration.ts)) reports
every saved loop against the installed Core (catalog 5 or later, else 409):

- `current`: a Core definition that still validates;
- `invalid`: a Core definition, possibly published, that the installed Core no
  longer accepts. It stays published until someone fixes it;
- `convertible`: a legacy loop that converts and validates, so it can be converted
  explicitly with `POST /loops/:id/convert`;
- `needs_attention`: a legacy loop with conversion issues, for example a missing
  repository binding (the migration never infers one);
- `running`: an executing loop, which is not validated.

The assessment is read-only. It never converts, publishes, unpublishes or writes
backups; conversion keeps its atomic original-graph backup and returns the loop
to Draft for review.

## Engine availability

Core advertises the engines it can launch in `runtime api` (`engines`; Cores that
predate the field are read as `[1, 2]` with `engineV2`, else `[1]`). A Core
without engine 1 runs only definitions, so `LoopRunManager.assertEngineSupport`
refuses a fresh legacy traversal with `legacy_engine_unavailable` before anything
is persisted. The rails launch route answers 409 before allocating worktrees.
Resumes keep their retained package and are never re-checked. A missing Core does
not block legacy traversal.
