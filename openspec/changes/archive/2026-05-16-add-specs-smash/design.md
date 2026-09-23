## Context

The hub already has two AI orchestration patterns that SMASH should mirror almost line-for-line:

1. **Contract Refine** (`server/modules/specs/runtime/contract-refine-runner.ts` + `server/modules/conversations/runtime/explore-contract-refine.ts`) — a fresh post-commit `claude` spawn whose only job is to produce a structured JSON addendum that mutates a single ticket. Byte-stable system prompt for cache hits, 1-turn budget, no `--resume` for the Quick variant, kill-switch env var, retry endpoint, sonner toast tracker on the client (`ContractRefineTrackerProvider`).
2. **Status pills** (`client/src/features/specs/components/explore-spec/ExploreStatusPills.tsx`) — three-stage label fader gated by a `VITE_FEATURE_*` flag with 150 ms minimum dwell, fed by WS progress events.

SMASH reuses both patterns and adds one new shape: instead of patching a single ticket, the runner does a transactional insert of N children plus a flip of the parent into épica state, inside the existing `mutateStore()` advisory-locked read-modify-write cycle in `server/modules/specs/runtime/ticket-store.ts` (JSON store, `schema_version` bump to `'1.2'`, backwards-compatible read).

The board (`SpecCard`, `TicketListView`, `TicketGridView`, `TicketPostItView`, `TicketStatusIndicator`) already supports a "variant" rendering pattern from the draft work — épica and child variants slot into that same dispatch.

## Goals / Non-Goals

**Goals:**
- One-click decomposition of a committed ticket with Contract Layer into an épica plus 3–8 ordered children.
- Premium, in-context UX: inline confirm, streaming pills, success toast with 10 s Deshacer, no full-screen modal stealing.
- Atomicity: épica flip and child inserts succeed together or not at all (single `mutateStore` callback).
- Hub-owned: no specrails-core changes, no project filesystem mutations, no slash command, no `.claude/commands/` write.
- Coherent visual language: épicas and children use the existing semantic theme tokens (`accent-highlight` for SMASH affordances, `accent-secondary` for the "↑ Épica" pill on children), staggered card-entrance animation reused from the existing Backlog flow.
- Analytics parity: SMASH spawns appear in `ai_invocations` with `surface='smash'`, surfaced in `AnalyticsPage` filters/timeline/exporter.

**Non-Goals:**
- Children inherit Contract Layer or get one auto-generated. Out of scope; user re-runs Refresh Contract per child manually.
- Depth > 1 (sub-épicas). Out of scope.
- Surfaces other than `TicketDetailModal` (no SpecCard menu, no keyboard shortcut). Out of scope.
- SMASH for draft tickets or tickets without Contract Layer. Gated; not designed for.
- Hijos visual grouping on the board (collapse/expand groups, indented rows). Out of scope — flat render with pill only.
- Quick-spec-time SMASH (`POST /tickets/generate-spec` returning N at once). Out of scope.
- Real-time per-pill state machine driven by the agent (e.g. tool-use events). The three pills are timed locally (Frame 3 in the proposal) and dismissed on first text delta — same approach as `ExploreStatusPills`.

## Decisions

### 1. Spawn shape: inline prompt, fresh spawn, no `--resume`

`claude` is spawned via `spawnAiCli` (same wrapper as `contract-refine-runner.ts`) with:

```
args = [
  '-p', `<title>\n\n<description>`,           // user prompt: the spec to split
  '--system-prompt', buildSmashSystemPrompt(),
  '--max-turns', '1',
  '--output-format', 'stream-json',
  '--disallowedTools', 'Read,Grep,Glob,Bash',
  '--model', <ticket's source conversation model or 'sonnet' fallback>
]
cwd = hub-managed dir (no .mcp.json, no project CLAUDE.md auto-load)
```

The hub-managed cwd is the same explore-cwd directory the Explore Spec acceleration already materialises (`server/modules/conversations/runtime/explore-cwd-manager.ts`) when `contextScope.mcp === false` — we reuse `ensureExploreCwd(slug)` and never touch the project tree.

**Why no `--resume`:** SMASH must work for both Explore-origin tickets (where a `session_id` exists) and Quick-origin tickets (no session). A unified fresh-spawn path means one runner, one prompt version, one cache key, and zero conditional branches. The full ticket description (including Contract Layer) is the only context the agent needs — and it's already canonical, byte-stable input.

**Why inline `-p` over slash command:** the `/specrails:*` namespace logically belongs to specrails-core; injecting a hub-side slash command into that namespace creates a release-coupling we don't need. The system prompt fully encodes the contract, and `-p "<title>\n\n<description>"` keeps the prompt deterministic and cacheable.

**Alternatives considered:**
- *Pre-existing slash command in specrails-core* — rejected: forces hub/core release coordination, gates feature behind core version banner, leaks an internal-only orchestration command into the user-visible command list.
- *`--resume <session_id>` when Explore-origin* — rejected: bifurcates the runner, blocks the Quick-origin path, and the additional context (chat history) is not worth the cache invalidation cost. The Contract Layer is already a denser summary than the chat.

### 2. Agent contract: strict JSON with ajv validation

`server/modules/conversations/runtime/explore-smash.ts` is a pure module exporting:

```typescript
export const SMASH_PROMPT_VERSION = 1

export interface SmashChild {
  title: string                 // ≤ 80 chars
  description: string           // markdown, ≥ 1 line
  priority: 'critical' | 'high' | 'medium' | 'low'
  executionOrder: number        // 1-based, contiguous within result
  rationale: string             // ≤ 200 chars, why this child exists
}

export interface SmashOutput {
  smashVersion: 1
  children: SmashChild[]        // 3 ≤ length ≤ 8
}
```

The runner extracts the last `result` event from the stream-json output (same parser pattern as `contract-refine-runner.ts`), strips fences, parses, and validates against an inline `ajv` schema. Validation failures → `smash.failed` WS event with reason `'invalid-output'` and no mutation.

**Why 3–8 hard-cap range:** below 3 the agent should just refine the original ticket; above 8 the user loses cognitive grasp. Caps are enforced both in the prompt and at parse time (length out of range → reject). No user-facing slider — the agent picks the count within the band.

**Alternatives considered:**
- *Markdown output parsed via section regex* — rejected: brittle, identical pain we had pre-Contract Layer JSON.
- *User-configurable target count via modal slider* — rejected: adds friction at exactly the point where the user wanted "one click".

### 3. Schema: extend ticket-store JSON to v1.2, backwards-compatible read

Three new fields on `Ticket`:

```typescript
is_epic: boolean              // default false
parent_epic_id: number | null // default null
execution_order: number | null // null for non-children
```

`normalizeTicket()` in `server/modules/specs/runtime/ticket-store.ts` is extended with defaults so older stores load without rewrites. `CURRENT_SCHEMA_VERSION` bumps from `'1.1'` to `'1.2'`. First write under new code persists the new version.

**Why JSON store, not a new SQLite table:** tickets live in JSON today; introducing a relational table for parent/child relationships breaks the single-source-of-truth pattern. Application-level orphaning on parent delete mirrors the existing `origin_conversation_id` mechanic, which is well-understood in the codebase.

**Why `parent_epic_id` as `number` not `string`:** ticket ids are integers in the JSON store (`Ticket.id: number`). Strings would force casts everywhere.

### 4. Transactional flip + insert

The runner's mutation is a single `mutateStore(filePath, (store) => { ... })` call:

```typescript
mutateStore(filePath, (store) => {
  const epic = store.tickets[String(epicId)]
  if (!epic || epic.is_epic) throw new Error(...)  // re-SMASH path is separate
  epic.is_epic = true
  for (const child of validated.children) {
    const id = store.next_id++
    store.tickets[String(id)] = buildChildTicket(id, epicId, child)
  }
})
```

`writeStore` already bumps revision and timestamps atomically; advisory file lock prevents concurrent writers. A second WS broadcast happens **after** the lock releases, ensuring observers see a consistent store.

**Failure handling:**
- Agent spawn error or invalid output → no mutation, `smash.failed` emitted, `ai_invocations` row recorded with `status='failed'`.
- Mutation throws mid-callback → store unchanged (lock releases without `writeStore` call), `smash.failed` emitted with reason `'mutation-failed'`.

### 5. Re-SMASH: only when no children remain

Re-SMASH is the same endpoint (`POST /tickets/:id/smash`); the server checks "does this épica currently have children with `parent_epic_id === id`?" and returns `409 has-children` if so. The client's Re-SMASH button shows a confirm "This will delete the 4 existing children" — confirming triggers a `DELETE /tickets/:id/children` (new sub-endpoint) then re-fires the SMASH POST.

**Why split into delete-then-smash instead of a "force" flag:** the deletion is a separate user-visible event that should fire its own WS broadcasts (`ticket_deleted` × N) so all open boards stay in sync, and we want the deletion to be auditable independently of the new SMASH run.

### 6. Deshacer (Undo): explicit endpoint, 10-second window

`POST /tickets/:id/smash/undo` reverses the most recent SMASH on this épica:

```typescript
mutateStore(filePath, (store) => {
  const epic = store.tickets[String(epicId)]
  if (!epic.is_epic) return  // already undone or never SMASHed
  // Delete every child whose parent_epic_id matches AND was created after epic.updated_at
  // (epic.updated_at was set by the original SMASH mutation)
  for (const [id, t] of Object.entries(store.tickets)) {
    if (t.parent_epic_id === epicId && t.created_at >= smashAt) {
      delete store.tickets[id]
    }
  }
  epic.is_epic = false
})
```

The 10-second window is enforced by sonner toast lifetime, not by the server. The endpoint itself accepts undo at any time, but the toast is the only surface that triggers it.

**Why explicit endpoint over storing a transaction log:** simpler, no new persistence shape, and "undo from outside the toast" is not a goal — the toast is the only entry point in v1.

### 7. WebSocket protocol

Five new `projectId`-scoped messages:

```
smash.started      { projectId, ticketId, runId }
smash.progress     { projectId, ticketId, runId, stage: 'analyzing'|'identifying'|'ordering' }
smash.completed    { projectId, ticketId, runId, childrenIds: number[] }
smash.failed       { projectId, ticketId, runId, reason: string }
smash.undone       { projectId, ticketId, runId, childrenIds: number[] }
```

The existing `ticket_updated` (épica flip) and `ticket_created` (per child) broadcasts also fire from the mutation, so consumers without SMASH-specific handlers still receive the underlying state changes.

**Why a `runId`:** the client tracker correlates a sequence of started/progress/completed events for the same SMASH invocation, even if two SMASHes overlap on different tickets within the same project.

### 8. Client tracker & toast

`client/src/features/specs/context/SmashTrackerContext.tsx` mounts at `App.tsx` root (sibling of `ContractRefineTrackerProvider`):

```typescript
useWsHandler('smash.started', ({ ticketId, runId }) => {
  setInflight(prev => ({ ...prev, [runId]: { ticketId, stage: 'analyzing' } }))
})
useWsHandler('smash.progress', ({ runId, stage }) => { ... })
useWsHandler('smash.completed', ({ ticketId, runId, childrenIds }) => {
  toast.success(`✨ Spec dividida en ${childrenIds.length} tickets`, {
    duration: 10_000,
    action: {
      label: 'Deshacer',
      onClick: () => fetch(`${apiBase}/tickets/${ticketId}/smash/undo`, { method: 'POST' })
    }
  })
})
useWsHandler('smash.failed', ({ ticketId, runId, reason }) => {
  toast.error('SMASH no pudo completarse', {
    description: reason === 'invalid-output' ? 'El agente devolvió output inválido' : reason,
    action: { label: 'Reintentar', onClick: () => fetch(.../smash, { method: 'POST' }) }
  })
})
```

The pills inside `TicketDetailModal` read from the same `inflight` map via `useSmashInflight(ticketId)`. Pills have a 150 ms minimum-display floor to prevent flicker on fast turns.

### 9. Analytics integration

`ai_invocations.surface = 'smash'` rows are written exactly like `contract-refine` writes them — `ticket_id` = épica id, `conversation_id` = null, `started_at` / `finished_at` / `duration_ms` / token fields populated from the stream-json `result` event.

`AnalyticsPage` changes:
- Surface filter chip: `smash`, colour `accent-highlight` (same family as `explore-spec`).
- `byMode` aggregator unchanged (smash is its own surface, doesn't fold into Quick vs Explore).
- `bySurface` and `dailyTimeline` automatically pick it up.
- CSV/JSON exporter columns unchanged (already row-shaped by surface).

### 10. Kill switch

`SPECRAILS_SMASH` env var, parsed identically to `SPECRAILS_EXPLORE_CONTRACT_REFINE` (case-insensitive `'0' | 'false' | 'off'` disable). When disabled:
- `POST /tickets/:id/smash` returns `409 disabled`.
- `GET /projects/:projectId/config` includes `featureFlags.smash: false` so the client hides the button entirely (no greyed-out tease).

## Risks / Trade-offs

- **[Agent over-partitions trivial specs]** → Mitigation: prompt explicitly instructs "if the spec is small enough to be a single ticket, return exactly 3 children that correspond to the natural beginning/middle/end of the spec." Caps prevent both under- and over-shooting. If telemetry shows over-partition is common, we add a `target` hint to the endpoint (no UI), not a slider.
- **[User accidentally SMASHes and misses the 10 s Deshacer]** → Mitigation: the inline confirm (Frame 2) before the spawn is the primary guard; Deshacer is the secondary. The épica state is also fully reversible by manually deleting children + editing the épica back to a normal ticket — no data loss is permanent.
- **[Concurrent SMASH on the same ticket from two tabs]** → Mitigation: the advisory file lock in `mutateStore` serialises the writes; the second runner sees `is_epic === true` and returns `409 already-epic`. Client button is disabled while `inflight[runId].ticketId === ticketId`.
- **[Children created during SMASH conflict with manually-added tickets between Deshacer firing]** → Mitigation: the Deshacer endpoint matches on `parent_epic_id === epicId AND created_at >= epic.updated_at_at_smash_time`. A manual ticket created after the SMASH but before Deshacer won't have a matching `parent_epic_id`, so it survives.
- **[Stream-json output parsing edge cases]** → Mitigation: reuse the exact `extractResultEvent` + fence-strip + ajv pipeline from `explore-contract-refine.ts`. Unit tests cover the negative paths (truncated stream, multiple result events, missing `usage`).
- **[Schema v1.2 forward-compat]** → Mitigation: old hub binaries reading a v1.2 store ignore the new fields (JSON read is permissive). Downgrade is safe: épicas just stop rendering as épicas, children stop showing the pill, but no data is lost.
- **[Visual confusion: child cards in Backlog mixed with their épica]** → Mitigation: `execution_order` plus a tie-breaker on `parent_epic_id` keeps children grouped under their épica in the natural sort. The `↑ Épica:` pill provides the linking affordance. If this isn't enough in practice, the modal-side hierarchy view is a complete escape hatch.
- **[`stream-json` parsing increases coupling to Claude CLI output shape]** → Mitigation: already coupled via Contract Refine; the failure mode (parse error → `smash.failed`, no mutation) is identical and well-tested. Adding SMASH does not increase the coupling surface.

## Migration Plan

No migration required.

- `ticket-store` v1.1 → v1.2 is backwards-compatible read (normalise on load, bump on write). Existing JSON stores keep working untouched until a SMASH actually runs against the project.
- No SQLite migration. The `ai_invocations` table already has a `surface` TEXT column; `'smash'` is just a new value.
- No project-side files written. No `.claude/`, `.mcp.json`, or `.specrails/` mutations.
- Rollback: set `SPECRAILS_SMASH=0` and redeploy; existing épicas continue to render correctly (the field reads are pure data), but new SMASHes are blocked. To fully revert visually, set `is_epic = false` and clear `parent_epic_id` on affected tickets — but épicas and orphan children are safe to leave in place; the system handles them gracefully.

## Open Questions

- **Per-épica audit metadata (deferred):** should we persist `smashed_at` and `smashed_by_run_id` on the épica for future "View SMASH history" UI? For v1, `updated_at` is sufficient and we defer the explicit fields.
- **Concurrency cap (deferred):** Explore Spec has a 5-concurrent cap per project. SMASH spawns are 1-turn and short-lived (≤ 30 s typical); we don't add a cap in v1, but if telemetry shows abuse we can reuse the Explore eviction pattern.
- **Cross-épica reordering UI (deferred):** the user can drag a child between épicas today (it would just lose `parent_epic_id` semantics); we don't ship an explicit "move to other épica" affordance.
