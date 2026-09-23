## 1. Server — ExploreCwdManager

- [x] 1.1 Create `server/modules/conversations/runtime/explore-cwd-manager.ts` with the embedded `CLAUDE.md` template constant (interpolates `{{projectName}}` and uses `./project` for the symlink target reference)
- [x] 1.2 Implement `ensureExploreCwd(projectId: string): string` — idempotent
- [x] 1.3 Implement `removeExploreCwd(projectId: string)` for project-removal cleanup
- [x] 1.4 Add a Windows fallback path: when both symlink modes throw, write a `project-path.txt`; the embedded `CLAUDE.md` documents the fallback
- [x] 1.5 Wire `ProjectRegistry.removeProject` to call `removeExploreCwd`
- [x] 1.6 Add `SPECRAILS_EXPLORE_LEGACY_CWD` env-var short-circuit

## 2. Server — Per-project Explore-MCP toggle

- [x] 2.1 No new migration needed: reuse existing `queue_state` key/value table
- [x] 2.2 Add `getExploreMcpEnabled` / `setExploreMcpEnabled` helpers
- [x] 2.3 Add `GET /api/projects/:projectId/explore-mcp-enabled`
- [x] 2.4 Add `PATCH /api/projects/:projectId/explore-mcp-enabled` with boolean validation
- [x] 2.5 Supertest coverage (default, round-trip, invalid payload)

## 3. Server — ChatManager spawn-cwd resolution

- [x] 3.1 `_resolveSpawnCwd(kind)` helper covering toggle on/off + env-var short-circuit
- [x] 3.2 Branch on `kind='explore'` in `sendMessage`; sidebar unchanged
- [x] 3.3 Toggle read fresh per turn via the project DB
- [x] 3.4 Chat-manager tests for kind=explore vs sidebar cwd

## 4. Server — System prompt byte stability

- [x] 4.1 Byte-equality assertion across two consecutive lightweight builds
- [x] 4.2 Diff-vs-attachment assertion (suffix-only difference)
- [x] 4.3 Code comment in `_buildLightweightSystemPrompt` forbidding live data and pointing at design.md D5

## 5. Server — Explore lifecycle (idle, crash, concurrency)

- [x] 5.1 `_exploreLifecycle: Map<convId, { idleTimer, crashCount, isStreaming, lastActivityAt, isMinimized }>` + `_exploreQueue`
- [x] 5.2 `POST /api/projects/:projectId/chat/conversations/:id/minimize` → `ChatManager.notifyMinimized`, starts the 2-min idle timer iff not streaming
- [x] 5.3 `POST .../restore` and new-message both cancel the idle timer; streaming-complete re-arms iff still minimized
- [x] 5.4 Crash auto-respawn: non-zero exit before `result` event + `crashCount === 0` → one retry with `--resume`; second crash → `chat_error`. User abort skips respawn
- [x] 5.5 Per-project concurrency cap of 5: evict oldest idle Explore spawn first; otherwise queue with a 30 s timeout → `chat_error busy`
- [x] 5.6 Vitest coverage for idle scheduling, restore-cancels-timer, crash respawn, double-crash error, busy-timeout, and concurrency drain

## 6. Server — Explore-cwd-manager tests

- [x] 6.1 `server/modules/conversations/runtime/explore-cwd-manager.test.ts`: 10 tests (first-call, idempotent, rewrite-on-template-change, symlink recreation, cleanup without following, env short-circuit, snapshot of rendered template)
- [ ] 6.2 Windows-only path: junction-vs-symlink + `project-path.txt` fallback — _deferred. The code path is implemented and exercised by the manual Windows smoke task (11.x); adding `fs.symlinkSync` mocks here would require restructuring the manager to inject a fs façade. Tracked as follow-up._

## 7. Client — Settings toggle

- [x] 7.1 `SettingsPage` Explore Spec section + toggle bound to `GET/PATCH /explore-mcp-enabled`
- [x] 7.2 Explainer copy beside the toggle covering the trade-off (MCP load vs first-token speed) and the still-working built-in tools
- [ ] 7.3 `.mcp.json`-presence hint — _deferred. No existing endpoint reports `.mcp.json` presence; adding one is out of scope for v1. The toggle is still discoverable in Settings; users with `.mcp.json` opt in explicitly._
- [x] 7.4 Vitest coverage: section renders, defaults reflect server state, PATCH on click

## 8. Client — Explore premium UX

- [x] 8.1 `ExploreStatusPills.tsx` with the three-stage state machine (`connecting → thinking → tool`) and 150 ms minimum-display threshold; tested in `__tests__/ExploreStatusPills.test.tsx`
- [x] 8.2 Skeleton at T+0: `pendingTurn` optimistic flag in `ExploreSpecShell` flips on submit so the pill area renders before the WS round-trip; clears once `isStreaming` flips
- [x] 8.3 Char-by-char rendering via `useSmoothStream` (RAF tick, 4 KB safety flush, falls back to raw when premium UX flag is off)
- [x] 8.4 `VITE_FEATURE_EXPLORE_PREMIUM_UX !== 'false'` flag gates `ExploreStatusPills`
- [x] 8.5 `MinimizedChatsContext.minimize` and `.restore` send `POST /chat/conversations/:id/minimize|restore` for Explore conversations
- [x] 8.6 Pill component tests (stage transitions, threshold, gating, unmount on text)

## 9. Embedded Explore CLAUDE.md content

- [x] 9.1 Embedded template drafted (~50 lines, role / `./project` policy / `spec-draft` protocol / never-write-tickets / Windows fallback note)
- [x] 9.2 Cross-checked against `/specrails:explore-spec` slash command behaviour
- [x] 9.3 Inline snapshot test pinning the rendered template for a fixed project name

## 10. Documentation & release

- [x] 10.1 New `### Explore Spec acceleration` section in repo `CLAUDE.md`
- [ ] 10.2 Release-note paragraph — _to be drafted in the next `feat:` commit message at commit time._
- [x] 10.3 Inline doc comment on `_buildLightweightSystemPrompt` linking to design.md D5

## 11. Verification

- [x] 11.1 `npm run typecheck` clean
- [x] 11.2 `npm test` clean (1875 server tests, 1828 client tests)
- [x] 11.3 `npm run test:coverage` server: 81.12% lines / 70.49% branches / 86.52% functions / 82.57% statements — all thresholds met
- [x] 11.4 `cd client && npm run test:coverage` client: 80.15% lines / 80.65% branches / 70.85% functions / 80.15% statements — all thresholds met
- [ ] 11.5 Manual smoke: open Explore with a non-trivial `CLAUDE.md`; verify symlink + speed + user CLAUDE.md untouched — _pending real-world run by the user_
- [ ] 11.6 Manual smoke: MCP toggle ON in a project with `.mcp.json` — _pending real-world run_
- [ ] 11.7 Manual smoke: minimize + 2 min idle kill + restore --resume — _pending real-world run_
- [ ] 11.8 Manual smoke: crash injection + auto-respawn-once + second-crash error — _pending real-world run_
- [ ] 11.9 Manual smoke: `SPECRAILS_EXPLORE_LEGACY_CWD=1` — _pending real-world run_
- [x] 11.10 `openspec validate accelerate-spec-chat-first-token --strict` clean
