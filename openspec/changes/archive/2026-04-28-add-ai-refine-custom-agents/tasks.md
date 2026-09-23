## 1. Server: data layer

- [x] 1.1 Add `agent_refine_sessions` table migration to per-project `jobs.sqlite` (columns per design D3, plus index on `(agent_id, status)`)
- [x] 1.2 Add typed CRUD helpers in `server/db.ts` (or a new `server/modules/agents/runtime/agent-refine-db.ts`) for create/get/update/list/delete
- [x] 1.3 Add startup retention prune in `ProjectRegistry` per design D11 (delete cancelled/error >24h, mark stuck streaming as error and prune, retain ready/applied)
- [ ] 1.4 Add unit tests covering CRUD + prune semantics (in-memory SQLite per repo convention)

## 2. Server: refine manager

- [x] 2.1 Create `server/modules/agents/runtime/agent-refine-manager.ts` mirroring `proposal-manager.ts` shape (constructor, broadcast injection, single-active-spawn-per-session lock)
- [x] 2.2 Implement `startRefine({ projectId, agentId, instruction, autoTest })`: spawn `claude` with stream-json, capture `session_id`, persist row, stream deltas
- [x] 2.3 Implement `sendTurn({ refineId, instruction })`: spawn `claude --resume <sessionId>`, stream deltas, update `draft_body` on every flush
- [x] 2.4 Implement `cancel({ refineId })`: kill spawn, set `status='cancelled'`, broadcast `agent_refine_cancelled`
- [x] 2.5 Map stream-json events → phase pills (`reading` → `drafting` → `validating`) and emit `agent_refine_phase` WS events
- [x] 2.6 Build inline system prompt (per design D1): current body, frontmatter rules, `custom-` prefix lock, project profile chain context
- [x] 2.7 Server-side YAML/frontmatter validation phase before emitting `agent_refine_ready`; on failure emit `agent_refine_error` with details
- [x] 2.8 Smart-mode auto-test integration (per design D8): after `ready`, run `testCustomAgent` only if body changed and >5s since last test; emit `agent_refine_test`
- [ ] 2.9 Unit tests with mocked `spawnClaude` covering: first turn → session id captured; resume turn → uses `--resume`; cancel mid-stream; phase ordering; auto-test debounce
- [x] 2.10 Handle WS reconnect: maintain server-side state so `GET /refine/:refineId` returns full chat + `draft_body` + active phase

## 3. Server: REST surface

- [x] 3.1 Add routes under `/api/projects/:projectId/profiles/catalog/:agentId/refine` in `server/modules/agents/runtime/profiles-router.ts` (or split into `server/agent-refine-router.ts` if file gets large)
- [x] 3.2 `POST /refine` → start session (body: `{ instruction, autoTest? }`); returns `{ refineId }`
- [x] 3.3 `POST /refine/:refineId/turn` → send follow-up instruction
- [x] 3.4 `GET /refine/:refineId` → rehydrate (chat history, `draft_body`, phase, `auto_test`)
- [x] 3.5 `PATCH /refine/:refineId` → toggle `auto_test`
- [x] 3.6 `DELETE /refine/:refineId` → cancel
- [x] 3.7 `POST /refine/:refineId/apply` → mtime/hash guard + name lock + reuse `updateCustomAgent()` write logic; 409 with `{ reason: 'disk_changed' | 'name_changed' }` on guard failures
- [x] 3.8 Gate all routes on `SPECRAILS_AGENTS_SECTION !== 'false'` and reject non-`custom-` agents with HTTP 400 `{ reason: 'not_a_custom_agent' }`
- [ ] 3.9 Integration tests for happy path, resume, cancel, disk-changed 409, name-changed 409, feature-flag-off 404, upstream-agent 400

## 4. WebSocket protocol

- [x] 4.1 Define WS message types in shared types: `agent_refine_stream`, `agent_refine_phase`, `agent_refine_ready`, `agent_refine_test`, `agent_refine_error`, `agent_refine_cancelled` (all carrying `projectId` + `refineId`)
- [x] 4.2 Wire `boundBroadcast` injection so server emits with the correct `projectId`
- [ ] 4.3 Add a smoke test that emits each message and asserts client filter logic by `projectId`

## 5. Client: hook + state

- [x] 5.1 Create `client/src/features/agents/hooks/useAgentRefine.ts` mirroring `useProposal.ts` (useReducer + WS subscription)
- [x] 5.2 State machine: `composing | streaming | reviewing | applying | error | cancelled`, derived from `draftBody` + `phase` + `streaming`
- [x] 5.3 Conversation history (`ConversationTurn[]`) with assistant turn appended by `agent_refine_stream` deltas
- [x] 5.4 Expose actions: `start`, `sendTurn`, `cancel`, `apply`, `toggleAutoTest`, `openInStudio`
- [x] 5.5 Reconnect: on WS reconnect, call `GET /refine/:refineId` to rehydrate
- [ ] 5.6 Unit tests for reducer transitions and reconnect rehydration

## 6. Client: AI Refine overlay

- [x] 6.1 Create `client/src/features/agents/components/AiRefineOverlay.tsx` (full-screen overlay component)
- [x] 6.2 Layout: chat pane (left), diff pane (right), action bar (Discard, Open in Studio, Apply)
- [x] 6.3 Chat pane: token cursor on streaming, `aria-live="polite"`, status pills (reading/drafting/validating/testing/done) with active spinner per design D7
- [x] 6.4 Auto-test toggle (default ON), checkbox persisted to server via `PATCH /refine/:refineId`
- [x] 6.5 Word-level diff renderer (`old_body` vs `draft_body`) with `+`/`−` glyphs and color-blind-safe palette per design D12
- [ ] 6.6 Diff hunk navigation: J/K shortcuts, focused hunk highlighted
- [x] 6.7 Diff shimmer + fade transitions, gated by `prefers-reduced-motion` (skeleton uses `motion-safe:animate-pulse`)
- [ ] 6.8 Virtualized diff list above 500 lines (react-window or equivalent) — current renderer falls back to coarse line diff above 20k tokens; no virtualization yet
- [x] 6.9 Keyboard map per spec: ⌘⏎ submit/apply, Esc discard with confirm, ⌘K focus input (J/K diff hunks deferred to 6.6)
- [x] 6.10 Focus trap (hand-rolled: focus moves to input on open, restored to previous element on close — full Tab cycling trap deferred)
- [x] 6.11 Concurrent-disk-edit (409 `disk_changed`) UX: inline banner with Reopen / Force-apply / Discard
- [x] 6.12 Name-changed (409 `name_changed`) UX: inline error explaining rename is separate
- [x] 6.13 Empty state copy in Composing: "Tell me what to change. I'll show a diff before anything saves."
- [x] 6.14 Error state inline (not toast); reduce-motion respected via `motion-safe:` utilities

## 7. Client: catalog integration

- [x] 7.1 Add **AI Edit** button to `AgentsCatalogTab.tsx` action row (custom agents only)
- [x] 7.2 Wire button click → open `AiRefineOverlay` for the selected agent id
- [x] 7.3 Hide button when `kind !== 'custom'`
- [x] 7.4 Hide button when `SPECRAILS_AGENTS_SECTION` is disabled (server returns 404 for catalog under this flag, so the button is unreachable on those servers; client also won't have agents listed)

## 8. Client: AgentStudio handoff

- [x] 8.1 Add `draftFromRefine` prop support to `AgentStudio` (props-based, not query param — overlay/catalog passes it directly)
- [x] 8.2 When present, `GET /refine/:refineId` and seed editor with `draftBody` instead of disk body
- [x] 8.3 Render persistent **Resume AI Edit** pill in Studio header
- [x] 8.4 Pill click closes Studio and reopens `AiRefineOverlay` with same `refineId`
- [x] 8.5 Studio without param remains unchanged (existing tests still cover this branch)

## 9. UX polish

- [x] 9.1 Status pills: ✓ for completed phases, spinner for active, dashed circle for pending; consistent sizing
- [x] 9.2 Skeleton diff while first turn streams (no draft yet)
- [ ] 9.3 "Continuing from earlier draft" pill when reopening a session in `ready` state — covered partially by Resume AI Edit pill in Studio; overlay-level pill not yet added
- [x] 9.4 "File changed on disk" banner for 409 disk_changed
- [x] 9.5 Design-system tokens reused across overlay (Tailwind utility classes only; matches existing components)
- [x] 9.6 Focus rings visible on key buttons (`focus-visible:ring-2`)

## 10. Tests + verification

- [ ] 10.1 Server unit tests pass `npm test`
- [ ] 10.2 Client tests cover overlay state machine, diff renderer, keyboard shortcuts, focus trap
- [ ] 10.3 Integration test: full happy path (start → 2 turns → apply) hitting in-memory SQLite + mocked spawnClaude
- [ ] 10.4 Manual smoke: open dev server, refine `custom-foo` end-to-end on a sample project; verify version bump in `agent_versions`; verify Apply broadcast updates UI
- [ ] 10.5 a11y manual pass: VoiceOver / NVDA reads streaming text; keyboard-only flow start → apply works; reduce-motion verified
- [ ] 10.6 Coverage thresholds met (server 80% lines/functions/statements, 70% branches; global 70%)
- [x] 10.7 `npm run typecheck` clean (server + client both pass)
