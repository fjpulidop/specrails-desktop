## Context

`/api` is served by one Express app (`server/index.ts`): host validation, CORS, a few public routes,
`requireAuth`, the desktop router on `/api` and the project router on `/api/projects`. The Tauri
updater endpoint is compiled into `tauri.conf.json`; the JS plugin `check()` cannot override
endpoints. Releases are published by `desktop-release.yml` to GitHub Releases with `latest.json`
(Tauri updater) and `manifest.json` (downloads). Core updates read
`registry.npmjs.org/specrails-core/latest`; Core has no `stable` dist-tag yet.

## Goals / Non-Goals

**Goals:** a cheap, uniform API version signal; a written, enforceable deprecation rule; an opt-in
slower channel for Desktop and Core that reuses signed artifacts; a guarded, manual promotion.

**Non-Goals:** API versioning by URL prefix; automatic promotion; per-project channels; publishing
Core's `stable` dist-tag (Core's half of task 4.3).

## Decisions

1. **Header middleware before every `/api` router.** `app.use('/api', apiVersionHeader)` right after
   CORS so public routes, 401s and 404s are stamped too; CORS exposes the header. A source-order test
   guards the mount position because `server/index.ts` is coverage-excluded.
2. **`/api/meta` lives in the desktop router, behind auth**, next to the Core update manager it reads.
   `/api/health` (public) only gains `apiVersion`; no existing field changes.
3. **Stable pointer = moving GitHub pre-release `stable`.** Promotion copies the promoted version's
   `latest.json`/`manifest.json` (URLs still point at that version's signed assets) plus
   `stable.json`. Alternatives rejected: a non-prerelease `stable` release would become the
   repository's "latest" release and break the `latest` channel and specrails.dev; re-tagging or
   rebuilding would require re-signing; a separate hosting endpoint reintroduces a second channel.
4. **Channel-aware native check instead of a config change.** `check_app_update(channel)` builds the
   updater with `updater_builder().endpoints([url])`, checks, stores the `Update` in the webview
   resource table and returns the same metadata as the plugin's `check`, so the JS `Update` class
   downloads/installs through the stock plugin commands with the configured pubkey. `tauri.conf.json`
   keeps the `latest` endpoint. A stable 404 is `stable-channel-unavailable`, never a silent switch.
5. **Core stable falls back only on a missing tag.** A 404 for `stable` uses `latest` with
   `channelFallback: true`; any other failure fails the check. The cached latest version is tagged
   with the channel it was resolved for and is never offered on another channel.
6. **Guard in `release-policy.mjs`.** Pure `assertStablePromotion` + GitHub-backed
   `stablePromotion`, reusing `latestTrustedCiRun` and `assertPromotion`. Inputs reach the shell via
   `env`, never `${{ }}` interpolation.

## Risks / Trade-offs

- Before the first promotion, stable users see "no stable release yet" → documented; maintainers
  promote once after merge.
- release-please (action inputs, no config file) cannot generate a "Deprecations" section → the
  maintainer adds it to the release PR's CHANGELOG as the last edit before merge; the ledger in the API
  reference is the durable record.
- The `stable` tag is created at the first promoted commit and not moved; `stable.json` names the
  promoted commit.
