## Context

The hub is distributed as a Tauri desktop app on macOS. When launched from `Applications/` via Finder or the Dock, the embedded server binary inherits the launchd `PATH`, not the interactive shell `PATH`. On a typical Apple Silicon Mac this means `/opt/homebrew/bin` is missing, while `/usr/local/bin` may or may not be present depending on `/etc/paths`.

`server/setup-prerequisites.ts` runs `which <cmd>` and `<cmd> --version` via `spawnSync` with `env: process.env` and no shell on POSIX. The check therefore sees only the launchd `PATH`. Three real-world failure modes have been observed:

1. **Brew Apple Silicon node not visible** — node installed in `/opt/homebrew/bin/node`, GUI server cannot find it; user has to launch the app from a terminal.
2. **Stale `/usr/local/bin/node` symlink** — left behind by an old `.pkg` install or previous brew prefix, target binary deleted. `which node` returns the symlink path; `node --version` fails. UI shows `Node.js — unknown found — needs 18.0.0+` (confirmed in user screenshot 2026-04-28).
3. **Version managers (Volta, nvm, fnm, asdf)** — shims live under `$HOME` and are added to `PATH` by shell rc files only. Invisible to GUI launches.

`server/modules/terminals/runtime/terminal-manager.ts` already sidesteps the issue by spawning `$SHELL -l -i` for PTYs. The rest of the server does not, so prerequisites detection, `npx specrails-core` install, claude CLI spawns, and git operations all degrade silently when the app is launched from the GUI.

Constraints:
- Must not delay the listening socket on startup — a 1.5s shell spawn at boot would noticeably hurt cold-start UX on the splash screen.
- Must not break terminal launches (developers running `npm run dev`), where `process.env.PATH` is already correct.
- Must remain a no-op on Windows: GUI launches inherit a usable `PATH`, and PowerShell login-shell semantics differ enough that a port is not justified for v1.

## Goals / Non-Goals

**Goals:**
- Prerequisites check finds Homebrew-installed node/npm/npx/git on Apple Silicon when the app is launched from Finder.
- Prerequisites check distinguishes "binary not on PATH" from "binary on PATH but not executable" so the user gets an actionable message in the broken-symlink case.
- All downstream server spawns (`QueueManager`, `ChatManager`, `SetupManager`, `terminalManager`) inherit the same enriched `PATH` without per-callsite changes.
- Provide a diagnostic surface so a user (or support) can copy-paste the exact `PATH`, sources, and `which` results into a bug report.

**Non-Goals:**
- Detecting and surfacing tools the user has installed but explicitly hidden (e.g. nvm with `nvm deactivate`).
- Auto-installing missing tools.
- Windows PATH augmentation (the inherited PATH on Windows GUI launches already covers Node/npm/git installs from the standard installers; revisit only if user reports surface).
- Replacing the existing prerequisites UI gate (separate change `gate-add-project-on-prerequisites`).

## Decisions

### Decision 1: Two-stage PATH resolution (sync fast path + async login-shell merge)

**What:** At startup, run a synchronous fast path that prepends a hard-coded list of well-known package-manager bin directories to `process.env.PATH`. Immediately after `app.listen`, fire an async login-shell spawn that merges any additional entries it finds. The fast path is sufficient for ~95% of macOS users; the slow path catches Volta/nvm/fnm/asdf users.

**Why over alternatives:**
- *Login-shell only (sync at startup)*: rejected because shell rc files can take 200ms–2s to evaluate and would delay the listening socket. Cold-start UX matters on a desktop app.
- *Login-shell only (lazy on first prereq check)*: rejected because the first prereq check happens when the user opens `AddProjectDialog`, blocking the modal for up to 1.5s. Async-after-listen amortises the cost into idle time.
- *Hard-coded paths only*: rejected because Volta/nvm/fnm/asdf users (a significant minority of Node developers) would still get the broken experience.

**Why these specific hard-coded paths (`/opt/homebrew/{bin,sbin}`, `/usr/local/{bin,sbin}`):** these are the canonical Homebrew prefixes for Apple Silicon and Intel Macs, and `/usr/local/bin` is the macOS `.pkg` installer destination for Node and Git. `~/.local/bin` is added on Linux only.

### Decision 2: Login-shell command uses sentinel markers, not raw output

**What:** Spawn `$SHELL -lic 'printf "__SRH_PATH_BEGIN__%s__SRH_PATH_END__" "$PATH"'` and parse with a regex `/__SRH_PATH_BEGIN__(.*?)__SRH_PATH_END__/`.

**Why:** `-l -i` runs the user's full rc chain. Many users print messages from `.zshrc` (motd, fortune, asdf reshim warnings, NVM_DIR warnings). A naive `echo $PATH` mixes with that noise. Sentinels make parsing robust without disabling rc files.

**Why not `bash -c` with a clean env:** that misses Volta/nvm exports that live only in the user's actual shell rc. The whole point is to recover the user's interactive PATH.

### Decision 3: Distinguish `installed` from `executable`

**What:** `setup-prerequisites.ts` currently treats `which <cmd>` succeeding as `installed: true`. We add a second probe: if `which` succeeds but `<cmd> --version` fails with `ENOENT` or non-zero exit, set `executable: false` and surface a different message.

**Why:** Confirmed real failure mode (broken `/usr/local/bin/node` symlink). Today the UI says "Node.js — unknown found — needs 18.0.0+" which is misleading — the user assumes a version mismatch and reinstalls Node, but the new install lands in `/opt/homebrew/bin` and the broken symlink in `/usr/local/bin` still wins. The clearer message ("found at <path> but failed to execute — possibly a broken symlink") points at the actual problem.

### Decision 4: Diagnostic endpoint behind a query flag, not a separate route

**What:** `GET /api/hub/setup-prerequisites?diagnostic=1` instead of `/api/hub/setup-prerequisites/diagnostic`.

**Why:** Keeps the route table simple and lets the diagnostic payload share the same caching headers and gating as the base endpoint. The diagnostic fields are added to the response only when `?diagnostic=1` is present, so the regular UI payload stays small.

### Decision 5: Persist the augmented PATH only into `process.env.PATH`, not a config file

**What:** `resolveStartupPath()` mutates `process.env.PATH` in place. It does not write to disk.

**Why:** The PATH must be re-resolved every launch — the user might install/uninstall Node between sessions. Caching to disk would create a stale-PATH bug class identical to the one we are fixing. The 50–500ms login-shell cost is acceptable per launch.

## Risks / Trade-offs

- **Risk:** Login-shell timeout on a slow machine (1.5s ceiling) means Volta users on first launch may see one prereq check before the async merge completes.
  → **Mitigation:** `usePrerequisites` already rechecks on `window.focus`, and we add a "Refresh" button click → forces a re-fetch. By the time the user reads the dialog and clicks Refresh, the merge has finished.

- **Risk:** A user's `.zshrc` is broken (`exit 1` early) and the login-shell spawn fails. Today the user gets nothing; with this change they get the fast-path PATH.
  → **Mitigation:** That is strictly an improvement, not a regression. Failure is logged once, not surfaced to the UI.

- **Risk:** Hard-coded `/opt/homebrew/bin` precedence over `/usr/local/bin` could shadow an Intel-brew user who deliberately prefers the Intel toolchain via Rosetta.
  → **Mitigation:** The augmentation **prepends only entries that are not already in PATH**. If the user's shell rc puts `/usr/local/bin` first, the login-shell merge restores their order. The fast path only fills in genuinely missing directories.

- **Risk:** Test environment (vitest in CI) has its own PATH and we don't want startup to spawn login shells during tests.
  → **Mitigation:** `augmentPathFromLoginShell()` is a no-op when `process.env.NODE_ENV === 'test'` or `VITEST === 'true'`. Unit tests for the function pass an explicit `spawn` injection seam.

- **Trade-off:** Two-stage resolution means the resolved PATH at any given instant depends on whether the async merge has completed. For setup-prerequisites this is fine (rechecks are cheap and frequent). For long-lived spawns (terminal panel, queue manager) the PATH is captured at spawn time, so a job spawned in the first 500ms of server life might miss Volta. Acceptable: queue jobs are launched manually by the user, not at boot.

## Migration Plan

This is a server-only behavioural change with additive API fields. No migration is required.

- Deploy: ships in the next desktop release (`v1.x.0`). `npm publish` of the hub package gets the same code.
- Rollback: revert the change; existing `setup-prerequisites.ts` keeps working with whatever PATH is inherited (i.e. back to the current broken behaviour). No data loss, no schema changes.

## Open Questions

- Should the login-shell merge log the new entries it discovered, even at info level? Useful for support, but noisy for `npm run dev` developers. **Tentative answer:** debug level only, gated by `DEBUG=specrails-hub:path` or similar.
- Do we want to extend this to the CLI entry point as well (`bin/specrails-hub`)? CLI users already have a usable PATH from their shell, so probably no — but worth confirming during implementation that the path-resolver is gated to server-side use only.
