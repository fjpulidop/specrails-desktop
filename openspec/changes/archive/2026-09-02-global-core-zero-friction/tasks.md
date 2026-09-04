# Tasks — global-core-zero-friction

## 1. Provider auto-detection (server)

- [x] 1.1 Create `server/provider-detection.ts`: singleton probing all registered adapters (PATH presence, `--version`, per-provider auth probe with 1500ms timeout → `authState`), 60s cache, beta-veto filtering at source
- [x] 1.2 Add `GET /api/providers/detected` (`?refresh=1` bypasses cache) + refresh on startup and `POST /api/projects`; broadcast app-global `providers.detected_changed` only on set change
- [x] 1.3 Rewire `server/provider-selection.ts` (`resolveProvider`, `validateRequestedProvider`, `isProviderEnabled`, `isMultiProvider`) to the detected set; primary derivation rule (stored-while-detected → claude → fixed order) with fallback notice on spawn for stale stored engines
- [x] 1.4 Backfill `projects.providers` reads to mirror the detected set (mapProjectRow shim, wire compat, no schema migration); keep POST accepting `provider`/`providers` for compat per delta spec
- [x] 1.5 Unit tests: detection cache/veto/auth-degrade, primary derivation, stale-engine fallback, POST compat behavior

## 2. Capability union (client)

- [x] 2.1 Flip `client/src/lib/provider-capabilities.ts` `sectionVisibleForProviders` from `every` to `some`; sweep all callsites; key single-provider selector suppression on detected-set size
- [x] 2.2 Client detection state: fetch detected set + subscribe to `providers.detected_changed` + focus-refresh (usePrerequisites pattern); feed engine selectors (`AiEngineSelector`, `RailEngineSelector`, `CliLaunchMenu`) from it, filtered per section capability; auth badge ("not signed in") on unauthenticated providers
- [x] 2.3 Client tests: union visibility, selector filtering, single-provider invariant, auth badge

## 3. Silent project add

- [x] 3.1 Server: `SetupManager.startSilentAssemble(projectId)` — background sequential `assembleProjectOffline` per detected provider; `project.assemble_progress` WS event; per-provider failure isolation + retry route reuse; lazy assemble hook for newly detected providers (spawn-time ensure)
- [x] 3.2 `POST /api/projects` registers-first then triggers silent assemble; never rolls back registration on assembly failure
- [x] 3.3 Client: strip provider checkboxes from `AddProjectDialog` (path + prereqs only); delete `SetupWizard.tsx` + checkpoint tracker + setup-chat phase UI; retire `setupProjectIds` in `useDesktop`; project card subtle assembling→ready indicator + failure badge with retry
- [x] 3.4 Re-home wizard Done-step hints: Jira CTA reachable from Settings + WelcomeScreen hint; MCP/agent-chat hints on WelcomeScreen; delete dead `setup` i18n keys, add new ones ×8 locales
- [x] 3.5 Prune dead setup routes/plumbing in `project-router-setup.ts`/`desktop-router.ts` (keep server-side enrich/standalone paths); tests: register-first, progress events, partial failure, retry

## 4. Legacy migration

- [x] 4.1 New `server/legacy-migration.ts`: startup scan (non-relocated + repo `.specrails/specrails-version`), kill switch `SPECRAILS_LEGACY_MIGRATION`, serialized background runner
- [x] 4.2 State move repo→workspace (profiles, local-tickets.json, backlog-config.json, state, file-summaries, plugins, agent-memory) preserving function; registry entry write
- [x] 4.3 Manifest builder from bundled framework listing + app-owned `.specrails/` leftovers; hard-excludes (`openspec/**`, worktrees, `custom-*`, user instruction files, non-owned `.mcp.json` keys — surgical removal via plugin helpers)
- [x] 4.4 Write-ahead journal `migration-log.json` (planned → executed), fail-open abort, resumable re-run of unexecuted entries; single non-blocking warning surface
- [x] 4.5 Tests over fixture repos: user files planted among framework files, carve-outs, mcp surgical cleanup, crash-resume, kill switch, ticket survival

## 5. Framework auto-update + re-seed

- [x] 5.1 Startup auto-swap in `FrameworkManager` (`versionCheck` → materialize → `swapCurrent` under registry lock), kill switch `SPECRAILS_FRAMEWORK_AUTOSWAP`, retain `framework.updated` broadcast; demote GlobalSettings flow to manual "check now"
- [x] 5.2 Re-seed pass: per relocated workspace regenerate instruction files (project name preserved), refresh Windows copy-fallback subtrees, re-link Kimi per-child skills; surgical `.mcp.json` framework-key update (never wholesale); record per-workspace framework version; run when recorded ≠ current
- [x] 5.3 Tests: swap idempotence, in-flight version pinning untouched, re-seed idempotence, plugin/user `.mcp.json` key preservation, missed-swap repair, rollback by re-pointing current

## 6. Verification & docs

- [x] 6.1 Full gates: `npm run typecheck`, `npm test`, server+client coverage thresholds
- [x] 6.2 Update CLAUDE.md (setup wizard section → silent add; multi-provider per project → detection; artifact relocation notes) + docs (`docs/internals/*` touched surfaces, user guide setup pages ×8 langs)
- [ ] 6.3 Manual smoke: add project offline, install a new provider CLI + focus refresh, legacy fixture migration, framework version bump swap+re-seed
