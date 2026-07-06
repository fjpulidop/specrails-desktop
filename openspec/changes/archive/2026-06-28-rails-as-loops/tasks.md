## 1. Catalog commands, ticket scope, and tokens (additive — no behaviour change yet)

- [x] 1.1 Add `{{cmd:batch}}` to `server/loop-command-catalog.ts` as a `coreCommand: 'batch-implement'` (native per-provider: claude `/specrails:batch-implement`, codex `$batch-implement`).
- [x] 1.2 Add a NATIVE command kind to the catalog and register `{{cmd:freestyle}}` — expands to a raw autonomous prompt (NOT a slash command); flagged claude-only. (Factory freestyle routes to QueueManager's real `_buildFreestylePrompt` in §3; this is the custom-loop fallback prompt.)
- [x] 1.3 Add `ticketScope: 'all' | 'per-ticket'` to `LoopCommand` (implement/batch=`all`, freestyle=`per-ticket`) + `dominantTicketScope()` + `referencesClaudeOnlyCommand()` helpers.
- [x] 1.4 Add the `{{spec.ids}}` token (all rail ticket ids → `#1 #2 #3`) to `interpolateSpec` + `LoopSpec.ticketIds`; `{{spec.id}}` stays the single-ticket token. `expandCommands` now embeds all ticket ids for `all`-scope commands.
- [x] 1.5 Unit tests: catalog expansion (implement/batch all-ids, codex `$`, freestyle raw), scope + claude-only helpers, `{{spec.ids}}` vs `{{spec.id}}`. 46 server tests green, typecheck clean.

## 2. Factory loops (the first deliverable)

- [x] 2.1 Define the `implement`, `batch`, `freestyle` factory loops in `server/loop-factory.ts` (graphs via `aiLoopGraph` using `{{cmd:implement}}`/`{{cmd:batch}}`/`{{cmd:freestyle}}` + `{{cmd:verify}}`); each carries its canonical rail `mode` + id `factory:<name>` + claudeOnly for freestyle; helpers `getFactoryLoop`/`isFactoryLoopId`/`factoryLoopMode`/`factoryLoopForMode`. 5 tests; graphs validate.
- [x] 2.2 Surface factory loops in the gallery: `GET /api/loops/factory` (registered BEFORE `/loops/:id`); `LoopsPage` renders a "Built-in" section — locked cards (no Edit/Delete/Publish) with Preview (reuses `TemplatePreviewModal`) + Fork. i18n `sections.builtIn`/`builtInBadge`/`actions.fork` ×8.
- [x] 2.3 "Fork to edit": `POST /api/loops/factory/:id/fork` clones the factory graph into a new user Draft; `LoopsPage` Fork button → opens the new draft in the builder; factory unchanged.
- [x] 2.4 Tests: factory graphs validate (loop-factory.test); router lists factory loops + fork→draft + 404 + route-ordering (loops-router.test, 24); LoopsPage built-in section + fork (LoopsPage.test, 39). parity green.

## 3. Rail loop resolution + execution routing + back-compat

- [x] 3.1 Resolver `loop-factory.ts` maps factory loop ⇄ legacy `mode` both ways (`factoryLoopMode` / `factoryLoopForMode`); used by the launch.
- [x] 3.2 Legacy `mode`-only launches are unchanged (mode path untouched) → back-compat preserved with no data migration. (Client maps `mode`→factory loop for the picker's selected value in §4.)
- [x] 3.3 Launch routing in `rails-router`: a `factory:*` loopId resolves to its legacy mode → existing QueueManager path (unchanged); a custom loopId stays `mode='loop'` → `LoopRunManager`.
- [x] 3.4 Command ticket scope honoured at launch: `all` → ONE run with `spec.ticketIds` = all rail tickets (`{{spec.ids}}`); `per-ticket` → one run per ticket. Engine passes `ticketIds` to `expandCommands`.
- [x] 3.5 Claude-only guard: a custom loop referencing a claude-only command (`{{cmd:freestyle}}`) on a non-claude rail → 400. (Factory freestyle keeps the existing `mode==='freestyle'` claude guard.)
- [x] 3.6 `rails.mode` + REST `mode` + frozen mobile wire intact (bare `mode` still accepted unchanged). Server tests: factory→mode routing, `res.body.mode` derivation, all-scope one-run + `spec.ticketIds`, claude-only guard (rails-router.test, 47).

## 4. Rail UI — Loop picker replaces the mode selector

- [x] 4.1 `RailControls` mode segmented control removed; `RailLoopSelector` is now the unified Loop picker (factory built-ins from a client constant + published custom loops), always shown when idle (`RailRow` both density blocks); `effectiveLoopId` resolves the picker value from selectedLoopId/mode.
- [x] 4.2 provider + effort selectors kept; `handleLoopChange` writes `selectedLoopId` AND the derived `mode` (`deriveRailMode`); `doLaunchRail` always sends `loopId = effectiveLoopId(...)`.
- [x] 4.3 Play guarded until an effective loop exists; Freestyle built-in hidden on non-claude rails + `handleEngineChange` falls the rail back to Implement when leaving claude on Freestyle.
- [x] 4.4 i18n `railControls.builtInLoops`/`customLoops` ×8 (parity green); built-in names reuse existing `railControls.implement|batch|freestyle`.
- [x] 4.5 Client tests: RailLoopSelector (built-ins always, freestyle gating, custom-when-enabled, onChange), rail-loops helpers (mode⇄id round-trip), RailControls (segmented control gone), all 19 page suites (211) green.

## 5. Standalone run for ticket-less loops

- [x] 5.1 `loopNeedsTicket(graph)` (client `lib/loop-ticket-need.ts`) — true on `{{spec.*}}` or `{{cmd:implement|batch|freestyle}}`; tested.
- [x] 5.2 Loops-page "Run" on ticket-less published loops → `LoopRunModal` (project + provider[multi] + effort[supported] + Execute) → `loopsApi.runStandalone` → switch to that project + open the job log.
- [x] 5.3 Server `POST /api/projects/:projectId/loop-runs` (`project-router-loop-runs.ts`): published-loop guard + claude-only guard + `LoopRunManager.run` with `railIndex:null`/`ticketId:null` → job in that project. `onLoopRunFinished` no-ops gracefully without a rail.
- [x] 5.4 "Run" hidden for ticket-needing loops (they route to a rail); i18n `actions.run` + `run.*` ×8 (parity green); tests: loop-ticket-need (client), LoopRunModal (client), standalone run route (server, 5).

## 6. Verification

- [x] 6.1 `npm run typecheck` (server + client) clean.
- [x] 6.2 Coverage gates pass: server `test:coverage` EXIT=0 (86.8% lines / 88% funcs / 76% branch) and client `test:coverage` EXIT=0 (85.16% lines/stmts, 80.99% branch, 72% funcs). 241 client files / 2776 tests green.
- [x] 6.3 `openspec validate rails-as-loops --strict` passes.
- [ ] 6.4 Manual smoke (USER): a rail with the Implement built-in runs `/specrails:implement` over all rail tickets; a ticket-less custom loop runs from the Loops page "Run"; a legacy `mode`-only rail still launches. (Requires `npm run dev` restart to load the new server code.)
