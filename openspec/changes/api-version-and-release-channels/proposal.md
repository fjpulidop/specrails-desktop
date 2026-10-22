## Why

Teams adopting Specrails across an organisation need to update without surprises (feedback 2026-10,
task 4.3). Today every `/api` client (desktop UI, CLI, MCP bridge, Companion, scripts) has no way to
know which HTTP contract it is talking to, there is no written rule for when that contract may break,
and every user receives every release the moment it ships: the updater only knows
`releases/latest/download/latest.json` and the Core update check only reads npm `latest`.

## What Changes

- Every `/api` response carries `X-Specrails-Api-Version: 1` (middleware mounted before any `/api`
  router, exposed to allowed CORS origins). `/api/health` adds `apiVersion` (additive).
- New authenticated `GET /api/meta` → `{ apiVersion, appVersion, coreVersion, contractSchemaVersion,
  channel, updateManifestUrl }`. The CLI `--status` prints `api: vN`; the MCP `specrails_support` tool
  gains a read-only `api_meta` action.
- Written API policy (API reference + CONTRIBUTING): additive changes keep the version, `apiVersion`
  is bumped only on breaking changes, deprecated routes/fields are announced under "Deprecations" in
  CHANGELOG, recorded in a ledger and kept for at least two minor releases.
- Update channels `latest` (default, unchanged behaviour) and `stable`, chosen in App settings ▸
  Updates and stored as the app setting `updateChannel`.
  - Desktop: `stable` reads `releases/download/stable/latest.json`, a moving GitHub **pre-release**
    whose assets are copies of a promoted version's signed updater manifest. A native command
    `check_app_update(channel)` rebuilds the updater with the channel endpoint and returns the stock
    plugin `Update`.
  - Core: `stable` reads the npm `stable` dist-tag and falls back to `latest` (reported as
    `channelFallback`) only when that tag does not exist yet.
- New `workflow_dispatch` workflow `promote-stable.yml`, gated by `release-policy.mjs
  stable-promotion`: published non-prerelease `vX.Y.Z` with `latest.json`, released ≥ 7 days ago,
  green main push CI for its exact commit, no backwards move unless `allow_rollback`.

## Capabilities

### New Capabilities
- `desktop-api-versioning`: API version header, `/api/meta`, and the versioning/deprecation policy.
- `desktop-update-channels`: `latest`/`stable` channel setting for Desktop and Core updates and the
  stable promotion workflow.

### Modified Capabilities

## Impact

- Server: `server/api-version.ts`, `server/update-channel.ts`, `server/index.ts`,
  `server/desktop-router.ts`, `server/desktop-db.ts`, `server/core-update-manager.ts`,
  `server/mcp/tools/support.ts`, `server/mcp/guide.ts`.
- Native: `src-tauri/src/app_updates.rs`, `src-tauri/src/lib.rs` (new command, no new crate).
- Client: `client/src/lib/app-updater.ts`, `UpdateChannelSection`, `AppUpdateSection`,
  `CoreUpdateSection`, `useDesktopUpdateNotifier`, settings locales (8).
- CLI: `cli/status.ts`.
- Release: `.github/workflows/promote-stable.yml`, `scripts/release-policy.mjs`.
- Docs: API reference, CONTRIBUTING, `docs/ci-cd.md`, `docs/cli.md`, `docs/mcp.md`, user guide
  `settings/6-updates.md` (8 locales).
- No migration (key/value app setting), no response field removed, `tauri.conf.json` unchanged.
