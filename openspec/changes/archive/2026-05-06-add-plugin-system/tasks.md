## 1. Plugin types & registry scaffolding

- [x] 1.1 Add `Plugin`, `PluginManifest`, `PluginOwnership`, `PluginState`, `PluginVerifyResult`, `PluginInstallContext`, `PluginPreviewResult` types in `server/types.ts`
- [x] 1.2 Create `server/plugins/paths.ts` exporting helpers for `<project>/.specrails/plugins/state.json`, `<project>/.specrails/plugins/snapshots/<jobId>.json`, and `~/.specrails/projects/<slug>/jobs/<jobId>/plugins.json`
- [x] 1.3 Create `server/plugins/index.ts` that exports a `BUNDLED_PLUGINS: Plugin[]` array (initially empty)
- [x] 1.4 Create `server/plugins/ownership.ts` with `buildOwnershipMap(plugins)` that fails fast on overlapping `mcpServers` / `agentFragments` / `configKeys` entries
- [x] 1.5 Unit-test `ownership.ts` for: no plugins, one plugin, two non-overlapping plugins, two overlapping plugins (asserts the thrown error names both plugins and the conflicting key)

## 2. PluginManager

- [x] 2.1 Create `server/plugin-manager.ts` exporting a `PluginManager` class taking `(registry, projectRegistry)` in its constructor
- [x] 2.2 Implement `listAvailable(projectId): Promise<CatalogEntry[]>` that merges the registry with `state.json`, marking entries `installed | not-installed | orphan | degraded`
- [x] 2.3 Implement `getProjectState(projectId): Promise<PluginState>` reading `state.json` (returns empty object when missing)
- [x] 2.4 Implement `previewInstall(projectId, name): Promise<PluginPreviewResult>` describing creates/modifies without mutating any file
- [x] 2.5 Implement `install(projectId, name, onLog)` with: prereq check, snapshot pre-mutation file bytes, run `Plugin.install`, run `Plugin.verify`, on failure restore snapshots; on success, write `state.json` entry with `installedFiles` list; emit `plugin.installed` WS event via the project broadcaster
- [x] 2.6 Implement `uninstall(projectId, name, onLog)` that runs `Plugin.uninstall`, removes the `state.json` entry, and emits `plugin.uninstalled`
- [x] 2.7 Implement `verify(projectId, name, opts?)` with default 2000ms timeout, returning `{ ok, reason, checkedAt }` and emitting `plugin.health_changed` when state transitions
- [x] 2.8 Implement `removeOrphan(projectId, name)` that deletes a `state.json` entry whose plugin no longer exists in the registry
- [x] 2.9 ~~Add `proper-lockfile` to `package.json`~~ — replaced with in-process mutex (Map<path, Promise>) in `json-mutation.ts`. Hub is single-process; cross-process locking would only matter for multi-process deployments. Documented in module header.
- [x] 2.10 Implement `surgicalMergeJson(filePath, mergeFn)` and `surgicalRemoveKeys(filePath, keysToRemove)` helpers in `server/plugins/json-mutation.ts` (read → modify → temp-write → rename, lockfile held throughout)
- [x] 2.11 Vitest suite `server/plugin-manager.test.ts`: install creates state, install rolls back on verify failure (asserts byte-equality of `.mcp.json` before/after), uninstall removes only owned keys, concurrent installs serialize, orphan detection
- [x] 2.12 Vitest suite for `surgicalMergeJson` covering: empty file, missing file, malformed JSON, concurrent writers, crash mid-rename (simulated)

## 3. REST router

- [x] 3.1 Create `server/plugins-router.ts` mounted at `/api/projects/:projectId/plugins`
- [x] 3.2 Implement `GET /` → catalog with per-plugin status
- [x] 3.3 Implement `GET /:name/preview-install` → diff describing planned changes
- [x] 3.4 Implement `POST /:name/install` → kicks off install, streams progress over WS using project broadcaster
- [x] 3.5 Implement `DELETE /:name` → uninstall (or orphan removal)
- [x] 3.6 Implement `GET /:name/health` → on-demand verify
- [x] 3.7 Mount the router from `server/index.ts` (alongside profiles router)
- [x] 3.8 Wire feature gate `SPECRAILS_PLUGINS_SECTION` (default on, parity with profiles router)
- [x] 3.9 Vitest suite `server/plugins-router.test.ts` covering: 200 happy paths, 404 for unknown plugin, 409 (or specific error code) for ownership conflict with user-authored MCP entry, 500 on install failure rolling back

## 4. Prerequisites: add `uv` detection

- [x] 4.1 Extend `server/setup-prerequisites.ts` with a `uv` detector (`uv --version`, parse semver, set `installed/executable/version/meetsMinimum`)
- [x] 4.2 Extend `InstallInstructionsModal` (client) with OS-aware install commands for `uv` (Homebrew, winget, curl/pip fallback) reusing the existing pattern
- [x] 4.3 Extend `setup-prerequisites.test.ts` with `uv`-present and `uv`-missing fixtures

## 5. QueueManager rail integration

- [x] 5.1 Add `resolvePluginsForSpawn(projectId, jobId, cwd)` private method in `server/modules/execution/runtime/queue-manager.ts`: read state, run `verify` per plugin in parallel with timeout, classify into `active` / `degraded`
- [x] 5.2 Add `snapshotPluginsForJob(jobId, projectId, active, degraded)` writing to `~/.specrails/projects/<slug>/jobs/<jobId>/plugins.json` (chmod 400)
- [x] 5.3 In the existing spawn path, call `resolvePluginsForSpawn` after profile resolution and before the `claude` spawn
- [x] 5.4 Inject `SPECRAILS_PLUGINS_ACTIVE` (CSV of names) and `SPECRAILS_PLUGINS_SNAPSHOT` (absolute path) into the spawn env when `active.length > 0`
- [x] 5.5 Add `specrails.plugins.active`, `specrails.plugins.degraded`, `specrails.plugins.versions` to the OTEL resource attrs builder (only when applicable)
- [x] 5.6 Emit `plugin.degraded` with `{ projectId, name, reason, jobId }` for each degraded plugin in this spawn
- [x] 5.7 Vitest in `server/modules/execution/runtime/queue-manager.test.ts`: spawn with no plugins (no env, no OTEL attr, no snapshot), spawn with healthy Serena (env set, snapshot file present with chmod 400, OTEL attrs include `serena`), spawn with degraded Serena (still spawns, `degraded` array populated, snapshot still written)
- [x] 5.8 Verify (test) that `ChatManager` does not call `resolvePluginsForSpawn` and does not set `SPECRAILS_PLUGINS_*` env vars
- [x] 5.9 Verify (test) that `SetupManager` does not invoke any `PluginManager` method during the wizard flow

## 6. Diagnostic export

- [x] 6.1 In `server/modules/accounting/runtime/telemetry-export.ts`, conditionally include `plugins.json` in the ZIP when the per-job snapshot exists
- [x] 6.2 Add a "Plugins" section in the generated `summary.md` that lists active and degraded plugin names + versions; render nothing if no snapshot
- [x] 6.3 Vitest in `server/modules/accounting/runtime/telemetry-export.test.ts`: ZIP includes `plugins.json` when snapshot exists, omits it otherwise; `summary.md` mentions plugins only when snapshot exists

## 7. WebSocket events

- [x] 7.1 Add `plugin.installed`, `plugin.uninstalled`, `plugin.health_changed`, `plugin.degraded` to the WS message-type union in `server/types.ts`
- [x] 7.2 Use the existing `boundBroadcast` (project-scoped) inside `PluginManager` and `QueueManager` paths
- [x] 7.3 Vitest assertions in plugin-manager + queue-manager suites that the right events fire with the right payloads

## 8. Serena plugin

- [x] 8.1 Create `server/plugins/serena/manifest.ts` with the manifest defined in the serena-plugin spec
- [x] 8.2 Create `server/plugins/serena/install.ts` that surgical-merges `mcpServers.serena` into `.mcp.json` and (optionally) writes `templates/instructions.md` to `.claude/agents/custom-serena.md`, recording every created/modified path in the install context
- [x] 8.3 Create `server/plugins/serena/verify.ts` running `uvx serena --version` with a 2000ms timeout, returning `{ ok, reason }`
- [x] 8.4 Create `server/plugins/serena/uninstall.ts` that surgically removes `mcpServers.serena` and deletes only files recorded as `installedFiles` for serena
- [x] 8.5 Create `server/plugins/serena/index.ts` exporting the assembled `Plugin` value, and register it in `server/plugins/index.ts`
- [x] 8.6 Optional: create `server/plugins/serena/templates/instructions.md` (skip in v1 if scope shrinks; verify uninstall path handles "no fragment shipped")
- [x] 8.7 Vitest `server/plugins/serena/install.test.ts`: install on fresh project, install preserving user-authored `mcpServers.myown`, install over an existing project-managed `serena` entry (idempotent), uninstall surgical
- [x] 8.8 Vitest `server/plugins/serena/verify.test.ts` mocking `child_process.spawn` for the four verify reasons (`ok`, `uv-not-on-path`, `uvx-non-zero-exit`, `verify-timeout`)

## 9. Client: IntegrationsPage

- [x] 9.1 Add `IntegrationsPage.tsx` to `client/src/pages/`, route `/integrations` mounted under `ProjectLayout`, sidebar entry next to Agents
- [x] 9.2 Add `useIntegrationsCatalog(activeProjectId)` hook backed by `useProjectCache` (stale-while-revalidate)
- [x] 9.3 Build `PluginCard` component (icon, name, version, description, `whatItDoes`, requirements with live satisfied/missing badges, primary action by status)
- [x] 9.4 Build `PluginInstallDialog` (preview-install fetch on open, prereq panel reusing `PrerequisitesPanel`, streaming log driven by WS, confirm disabled until prereqs satisfied)
- [x] 9.5 Build `PluginDiffPreview` rendering `+ create` / `~ modify` lines from the preview response
- [x] 9.6 Build `PluginUninstallDialog` (destructive style, "Will revert" / "Will NOT touch" lists, explicit confirm)
- [x] 9.7 Render orphan section below the active catalog with "Remove orphan" action
- [x] 9.8 Wire WS event handlers (`plugin.installed`, `plugin.uninstalled`, `plugin.degraded`, `plugin.health_changed`) using the existing `projectId` ref filter pattern
- [x] 9.9 Empty state, error state with Retry, loading skeleton cards
- [x] 9.10 Vitest + Testing Library suite for `IntegrationsPage`: cards render per status, install dialog calls preview before mutation, prereqs gate the confirm button, uninstall confirm flow, orphan section appears, WS event filtering by projectId
- [x] 9.11 Visual sanity check in dev (`npm run dev`) — flow once through install + uninstall against a scratch project, confirm tokens use semantic theme tokens (no `dracula-*` regression)

## 10. Coverage and CI

- [x] 10.1 Run `npm run typecheck` and `npm test` locally, fix any failures
- [x] 10.2 Run `npm run test:coverage` (server) and ensure ≥ 80% lines/functions/statements, ≥ 70% branches; iterate with extra tests until thresholds clear
- [x] 10.3 Run `cd client && npm run test:coverage` and ensure ≥ 80% lines/statements, ≥ 70% functions; iterate with extra tests if needed
- [x] 10.4 Ensure no new entries in `vitest.config.ts` exclude lists; if any are needed, document inline why they are structurally unreachable in the test environment

## 11. Documentation and rollout

- [x] 11.1 Update `CLAUDE.md` with a short "Plugins" section describing the per-project plugin system, additivity invariant, and `.specrails/plugins/` layout
- [x] 11.2 Add a one-paragraph note in the project README under "Features" mentioning per-project integrations
- [x] 11.3 Smoke-test the desktop build path: confirm the bundled plugin module is included in the sidecar bundle and the server starts on a fresh install with `BUNDLED_PLUGINS` populated
