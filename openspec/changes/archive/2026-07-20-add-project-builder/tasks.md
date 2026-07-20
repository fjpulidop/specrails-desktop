# Tasks — add-project-builder

## 1. Protocol + persistence foundations (server)

- [x] 1.1 Create `server/blueprint-types.ts` (Blueprint schema types: product, coreFlow, platform, stack, assumptions, milestones with `planned|committed|done`, `specsComplete`, rich m1Specs with kind/short summary/canonical description/separate acceptance criteria/priority/labels/dependency, plus legacy v1 read defaults) + `server/blueprint-draft-parser.ts` (fenced `blueprint-draft` extraction, full-snapshot last-valid-wins, streaming tail cut, unknown-key drop, `blueprintVersion` gate) adapting `spec-draft-parser.ts` mechanics; unit tests for all parse scenarios
- [x] 1.2 Create `server/blueprint-render.ts`: deterministic `blueprint.md` render from `blueprint.json` (pattern: `renderContractLayerMarkdown`) + `writeBlueprintPair(workspaceDir, blueprint)` (json + md, temp+rename); byte-stability test
- [x] 1.3 Desktop-db migration: `blueprint_conversations` / `blueprint_messages` tables (shape of `agent_conversations`/`agent_messages`) + CRUD in a new `server/blueprint-store.ts`; tests with `:memory:`

## 2. Day-0 Builder chat (server)

- [x] 2.1 Create `server/builder-cwd-manager.ts` (`~/.specrails/builder-cwd/`, always-rewritten instruction file, no project symlink, no MCP) mirroring `agent-cwd-manager.ts`
- [x] 2.2 Create `server/blueprint-chat-manager.ts`: `BlueprintChatManager` reusing `runAiCliInvocation`; system prompt module `server/blueprint-operator-prompt.ts` (interview discipline ≤3 question turns, propose-don't-ask, "surprise me" proposal, approval before detailed generation, complete 5–10-spec M1 in one response/snapshot with no partial waves, scaffold-first, exact normal-spec headings with ≥2 Out-of-Scope/Technical bullets, separate 4–10 criteria, summary/kind/priority/labels/completion/dependency rules, truthful day-0 grounding); WS `blueprint.stream|done|error` (app-global, NOT in mobile-ws translation); `recordAgentInvocation` with `project_id NULL` on every settle path
- [x] 2.3 REST `server/blueprint-router.ts` mounted at `/api/blueprint` (gated `SPECRAILS_PROJECT_BUILDER !== 'false'`): conversations CRUD, `/send` 202, `/models` catalog passthrough; provider/model selection plus validated per-turn reasoning effort mirroring agent-chat; route tests

## 3. Orchestrated commit (server)

- [x] 3.1 Extract assemble from `SetupManager.startInstall` into shared callable `assembleProjectOffline(projectPath, slug, providers[])` (extract-don't-fork; prefer bundled core; allow `npx specrails-core` only in dev/non-desktop runtimes; packaged desktop without a valid bundle fails early); wizard tests stay green
- [x] 3.2 Create `server/blueprint-commit.ts`: `executeBlueprintCommit(deps, input)` with DI IO bag (pattern: `rail-pr-decision.ts`) — sync validation (location empty-or-absent, providers, schema + `specsComplete` + 5–10 m1Specs + shared canonical rich-spec quality gate + scaffold-first, framework availability under the desktop/dev policy, no registry entry) then ordered steps: mkdir → `git init -b main` + deterministic README from pitch + initial commit → registry allocate + assemble → write blueprint pair → insert M1 tickets (`mutateStore`, `todo`, label `M1`, Builder source/provenance, priority/summary/domain labels, criteria folded once, dependencies mapped, advisory ticketIds back into blueprint.json) → `ProjectRegistry.addProject` LAST → best-effort `gh repo create --private --source . --push`; per-step `blueprint.commit_progress` + terminal `commit_done|commit_failed` WS
- [x] 3.3 Wire `POST /api/blueprint/commit` (202) into `blueprint-router.ts`; unit tests: validation rejections, register-last crash posture (fail injection per step), gh-failure-never-aborts, offline assemble, ticket order + advisory ids

## 4. Client — chooser + Builder shell

- [x] 4.1 Add Existing|New pre-screen to `AddProjectDialog` (two cards; flag-gated `VITE_FEATURE_PROJECT_BUILDER`, off ⇒ direct Existing); Existing path byte-identical; component tests
- [x] 4.2 Create `client/src/lib/blueprint-draft.ts` (client mirror parser, last-valid-wins, tail cut) + tests
- [x] 4.3 Create `ProjectBuilderShell` (chat + live blueprint panel — five dimension ✓/✗ rows, complete rich spec set revealed atomically with summary/priority/criteria review, "surprise me" chip on turn 1, provider/model bar); WS wiring for `blueprint.stream|done|error`; invalid-block-keeps-panel behavior
- [x] 4.4 Commit mini-form (name prefill, location default `~/projects/<slug>`, provider multi-select reuse, gh checkbox gated on prerequisites `gh` present+authenticated) + streamed progress view consuming `blueprint.commit_progress`; success screen with "Launch Milestone 1" CTA (skippable)

## 5. Client — milestone lifecycle

- [x] 5.1 "Launch Milestone 1" action: gather M1-labeled `todo` tickets → one rail (create via `POST /rails` if needed) → batch-implement launch via existing rails REST; existing 409 guards surface as toasts
- [x] 5.2 Sidebar Builder entry (board + mission modes, active project only, visible iff workspace `blueprint.json` exists — new `GET /api/projects/:projectId/blueprint` read endpoint): per-milestone progress derived live from board tickets by `M<n>` label, Launch M1 + Generate M<next> actions
- [x] 5.3 "Generate M2+" path: project-level conversation `kind='milestone'` through existing ChatManager (provider-equivalent milestone prompt seeded with blueprint.json + target `plannedSpecs` + canonical rich-spec and verified-code grounding contracts, returning the complete target milestone set in one response/snapshot; `blueprint-draft` protocol out; accounting `surface='explore-spec'`); atomic shared quality gate before commit; insert `M<n>` tickets with M1-parity priority/summary/domain labels/folded criteria/dependencies and Builder source/provenance + flip milestone `status='committed'` + re-render blueprint.md; Jira rides existing machinery

## 6. i18n + docs + gates

- [x] 6.1 New `builder` i18n namespace across all 8 locales (chooser, shell, panel, mini-form, progress steps, sidebar entry, toasts); key-parity test green
- [x] 6.2 Update CLAUDE.md (Project Builder section) + `docs/internals/project-builder.md` (as-built: protocol, commit ordering, crash posture) + in-app guide pages if applicable
- [x] 6.3 Full gates: `npm run typecheck`, `npm test`, `npm run test:coverage` (server ≥80%), `cd client && npm run test:coverage` (client ≥80%); iterate tests until green
