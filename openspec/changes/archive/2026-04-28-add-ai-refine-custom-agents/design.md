## Context

Custom agents live as `.claude/agents/custom-*.md` per project. The hub already manages them through `server/modules/agents/runtime/profiles-router.ts` (CRUD), `server/modules/agents/runtime/agent-generator.ts` (one-shot generation), and `client/src/components/agents/{AgentsCatalogTab,AgentStudio}.tsx` (list + edit).

The codebase already implements an iterative AI editing pattern in two places:

1. **Tickets** — capability `ai-edit-diff-review`, with the Idle/Composing/Reviewing state machine and word-level diff in `TicketDetailModal`.
2. **Feature proposals** — `server/modules/specs/runtime/proposal-manager.ts` + `client/src/components/FeatureProposalModal.tsx` + `client/src/hooks/useProposal.ts`. Spawns `claude` with `--resume <sessionId>` so multi-turn refinements stay cheap and context-aware. Streams via WebSocket (`proposal_stream`, `proposal_ready`, `proposal_refined`).

This change ports the proven proposal-style architecture to custom agents and combines it with the diff-review UX from tickets, then adds three premium polishes: full-screen overlay, staged status pills, and optional auto-test.

## Goals / Non-Goals

**Goals:**

- Premium, accessible, multi-turn AI editing for existing custom agents.
- Reuse the existing apply path (`PATCH /catalog/:agentId`) so versioning, validation, and broadcasts are unchanged.
- Reuse the proven session-resume pattern from `ProposalManager` rather than inventing a new one.
- Reuse the diff-review state machine from `ai-edit-diff-review` (Idle/Composing/Reviewing) so the mental model is consistent across the hub.
- Side-by-side full-screen overlay UX with token streaming, staged status pills, diff with color-blind-safe glyphs, and full keyboard control.
- Optional auto-test toggle (default ON, "Smart" mode) integrated with `POST /catalog/test`.

**Non-Goals:**

- No changes to `specrails-core` (no new slash command, no SDK/CLI flag changes).
- No multi-agent batch refinement (one agent at a time).
- No automated rename of the agent (`name`/`id`/filename remain locked; rename stays an explicit Studio action).
- No replacement of `agent-generator.ts` (one-shot generation from description remains for the "create new" path).
- No support for refining `upstream` (non-`custom-*`) agents — refine is custom-only, mirroring the existing edit/delete restriction.
- No persistent multi-developer collaboration on a refine session (single user per session).

## Decisions

### D1. Inline system prompt in the hub (no specrails-core slash command)

Confirmed during exploration. `agent-refine-manager.ts` constructs the prompt locally with: current agent body, frontmatter rules, naming constraints, and the project's resolved profile chain.

- **Why**: keeps the change hub-local; ships faster; custom agents are a hub-core feature.
- **Alternative considered**: add `/specrails:refine-agent` to specrails-core (rejected — couples release cadence and breaks the v1 "no core changes" goal).

### D2. New `agent-refine-manager.ts`, mirror `proposal-manager.ts`

A new manager module sibling to `ProposalManager`, identical in shape:

- `startRefine({ agentId, instruction })` → spawns `claude` with stream-json, persists `session_id`.
- `sendTurn({ refineId, instruction })` → spawns with `--resume <sessionId>`.
- `cancel({ refineId })` → kills active spawn.
- Streams stream-json deltas to WS as `agent_refine_stream`; emits `agent_refine_phase` for staged pills; final body in `agent_refine_ready`.

- **Why**: the proposal pattern is battle-tested. Copy-and-adapt is faster and lower risk than abstracting.
- **Alternative considered**: extracting a shared `SessionRefineManager` base class. Rejected for v1 — premature abstraction, two consumers is not enough signal.

### D3. New table `agent_refine_sessions` in per-project `jobs.sqlite`

```
agent_refine_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,         -- e.g. "custom-foo"
  session_id TEXT,                -- claude --resume id, NULL until first turn returns
  base_version INTEGER NOT NULL,  -- agent_versions.version at start; used for stale detection
  base_body_hash TEXT NOT NULL,   -- sha256 of disk body at start; used for mtime/concurrent-edit check
  draft_body TEXT,                -- latest streamed full body
  status TEXT NOT NULL,           -- 'idle'|'streaming'|'ready'|'applied'|'cancelled'|'error'
  auto_test INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_refine_sessions_agent ON agent_refine_sessions(agent_id, status);
```

- **Why**: gives explicit lifecycle, supports cancel/resume, supports retention prune, and decouples from `agent_versions` (which is committed history; this is in-flight drafts).
- **Alternative considered**: a `draft=1` flag on `agent_versions`. Rejected — pollutes the version history and breaks the invariant that every `agent_versions` row corresponds to a saved file on disk.

### D4. Apply path = existing `PATCH /catalog/:agentId` with mtime guard

The refine overlay does NOT introduce a new write path. Apply calls a thin wrapper `POST /catalog/:agentId/refine/:refineId/apply` that:

1. Re-reads the file on disk and checks `sha256 === base_body_hash`. If different → return 409 with `{ reason: "disk_changed" }`.
2. Calls the existing `updateCustomAgent()` logic (same one used by `PATCH /catalog/:agentId`) with `draft_body`.
3. Marks `agent_refine_sessions.status='applied'` and broadcasts the standard catalog change WS event.

- **Why**: zero divergence in validation/version-bump logic. One write path = one set of bugs.

### D5. Locked frontmatter fields on apply

Server validates that `name`/`id` (the `custom-<slug>` token) is unchanged between `base_body_hash` content and `draft_body`. If the model rewrote the name, apply rejects with `{ reason: "name_changed" }`.

- **Why**: rename has cross-cutting effects (filename, version history, reference from profiles). Out of scope for v1.

### D6. Full-screen overlay, not a small modal

Single component `AiRefineOverlay`, launched from `AgentsCatalogTab` via the new "AI Edit" button. Modal-on-modal banned: if Studio is open, AI Edit on the same agent reuses the same surface (closes Studio, opens overlay).

```
┌─ AI Edit · custom-foo ─────────────────────  Esc ─┐
│ ┌─────────────────┬─────────────────────────────┐ │
│ │ Conversation    │ Diff (word-level)           │ │
│ │ + status pills  │ +/− glyphs, j/k navigable   │ │
│ │ + auto-test ✓   │                             │ │
│ │ + input ⌘⏎      │                             │ │
│ └─────────────────┴─────────────────────────────┘ │
│  [Discard]    [Open in Studio]    [Apply ⌘⏎]    │
└──────────────────────────────────────────────────┘
```

- **Why**: focused workspace, premium feel, big enough canvas for diff. Aligns with how serious editing tools (VS Code merge, GitHub PR review) feel.

### D7. Staged status pills driven by stream-json tool events

Map `claude` stream-json `tool_use` blocks to phases:

| Phase | Trigger |
|-------|---------|
| `reading` | start of session, first turn before first `text` block |
| `drafting` | first non-empty `text` delta arrives |
| `validating` | server-side post-stream YAML/frontmatter check |
| `testing` | only if auto-test enabled and `ready` |
| `done` | `agent_refine_ready` |

- **Why**: layered feedback (token stream + named phase) makes long thinks feel intentional, not stuck.

### D8. Auto-test = Smart mode

Run `testCustomAgent()` only when:

1. `auto_test=1` for the session, AND
2. `draft_body` differs from previous test's body, AND
3. `>5s` since last test for this session.

Test result piped back into the chat as a structured turn (`role: 'system', kind: 'test_result'`).

- **Why**: keeps the "auto" promise without burning latency or doubling spend on every micro-edit.

### D9. Sample task for auto-test

Reuse the most-recent row in `agent_tests` for `agent_id`. If none, fall back to a built-in placeholder per agent kind (architect/dev/reviewer/other). Pinning a "default test" is a future enhancement; not in v1.

### D10. WebSocket message namespace

```
agent_refine_stream    { projectId, refineId, deltaText }
agent_refine_phase     { projectId, refineId, phase }
agent_refine_ready     { projectId, refineId, draftBody }
agent_refine_test      { projectId, refineId, result }
agent_refine_error     { projectId, refineId, message }
agent_refine_cancelled { projectId, refineId }
```

Client filters by `projectId` (active) AND `refineId` (current overlay).

### D11. Retention

A startup task in `ProjectRegistry` prunes `agent_refine_sessions` rows where `status IN ('cancelled','error') AND updated_at < now - 24h`, plus `status='draft' AND updated_at < now - 24h`. Applied/ready sessions are kept indefinitely (small footprint, debugging value).

### D12. Accessibility

- All controls reachable by keyboard. Focus trap inside overlay, focus restored to triggering card on close.
- `aria-live="polite"` on chat region; `aria-busy` on diff during streaming.
- Color-blind safe diff: `+`/`−` glyphs in addition to red/green; configurable via `prefers-color-scheme` & `prefers-contrast`.
- `prefers-reduced-motion` disables shimmer/fade.
- All buttons have visible focus rings (Tailwind `focus-visible:ring-2`).

## Risks / Trade-offs

- **[Concurrent disk edit]** User edits the file in another editor while overlay is open. → Mitigation: `base_body_hash` check on apply; on mismatch, surface "File changed on disk" with options Reopen / Force-apply / Discard.
- **[Frontmatter break]** AI emits invalid YAML or rewrites locked fields. → Mitigation: server-side validate on apply; D5 locks `name`. Validation phase pill surfaces failure inline before the user can click Apply.
- **[Auto-test latency / cost]** Running `claude` twice per turn doubles spend. → Mitigation: D8 Smart mode debounce; toggle visible and persistent per agent.
- **[Big agents]** Diff renderer slow >500 lines. → Mitigation: virtualized diff list (react-window or similar) above the threshold; v1 acceptance: diff renders smoothly up to 500 lines, soft warning above.
- **[Abandoned sessions accumulate]** → Mitigation: D11 retention prune at startup.
- **[Stream interrupted by network blip]** WS reconnect mid-stream loses tail. → Mitigation: server keeps full `draft_body` in DB on every flush; reconnecting client re-fetches via `GET .../refine/:refineId` and resumes diff from current state.
- **[Permission to spawn claude]** Refine spawns `claude --dangerously-skip-permissions` like `agent-generator.ts` already does. → Mitigation: same posture, no new attack surface, but document explicitly in the spec.

## Migration Plan

- New tables and routes are additive. No data migration.
- Feature gate via `SPECRAILS_AGENTS_SECTION !== 'false'` (already gates `profiles-router`); no new env var.
- Rollback: revert PR; the `agent_refine_sessions` table is left in place (harmless empty); existing AgentStudio + Generate flows are unchanged.

## Open Questions

- Should the chat support attaching arbitrary text (e.g., paste a sample agent the user likes) as extra context? (Defer; out of v1.)
- Should we show estimated cost per turn (token meter) in the corner? (Defer; opt-in setting in a future change.)
- Should "Open in Studio" persist the in-flight session on Studio side too, so the user can return to refine? (v1: yes — Studio shows a "Resume AI Edit" pill if a non-applied session exists for the open agent.)
