# Design — global-core-zero-friction

## Context

The bundled-framework relocation already made core assembly offline and global: `~/.specrails/framework/<version>/<provider>/` + atomic `current` symlink, workspaces symlinking static subtrees, `assembleProjectOffline` shared by SetupManager and the Project Builder. What remains is the friction shell around it: a 5-phase per-project wizard, provider selection frozen at creation, legacy repo-resident installs pinned to old versions, a voluntary update swap, and per-workspace copied files that a swap does not refresh.

Current facts this design builds on:
- `SetupWizard.tsx` (~920 lines) drives Configure (Agents/Models tabs) → Install (streamed npx/assemble log) → Done (Jira CTA, MCP/agent-chat hints).
- `projects.providers` (desktop-db migration 10/11) is set at creation, immutable; `provider` = primary. `provider-selection.ts` validates requests against it.
- `provider-capabilities.ts` `sectionVisibleForProviders` implements the intersection rule.
- `FrameworkManager.versionCheck/materialize/swapCurrent` exist; swap is user-triggered (core-update-channel, PR #411).
- Copied (non-symlinked) workspace files: instruction files (carry project name), `.mcp.json` (also mutated by the plugin system), Windows copy-fallback trees, Kimi per-child skill links.
- `migrateWorkspaceToSymlinks` exists (copy→symlink upgrade, non-destructive); repo cleanup does NOT exist.

## Goals / Non-Goals

**Goals:**
- Add Project = path + prerequisites, nothing else; workspace assembles silently in background.
- Every project always offers every detected, non-vetoed provider; detection includes auth state.
- Capability visibility = union of detected providers' capabilities.
- Legacy repo-resident installs migrate to the workspace automatically on startup; repos end pristine.
- Framework `current` swaps automatically on startup when a newer version is bundled; copied files re-seed post-swap.

**Non-Goals:**
- Changing specrails-core's own CLI (`npx specrails-core init` standalone path keeps working; registry `source: 'core-standalone'` untouched).
- Per-project core version pinning (explicitly dropped — global latest always; in-flight rails keep their resolved version).
- Reworking the AI-enriched install flow (already not exposed in-app).
- Mobile wire changes, bundle id, registry.json schema changes.

## Decisions

### D1 — Detection is an app-level singleton, not project state
New `server/provider-detection.ts`: probes the four provider CLIs — PATH resolution (reusing `path-resolver` results), `--version` execution, and per-provider auth probe (claude: `~/.claude.json` presence heuristic or version-only; codex: auth file under `~/.codex`; gemini: version-only v1; kimi: reuse its existing readiness/auth probe; gh precedent for the offline-auth-probe pattern). Result cached 60s in-memory. Refresh triggers: server startup, `POST /api/projects` (project add), and `GET /api/providers/detected?refresh=1` called by the client on window focus (mirrors `usePrerequisites`). Changes broadcast app-global WS `providers.detected_changed` (no `projectId`). Beta vetoes (`SPECRAILS_CODEX_BETA=0`, `SPECRAILS_GEMINI_BETA=0`) filter the detected set at the source, so every consumer sees detected ∩ non-vetoed.
*Alternative rejected*: fs watcher on PATH dirs — fragile, focus-refresh covers the real UX moment.

### D2 — `projects.providers` becomes a compatibility shadow, detection is authoritative
No destructive schema change. `resolveProvider`/`validateRequestedProvider` switch their source of truth from the project row to the global detected set. The `providers` column is kept and backfilled to the detected set on read (wire compat: existing clients and the mobile app read it), but no longer gates anything. `provider` (primary) is derived: claude if detected, else fixed order `[claude, codex, gemini, kimi]`; a project whose stored primary is still detected keeps it (stability), otherwise falls back with a subtle notice. Per-conversation/per-rail stored engines (`chat_conversations.provider`, `rails.ai_engine`) referencing an undetected provider fall back to primary at spawn, never block.
*Alternative rejected*: dropping the columns — breaks mobile wire and multi-provider invariants for zero gain.

### D3 — Capability visibility flips to union in ONE helper
`sectionVisibleForProviders(section, providers)` changes from `every` to `some`; engine selectors already filter per-invocation, so incapable providers are simply absent from that section's selector. The single-provider invariant ("selectors don't render at length 1") is preserved by keying selector rendering on the DETECTED set length. Kimi's gated-off surfaces (Quick Spec, AI Edit, etc.) keep their per-invocation rejection — union only affects section visibility, not per-action validation.

### D4 — Add Project: register-first, assemble-background
`POST /api/projects` registers the project and returns immediately (existing behavior). SetupManager gains a `startSilentAssemble(projectId)` path: per detected provider, run `assembleProjectOffline` sequentially in background (reuses the existing per-provider queue). Progress rides a slim app-level WS event `project.assemble_progress` (`{projectId, provider, status}`) consumed only for the project card's subtle spinner/ready state — no wizard UI. Failure per provider → project stays usable with the succeeded providers; a card badge + retry action (reuses the existing install retry route). `setupProjectIds` in `useDesktop` is retired; the project is navigable the moment it registers (surfaces that need the workspace show skeletons until `assemble_progress: done`). `SetupWizard.tsx`, its checkpoint tracker, and the setup chat phase are deleted; `SetupManager`'s phase-4 `/setup` chat and enrich path stay server-side for the standalone escape hatch but are unreachable from the app UI.
*Alternative rejected*: keeping a minimal 1-screen wizard — any modal screen is the friction being removed.

### D5 — Legacy migration: manifest-driven, journaled, fail-open
Startup pass over registered projects: a project is "legacy" when the two-part activation gate says non-relocated AND `<repo>/.specrails/specrails-version` exists. Migration per project, in background, serialized:
1. Ensure workspace exists + assemble (bundled framework).
2. MOVE per-project state from repo → workspace: `.specrails/{profiles,local-tickets.json,backlog-config.json,state,file-summaries,plugins}` and `agent-memory/`. Registry entry written.
3. CLEAN the repo with a **manifest**: the bundled core version's framework file listing (computed from `framework/<version>/<provider>/`, i.e. exact relative paths of `sr-*` agents, `specrails`/`opsx` command dirs, skills, rules) + the app-owned `.specrails/` leftovers, **UNION known historical patterns** — a legacy repo may have been installed by an older core (4.x) whose file set differs from the current bundled listing (renamed commands, retired agents, the deprecated `commands/sr/` namespace). The manifest therefore also includes the stable historical patterns: `<providerDir>/agents/sr-*.md`, `<providerDir>/commands/{sr,specrails,opsx}/`, framework-owned skills/rules dir names. Patterns stay narrow (framework naming conventions only) so user files can never match. Delete ONLY exact manifest matches. Never touched: `openspec/**`, `.claude/worktrees/**`, `custom-*.md`, user instruction files (a `CLAUDE.md` the old installer appended to is left as-is — content surgery is out of scope v1), user settings, `.mcp.json` keys not owned by us (surgical key removal via the plugin-system helpers).
4. Journal every action (moved/deleted/skipped + reason) to `~/.specrails/projects/<slug>/migration-log.json` BEFORE executing deletions (write-ahead), so a crash is auditable and resumable.
Any step failure → abort that project's cleanup (state already moved is fine — workspace wins by the activation gate), project keeps working, non-blocking warning surfaced once. No user prompt: forced but fail-open.
*Alternative rejected*: interactive migration banner — user chose forced; fail-open replaces consent as the safety valve.

### D6 — Auto-update swap + re-seed
On startup (after migrations), `FrameworkManager.versionCheck()` auto-materializes and `swapCurrent()` — no settings toggle (the voluntary GlobalSettings flow becomes a manual "check now" affordance only). Post-swap re-seed pass over relocated workspaces: regenerate instruction files (re-render template with project name), refresh Windows copy-fallback subtrees (re-run the copy branch), re-link Kimi per-child skills. `.mcp.json` is NOT wholesale re-copied — only framework-owned keys are surgically updated (plugin/user keys preserved, reusing `mergeMcpServers` semantics). Re-seed is idempotent and also runs for any workspace whose recorded framework version ≠ current (catches machines that were off during the swap). `framework.updated` WS broadcast retained.
Rollback: `current` is a symlink — pointing it back at the prior version dir + re-running re-seed restores the old state; prior versions are never deleted by this change.

## Risks / Trade-offs

- [Repo cleanup deletes a user file] → manifest = exact framework listing only; write-ahead journal; `openspec/**`/worktrees/`custom-*` hard-excluded; unit tests over a fixture repo with user files planted alongside framework files.
- [Intersection→union regressions on gated surfaces] → the flip is one helper + its tests; per-invocation validation unchanged; sweep every `sectionVisibleForProviders` callsite.
- [`.mcp.json` re-seed clobbers plugin/user servers] → surgical key-level merge only, plugin ownership map respected; never wholesale copy on re-seed.
- [Auth probes are slow/hang] → each probe timeout-bounded (1500ms, `gh auth token` precedent), failures degrade to "installed, auth unknown"; probes parallel.
- [Startup cost: migration + swap + re-seed on big installs] → all background/async after the server is listening; serialized per project; UI never blocks.
- [Detected-set churn mid-session] → 60s cache + explicit triggers only; WS event lets clients converge; spawns always re-resolve at spawn time.
- [Wizard deletion breaks Project Builder's assemble reuse] → Builder uses `offline-assemble.ts` directly, untouched; only the wizard UI + setup phases die.

## Migration Plan

1. Ship detection + union flip + silent add (wizard deleted) — legacy projects still work via the activation gate.
2. Same release: startup legacy migration (fail-open) + auto-swap + re-seed.
3. Rollback: `SPECRAILS_LEGACY_MIGRATION=false` and `SPECRAILS_FRAMEWORK_AUTOSWAP=false` kill switches (env, default on); wizard code is deleted, so UI rollback = release rollback.

## Open Questions

- Zero providers detected: Add Project should still register (workspace assembles when a provider appears) — empty-state copy needed; confirm.
- Does the mobile app render anything wizard-dependent? (Believed no — wire types unchanged.)
- Deprecation notice for `npx specrails-core init` docs, or leave silently supported.
