# Global core, zero friction

## Why

specrails-core still behaves like a per-project installer: adding a project runs a 5-phase setup wizard (configure per provider, streamed install log, done screen) even though the bundled-framework relocation already made assembly an offline, seconds-long symlink operation against `~/.specrails/framework/current`. The wizard, the up-front provider selection, and the frozen legacy repo-resident installs are pure friction with no remaining reason to exist — core is now three fixed agents and the framework is app-managed. This change makes specrails-core a fully global, app-managed dependency: install/update of the desktop app (or the standalone core-update channel) IS the install/update of core, for every project at once.

## What Changes

- **Kill the per-project setup wizard.** Add Project = path input + prerequisites gate only. On submit the project registers immediately and the workspace assembles silently in the background (`assembleProjectOffline`, per detected provider). No Configure step, no Install log screen, no Done screen. A subtle "project ready" signal replaces the wizard; the Jira CTA and MCP/agent-chat hints move to WelcomeScreen/first-visit surfaces. **BREAKING** (UI flow removal).
- **Auto-detect AI providers, always all.** Provider selection at project creation is removed; `projects.providers` stops being a user choice fixed at creation. The app probes claude/codex/gemini/kimi (existence + version + auth state — auth-probed "premium" detection, precedent: gh/kimi probes) at app startup, on project add, and on window focus (60s cached, `usePrerequisites` pattern). Every project always offers every detected, non-vetoed (`SPECRAILS_*_BETA` flags) provider. Newly detected providers trigger lazy per-provider workspace assembly. A provider that disappears falls back to primary with a subtle notice, never a block. Primary/default = claude if present, else fixed preference order. **BREAKING** (data-model semantics of `projects.providers`).
- **Capability visibility flips from intersection to union.** Sidebar sections show when ANY detected provider supports them (today: only when ALL do); per-invocation engine selectors filter to capable providers. Prevents "installed gemini → Agents section vanished everywhere".
- **Forced migration of legacy repo-resident installs.** On startup, projects with core installed inside the repo migrate to the relocated workspace (base: `migrateWorkspaceToSymlinks`) and the repo is cleaned of app-owned artifacts (`.specrails/`, `sr-*` framework files) — manifest-driven, dry-run logged, never touching user-owned files (`custom-*.md`, user `CLAUDE.md`, user settings, `openspec/**`, worktrees). **BREAKING** (repo contents change on upgrade).
- **Aggressive framework auto-update with re-seed.** When a newer bundled framework version is present, `current` swaps automatically at app startup (no voluntary opt-in step), and a post-swap re-seed pass regenerates the per-workspace COPIED files (instruction files, `.mcp.json`, Windows copy-fallback trees) so nothing stays frozen at the old version. In-flight rails keep their resolved version (existing guarantee).

## Capabilities

### New Capabilities
- `provider-auto-detection`: global machine-level probing of AI provider CLIs (existence, version, auth state), caching/refresh triggers, beta-flag vetoes, primary-provider derivation, lazy per-provider workspace assembly, disappeared-provider fallback.
- `silent-project-add`: wizard-less Add Project flow — path + prerequisites gate, immediate registration, background offline assembly, failure surfacing, relocated hints (Jira/MCP/agent-chat).
- `legacy-install-migration`: forced startup migration of repo-resident core installs to the relocated workspace, manifest-driven repo cleanup with user-file safety guarantees and dry-run audit log.
- `framework-auto-update`: automatic `current` swap on startup when a newer framework is bundled/available, post-swap re-seed of copied (non-symlinked) workspace files, in-flight version pinning.

### Modified Capabilities
- `multi-provider-architecture`: provider set is no longer fixed at project creation; capability visibility changes from intersection to union; per-invocation validation targets the detected set.
- `setup-wizard-install-cta`: superseded — the wizard flow this CTA lives in is removed; requirement retires or re-homes to the silent-add flow.
- `setup-wizard-summary`: superseded — the Done/summary step is removed; its Jira/MCP hints re-home to WelcomeScreen/first-visit surfaces.

## Impact

- **Server**: `setup-manager.ts` (wizard orchestration shrinks to background assemble), `provider-selection.ts` + `providers/registry.ts` (detection-driven set), `workspace-manager.ts` / `offline-assemble.ts` (lazy per-provider assembly, re-seed), `framework-manager.ts` (auto-swap policy), new migration module (legacy cleanup), `desktop-db.ts` (`projects.providers` semantics), `desktop-router.ts` / `project-router-setup.ts` (setup routes retire/shrink), capability gating helpers.
- **Client**: `SetupWizard.tsx` (deleted), `AddProjectDialog.tsx` (path + prereqs only), `useDesktop.tsx` (`setupProjectIds` lifecycle), `provider-capabilities.ts` (union rule), engine selectors (detected-set source), WelcomeScreen (re-homed hints), i18n `setup`/`builder` namespaces ×8.
- **Contracts preserved**: mobile wire compat, bundle id, registry.json schema, `SPECRAILS_REPO_DIR` env indirection, prerequisites gate, openspec + worktrees repo carve-outs.
- **Risk concentration**: legacy repo cleanup (destructive, needs manifest + tests) and the intersection→union flip (touches every gated surface).
