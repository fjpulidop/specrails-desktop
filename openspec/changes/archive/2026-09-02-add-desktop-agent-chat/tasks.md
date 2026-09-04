# Tasks — Desktop Agent Chat

## 1. App-level backend (`AgentChatManager`)
- [x] 1.1 Extract/confirm the shared spawn→stream→settle core is reusable from `spawn-lifecycle.ts` for an app-level (non-project) caller.
- [x] 1.2 `server/agent-cwd-manager.ts` — materialize `~/.specrails/agent-cwd/` (operator `CLAUDE.md`/instructions, no project symlink) with cleanup.
- [x] 1.3 `server/agent-mcp-config.ts` — write the `--mcp-config` file pointing at the bundled `specrails-mcp` bridge; resolve the bundled path (desktop) / dev path.
- [x] 1.4 `server/agent-chat-manager.ts` — spawn (multi-provider via `getAdapter`), stream over `agent.*` WS events, operator system prompt (byte-stable for caching), per-conversation state.
- [x] 1.5 `desktop-db.ts` — `agent_conversations` + `agent_messages` tables (migration); CRUD incl. `pinned_project_id`, `provider`, `model`, `tier_level`.
- [x] 1.6 `server/agent-chat-router.ts` — `/api/agent/*`: conversations CRUD, send, set-provider, set-tier, set-project, approvals; gated by `SPECRAILS_AGENT_CHAT`.
- [x] 1.7 Wire into `index.ts`: construct `AgentChatManager`, mount router, graceful shutdown.

## 2. Tier ladder + approvals (server)
- [x] 2.1 Map the cumulative ladder (Observe/Edit/Operate/Autonomous) onto the MCP four-tier model; pure resolver module + tests.
- [x] 2.2 Enforce the conversation `tier_level` before tool dispatch; machine-readable "needs level N" refusal.
- [x] 2.3 Keep the in-app level independent of Settings▸MCP external checkboxes (verified by test).
- [ ] 2.4 Option-C approval gating: classify actions (reversible / cost / destructive); per-session suppression state.

## 3. Part A — MCP availability to projects
- [x] 3.1 Surgical merge of `mcpServers.specrails` into `<workspace>/.mcp.json` on setup (reuse plugin mutex/atomic pattern).
- [x] 3.2 Entry runs the bundled bridge; assert no token inlined; bridge reads `~/.specrails/mcp.token`.
- [x] 3.3 Idempotency + preserve existing (plugin) entries; tests.

## 4. Client shell
- [x] 4.1 `AgentChatContext` provider at App root (inside `DesktopProvider`); summon/minimize state; `Cmd/Ctrl+K` handler (guarded vs dialogs).
- [x] 4.2 Top-bar Bot trigger; `AgentChatPanel` (movable+resizable via `useMovableResizableModal`, non-modal, generous default size + presets + persistence).
- [ ] 4.3 `MinimizedChatsContext` — add `'agent'` chip kind + dock rendering.
- [x] 4.4 `useAgentChat` hook + message rendering reusing `useSmoothStream`; `AgentToolCard` (live `◉` via `specrails_watch`), `AgentApprovalChip`.
- [x] 4.5 Degraded mode: "Enable Specrails MCP" banner when `mcp_enabled` is false (calls `/api/mcp-admin`).

## 5. Project selector + tier chip (client)
- [x] 5.1 `AgentProjectSelector` — Cursor-style dropdown (search, Recents, list, footer actions); default = open project, override to `Home`; decoupled from dashboard.
- [x] 5.2 `Home` app-global behavior + "ask to create/search-all" when ambiguous.
- [ ] 5.3 "Search across all projects" fan-out affordance (v1: agent iterates).
- [x] 5.4 `AgentTierChip` — `Shift+Tab` cycling, level-fill animation, lock message on refusal.

## 5A. Conversational context palette (captured exploration)
- [x] 5A.1 Composer tokenization for immediate `@`, `#`, and `/` triggers, with shared floating palette positioning and close behavior.
- [x] 5A.2 `@` reference source: conversation-created objects, current/pinned project scope, specs, projects, jobs, recents, and global search fallback.
- [x] 5A.3 `#` trace source: direct IDs, jobs/runs/errors/checks/changes, state filters such as failed/running/recent, scoped before global.
- [x] 5A.4 `/` action source: create/update/launch/compare/summarize/save/open/generate actions that consume existing chips and respect tiers/approvals.
- [x] 5A.5 Context-aware action ranking by chip/current scope (empty, project, spec, job/run, PR delivery, file) with domain-language labels.
- [x] 5A.6 Composer `+` button that opens the same palette visually (Reference / Trace / Action / Attachment / Browser capture).
- [x] 5A.7 Structured chip model (`type`, `id`, `label`, `scope`, metadata freshness) and agent-turn payload wiring.
- [x] 5A.8 Inline composer chips plus inline conversation chips, with removable/pinnable chips and hover/click previews.
- [x] 5A.9 Keyboard and pointer polish: Up/Down, Enter, Tab, Esc, Backspace chip deletion, mouse selection, and visual `+` flow.
- [x] 5A.10 Ambiguous/no-result states: inline disambiguation, search-all, create-new, ask-agent, and archived-results affordances.
- [x] 5A.11 Tests for contextual ranking, chip serialization, keyboard selection, scoped `Home` vs project behavior, `+` menu routing, and no-result actions.

## 6. Motion + visual
- [x] 6.1 Add `motion` dependency (client); confirm React-19 compatibility + bundle impact.
- [x] 6.2 Implement signature animations (summon, minimize-morph, tool-card stagger, tier-fill, dropdown spring); transform/opacity only, `will-change` lifecycle.
- [x] 6.3 `prefers-reduced-motion` collapse path; WebKit blur ≤20px single-layer; rAF-throttled drag/resize.
- [x] 6.4 Theme-token compliance (no hardcoded colors); tier accent reacts to level.

## 7. i18n
- [x] 7.1 New `agent` namespace (EN source): tier names, dropdown, approvals, errors, empty states.
- [x] 7.2 Translate to the other 7 locales; locale-parity test green.

## 8. Tests + gates
- [x] 8.1 Server unit tests: tier resolver, approval gating, project-scope resolution, mcp-config writer, workspace `.mcp.json` merge.
- [x] 8.2 Client tests: tier-chip cycling, selector Home/ambiguous logic, approval flow, degraded banner, reduced-motion.
- [x] 8.3 `npm run typecheck` + `npm test` + server/client coverage ≥ thresholds.
- [x] 8.4 `openspec validate add-desktop-agent-chat --strict` passes.

## 9. Follow-ups (out of v1 scope — documented, not built)
- [ ] 9.1 Native cross-project search MCP capability (replaces the fan-out).
- [ ] 9.2 Optional "follow the agent" toggle (dashboard view tracks the agent's pinned project).
- [ ] 9.3 Detached Tauri window mode (multi-monitor).
- [ ] 9.4 Per-conversation spend cap / hard recursion ceiling.
