## Why

Specs that emerge from Explore or Quick generation often cover too much scope to execute as a single ticket — they implicitly bundle multiple subtasks that an engineer (or the implement pipeline) would benefit from tackling sequentially. Today the only options are to commit the spec as-is (the pipeline runs it monolithically) or to manually copy-paste it into smaller tickets (tedious, lossy, breaks Contract Layer alignment). SPECs SMASH gives the user a one-click "explode this spec into ordered subtasks" action that turns a single ticket into a parent **épica** plus N executable children, with the AI doing the partition based on the Contract Layer the user already approved.

## What Changes

- **SMASH action in `TicketDetailModal`** — visible only when the ticket is committed (`status !== 'draft'`) AND its description contains a `## Contract Layer` block. Disabled with tooltip otherwise.
- **One-click auto-split with inline confirm** — clicking the button shows an inline confirmation (no separate modal); confirming spawns a hub-orchestrated `claude` turn that returns a strict JSON list of child tickets (3–8 children, hard cap 8).
- **Original ticket becomes an épica** — gains `is_epic = 1`. Stays in its current column. Renders a `💥 N hijos` badge. Description (with Contract Layer) is preserved verbatim.
- **Children persisted with new schema fields** — `parent_epic_id` (FK to the épica), `execution_order` (1..N within the épica). Children inherit nothing automatically beyond the priority the SMASH agent assigns; they have **no Contract Layer** at birth (user can run `Refresh contract` per child if desired).
- **Depth-1 only** — a child cannot itself be SMASHed (button hidden when `parent_epic_id IS NOT NULL`). An épica without children can be re-SMASHed; with children, re-SMASH requires confirmation that current children will be deleted.
- **Children render flat in the board** — same Backlog list, ordered by `execution_order`. Each child card shows a clickable `↑ Épica: <title>` pill. The épica card shows a `💥 N hijos` badge. No new columns, no new filters, no collapse/expand groups on the board.
- **Modal renders hierarchy** — the épica's `TicketDetailModal` gains a `Hijos (N)` section listing children inline (clickable to navigate); each child's modal shows a breadcrumb `← <epic title>` and a "Parte de épica · paso K de N" card.
- **Premium streaming UX** — status pills (`Analizando spec… → Identificando subtareas… → Ordenando ejecución…`) above the button during the spawn, mirroring the Explore Spec pills pattern. Result surfaces as a glass-card sonner toast with a 10-second **Deshacer** action that deletes all children and clears `is_epic` atomically.
- **`ai_invocations.surface = 'smash'`** — every SMASH spawn (success, failure, retry) records a row, with `ticket_id` set to the épica's id and `conversation_id = null`. The new surface chip is added to the Analytics filter set and timeline colour map.
- **Hub-side prompt, no specrails-core coupling** — the SMASH agent is invoked as a fresh `claude` spawn with an inline system prompt (`buildSmashSystemPrompt()`, `SMASH_PROMPT_VERSION = 1`, byte-stable for prompt caching). No slash command, no `--resume`, no project-level config, no specrails-core release coordination.
- **Cascade on épica delete** — children are orphaned, not deleted: `parent_epic_id` is set to `NULL` (application-level `ON DELETE SET NULL`), mirroring the `origin_conversation_id` pattern.
- **Kill switch** — `SPECRAILS_SMASH=0|false|off` (case-insensitive) hub-wide disables the endpoint and hides the button. Mirrors `SPECRAILS_EXPLORE_CONTRACT_REFINE`.
- **Retry endpoint** — `POST /api/projects/:projectId/tickets/:id/smash` is the same endpoint for first-time fire and retry; idempotency is at the UX layer (button hidden when streaming), not the schema layer.

## Capabilities

### New Capabilities
- `specs-smash`: AI-driven decomposition of a committed ticket into an épica + ordered child tickets, including the SMASH agent contract (input/output), the épica/child schema (`is_epic`, `parent_epic_id`, `execution_order`), the streaming spawn lifecycle, the deshacer/retry surface, and the AnalyticsPage integration via `ai_invocations.surface = 'smash'`.

### Modified Capabilities

None. The SpecsBoard, TicketDetailModal, and AnalyticsPage existing capabilities are not modified at the **requirement** level — they gain new render branches gated on `is_epic` / `parent_epic_id`, but their existing requirements remain unchanged. Those visual additions are owned by the new `specs-smash` capability.

## Impact

- **Server**:
  - `server/modules/specs/runtime/ticket-store.ts` — extend `Ticket` type with `is_epic: boolean`, `parent_epic_id: string | null`, `execution_order: number | null`. Bump `schema_version` from `'1.1'` to `'1.2'`; old stores keep loading (defaults applied on read).
  - New `server/modules/specs/runtime/smash-runner.ts` — orchestrates spawn, parses output, executes transactional insert (épica flip + N children) inside a single store mutex.
  - New `server/modules/conversations/runtime/explore-smash.ts` (pure) — `SMASH_PROMPT_VERSION`, `buildSmashSystemPrompt()`, `SmashChildSchema` (ajv), `parseSmashOutput()`, `validateSmashChildren()`.
  - `server/project-router.ts` — new `POST /tickets/:id/smash` endpoint, `POST /tickets/:id/smash/undo` endpoint, `DELETE /tickets/:id` cascade (orphan children).
  - `server/modules/accounting/runtime/ai-invocations.ts` — accept `surface='smash'`; no other changes.
  - WebSocket events — new `smash.started`, `smash.progress` (pill state), `smash.completed`, `smash.failed`, all project-scoped.
- **Client**:
  - `client/src/features/specs/components/TicketDetailModal.tsx` — SMASH button in actions row, inline confirm, streaming pills, hijos section render, breadcrumb for children, Re-SMASH variant.
  - `client/src/features/specs/components/SpecCard.tsx`, `TicketListView`, `TicketGridView`, `TicketPostItView`, `TicketStatusIndicator` — render `💥 N hijos` badge on épicas and `↑ Épica: X` pill on children; new variant alongside the existing draft variant.
  - New `client/src/features/specs/context/SmashTrackerContext.tsx` — mounted at `App.tsx` root (sibling of `ContractRefineTrackerProvider`); listens to SMASH WS events, drives sonner toasts with Deshacer action.
  - `client/src/features/analytics/pages/AnalyticsPage.tsx` + `client/src/components/analytics/*` — add `smash` surface chip, colour mapping `accent-highlight`, exporter columns.
- **Storage & migrations**: new ticket-store schema version `1.2` (backwards-compatible read). No new SQLite migration — tickets live in JSON store today.
- **Env / config**: new `SPECRAILS_SMASH` server env var (default ON); no client build flag (the feature is in-app, no early-stage toggle).
- **Tests**: server unit tests for the pure parser/validator + runner integration; client component tests for the modal action and the tracker provider; analytics tests for the new surface chip.
- **Out of scope (deferred)**:
  - Depth > 1 (sub-épicas).
  - Per-child Contract Refine at SMASH time (children are born without contracts; user re-runs Contract Refine manually).
  - Confirmation-with-preview-before-commit (auto-create stands; Deshacer covers regret).
  - Re-SMASH with non-empty children carrying their dependencies (user deletes children first, or accepts deletion in the Re-SMASH confirm).
  - Quick-spec-time SMASH (`POST /tickets/generate-spec` returning N children at once).
  - SpecCard right-click "SMASH" affordance — for now SMASH lives only in the modal.
