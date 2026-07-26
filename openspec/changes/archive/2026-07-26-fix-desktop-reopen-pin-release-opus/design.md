## Context

Four unrelated defects, grouped only because they are all small, user-visible desktop regressions found in one session.

1. **Dock reopen.** `on_window_event` prevents close and hides the window so the sidecar keeps running behind the tray. `tauri_plugin_single_instance` re-shows the window when the app is *launched again*, which is what happens on Windows (a hidden window has no taskbar button, so the user necessarily uses the pinned shortcut / Start menu). On macOS the app is still running with a Dock icon, so clicking it never launches a second process — it raises `applicationShouldHandleReopen`, which Tauri surfaces as `RunEvent::Reopen`. That event is currently unhandled, so the window is only reachable through the menu-bar item.

2. **Mission pin.** `AgentChatContext` owns both the draft pin (compose screen) and the live conversation's `pinned_project_id`. `setPinnedProject` already syncs *forward* (mission selector → sidebar) in Agent Mode. There is no backward sync: `AgentChatContext` never reads `activeProjectId` at all, so selecting a project in the sidebar leaves the mission pointed at the previous project (or Home).

3. **Worktree release.** `linkNodeModulesIntoWorktree` symlinks the base checkout's `node_modules` trees into a fresh worktree. Those paths are appended to `overlayExcludes` (commit-time exclusions) but never become `OverlayCleanupEvidence`, which is what release verification uses to build its `git status` exclusion pathspec. A repo whose `.gitignore` says `node_modules/` (directory pattern) does **not** ignore a *symlink* named `node_modules`, so the link surfaces as an untracked entry. Release then reports `the worktree contains changes made after settlement`, parks the row at `needs-review` forever, and the branch can never be checked out. Reproduced with a real user worktree whose only unauthorized entry was `node_modules -> <repo>/node_modules`.

4. **Opus alias.** `CLAUDE_MODELS` exposes the alias `opus`, which is passed straight to `--model opus`. The CLI decides which Opus generation that means.

## Goals / Non-Goals

**Goals:**
- Every platform has a working "bring the hidden app back" gesture from the OS shell.
- An unstarted mission follows the project the user is looking at.
- App-created warm-dependency links can never block release/checkout, including for worktrees already stuck today.
- "Opus" in the Claude model selector means Opus 5.

**Non-Goals:**
- Changing the hide-to-tray behaviour itself, adding a Windows taskbar presence while hidden, or touching sidecar lifecycle.
- Re-pinning a mission that already has messages.
- Relaxing any other part of the release safety ladder (settlement snapshots, HEAD/ref identity, non-force removal, quarantine).
- Changing stored model identity: `opus` remains the persisted/validated catalog value.

## Decisions

### D1 — Handle `RunEvent::Reopen` rather than changing hide semantics

`RunEvent::Reopen { has_visible_windows }` is macOS-only (`#[cfg(target_os = "macos")]` in tauri 2.10) and fires exactly for the Dock click. Handling it reuses the existing `show_main_window` helper, so tray Open, single-instance relaunch, and Dock click share one code path.

*Alternative rejected:* `minimize()` instead of `hide()` on close, which would keep a Dock/taskbar entry. It defeats the purpose of hiding to the tray and would change behaviour on both platforms.

*Windows:* no code change is required — the single-instance callback already calls `show_main_window`. This is stated in the spec so the parity is a maintained contract rather than an accident.

### D2 — Bind the mission from an effect on the active project, gated on "not started"

`AgentChatProvider` is mounted inside `DesktopProvider`, so it can read `activeProjectId`. An effect that fires on *changes* (skipping the mounted value via a ref) applies:
- no active conversation → `setDraftPinnedProjectId(projectId)`
- active conversation with zero messages → `patchActive({ pinnedProjectId })`
- otherwise → no-op

The first-render skip is what protects an explicitly Home-pinned mission from being converted on mount. The effect is additionally gated on `uiMode === 'agent'`, so the board-mode floating panel is untouched.

*Alternative rejected:* wiring the sidebar's click handler directly. The sidebar is not the only writer of `activeProjectId` (command palette, ref chips, restore flows), and an effect keeps the invariant regardless of the source.

*Loop safety:* `setPinnedProject` writes `activeProjectId` only when there is no active conversation, and the effect writes the pin to the same value, so the second pass is a no-op.

### D3 — Authenticate warm-dependency links live at release, and persist evidence at settle

Two complementary halves:

- **Live authentication (heals existing damage).** `verifyReleaseEvidence` derives warm-link evidence from the filesystem: an entry named `node_modules`, at depth ≤ 2 inside the worktree, that is a symlink whose resolved target equals the base repo's identically-named path. Deriving it live means worktrees that settled *before* this change — with no persisted evidence — release on the next decision without any manual step. This is the same standard already used by `recoveryOverlayExcludes`: the proof is the link target anchored to a directory the app controls, never a name-based classification.
- **Persisted evidence (correct by construction going forward).** `linkNodeModulesIntoWorktree` also returns fingerprints for the links it authenticates, including links that already existed from a previous pass (resume safety — today a resumed launch loses even the commit exclusion). Those entries are concatenated into the durable branch record's cleanup evidence.

Because the derived/persisted entries are ordinary `OverlayCleanupEvidence`, the existing quarantine machinery moves them out atomically before `git worktree remove`, which is required anyway: non-force removal refuses a worktree containing untracked files.

*Alternative rejected:* excluding `node_modules` by name at release. That would let any unauthenticated dependency directory — including a real one holding user work — be silently discarded, violating "Recoverable work is never removed automatically".

*Alternative rejected:* forcing removal when only dependency paths remain. Force removal is prohibited by the same requirement.

*Quarantine note:* a quarantined warm link is just a symlink; the shared dependency tree it points at is never moved or deleted.

### D4 — Resolve the `opus` alias inside the Claude adapter's arg builder

A single `resolveClaudeModel()` applied where `--model` is pushed keeps the change to one file and one concept: catalog value in, model id out. Storage, validation, analytics and the selector keep using `opus`; `normaliseModel` gains `claude-opus-5 → opus` so round-tripping is stable.

*Alternative rejected:* changing the catalog `value` to `claude-opus-5`. It would invalidate stored profiles, project settings, and conversation rows that hold `opus`.

## Risks / Trade-offs

- **[A future Opus generation makes the pin stale]** → The mapping is one constant in the adapter next to the catalog; the normalisation switch already carries the historical ids, so adding the next one is a two-line edit.
- **[Live warm-link authentication widens what release may quarantine]** → Narrowed by three independent conditions (exact name, depth ≤ 2, resolved target equals the base repo's identically-named directory). A real directory, a copy, or a foreign link target all stay unauthorized and preserve the worktree.
- **[Depth-limited discovery misses a deeply nested package]** → It mirrors `MAX_DEPTH` in the linker, so it can only miss links the app never created; those correctly remain unauthorized.
- **[Backward pin sync surprises a user who deliberately parked a Home mission]** → Mitigated by the first-render skip and by never touching a mission that has messages.
- **[`RunEvent::Reopen` cannot be exercised in CI]** → macOS-only OS event; covered by the spec scenario and manual verification, like the rest of the Tauri shell.
