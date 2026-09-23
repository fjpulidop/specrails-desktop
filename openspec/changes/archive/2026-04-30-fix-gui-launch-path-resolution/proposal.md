## Why

When SpecRails Hub is launched from the macOS Applications folder / Dock (Finder GUI launch), the server inherits the launchd `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin` plus whatever `/etc/paths` adds), which on Apple Silicon does NOT include `/opt/homebrew/bin`. The setup-prerequisites check uses `which` + `<cmd> --version` against `process.env.PATH` directly, so:

- A fresh `brew install node` lands in `/opt/homebrew/bin/node`, which the GUI server never sees.
- Stale symlinks left in `/usr/local/bin` from previous installations (a common state) cause `which node` to succeed but `node --version` to fail with ENOENT, surfacing as `Node.js — unknown found — needs 18.0.0+` in the UI even though the user has just installed Node.
- The user is blocked from registering any project, with no actionable explanation.

The same root cause silently degrades any other tool spawn (`claude` CLI, `npx specrails-core`, git operations) when launched from the GUI. The terminal panel already works around it by spawning `$SHELL -l -i`; the rest of the server does not.

## What Changes

- At server startup, resolve a usable `PATH` for child processes spawned from the hub:
  - **Fast path (synchronous)**: prepend well-known macOS package-manager bin directories that are missing from the inherited `PATH` — `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`, `/usr/local/sbin`.
  - **Slow path (async, best-effort)**: spawn the user's login shell once (`$SHELL -lic 'echo -n __PATH__:$PATH:__END__'`) with a short timeout (~1500ms). If it succeeds, merge any additional entries (e.g. `~/.volta/bin`, `~/.nvm/versions/node/.../bin`, `~/.fnm`, asdf shims) ahead of the existing `PATH`. If it times out or errors, fast path stays in effect and the server logs a warning.
- The augmented `PATH` is written to `process.env.PATH` so all existing `spawnSync` / `spawn` callsites benefit without code changes (`setup-prerequisites.ts`, `queue-manager.ts`, `chat-manager.ts`, `setup-manager.ts`, `terminal-manager.ts`).
- Linux launches behave the same way (`/usr/local/bin`, `~/.local/bin`, login shell merge). Windows is unaffected — GUI launches on Windows already inherit a usable `PATH` from the user environment, and `process.env.PATH` semantics differ; this change is no-op on `win32`.
- When `which <cmd>` returns a path but executing the command fails (broken symlink, missing dylib), `setup-prerequisites.ts` distinguishes that case from "not installed" so the UI can show a clearer message ("Node.js found at /usr/local/bin/node but failed to execute — possibly a broken symlink. Reinstall Node.js or remove the stale link.").
- New diagnostic endpoint `GET /api/hub/setup-prerequisites/diagnostic` returns the resolved `PATH`, the source of each segment (inherited / fast-path / login-shell), and the absolute path returned by `which` for each required tool. Hidden behind a query flag (`?diagnostic=1`) so it is not exposed in the default UI; used by the install-instructions modal's "Copy diagnostics" button.
- Logging: the server logs a single line at startup summarising `inherited=<N entries> augmented=<M entries> loginShell=<ok|skipped|timeout> source=<gui|terminal>`.

## Capabilities

### New Capabilities
- `gui-launch-path-resolution`: Server-side resolution of a usable `PATH` at startup so binaries installed via Homebrew, Volta, nvm, fnm, asdf, etc. are discoverable regardless of how the desktop app was launched (Finder/Dock vs terminal). Defines the augmentation strategy, the login-shell merge contract, the broken-symlink detection rule, and the diagnostic endpoint.

### Modified Capabilities
<!-- None. The existing add-project-prerequisites-gate change is independent — it specifies the UI gate; this change specifies the underlying PATH resolution that feeds the detection. -->

## Impact

**New code (server):**
- `server/path-resolver.ts` — resolves and merges `PATH` segments at startup. Exposes `resolveStartupPath()` (sync fast path) and `augmentPathFromLoginShell()` (async, fire-and-forget on startup).

**Modified code (server):**
- `server/index.ts` — calls `resolveStartupPath()` before any router/manager initialisation; kicks off `augmentPathFromLoginShell()` immediately after.
- `server/setup-prerequisites.ts` — new `executable: boolean` field per prerequisite to flag the `which` succeeds / `--version` fails case; reuses the augmented `process.env.PATH` (no logic change to spawn calls themselves).
- `server/hub-router.ts` — adds `GET /api/hub/setup-prerequisites/diagnostic`.
- `server/setup-prerequisites.test.ts` — coverage for the broken-symlink detection branch.
- New `server/path-resolver.test.ts` — unit tests covering fast-path augmentation, login-shell parsing, timeout handling, and Windows no-op.

**Modified code (client):**
- `client/src/features/projects/components/PrerequisitesPanel.tsx` — renders the new `executable: false` state with a distinct message and a "Copy diagnostics" affordance that hits the diagnostic endpoint.
- `client/src/features/projects/components/__tests__/PrerequisitesPanel.test.tsx` — coverage for the new state.

**APIs:**
- `GET /api/hub/setup-prerequisites` response gains an optional `executable` field per prerequisite. Additive, no breaking change.
- New `GET /api/hub/setup-prerequisites/diagnostic`.

**Performance:**
- Fast path: O(1), negligible. Login-shell spawn: ~50–500ms typical, capped at 1500ms, runs async after server is listening — does not delay startup.

**Security:**
- The login shell command is a fixed string with no user input interpolation. Output is parsed via sentinel markers (`__PATH__:...:__END__`) to avoid being polluted by rc-file `echo` statements. Failure is silent; no shell injection surface.
