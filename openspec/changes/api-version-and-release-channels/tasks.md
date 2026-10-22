## 1. API versioning

- [x] 1.1 `server/api-version.ts`: `API_VERSION`, header middleware; mount before every `/api` router; expose via CORS; `apiVersion` on `/api/health`
- [x] 1.2 `GET /api/meta` in the desktop router
- [x] 1.3 CLI `--status` prints `api: vN`; MCP `specrails_support` `api_meta` action
- [x] 1.4 Policy in API reference (ledger) and CONTRIBUTING

## 2. Update channels

- [x] 2.1 `server/update-channel.ts` + desktop setting `update_channel` through `/api/settings`
- [x] 2.2 Core update manager resolves the channel dist-tag with 404-only fallback and channel-scoped cache
- [x] 2.3 Native `check_app_update(channel)` command (`src-tauri/src/app_updates.rs`)
- [x] 2.4 Client: `lib/app-updater.ts`, `UpdateChannelSection`, channel-aware app check, Core fallback note, 8 locales
- [x] 2.5 `promote-stable.yml` + `release-policy.mjs stable-promotion`

## 3. Docs and verification

- [x] 3.1 `docs/ci-cd.md` update channels, user guide `settings/6-updates.md` (8 locales), CLI/MCP docs
- [x] 3.2 Tests: header, `/api/meta`, setting persistence, Core channel resolution, endpoint parity, promotion guard, client setting
- [x] 3.3 typecheck, targeted server/client suites, `test:scripts`, `cargo check`/tests, architecture audit, source map
- [ ] 3.4 After merge: run `Promote Stable` once for a release ≥ 7 days old; smoke the Stable channel in a packaged build
