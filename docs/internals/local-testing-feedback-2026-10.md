# Local testing: feedback-2026-10 program

How to run this Desktop branch (`local/feedback-2026-10`, worktree
`/Users/javi/repos/wt/desktop-local`) in dev against the local Core branch
(`local/feedback-2026-10`, worktree `/Users/javi/repos/wt/core-local`), and a
smoke checklist covering every feature of the program. Nothing here pushes or
publishes anything.

## 1. How Desktop finds Core in dev

`npm run dev` starts `tsx watch server/index.ts` (API on `127.0.0.1:4200`) and
Vite (`4201`, proxies `/api`). There is no bundled Core in dev.

- **`SPECRAILS_CORE_BIN`** is the override for everything (`server/core-runtime.ts`
  `resolveCoreRuntime`): framework install, `check-core-compat`, the update
  card and the agent runtime (`<core>/dist/agent-runtime/{index,cli}.js`, found
  next to the selected package). It may point at `bin/specrails-core.mjs` of a
  checkout; Desktop walks up to its `package.json` and needs
  `dist/installer/cli.js`. It is rejected when its version is older than
  `~/.specrails/framework/current` (no downgrades) or its major is not 4–6.
- **`SPECRAILS_CORE_RUNTIME_PATH`** (optional) pins the agent runtime entry
  (`<core>/dist/agent-runtime/index.js`) explicitly.
- **`SPECRAILS_FRAMEWORK_AUTOSWAP=false`** stops the boot-time framework swap.
  Without it, a newer local Core is materialized into
  `~/.specrails/framework/<version>` and `current` moves there, which your normal
  Desktop then cannot resolve without the override.
- `npm link` is not used.

## 2. Build the local Core

The Core branch exposes contract 5.7, role instructions 17, node kinds 8 and
the `runtime api` capabilities `sessions`, `flowSessions`, `reviewBrief`,
`deriveChange`, `architectClarifications`, `specTrace`, `baselineOnTouch` and
`rulesInventory`. Build it before running Desktop or the paired tests.

```sh
git -C /Users/javi/repos/wt/core-local status --short     # expect no "UU" lines
cd /Users/javi/repos/wt/core-local
npm ci                       # only if dependencies changed (node_modules is shared with /Users/javi/repos/specrails-core)
npm run build                # tsc → dist/
node bin/specrails-core.mjs runtime api | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).capabilities;console.log({architectClarifications:c.architectClarifications,specTrace:c.specTrace,baselineOnTouch:c.baselineOnTouch,rulesInventory:c.rulesInventory,reviewBrief:c.reviewBrief,deriveChange:c.deriveChange,flowSessions:c.flowSessions,sessions:c.sessions})})'
```

If `runtime api` does not print JSON in your build, check the capabilities
from Desktop instead (step 4). The version in `core-local/package.json` equals
the released 6.6.5, so the version number alone does not prove the local
checkout is active.

## 3. Run Desktop dev against it

Run with your real `HOME`, after backing up the SQLite databases.

**Why not an isolated `HOME`.** On macOS, changing `HOME` breaks the provider
logins: the Claude CLI keeps its credentials in the login keychain keyed to
the real home, so `claude`, `codex` and `gemini` look unauthenticated and every
run fails. Running against your real data is safe because migrations 72–78 of
this branch are additive (new tables and columns only): the released Desktop
keeps working on the same databases after you go back to it.

1. Close the released Desktop app, then back up every SQLite file
   (`desktop.sqlite` and each project's `jobs.sqlite`, with their WAL/SHM
   siblings), skipping the tool and runtime caches:

   ```sh
   BACKUP=~/specrails-db-backup-$(date +%Y%m%d)
   mkdir -p "$BACKUP" && cd ~/.specrails && find . -name "*.sqlite*" -not -path "./tools/*" -not -path "./runtimes/*" | cpio -pdm "$BACKUP"
   ```

2. Start Desktop dev against the local Core:

   ```sh
   cd /Users/javi/repos/wt/desktop-local
   SPECRAILS_CORE_BIN=/Users/javi/repos/wt/core-local/bin/specrails-core.mjs \
   SPECRAILS_CORE_RUNTIME_PATH=/Users/javi/repos/wt/core-local/dist/agent-runtime/index.js \
   SPECRAILS_FRAMEWORK_AUTOSWAP=false \
   npm run dev
   ```

   Keep `SPECRAILS_FRAMEWORK_AUTOSWAP=false`: without it the newer local Core
   is materialized into `~/.specrails/framework/<version>` and `current` moves
   there, which the released Desktop then cannot resolve.

3. Restore (only if needed): close both the dev server and the released app,
   then copy the backup back over `~/.specrails`
   (`cd "$BACKUP" && find . -name "*.sqlite*" | cpio -pdmu ~/.specrails`).

- Use other ports if your normal Desktop is running:
  `SPECRAILS_DEV_SERVER_PORT=4300 SPECRAILS_DEV_CLIENT_PORT=4301`.
- After rebuilding Core, restart `npm run dev` (`tsx watch` only watches
  Desktop files, and capabilities are read at startup).
- Contract check against the same Core (optional):
  `SPECRAILS_CORE_BIN=/Users/javi/repos/wt/core-local/bin/specrails-core.mjs npm run check-core-compat`.
  A new Core checkpoint or verb makes it report incompatible; that is expected
  until the Core branch is released and paired.

Open `http://127.0.0.1:4201`.

## 4. Verify which Core is active

```sh
TOKEN=$(cat ~/.specrails/desktop.token)
curl -s -H "x-desktop-token: $TOKEN" http://127.0.0.1:4200/api/core-update/status   # runtimeSource: "override", runtimeVersion
curl -s -H "x-desktop-token: $TOKEN" http://127.0.0.1:4200/api/meta                 # apiVersion and versions
curl -si http://127.0.0.1:4200/api/health | grep -i x-specrails-api-version
curl -s -H "x-desktop-token: $TOKEN" http://127.0.0.1:4200/api/projects/<projectId>/core/phase3-capabilities
```

The server log prints `[SetupManager] spawning core: …/core-local/bin/specrails-core.mjs`
when a project is set up. `phase3-capabilities` must show `true` for every
capability (all four are `true` with the local Core).

## 5. Test project

Use a throwaway repository with a test runner, at least one OpenSpec
capability and a `CLAUDE.md`/`AGENTS.md` with a few rules:

```sh
mkdir -p /tmp/sr-smoke && cd /tmp/sr-smoke && git init -q && npm init -y >/dev/null
npm i -D vitest >/dev/null && npm pkg set scripts.test="vitest run" scripts.lint="node -e 0"
mkdir -p openspec/specs/search src && printf '### Requirement: Finds by title\nThe search SHALL match titles.\n\n### Requirement: Empty query\nAn empty query SHALL return nothing.\n' > openspec/specs/search/spec.md
printf '# Rules\n- API calls use getApiBase()\n- Copy is reviewed by design\n' > AGENTS.md
git add -A && git commit -qm init
```

Test projects need at least one commit: Flow and isolated rail launches
create a worktree from the base branch, so a repository with an unborn HEAD is
refused with "This repository has no commits yet" (`409
repository_has_no_commits`). The `git commit` above covers it.

Add it in Desktop (Add project), configure a provider, and set
`.specrails/agent-runtime.json` verification to `npm test` (or accept the
suggestion in Project settings ▸ Agent runtime).

## 6. Smoke checklist

Mark each line. "Core" means the capability must be announced by the local
Core; without it the feature must be absent and nothing else may change.

### Phase 0–1: review capacity
- [ ] **Budget guard.** Project settings ▸ Budget: set a tiny daily cap, launch a rail → `409 daily_budget_exceeded` card; a running loop pauses between AI steps (`budget_paused`) and resumes after raising the cap.
- [ ] **WIP limit.** Project settings ▸ Review limit = 1. With one delivery on review, the board badge reads "In review 1/1", Play is disabled with a tooltip, Launch all holds rails back; a Relaunch/revision of the existing delivery still works.
- [ ] **Risk brief** (Core `reviewBrief`). After a run, the review packet opens with **What to look at** (risks high first); the draft PR body has the brief; mission/delivery cards show the top risk.
- [ ] **Decision times.** Analytics shows time to decision / merge per loop; deciding a delivery updates it.
- [ ] **Reviewer suggestion.** In a loop's agents editor, put reviewer and developer on the same model family → the "use another family" suggestion appears; Dismiss persists per project.

### Phase 2: Flow (Core `sessions`, `flowSessions`, `deriveChange`)
- [ ] **Triage chip.** A new spec gets a triage chip (size, recommended loop); the rail launch preselects the recommended loop; `POST /tickets/:id/triage` recomputes.
- [ ] **Offer → entry.** In a mission, ask to explore an idea → a Flow offer card; accept → Flow bar, In Flow label on the board.
- [ ] **Interrupt.** Send a message while the agent works → it is delivered mid-turn (no queue wait).
- [ ] **"This is it".** Press it → launch card with **Flow → Spec** preselected; Launch.
- [ ] **Flow → Spec loop.** The run derives the OpenSpec change; the packet shows **Derivation** (N/M files explained).
- [ ] **Summary carries the conversation.** `.specrails/pipeline/<runId>/flow-summary.md` lists every message you typed in Flow (`transcriptTurns` > 0) with `↳ Agent:` first lines; the packet's Derivation shows the same turn count.
- [ ] **Change name.** The derived change is `openspec/changes/<kebab spec title>` (no `ticket-N-addenda-…`).
- [ ] **Repair round.** When the review rejects (or a check fails), the run log shows `fix` (fixer stance) then `derive` again, and the change is updated in place; an approval after the round archives normally.
- [ ] **Requested changes.** With rounds exhausted, the mission card reads **The reviewer requested changes** with the issues and failing checks (no "Implementation failed · settlement_interrupted"); the rail strip shows **Changes requested** and no Discard.
- [ ] **Back to Flow.** Press it → the Flow bar returns on the same worktree (files intact), the spec shows In Flow again, the delivery card reads **Back in Flow**, and your next message reaches the agent with the review.
- [ ] **Relaunch.** From a requested-changes card, Relaunch → a new Flow → Spec run on the same rail and worktree re-derives the same change.
- [ ] **Spec rewrite.** After settle, the placeholder spec is rewritten from the derived change (Contract Layer applied).
- [ ] **Jira on review.** With Jira linked, the Flow spec gets its issue created and moved to review only after settle (never while In Flow).
- [ ] **Companion «In Flow».** In the companion app (`/Users/javi/repos/wt/companion-in-flow`, commit `02c4b79`), the spec shows the In Flow label.

### Phase 4: adoption
- [ ] **Freestyle on Codex/Gemini.** Launch Freestyle on a rail with Codex, then Gemini → runs and verifies; no capability error.
- [ ] **Minimal env.** Project settings ▸ Agent environment = minimal; `GET /api/projects/:id/agent-env/status` lists only allowlisted names; a run still authenticates its provider.
- [ ] **Audit log.** After a run, `GET /api/projects/:id/jobs/:runId/audit?format=csv` lists reads/writes/execs; retention setting saves.
- [ ] **API meta / update channels.** `X-Specrails-Api-Version: 1` on every `/api` response; `/api/meta` returns the version set; Settings ▸ Updates switches Latest/Stable without downgrading.
- [ ] **Loop economics.** Analytics ▸ Loop economics lists loops with delivered/merged/discarded, cost split, rounds; unknown values show "no data", never 0.

### Phase 3 + 4.4: this branch
- [ ] **Out of scope (Quick).** Add spec (Quick) → the spec window shows **Out of scope** under the description, and the description has no Out of Scope section. Edit it (one item per line) and save; reopen → kept.
- [ ] **Out of scope (Explore).** Explore a spec → the draft panel has an Out of scope list; Create Spec → the ticket has it. Continue editing a spec → its non-goals are kept after Update Spec.
- [ ] **Agents see non-goals.** Launch Freestyle on that spec → the run log prompt contains `## Out of Scope`.
- [ ] **Clarifications** (Core `architectClarifications`). Launch Implement on a deliberately ambiguous spec ("Add search; decide whether archived projects appear") → the run pauses with the question. With **Post architect clarifications to Jira** on and the spec linked to Jira, one comment appears on the issue. Reply in Jira; within a poll (≤ 60 s) the spec gets an open **clarification** addendum. A clear spec proceeds and, with the setting on, posts its assumptions instead. Setting off → no comment.
- [ ] **Requirements demonstrated** (Core `specTrace`). Have the run tag one test `[spec:search/finds-by-title]` → the packet shows **Requirements demonstrated 1/2** with the touched requirement flagged; Analytics ▸ Loop economics shows `1/2 · 50%`.
- [ ] **CI snippet.** In the test repo, `npx specrails-core pipeline trace --check --tests-passed` exits 1 naming the undemonstrated touched requirement (with an active change), 0 without `--check`.
- [ ] **Drift sweep.** Loops library lists **Drift sweep** (read-only); running it changes no files and reports contradictions.
- [ ] **Baseline on touch** (Core `baselineOnTouch`). Settings ▸ Existing-project anchoring ▸ Baseline on touch on. Spec a change to `src/` code no spec mentions → the packet shows **Spec created where the work passed** (module, requirements, tests) and the cost line adds "baseline $X of it". Break a characterization test on purpose → the run stops with "Baseline blocked: the characterization tests do not pass on the unchanged code…".
- [ ] **Old Core.** Run Desktop without `SPECRAILS_CORE_BIN` (released Core) → anchoring switches disabled with an update note, no new packet sections, drift sweep absent, settle evidence unchanged.
- [ ] **Rules inventory** (Core `rulesInventory`). Right after adding the project, Project settings ▸ Project rules shows the gates and the rules as **Unclassified** with an "inventoried offline" note (Core `init` runs it offline). **Re-run inventory** (provider configured in agent runtime settings) classifies them into automatable / human only / enforced. **Create spec** on an automatable rule adds a `todo` spec (source `rules`). The packet of the next delivery lists **Needs human eyes**. With no verification commands, Agent runtime ▸ verification shows the plain gates first; saving is explicit. The root `CLAUDE.md` of a Claude project has the `<!-- specrails-managed:start -->` block pointing at `.specrails/rules.json`.

## 7. Automated checks

```sh
cd /Users/javi/repos/wt/desktop-local
npm run typecheck
npx vitest run                         # server
npm run test --prefix client
npm run test:scripts
npm run audit:architecture
npm run build
for c in ticket-non-goals-and-jira-clarifications spec-trace-surfaces baseline-on-touch-settings project-rules-inventory; do openspec validate $c --strict; done
```

Paired engine suites against the local Core (what the CI `paired-core-engine`
job runs; about 11 minutes):

```sh
cd /Users/javi/repos/wt/core-local && npm run build
cd /Users/javi/repos/wt/desktop-local
export SPECRAILS_CORE_SOURCE_DIR=/Users/javi/repos/wt/core-local
export SPECRAILS_EFFICIENCY_CORE_ROOT=/Users/javi/repos/wt/core-local
export SPECRAILS_CORE_BIN=/Users/javi/repos/wt/core-local/bin/specrails-core.mjs
npm run check-core-compat                       # contract 5.7 (paired target 5.7) ✓ Compatible
node scripts/paired-core-shards.mjs run 1/1 /tmp/paired.xml
```

The vendored `server/schemas/agent-runtime.schema.json`,
`workflow-definition.schema.json` and `fixtures/` are byte-identical to
`core-local/schemas/`; the schema parity tests compare them when
`SPECRAILS_EFFICIENCY_CORE_ROOT` is set.
