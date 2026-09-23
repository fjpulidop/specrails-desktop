## Context

Today every Explore Spec chat turn re-pays the full cold-start cost on the model side:

```
spawn claude (cwd = <project.path>)
  ↓
1. claude CLI auto-loads <project.path>/CLAUDE.md     ← ~5–15K tokens in specrails-hub
2. claude CLI loads .claude/rules/*.md
3. claude CLI loads .mcp.json (handshake serena, etc.)
4. ChatManager system prompt = `_buildLightweightSystemPrompt()` (Explore uses this — no stats)
   OR `_buildSystemPrompt()` (sidebar — pulls getStats() + listJobs() with timestamps)
5. API processes everything fresh → first token (~1.5–3s)
```

Two compounding factors keep first-token latency bad turn after turn:

1. The project's `CLAUDE.md` is huge in this repo (and likely in any non-trivial project) and is auto-loaded by `claude` from the cwd on every spawn.
2. For sidebar chat the `_buildSystemPrompt()` injects live, timestamp-bearing job stats into the system prompt, which makes the system prompt non-deterministic across turns and **prevents Anthropic prompt caching from ever hitting**.

For Explore specifically, the lightweight prompt already avoids (2), but (1) dominates because `claude` auto-loads `CLAUDE.md` from `cwd`. Even if we cached the system prompt perfectly, we still pay for the project `CLAUDE.md` every turn.

The user explicitly chose: **accelerate Explore, leave Quick and sidebar alone for now**, **keep tools available for quality**, **accept losing project MCP servers in Explore by default with an opt-in toggle**, and **respawn-with-`--resume` instead of investigating true persistent stdin multi-turn**.

## Goals / Non-Goals

**Goals:**

- Cut Explore first-token latency on turn 1 by removing project `CLAUDE.md` auto-load from the spawn path.
- Cut Explore first-token latency on turns 2+ by stabilising the Explore system prompt so Anthropic prompt cache hits.
- Preserve full tool access in Explore (`Read`, `Grep`, `Glob`, etc.) so spec quality is not compromised — the project repo remains reachable via a `./project` symlink in the Explore cwd.
- Never modify, replace, move, or delete the user's `<project>/CLAUDE.md`.
- Give the user an explicit per-project escape hatch (`Use MCPs in Explore`) when they really do want `.mcp.json` loaded — default OFF.
- Make every Explore turn feel "electrizante" via instant skeleton, status-pill stages, and char-by-char streaming animation.
- Keep Explore lifecycle predictable: idle-kill on minimize-to-toast, single auto-respawn on crash, hard concurrency cap.
- Hold or improve current coverage thresholds (server 80% / client 80%).

**Non-Goals:**

- Quick-mode (`POST /tickets/generate-spec`) acceleration — separate change.
- Sidebar chat (`kind='sidebar'`) acceleration — separate change. The `_buildSystemPrompt()` cache-busting bug is intentionally left in place here.
- True persistent process via stdin multi-turn (e.g. `claude --input-format stream-json` keeping a single child alive across multiple `user` events). The user has explicitly asked us NOT to investigate this.
- Per-project user-customizable `explore-instructions.md` overrides — deferred until somebody actually asks.
- Changing `specrails-core` in any way.
- Changing the Explore overlay UX, draft pane, fenced `spec-draft` block protocol, save-as-draft, continue-explore, or commit endpoints. All existing `explore-spec` requirements remain valid.

## Decisions

### D1: Run Explore turns from a hub-managed cwd, not the project path

**Decision.** Every Explore turn (`kind='explore'` chat conversation) — including resumed and minimized-then-restored sessions — spawns `claude` with `cwd = ~/.specrails/projects/<slug>/explore-cwd/`. This directory contains:

```
~/.specrails/projects/<slug>/explore-cwd/
├── CLAUDE.md            ← embedded mini-prompt, hub-owned, ~30–60 lines
└── project              ← symlink (or junction on Windows) → <project.path>
```

When the project's MCP toggle is ON, Explore turns instead spawn with `cwd = <project.path>` (legacy behaviour) so `.mcp.json` is honoured.

**Why.** This is the single largest win for first-token latency: it removes project `CLAUDE.md` auto-load (the dominant input-token cost) without touching the user's repo, while keeping tools functional via the symlink.

**Alternatives considered.**
- *Spawn from `<project.path>` and somehow tell `claude` not to auto-load `CLAUDE.md`*: the CLI does not currently expose a `--no-project-instructions` flag. Even if it did, it would be a moving target.
- *Copy `CLAUDE.md` into `<project>/.specrails/explore/CLAUDE.md` and spawn from there*: contaminates the user's repo, requires gitignore handling, and risks shadowing semantics that surprise teams.
- *Embed project `CLAUDE.md` content into the system prompt instead*: defeats the purpose — same input tokens, just routed differently, and no longer cacheable per-project.

### D2: Hub-managed embedded `CLAUDE.md` template, no per-project override in v1

**Decision.** The Explore `CLAUDE.md` is a single embedded constant in `server/modules/conversations/runtime/explore-cwd-manager.ts`. On first-use per project (and on hub version bump), the file is materialised at `~/.specrails/projects/<slug>/explore-cwd/CLAUDE.md`. The constant is interpolated with `{{projectName}}` and `{{projectPath}}` so the prompt naturally references the user's repo via `./project`.

The template communicates, in ~30–60 lines:

1. The role: "interactive thinking partner helping shape a spec proposal."
2. The fenced ` ```spec-draft ` block protocol (referencing the existing explore-spec slash command behaviour).
3. The presence of the user's repo at `./project` and the rule "explore the repo only when the spec actually requires it; do not pre-emptively read files."
4. The rule never to write tickets directly — the hub commits.

**Why.** YAGNI on per-project customisation: nobody has asked. v1 ships single source of truth. If someone wants per-project overrides later, we add `<project>/.specrails/explore-instructions.md` as an opt-in concat (~30 LoC delta) with no break.

**Alternatives considered.** See proposal/design discussion summary in the change folder; the user explicitly chose Option A.

### D3: Symlink `./project → <project.path>` (junction on Windows)

**Decision.** During `ensureExploreCwd(projectId)` the manager creates a relative symlink `./project` pointing at the project's absolute path. On Windows `fs.symlinkSync(target, path, 'junction')` is used (no admin privilege required, no developer-mode dependency). On POSIX a regular symlink. If the symlink already exists pointing at a different target (e.g. project path moved), it is recreated.

**Why.** Tools (`Read`, `Grep`, `Glob`) work with familiar `./project/...` paths. No fork in the system prompt between OSes. No copying or watching.

**Risks.** Symlinks inside `cwd` mean `Glob("**/*")` could traverse into the project. We mitigate by instructing the model in the embedded `CLAUDE.md` to scope reads explicitly under `./project/...` only when the spec requires evidence — this is policy, not enforcement. If we need hard enforcement later, we can ban the symlink and require absolute paths via a system-prompt-injected `PROJECT_PATH`.

### D4: Per-project `explore_mcp_enabled` toggle — default OFF

**Decision.** Add a per-project setting `explore_mcp_enabled` (boolean, default `false`) stored in the per-project `jobs.sqlite` (new migration). New endpoints:

- `GET /api/projects/:projectId/explore-mcp-enabled` → `{ enabled: boolean }`
- `PATCH /api/projects/:projectId/explore-mcp-enabled` body `{ enabled: boolean }`

`ChatManager.sendMessage` resolves the cwd at spawn time:

```ts
const useMcps = projectSettings.exploreMcpEnabled ?? false
const cwd = useMcps
  ? this._cwd                                    // <project.path> (legacy)
  : exploreCwdManager.getCwd(this._projectId)   // ~/.specrails/.../explore-cwd
```

The setting is read fresh on every `sendMessage` call so toggling takes effect on the next turn (no process restart).

**Why.** Some projects rely on serena or other MCP servers in their flow; the toggle is the escape hatch. Defaulting OFF makes the acceleration the out-of-the-box behaviour.

**UI.** New Explore section in `client/src/features/settings/pages/SettingsPage.tsx` with a single toggle and a one-paragraph explainer about the trade-off (no MCP servers vs faster first-token, plus a note that tools still work).

### D5: Stable Explore system prompt — already lightweight, but harden

**Decision.** `ChatManager.sendMessage` for `provider='claude'` already calls `_buildLightweightSystemPrompt()` when `options.lightweight === true`, and Explore always passes `lightweight: true`. No live stats are injected today, so the prompt IS deterministic — except for two bytes that aren't but should be made so:

1. The project name is interpolated. Project name is stable so this is fine — keep.
2. The `USER_ATTACHMENT_SYSTEM_NOTE` is appended only when attachments exist on a turn. This is correct and intentional — different shape, different cache key. Acceptable.

We **explicitly forbid** any future addition of timestamps, job ids, or live aggregates to the lightweight builder. A unit test asserts the lightweight prompt is byte-stable across two consecutive invocations.

**Why.** This guarantees Anthropic's automatic prompt caching can hit on consecutive Explore turns within the 5-minute TTL window, regardless of whether we are spawning fresh or resuming.

### D6: Optimized respawn with `--resume`, NOT persistent stdin

**Decision.** Each Explore turn continues to spawn a fresh `claude` process. The conversation's `session_id` is captured from the first turn's `system` event (already happens today) and passed to subsequent spawns via `--resume <session_id>` (already happens today). What changes:

- Spawn `cwd` per D1.
- System prompt per D5.
- Tools left at `--tools default` (user requirement).

We do not investigate stdin multi-turn.

**Why.** User decision. The combined effect of D1 + D5 is enough to get the felt latency drop the user wants, and avoiding a persistent-process refactor shrinks blast radius and test surface.

**Trade-off.** We continue paying ~300–500 ms of `claude` CLI bootstrap per turn (process spawn, auth check, tool registration). With MCP off (default), the MCP handshake cost is also gone — partial recovery of what stdin-persistence would have given.

### D7: Lifecycle — idle-kill, crash-recovery, concurrency cap

**Decision.** A new `ExploreSpawnPolicy` layer sits inside `ChatManager` and applies only to `kind='explore'` conversations:

- **Idle on minimize-to-toast:** when the client minimizes an Explore overlay, the existing toast registration emits a hint to the server (new WS event `chat.minimized`, `{ conversationId }`). The server starts a 2-minute timer; if the timer fires before the conversation is unminimised or sent another message, any active spawn for that conversation is killed (SIGTERM, 1s grace, SIGKILL). The conversation row is untouched — `session_id` is preserved so the next message respawns with `--resume`.
- **Crash recovery:** if `child.on('close')` fires with a non-zero code AND no `result` event was observed for the in-flight turn, the manager auto-respawns the same turn once with the same prompt and `--resume`. If the second attempt also fails, a `chat_error` is broadcast with a `crashed` reason. A per-conversation crash counter resets on any successful turn.
- **Concurrency cap:** a per-project counter tracks active Explore spawns. When a 6th would be created, the oldest *idle* (not currently streaming) Explore process is killed first. If all 5 are streaming, the new turn is queued and started when one finishes — if a queued turn has waited > 30 s, the user receives a `chat_error` with `busy`.

**Why.** Predictable resource usage; degraded but graceful behaviour under stress; transparent recovery from transient `claude` CLI crashes.

**Alternatives considered.**
- *Reject 6th turn outright with `busy`*: too unfriendly; killing-idle is a Pareto improvement.
- *No crash recovery*: user has to retry manually, which feels broken in the new "electrizante" UX.

### D8: Premium streaming UX

**Decision.** A new client component `ExploreStatusPills` derives status from existing WS events without protocol changes:

| Stage | Trigger |
|---|---|
| `Conectando…` | `chat_started` (or local "send button clicked" as a T+0 fallback) |
| `Pensando…` | `system` event observed (claude process started, awaiting model) |
| `Consultando código…` | any `tool_use` event in the current turn |
| (pills disappear) | first `text` delta of the turn |

The shell renders a skeleton bubble immediately on user-message-sent (no WS round-trip required for the skeleton), with the first stage pill `Conectando…` already visible. Char-by-char rendering: a small client-side queue accepts streamed deltas and pumps them to the DOM at ~60 fps via `requestAnimationFrame`, so jitter from server-side batching is smoothed out.

**Why.** Most of the perceived speed-up at parity backend latency comes from filling the void between user-press-Enter and first-token-on-screen with motion and informative state.

### D9: Cleanup on project removal

**Decision.** `ProjectRegistry.removeProject` already runs cleanup hooks (jobs sqlite, terminal manager, etc.). Add a hook to remove `~/.specrails/projects/<slug>/explore-cwd/` recursively (the `project` symlink is unlinked, not followed). Also kill any active Explore spawns for the project.

**Why.** Hygienic; matches the pattern of the rest of `~/.specrails/projects/<slug>/`.

## Risks / Trade-offs

- **[Risk] User has project MCP servers they expect to work in Explore (e.g. serena)** → Mitigation: the Settings toggle. Surface a hint near the toggle when `.mcp.json` is detected in the project ("This project defines MCP servers — enable to load them in Explore").
- **[Risk] The embedded `CLAUDE.md` template diverges from spec quality expectations** → Mitigation: ship the v1 template based on the existing `/specrails:explore-spec` slash command body so behaviour is unchanged from the model's perspective. Iterate via normal product feedback.
- **[Risk] Symlink `./project` followed by `Glob("**/*")` confuses Claude into reading the entire repo unprompted** → Mitigation: explicit policy in the embedded prompt ("only read under `./project/...` when the spec actually requires evidence; never enumerate the repo broadly"). If telemetry shows it does this anyway, we add hard enforcement (replace symlink with a system-prompt-injected `PROJECT_PATH` and require absolute paths).
- **[Risk] Tests for spawn `cwd` get brittle** → Mitigation: extract a tiny `resolveExploreSpawnCwd(projectId, settings, exploreCwdManager)` pure function and unit-test it; ChatManager-level tests assert this is the value passed to `spawnAiCli`.
- **[Risk] Crash auto-respawn races with the user clicking "Stop"** → Mitigation: the crash counter is set BEFORE the second spawn attempt; if `interrupt` fires in between, abandon the respawn and reset.
- **[Risk] Idle-kill timer on minimize fires while the user is typing in another tab unaware** → Mitigation: idle is measured from "last user message OR last assistant turn end", not from minimize-time alone; if a turn is in flight when minimize happens, the timer doesn't start until the turn completes.
- **[Risk] Symlink creation fails on Windows for users on a SMB share or restrictive corp policy** → Mitigation: junction first; if both junction and symlink fail, fall back to writing a `project-path.txt` and instruct the prompt to use absolute paths from there. This fallback is documented in `CLAUDE.md` (the embedded one) so the model still works.
- **[Trade-off] Default-OFF MCPs in Explore is a behaviour change** → users with `.mcp.json` in their projects will see fewer tool capabilities until they flip the toggle. Mitigation: release-note callout; in-product banner inside the Explore overlay the first time it spawns in a project that has `.mcp.json` AND the toggle is OFF (`Use MCPs in Explore? Toggle in Settings → Explore.`).
- **[Trade-off] We do not unify Explore and sidebar acceleration** → sidebar chat still pays the cache-busting cost. Acceptable for this change; tracked as follow-up.

## Migration Plan

1. Ship behind no flag — the new behaviour is the default. Toggle is opt-in for legacy.
2. On first server start after the change:
   - Run the new sqlite migration adding `explore_mcp_enabled` column (default 0).
   - For each project in the registry, kick `ExploreCwdManager.ensureExploreCwd(projectId)` lazily (on first Explore turn), not eagerly at startup, to avoid filesystem IO in the boot path.
3. Existing in-flight Explore conversations (sessions whose `session_id` predates the change) keep working: the next turn just spawns from the new cwd with `--resume`. Anthropic prompt cache won't hit on the very first post-upgrade turn (different system prompt in the cache key — *system prompt itself is the same, but the project context changes*), but turn 2 onwards will.
4. **Rollback strategy:** if the change misbehaves in production, an env var `SPECRAILS_EXPLORE_LEGACY_CWD=1` forces every Explore spawn to use `<project.path>` regardless of the toggle and skips the explore-cwd creation entirely. The migration column stays in place (additive, harmless). Status pills and char-by-char rendering can be feature-flagged via `VITE_FEATURE_EXPLORE_PREMIUM_UX=false` to revert client-side independently.

## Open Questions

- *Is there a measurable latency hit from creating the symlink on the first Explore turn (especially on macOS with Tauri sandboxing)?* — should be sub-ms; if it shows up in dev, hoist into a one-time `ensureExploreCwd` at project-registration time. Will measure during implementation.
- *Should `chat.minimized` be a WS event or an HTTP `POST /chat/conversations/:id/minimize`?* — leaning WS because it's transient state, but HTTP gives a cleaner surface for retries. Defer to implementation; either works.
- *What's the right `Pensando…` debounce?* — if `system → first text delta` is < 200 ms, showing `Pensando…` for one frame and replacing it looks janky. Add a 150 ms minimum-display threshold per pill.
