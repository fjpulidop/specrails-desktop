## 1. Probe

- [x] 1.1 In `server/path-resolver.ts`, add `readEnvFromLoginShell(names, opts)`. It is async and uses `spawn`, with a default timeout of 10 s (`SPECRAILS_LOGIN_SHELL_TIMEOUT_MS`) and a 1 MiB output cap. It returns `{ values, status: 'ok' | 'timeout' | 'failed', exitCode, shell }` and accepts values from a complete sentinel block regardless of exit status.
- [x] 1.2 Make `readEnvFromLoginShellSync` accept a complete sentinel block regardless of exit status, keeping its 1.5 s budget for the cold fallback.
- [x] 1.3 Unit tests with an injected spawn:
  - slow success (async) versus a sync timeout;
  - a non-zero exit with a complete block, which is recovered;
  - a missing sentinel, which is `failed`;
  - a timeout;
  - a banner printed before the block.

## 2. Project cache and status

- [x] 2.1 In `server/project-env.ts`, replace the single cache with per-project, per-name records: `{ status, shell, checkedAt, expiresAt }`, plus values held in memory. Successes expire after 10 minutes and failures after 30 s.
  - Add `refreshProjectEnv(db)` (async, de-duplicated in flight) and `getProjectEnvStatus(db)` (value-free).
  - Keep `resolveWorktreeEnvPassthrough` synchronous. It reads the cache and uses the sync probe only when no record exists.
- [x] 2.2 Warm on project open and on a `worktreeEnvPassthrough` settings change (`project-registry.ts`, project-settings update path). Schedule a refresh before successes expire, while the project is loaded, and stop it when the project unloads.
- [x] 2.3 Tests:
  - a project-scoped cache, so a second project never receives another project's values;
  - a removed name disappears from the status and the spawn environment;
  - a failure is retried after 30 s, and a success stays cached;
  - `process.env` is never mutated.

## 3. API and MCP

- [x] 3.1 Add the project routes `GET /env-passthrough/status` and `POST /env-passthrough/recheck`. Mount them with the project-settings HTTP adapter, preserving route precedence, and document them in `docs/internals/api-reference.md`.
- [x] 3.2 Include the statuses (names and states only) in the MCP `env` tool output.
- [x] 3.3 Add a test that a fixture secret never appears in the route responses, the MCP output or the logs.

## 4. Run-log warning

- [x] 4.1 Where queue, loop and rail spawn environments are built, write one aggregated warning line to the run log when configured names are unresolved, for example `[environment] NODE_AUTH_TOKEN not available (probe-timeout); configure it in the login shell or launch from a terminal`.
- [x] 4.2 Tests in the queue-manager and loop-executor suites, asserting the warning content and that no value appears.

## 5. UI

- [x] 5.1 In `ProjectSettingsSections.tsx` (environment card), fetch the statuses with `getApiBase()`, keyed on `activeProjectId`. Render a status chip and a tooltip explanation per name, plus a "Check again" button that calls recheck.
- [x] 5.2 Add the i18n strings for every status and for the action, in all 8 locales.
- [x] 5.3 Client tests for chip rendering, recheck and project switching (stale responses ignored).

## 6. Docs and verification

- [x] 6.1 Document the recovery, the statuses and `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS` in `docs/internals/configuration.md` and in the user docs for project environment.
- [x] 6.2 Run `npm run typecheck`, the server suites (`project-env`, `path-resolver`, the queue and loop suites) and the client test for the settings section.
