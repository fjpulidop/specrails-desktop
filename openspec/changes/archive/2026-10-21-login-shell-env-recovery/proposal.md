## Why

When Specrails is launched from the Dock or Finder, it does not inherit the user's shell environment. Desktop recovers each project-configured name (for example `NODE_AUTH_TOKEN`) by probing the login shell (`$SHELL -l -i -c 'printf …'`, in `readEnvFromLoginShellSync`). That probe discards its result without telling anyone in three cases:

- **Short timeout.** The probe has a 1.5 s timeout, and real interactive profiles (oh-my-zsh, nvm, powerlevel10k, conda) routinely exceed it.
- **Non-zero exit.** A non-zero shell exit throws away the output even when the sentinel block containing the value is present.
- **No diagnostic.** No log line, UI state or warning is produced. The run continues without the variable, and the failure surfaces later as an unrelated `yarn` 401 or a lint error.

A user with `NODE_AUTH_TOKEN` correctly defined and configured on the Project could only make it work by launching Specrails from a terminal. Raising the timeout alone is not acceptable, because the probe is `spawnSync` on the server's event loop.

## What Changes

- **Asynchronous probe.**
  - Desktop probes the login shell for the configured names asynchronously, when the project opens, when its configured names change, and before a cached result expires.
  - The probe gets a generous budget: 10 s by default, configurable through `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS`.
  - Spawn-time resolution reads the warm cache. It runs the synchronous probe, at its current short budget, only as a cold fallback.
- **Sentinel-based acceptance.** The probe accepts the value whenever the sentinel block is complete, whatever the shell's exit status. A non-zero status is recorded only as a diagnostic.
- **Per-name status, without values.** Each configured name gets a resolution status:
  - `inherited`: present in the process environment;
  - `recovered`: found in the login shell;
  - `not-defined`: the probe succeeded but the shell does not define the name;
  - `probe-timeout`;
  - `probe-failed`: spawn error, or the sentinel is missing.

  A project endpoint exposes these statuses, together with the shell path and the last-check time. Values are never exposed.
- **Visible in the UI.** The Project's environment section shows each name's status, with a "Check again" action. A localized hint explains what each failure means.
- **Visible in runs.** When a run spawns with a configured name unresolved, the run log gets one warning line naming the variable and its status. The value is never printed.
- **Cache policy.**
  - Successful recoveries stay valid for 10 minutes, and the background refresh keeps them current.
  - Failed or empty results keep the 30 s retry window.
  - Credentials stay project-scoped, are never written to `process.env`, and are never persisted.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `project-runtime-environment`: the login-shell recovery requirement changes in four ways. The probe becomes asynchronous with a larger budget and sentinel-based acceptance. Success and failure get distinct cache lifetimes. Each name gets an observable resolution status. Unresolved configured names are reported in the run log.

## Impact

- **Server:**
  - `server/path-resolver.ts`: adds the async probe and sentinel acceptance.
  - `server/project-env.ts`: adds the status cache, background refresh and status reader.
  - `server/project-registry.ts`: warms the cache when the project opens or its settings change.
  - Adds a new project route, `GET /api/projects/:id/env-passthrough/status` (plus a `POST` to recheck), mounted with the other project-settings routes.
  - The run-log warning goes where the loop and queue spawn environments are built (`queue-manager.ts`, `resolveLoopBaseEnv` call sites).
- **Client:** status chips and the "Check again" action in `ProjectSettingsSections.tsx`, with strings in all 8 locales.
- **MCP:** the `env` tool can include the statuses (names only).
- **Security:** the status payload and the logs contain names and states only, never values.
