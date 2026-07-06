# Cost Accounting Audit — why the app said $28 while Claude said $40

**Date:** 2026-07-02 · **Branch:** `feat/mission-control-suite` · **Scope:** every path that measures, records, aggregates or displays AI spend.

**Method:** 152-agent adversarial workflow — 11 dimension-specific finders + 1 ground-truth researcher → 77 raw findings → 46 after semantic dedup → each judged by 3 independent adversarial verifiers (correctness / reproduction / user-visibility). 10 findings whose verifiers died on a session limit were hand-verified afterwards. **Result: 42 confirmed defects, 3 refuted, 1 prior bug (BUG-07) verified fixed.** ~12M subagent tokens spent.

---

## Executive summary — where the missing ~$12 most plausibly went

Ranked by likelihood for a single heavy execution:

1. **Subagent (Task tool) usage is not in the CLI's `total_cost_usd`.** Per claude-code docs/issues (see Ground truth), the headless `result` event's `total_cost_usd` is a client-side estimate that has documented gaps around subagents and resumed history. A specrails rail run that fans out sr-architect/sr-developer/sr-reviewer style subagent work can therefore report materially less than what Anthropic meters — and the app can only ever record what the CLI reports. **Not an app bug, but the app presents the number as authoritative.**
2. **Worktree-rail merge-back AI steps are completely untracked** (CRIT-2) — and worktree isolation is on by default. verify / resolve-merge / fix spawns burn real tokens that never touch `ai_invocations` **or** the jobs table.
3. **Any claude spawn killed before its terminal `result` event persists `total_cost_usd = NULL` → $0** (CRIT-1): job cancel, zombie kill, shutdown timeout, chat abort, idle-kill, loop step timeout, SMASH timeout, contract-refine 60s timeout. No pricing fallback exists for claude because per-event usage is discarded (HIGH-12).
4. **Whole surfaces are unrecorded**: Desktop Agent Chat / Mission Control, ticket AI-Edit route, /opsx:ff spec launcher, ProposalManager, custom-agent generate/test, sidebar chat, auto-titles, setup wizard, cancelled AI-Edit turns, failed file-summaries.
5. **Windowed defaults read as totals**: per-project analytics defaults to 30d, app-level to 7d, both under a hero figure easily read as all-time; plus the app-level KPI reads ONLY the jobs table (no chat/spec/summary/smash/loop spend at all).

Counterweight (why the app can also OVERcount in other scenarios): persistent-stdin explore/interactive turns record the session-CUMULATIVE `total_cost_usd` per turn (HIGH-6 / MED-15), so long multi-turn conversations multiply cost — worth fixing before trusting any reconciliation.


## Ground truth — what the claude CLI actually reports (from docs + anthropics/claude-code issues; re-verify before depending on any single claim)
- `total_cost_usd` is a **client-side estimate, not the bill** (official cost-tracking docs carry an explicit warning; price table is bundled, can drift).
- **Cache write/read costs are included** (write 1.25x/2x input by TTL, read 0.1x).
- **Subagent (Task tool) usage: documented gaps** — multiple issues report subagent cost not reflected in the parent session's reported cost (e.g. #55144, #39903) and statusline/stream aggregation under-reporting in cache-heavy + background-agent sessions (#33887).
- **Resume / persistent stdin:** per-turn `result.total_cost_usd` covers only the new turn; reloaded history that is re-sent to the API is not in the figure (#19554, #13088). NOTE: the workflow's reproduction judges found empirically that in the app's persistent-stdin transport the field behaved **cumulatively** across turns — treat per-version behaviour as unstable and verify against the shipped CLI version.
- Known metering regressions have existed in both directions (#53371 over-reporting 10–100x, #49302 cache reads at full input rate), so cross-checking against the Anthropic Console usage API is the only authoritative reconciliation.


## Confirmed defects (42) — 4 critical / 10 high / 13 medium / 15 low
| # | Sev | Impact | Location | Defect |
|---|-----|--------|----------|--------|
| CRIT-1 | critical | undercount | `server/providers/claude-adapter.ts:256` | Any claude spawn killed before its terminal `result` event persists total_cost_usd=NULL ($0) — no pricing fallback exists for claude, across every surface (job cancel/zombie/shutdown-timeout, chat abort/idle-kill, loop step timeout, SMASH timeout, contract-refine 60s timeout) |
| CRIT-2 | critical | undercount | `server/rail-merge-orchestrator.ts:54` | Worktree-rail merge-back AI steps (verify / resolve-merge / fix) are completely untracked — and worktree isolation is ON by default |
| CRIT-3 | critical | undercount | `server/queue-manager.ts:1773` | Server restart / graceful shutdown / project removal mid-job loses the whole job's cost: _onJobExit is disabled by the _disposed guard and _restoreFromDb writes failed rows with no ai_invocations row |
| CRIT-4 | critical | undercount | `server/interactive-job-session.ts:210` | Interactive freestyle job finalized (or crashed) mid-turn drops the entire in-flight turn's cost — the final row can even be an authoritative $0 'success' |
| HIGH-1 | high | undercount | `server/queue-manager.ts:383` | Interactive job torn down by shutdown/restart never writes an ai_invocations row even though the jobs row already holds its accumulated cost — permanent jobs-vs-analytics divergence |
| HIGH-2 | high | overcount | `server/interactive-job-session.ts:324` | Interactive accumulator sums per-turn result total_cost_usd, but in the persistent stream-json transport that field is CUMULATIVE across turns — multi-turn interactive jobs inflate cost quadratically (empirically verified) |
| HIGH-3 | high | undercount | `server/agent-chat-manager.ts:300` | Desktop Agent Chat / Mission Control turns are billable app-driving AI invocations with no cost accounting anywhere |
| HIGH-4 | high | undercount | `server/project-router-tickets.ts:1665` | Ticket AI-Edit route (POST /tickets/:id/ai-edit) spawns a multi-turn claude run with zero ai_invocations recording |
| HIGH-5 | high | undercount | `server/spec-launcher-manager.ts:98` | SpecLauncherManager /opsx:ff launch is a full unbounded agentic claude run with no invocation recording |
| HIGH-6 | high | undercount | `server/proposal-manager.ts:255` | ProposalManager spawns (/specrails:propose-feature exploration, refinement turns, issue creation) are untracked |
| HIGH-7 | high | undercount | `server/spending.ts:190` | Custom period excludes the ENTIRE final day: bare YYYY-MM-DD 'to' compared lexicographically against full-ISO started_at |
| HIGH-8 | high | undercount | `server/providers/claude-adapter.ts:215` | parseClaudeStreamLine discards per-assistant-event `usage`, so cumulative token usage can never be reconstructed for interrupted runs — partial-stream estimation is structurally impossible |
| HIGH-9 | high | both | `client/src/components/analytics/SpendingHero.tsx:41` | SpendingHero count-up animation is never cancelled; a second data arrival within 600ms is overwritten by the stale total's final frame |
| HIGH-10 | high | undercount | `client/src/pages/JobDetailPage.tsx:384` | Pipeline total sums null job costs as $0 with no indicator (and drops the ~ estimated marker) |
| MED-1 | medium | overcount | `server/chat-manager.ts:1169` | Persistent-stdin Explore records each turn's ai_invocations row with the session-cumulative total_cost_usd, multiplying conversation cost (flag-gated, default OFF) |
| MED-2 | medium | undercount | `server/chat-manager.ts:906` | Chat crash auto-respawn discards the crashed spawn's burned tokens (adapterEvents zeroed), and a respawn spawn-failure writes no row at all |
| MED-3 | medium | undercount | `server/agent-generator.ts:68` | Custom-agent generate and test spawns (Studio generate, manual test endpoint, and default-on per-refine-turn auto-test) are untracked |
| MED-4 | medium | undercount | `server/chat-manager.ts:974` | Sidebar chat (kind='sidebar') is completely unrecorded — every billable sidebar turn (project cwd + live dashboard context) is invisible to analytics |
| MED-5 | medium | undercount | `server/queue-manager.ts:1937` | Daily-budget PAUSE enforcement sums only status='completed' jobs with a UTC date('now') boundary and reads only the jobs table — failed-but-billed jobs and all non-job surfaces never count, and it disagrees with the /budget meter |
| MED-6 | medium | both | `server/project-router-spending.ts:412` | Per-project GET /budget costToday: UTC date('now') boundary + jobs-table-only scope |
| MED-7 | medium | both | `server/queue-manager.ts:1856` | Multi-ticket jobs attribute 100% of cost to ticketIds[0]: topTickets and /tickets/:id/spending-summary over/under-attribute batch spend |
| MED-8 | medium | undercount | `server/desktop-analytics.ts:118` | App-level cost KPIs (HOME analytics, StatusBar /stats costToday, /api/state) read ONLY the jobs table — all non-job billable surfaces (explore, quick-spec, ai-edit, contract-refine, file-summary, smash, loop-only rows) are invisible |
| MED-9 | medium | undercount | `client/src/pages/AnalyticsPage.tsx:76` | Per-project /analytics defaults to a 30-day window — windowed total easily read as the all-time total |
| MED-10 | medium | undercount | `client/src/pages/DesktopAnalyticsPage.tsx:285` | Desktop (cross-project) analytics defaults to a 7-day window for a KPI labelled 'Total cost' |
| MED-11 | medium | undercount | `client/src/pages/DesktopAnalyticsPage.tsx:296` | App-level analytics auto-refresh listens for a WS message ('log' + event_type 'job_done') the server never emits — totals go stale |
| MED-12 | medium | undercount | `server/agent-refine-manager.ts:377` | Cancelled/disposed AI-Edit refine turns return before recordInvocation — no row (not even aborted) is written |
| MED-13 | medium | undercount | `server/file-summary-generator.ts:187` | file-summary generator discards captured cost on non-zero exit and on empty-summary rejection |
| LOW-1 | low | undercount | `server/chat-manager.ts:1417` | Auto-title spawns are billable claude invocations that are never recorded (fired on the first turn of every conversation) |
| LOW-2 | low | undercount | `server/setup-manager.ts:1234` | Setup-wizard AI spawns (Claude /setup chat) are unrecorded on any accounting surface |
| LOW-3 | low | undercount | `server/project-router-spending.ts:274` | Summary CSV '# By model' section is silently top-10-truncated and excludes NULL-model rows — its sum does not reconcile to '# Totals' |
| LOW-4 | low | neutral | `server/spending.ts:261` | minCostUsd filter compiles to `total_cost_usd >= ?`, so minCostUsd=0 silently drops all NULL-cost rows (not a no-op) |
| LOW-5 | low | undercount | `server/pricing.ts:52` | Gemini Pro long-context (>200k) pricing tier not modeled — flat <=200k rates knowingly under-estimate long-context prompts |
| LOW-6 | low | both | `server/queue-manager.ts:2136` | Unkillable-job recovery can double-record the same job: _forceFailUnkillableJob writes an 'aborted' NULL-cost row, then the child's eventual close runs _onJobExit and writes a second row (and double-fires _onJobFinished) |
| LOW-7 | low | neutral | `server/chat-manager.ts:1221` | Persistent-stdin turns are recorded status='success' even when the result event reports an error (is_error / error subtypes) |
| LOW-8 | low | neutral | `server/loop-executors.ts:163` | Loop invocation rows never persist num_turns / session_id / duration fields — dropped between the executors and the recorder |
| LOW-9 | low | undercount | `server/smash-runner.ts:511` | SMASH splitInt floors token and turn splits across children — sum of splits < original (num_turns can collapse to 0) |
| LOW-10 | low | undercount | `server/smash-runner.ts:779` | SMASH failure paths that DO capture real cost never broadcast spending.invalidated — open dashboards keep showing the pre-spend (lower) total |
| LOW-11 | low | neutral | `client/src/components/analytics/ModelBreakdown.tsx:24` | ModelBreakdown percentages use the server-capped top-10 sum as denominator and render only top-5 |
| LOW-12 | low | undercount | `server/smash-runner.ts:504` | SMASH children share one try/catch around the recordInvocation loop — a mid-loop failure drops all remaining children's cost |
| LOW-13 | low | neutral | `server/project-router-tickets.ts:705` | Salvaged error_max_turns quick-spec (ticket created) is recorded status='failed' |
| LOW-14 | low | overcount | `server/agent-generator.ts:222` | testCustomAgent double-counts token usage (per-message usage + cumulative result usage summed) |
| LOW-15 | low | neutral | `server/queue-manager.ts:1063` | Interactive job duration_ms is wall-clock including idle time between turns |


## Details

### CRIT-1 · Any claude spawn killed before its terminal `result` event persists total_cost_usd=NULL ($0) — no pricing fallback exists for claude, across every surface (job cancel/zombie/shutdown-timeout, chat abort/idle-kill, loop step timeout, SMASH timeout, contract-refine 60s timeout)

**Location:** `server/providers/claude-adapter.ts:256` · **Severity:** critical · **Impact:** undercount · **Category:** cost extraction / capture-loss (no result event)

**Evidence.** extractClaudeResult: `if (!resultPayload) return { session_id: sessionId }` (claude-adapter.ts:256) — all usage/cost fields undefined when no `result` frame arrived. finaliseInvocationResult (result-event.ts:79) applies the rate-card fallback only when `!adapter.capabilities.nativeCostUsd`; claude declares `nativeCostUsd: true` (claude-adapter.ts:318), so estimation never runs — and PRICING (pricing.ts:44-63) contains zero `claude:*` entries anyway, so even the fallback would return null; the diagnostic console.warn (result-event.ts:90-99) is inside the non-native branch so nothing is even logged. recordInvocation persists `total_cost_usd ?? null` (ai-invocations.ts:103) and every SUM (`COALESCE(SUM(total_cost_usd),0)`, spending.ts:345/365) treats NULL as $0, with no unpriced-row indicator in SpendingResponse. Kill paths hitting this: user cancel/zombie treeKill SIGTERM (queue-manager.ts:2036-2097, rows recorded 'aborted' at 1850-1862), spawn-lifecycle.ts:148 wall-clock timeout settling immediately on SIGTERM, chat abort/double-crash/persistent-child death/shutdown (chat-manager.ts:981-996, 1332-1345, 1361/1375; pinned NULL by chat-manager.test.ts:945), loop AI-step 15-min / Decider 3-min timeouts (loop-executors.ts:20-21,121,158 — loop-run-manager.ts:332-338 admits 'the loop total is a LOWER BOUND', but only the job log carries the '≥' marker), SMASH SMASH_TIMEOUT_MS_SIMPLE=60s / FULL=900s (smash-runner.ts:675-676, resultEvent null → `{}` → NULL row), and contract-refine REFINE_TIMEOUT_MS=60s resuming a fat Explore session (contract-refine-runner.ts:38,443; same in the quick variant 620-629 and the generate-spec 8-min watchdog, project-router-tickets.ts:376-386).

**Failure scenario.** During a heavy multi-rail execution the user cancels one stuck rail after 40 minutes, a second rail is zombie-killed at the 30-min inactivity mark, one loop implement-step hits the 15-min AI_STEP_TIMEOUT_MS, and a contract refine blows its 60s budget. Anthropic billed every streamed token of all four ($5-15 total); all four ai_invocations rows persist with total_cost_usd NULL and contribute $0 to the Analytics hero, bySurface, byModel, topTickets. App shows $28 while Claude's accounting shows $40.

**Gap contribution.** Prime suspect for the bulk of the $12: a single canceled/zombie-killed/timed-out heavy claude run loses 100% of its multi-dollar spend, and heavy executions are exactly where kills and timeouts happen.


### CRIT-2 · Worktree-rail merge-back AI steps (verify / resolve-merge / fix) are completely untracked — and worktree isolation is ON by default

**Location:** `server/rail-merge-orchestrator.ts:54` · **Severity:** critical · **Impact:** undercount · **Category:** untracked billable spawn (capture completeness)

**Evidence.** rail-merge-orchestrator.ts:54-55 `const step = (cmd) => executor.runAiStep({ prompt: expand(cmd), provider, model, effort, cwd: baseDir, repoDir: baseDir })`; the returned AiStepResult carries cost/tokens (loop-executors.ts:163-184) but verifyIntegrated reads only `res.text` (57-60) and resolveConflict/rebaseAndFix discard the result entirely (62-75). runAiStep computes cost via finaliseInvocationResult (loop-executors.ts:158) but never calls recordInvocation — recording happens only inside LoopRunManager's `record()` wrapper (loop-run-manager.ts:394), which the merge-back bypasses: rail-isolated-launch.ts:139-141 calls `runMergeBack({ git, executor: createLoopExecutors(), baseDir: baseRepo, … })` directly. grep confirms zero recordInvocation in rail-merge-orchestrator.ts / rail-isolated-launch.ts / merge-manager.ts. merge-manager.ts:106 runs verifyIntegrated for EVERY merged branch (not just conflicted ones), so an N-ticket rail runs ≥N full agentic `{{cmd:verify}}` claude spawns ('run the full verification (tests, linter, build)… fix and re-run until green', loop-command-catalog.ts:120-132) plus resolve-merge per conflict and fix+re-verify per red integration. This path is live by default: rail-isolation.ts:36-39 `isRailWorktreesEnabled()` returns true unless SPECRAILS_RAIL_WORKTREES=0/false/off, wired at rails-router.ts:365-391.

**Failure scenario.** User launches a per-ticket rail with 4 tickets on a mutating loop (default config). The 4 loop runs are recorded (~$20 in ai_invocations), then merge-back runs 4 verify spawns + 2 resolve-merge + 1 fix + 1 re-verify — 8 full agentic claude runs ($8-12) that appear in no ai_invocations row, no jobs row, no loop_runs rollup, and trigger no spending.invalidated. Claude bills ~$30+; Analytics shows ~$20.

**Gap contribution.** Single most plausible contributor: 5-10 untracked full-agentic spawns on a heavy multi-ticket rail with conflicts can total $8-12, matching the reported gap almost by itself.


### CRIT-3 · Server restart / graceful shutdown / project removal mid-job loses the whole job's cost: _onJobExit is disabled by the _disposed guard and _restoreFromDb writes failed rows with no ai_invocations row

**Location:** `server/queue-manager.ts:1773` · **Severity:** critical · **Impact:** undercount · **Category:** capture-loss (restart/shutdown)

**Evidence.** shutdown() (queue-manager.ts:353-397) sets `_disposed = true`, treeKills the active child, and nulls `_db`; when the child's 'close' later fires, `_onJobExit` returns at `if (this._disposed) return` (line 1773) — BEFORE finishJob and recordInvocation, even if a full `result` event with total_cost_usd was already captured. On next boot `_restoreFromDb` runs `UPDATE jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'` (2230-2233), mirrored by the initDb orphan sweep (db.ts:842-844) — no cost written and no ai_invocations row EVER created (the only surface='job' writers are _onJobExit/_failWedgedJob/_forceFailUnkillableJob/_settleInteractiveJob, none of which run for a restart-orphaned job); the job doesn't even count toward totalRuns/failureRate. An ungraceful crash (e.g. the known tsx-watch freeze) hits the same path; a project removed mid-run also records nothing.

**Failure scenario.** User quits or restarts the app while a $10 rail is 80% complete. Anthropic billed all API calls already made. After restart the job shows 'failed' with no cost in Job Detail, and Analytics has zero record of the invocation — the app total is $10 short.

**Gap contribution.** Very plausible: one mid-run app restart of a long rail covers most or all of the $12.


### CRIT-4 · Interactive freestyle job finalized (or crashed) mid-turn drops the entire in-flight turn's cost — the final row can even be an authoritative $0 'success'

**Location:** `server/interactive-job-session.ts:210` · **Severity:** critical · **Impact:** undercount · **Category:** capture completeness / interactive session finalize

**Evidence.** Cost accumulates ONLY in `_onTurnResult` on a `result` frame (interactive-job-session.ts:306-344: `this._accum.total_cost_usd += normalised.total_cost_usd ?? 0`). `finalize()` (210-227) SIGTERMs the resident child immediately (`child.kill('SIGTERM')` at 218) with no wait for the streaming turn's result; `_handleClose` → `_settle(this._finalizing ? 'finalized' : 'crashed')` (409-436) hands back `{ ...this._accum }`, silently dropping `_turnEvents` (no estimation attempt — and per the adapter finding the events carry no usage anyway). `zeroUsage()` (68-77) initialises `total_cost_usd: 0`, so QueueManager._settleInteractiveJob (queue-manager.ts:1066-1086) persists an ai_invocations row with total_cost_usd=0 (a number, NOT NULL), `total_cost_usd_estimated: false`, status 'success' for a single-turn job finalized mid-flight. The module header (lines 10-12) claims 'the finalized job carries the full conversation's spend' — untrue when finalized mid-turn.

**Failure scenario.** User launches a heavy Interactive freestyle rail (the first turn IS the whole pipeline). The agent works 30-60 min; the user, seeing the work done, clicks Finalize BEFORE the turn's terminal result fires. Job Detail shows $0.00 and ai_invocations gets an authoritative-$0 success row while Claude's ledger billed $5-$15. Same loss on a mid-turn child crash.

**Gap contribution.** Can single-handedly explain the whole $12: one heavy interactive turn finalized mid-flight records $0 against a real multi-dollar spend.


### HIGH-1 · Interactive job torn down by shutdown/restart never writes an ai_invocations row even though the jobs row already holds its accumulated cost — permanent jobs-vs-analytics divergence

**Location:** `server/queue-manager.ts:383` · **Severity:** high · **Impact:** undercount · **Category:** jobs vs ai_invocations divergence (shutdown lifecycle)

**Evidence.** QueueManager shutdown/dispose calls `session.dispose()` for every interactive session (queue-manager.ts:383-388; the comment states 'dispose() does not settle'). InteractiveJobSession.dispose() (interactive-job-session.ts:229-237) sets `_disposed` and kills the child WITHOUT `_onSettle`; `_handleClose` early-returns on `_disposed` (410), so `_settleInteractiveJob` — the ONLY writer of an interactive job's ai_invocations row (queue-manager.ts:1066) — never runs. Every completed turn was already persisted into the jobs row via accumulateInteractiveTurn (db.ts:873-901, `total_cost_usd = COALESCE(total_cost_usd,0) + ?`), and the startup sweep `UPDATE ... SET status='failed'` (queue-manager.ts:2231-2233 / db.ts:841-844) preserves those columns with no ai_invocations backfill. Job Detail shows the real cost; Analytics has no row at all.

**Failure scenario.** An interactive session accumulated $6-8 across several turns; the user quits the app (tray Exit / update restart / crash) without finalizing. After restart the job page shows the cost (failed), but the Analytics total, byModel, topTickets and exports are that much short forever.

**Gap contribution.** Direct contributor when an interactive session was open at app quit: the whole session's accumulated spend is present in jobs but absent from the analytics total the user compared.


### HIGH-2 · Interactive accumulator sums per-turn result total_cost_usd, but in the persistent stream-json transport that field is CUMULATIVE across turns — multi-turn interactive jobs inflate cost quadratically (empirically verified)

**Location:** `server/interactive-job-session.ts:324` · **Severity:** high · **Impact:** overcount · **Category:** cost semantics / persistent-stdin transport

**Evidence.** `_onTurnResult` does `this._accum.total_cost_usd += normalised.total_cost_usd ?? 0` and `+= num_turns ?? 1` per result frame (interactive-job-session.ts:320-325), mirrored into the jobs row via accumulateInteractiveTurn (db.ts:884-885 `+ ?`). All frames come from ONE resident `claude -p --input-format stream-json` child (chat-stream args, claude-adapter.ts:119-137). Empirically verified against the installed claude CLI in this exact transport (one resident child, two turns): turn-1 result reported total_cost_usd=0.0164211; turn-2 reported 0.0191507 while turn-2's OWN usage (in=10, out=40, cache_read=24056, cache_create=57) prices to ~0.0027 — i.e. cumulative (turn-1 cost + turn-2's own). Token fields are per-turn (correct); only cost is cumulative. Summing per-turn values counts turn 1's cost N times over an N-turn session (Σ of prefix sums). A separate `--resume`-across-processes test showed per-process cost, so normal rail/chat spawn-per-turn paths are unaffected. Nothing in the repo validates the semantics: interactive-job-session.test.ts fabricates identical per-turn frames (total_cost_usd: 0.05 at line 32) and asserts sum 0.1 (line 122) — the per-turn assumption is baked into the fixture.

**Failure scenario.** Interactive freestyle job with 4 turns costing $2 each: real total $8, recorded 2+4+6+8 = $20 on both the jobs row and the final ai_invocations row (num_turns similarly inflated). Opposite direction to the reported gap, but it corrupts the same figures — meaning the true undercount from the other findings is even larger than the observed $12.

**Gap contribution.** Not directly (overcounts); masks/offsets the undercount bugs in mixed workloads and must be fixed to trust any reconciliation.


### HIGH-3 · Desktop Agent Chat / Mission Control turns are billable app-driving AI invocations with no cost accounting anywhere

**Location:** `server/agent-chat-manager.ts:300` · **Severity:** high · **Impact:** undercount · **Category:** untracked billable spawn (capture completeness)

**Evidence.** AgentChatManager.sendMessage runs full claude turns via runAiCliInvocation (agent-chat-manager.ts:264); the 'result' handler harvests ONLY the session id: `case 'result': { const sid = (ev.payload as { session_id?: string }).session_id; if (sid) capturedSessionId = sid; break }` (300-304) — total_cost_usd/usage/num_turns discarded. grep confirms zero recordInvocation/finaliseInvocationResult/cost fields across agent-chat-manager.ts, agent-chat-router.ts, agent-store.ts and desktop-db.ts. Structurally there is nowhere to write: ai_invocations lives in per-project jobs.sqlite while agent chat is app-global (desktop.sqlite). CLAUDE.md lists only sidebar chat and setup wizard as intentional exclusions — agent chat is an undocumented gap, and it landed AFTER the prior analytics audit (a7d39c1 Jul-1, extended by b06f0c9 and 34dbf9e Mission Control). Ironically docs/guide advertises asking the agent 'How much did I spend this week?' — an answer that can never include its own turns.

**Failure scenario.** User drives the heavy execution through Agent Mode / Mission Control (Operate/Autonomous tier): background missions run 30-80 multi-minute operator turns (large system prompt + dozens of MCP tool round-trips) at $0.10-0.40 each. The rails/jobs the agent triggers via REST DO record, so the app total is exactly Claude's total minus the orchestration turns — $5-15 of systematic invisible spend on no analytics surface (per-project /analytics, HOME, StatusBar, exports).

**Gap contribution.** Top candidate on this exact branch (Mission Control is its headline feature); can single-handedly explain the $12 gap on a mission-driven day.


### HIGH-4 · Ticket AI-Edit route (POST /tickets/:id/ai-edit) spawns a multi-turn claude run with zero ai_invocations recording

**Location:** `server/project-router-tickets.ts:1665` · **Severity:** high · **Impact:** undercount · **Category:** untracked billable spawn (capture completeness)

**Evidence.** project-router-tickets.ts:1665 `const child = spawnAiCli(binary, args, { env: process.env, …, cwd: project.path })` for the ticket-description AI-Edit (route at 1547; claude args at 1640-1649 include `--max-turns 4`, `--tools default`, image flags; the system prompt at 1591 instructs 'briefly check CLAUDE.md and the project directory structure', so it is a tool-using run whose input includes the full description + prior refinement turns + attachments, re-sent each edit). The close handler (1748-1770) only broadcasts ticket_ai_edit_done/error — no finaliseInvocationResult, no recordInvocation, no spending.invalidated; grep shows this file's only recordInvocation is the generate-spec route (line 698). Distinct from agent-refine-manager's surface='ai-edit' (Agents Studio refine), which IS recorded — the ticket-modal AI Edit is the untracked one.

**Failure scenario.** User iteratively refines a spec description with 5 AI-Edit turns (each up to 4 agentic turns reading CLAUDE.md + repo). Claude bills all 5 ($0.30-0.80 each); Analytics and the ticket's spending summary show $0 for them.

**Gap contribution.** Directly: every spec-description AI edit is 100% invisible; a spec-polishing session plausibly loses $1-5.


### HIGH-5 · SpecLauncherManager /opsx:ff launch is a full unbounded agentic claude run with no invocation recording

**Location:** `server/spec-launcher-manager.ts:98` · **Severity:** high · **Impact:** undercount · **Category:** untracked billable spawn (capture completeness)

**Evidence.** spec-launcher-manager.ts:98 `const child = spawnClaude(args, { env: process.env, …, cwd: this._cwd })` running the resolved `/opsx:ff <description>` prompt (82-83) with `--dangerously-skip-permissions --tools default --output-format stream-json` and NO --max-turns — the fast-forward OpenSpec artifact-creation pipeline (proposal + specs + design + tasks), an unbounded multi-turn agentic run. The class holds no DB handle (constructor at 29 takes only broadcast+cwd); the close handler (174-202) only broadcasts spec_launcher_done/error; no recordInvocation anywhere in the file. Live via project-router-setup.ts:375, constructed per-project at project-registry.ts:566. Its own shutdown comment (line 70) acknowledges the child 'keeps burning spend' — none of it recorded.

**Failure scenario.** User launches a spec via /opsx:ff: claude runs for several minutes creating a full OpenSpec change (many tool calls, many turns). Claude's accounting shows $2-5; the app records nothing — no row, no cost, no tokens.

**Gap contribution.** One of the largest single contributors possible: one or two /opsx:ff launches in a heavy execution can silently account for $4-10 of the gap.


### HIGH-6 · ProposalManager spawns (/specrails:propose-feature exploration, refinement turns, issue creation) are untracked

**Location:** `server/proposal-manager.ts:255` · **Severity:** high · **Impact:** undercount · **Category:** untracked billable spawn (capture completeness)

**Evidence.** proposal-manager.ts:255 `const child = spawnClaude(args, { env: process.env, …, cwd: this._cwd })` in `_runProcess`, used by three billable flows: startExploration (line 92/110: full-codebase `/specrails:propose-feature` run with `--dangerously-skip-permissions --tools default`), sendRefinement (148/152: `--resume` + feedback — each re-bills session context), and createIssue (194/198: `--resume` + gh-issue prompt). The close handler (333-350) only updates proposal status/broadcasts; no recordInvocation import in the file. Live at project-router-setup.ts:271/296/311, instantiated per project at project-registry.ts:560.

**Failure scenario.** User runs a proposal cycle: an agentic codebase-reading exploration ($0.50-2), two refinement turns resuming the session, and issue creation — four claude invocations billed by Claude, zero rows in ai_invocations.

**Gap contribution.** A proposal cycle in a heavy execution plausibly loses $1-4.


### HIGH-7 · Custom period excludes the ENTIRE final day: bare YYYY-MM-DD 'to' compared lexicographically against full-ISO started_at

**Location:** `server/spending.ts:190` · **Severity:** high · **Impact:** undercount · **Category:** period-boundary / date math

**Evidence.** resolveRange's custom branch returns client strings verbatim (`from: filters.from, to: filters.to`, spending.ts:190-191) and buildWhere applies `started_at <= ?` (:227). The client PeriodSelector feeds bare `YYYY-MM-DD` from `<input type="date">`; stored started_at is a full ISO instant (queue-manager.ts:1157). SQLite string comparison: `'2026-07-02T09:15:00.000Z' <= '2026-07-02'` is FALSE, so every row started on the range's end date is dropped (the from side works, making the bug asymmetric). desktop-analytics.ts:82 fixed this exact problem with a next-day `started_at < ?` — spending.ts never got the fix. The same resolveRange/buildWhere feeds getInvocations and the /analytics/export route, so the raw table and both exports drop the same day; prevTotalCostUsd/deltaPct use the same broken boundary.

**Failure scenario.** User runs the heavy execution today, spends $12, then selects Custom 2026-06-01 → 2026-07-02 to review the month including today. Every invocation of the heavy run is excluded; Hero shows $28 while Claude shows $40, the dailyTimeline zero-fills the final day, and the exports omit the same rows.

**Gap contribution.** Can account for the FULL $12 by itself if the user checked the total with a custom range ending on the day of the heavy run.


### HIGH-8 · parseClaudeStreamLine discards per-assistant-event `usage`, so cumulative token usage can never be reconstructed for interrupted runs — partial-stream estimation is structurally impossible

**Location:** `server/providers/claude-adapter.ts:215` · **Severity:** high · **Impact:** undercount · **Category:** estimation input completeness (per-event usage accumulation)

**Evidence.** In parseClaudeStreamLine (claude-adapter.ts:215-237) an `assistant` frame is reduced to `{ kind: 'text-delta' }` / `{ kind: 'tool-use' }`; the `message.usage` block (input/output/cache_read/cache_creation per API call) is thrown away — only unmatched frames keep `raw`. The adapterEvents array that finaliseInvocationResult walks therefore contains usage ONLY inside the terminal result payload (extractClaudeResult :258-268). No code path sums usage across assistant events. The client does the opposite for display: JobStatusPanel derives live Turns/Tokens from streamed assistant events — proving the data is on the wire and dropped server-side.

**Failure scenario.** A claude rail is killed after 30 API turns. The stream carried usage on every assistant event (hundreds of thousands of tokens) but the parser dropped it; even if the nativeCostUsd gate and the missing claude rate card were fixed, no estimator could run because the token counts were never captured. The invocation persists NULL tokens and NULL cost.

**Gap contribution.** Enabler/compounder of the no-result-event finding: the reason the app cannot produce even a conservative estimate for interrupted claude runs; they must be fixed together to close the gap.


### HIGH-9 · SpendingHero count-up animation is never cancelled; a second data arrival within 600ms is overwritten by the stale total's final frame

**Location:** `client/src/components/analytics/SpendingHero.tsx:41` · **Severity:** high · **Impact:** both · **Category:** stale-display race (uncancelled requestAnimationFrame loop)

**Evidence.** The effect at lines 37-56 starts a 600ms rAF loop on the FIRST non-zero data arrival; no rAF id is stored and there is no effect cleanup, so when a second SpendingResponse lands mid-animation the else-branch's `setDisplayedTotal(target)` (fresh total) is subsequently overwritten by the still-running old loop, whose final frame at t=1 writes EXACTLY the old target. The headline (line 87 `fmtUsdLarge(displayedTotal)`) then shows the stale total indefinitely, while the segment bar/legend (139-161, built from `data`) reflect the fresh figures — the card contradicts itself. AnalyticsPage.tsx makes the double-arrival realistic: mount fetch resolves (~100ms) starting the animation, and the WS spending.invalidated debounce (500ms, AnalyticsPage.tsx:220-224) plus fetch latency lands the refreshed response inside the 600ms window.

**Failure scenario.** User opens /analytics as the heavy execution's final rows are being recorded. Mount fetch returns $28 (mid-write) at t≈100ms → animation starts. Refetch resolves $40 at t≈650ms → setDisplayedTotal(40). The old animation's last frame at t≈700ms writes $28 back. Hero permanently displays $28 while the server says $40, until the next data change.

**Gap contribution.** Reproduces the exact symptom: the headline total holds a value captured mid-execution after the authoritative response arrived; the gap equals whatever cost landed between the two fetches — easily $12 on a heavy run.


### HIGH-10 · Pipeline total sums null job costs as $0 with no indicator (and drops the ~ estimated marker)

**Location:** `client/src/pages/JobDetailPage.tsx:384` · **Severity:** high · **Impact:** undercount · **Category:** null-coerced-to-zero client summation

**Evidence.** `totalCostUsd: pipelineJobs.reduce((s, j) => s + (j.total_cost_usd ?? 0), 0)` (JobDetailPage.tsx:384). JobSummary.total_cost_usd is `number | null` (client/src/types.ts:18) and JobStatusPanel documents nulls as legitimate ('authoritative value may legitimately be null', JobStatusPanel.tsx:398-399). Per-job the panel renders '—' + 'Not available', but the 'Pipeline total (N jobs)' card (JobStatusPanel.tsx:341) silently coerces nulls to $0 while jobCount still counts them, and never prefixes '~' when a sibling's cost is a pricing-table estimate (total_cost_usd_estimated), unlike the per-job costValue (:149-151).

**Failure scenario.** A heavy Architect→Developer→Reviewer pipeline runs; the Developer phase is timeout-killed after burning $12 (cost stays null). Job Detail shows 'Pipeline total (3 jobs): $28.xxxx' with no ~, no dash, no footnote — the user reads $28 as the pipeline's full cost while Claude billed ~$40.

**Gap contribution.** A single lost result event on one heavy phase removes that phase's entire cost from the displayed pipeline total with zero signal — $12 on one phase is entirely plausible.


### MED-1 · Persistent-stdin Explore records each turn's ai_invocations row with the session-cumulative total_cost_usd, multiplying conversation cost (flag-gated, default OFF)

**Location:** `server/chat-manager.ts:1169` · **Severity:** medium · **Impact:** overcount · **Category:** cost semantics / persistent-stdin transport

**Evidence.** `_streamPersistentExploreTurn`'s recordInv (chat-manager.ts:1166-1189) writes one ai_invocations row per turn from `finaliseInvocationResult(adapter, adapterEvents)`, persisting `resultPayload.total_cost_usd`/`num_turns` verbatim (claude-adapter.ts:268-269). One long-lived child serves all turns (ExploreStdinSessions.getOrSpawn, explore-stdin-session.ts:92-139); each turn ends on its own result event (finishTurn :1305-1310). No diffing against the previous turn's values, and the only persistent-stdin cost test (chat-manager.test.ts:1110) covers a single-turn session. Same cumulative-result-frame transport empirically verified in the interactive-job finding: row n contains the cost of turns 1..n, so summing rows overcounts ~×(N+1)/2. Active only when SPECRAILS_EXPLORE_PERSISTENT_STDIN=1 (default OFF).

**Failure scenario.** With the flag on, a 10-turn Explore conversation at ~$0.05/turn (real ~$0.50) writes rows 0.05…0.50 → Analytics shows ~$2.75 for the conversation, and getTicketSpendingSummary inflates the linked ticket the same way.

**Gap contribution.** None for the reported undercount (opposite direction, flag default-off); will corrupt analytics upward the moment the flag ships on.


### MED-2 · Chat crash auto-respawn discards the crashed spawn's burned tokens (adapterEvents zeroed), and a respawn spawn-failure writes no row at all

**Location:** `server/chat-manager.ts:906` · **Severity:** medium · **Impact:** undercount · **Category:** capture / crash-respawn

**Evidence.** When an explore child exits non-zero before `result` (chat-manager.ts:863-871), the respawn branch resets accumulators: `this._buffers.set(conversationId, '')` (:904) and `adapterEvents.length = 0` (:906, commented as avoiding 'double-count'). But the first spawn's API calls are already billed, and the respawned process's result.total_cost_usd covers only its own calls (`--resume` restores conversation state, not the cost counter). Only ONE row is written for the turn (:984), reflecting only the second spawn. If the respawned child hits an async spawn 'error' (:919-940), the handler cleans up and resolve()s WITHOUT any recordInvocation — the turn is entirely invisible.

**Failure scenario.** A heavy explore turn crashes 2 minutes in after $1+ of tool-call rounds; the auto-respawn re-runs with --resume and the recorded row carries only the second process's cost. Claude's accounting includes both processes; the app includes one.

**Gap contribution.** Plausible contributor if any explore turn crashed during the heavy execution — each occurrence loses the full pre-crash burn.


### MED-3 · Custom-agent generate and test spawns (Studio generate, manual test endpoint, and default-on per-refine-turn auto-test) are untracked

**Location:** `server/agent-generator.ts:68` · **Severity:** medium · **Impact:** undercount · **Category:** untracked billable spawn (capture completeness)

**Evidence.** agent-generator.ts:68 (generateCustomAgent spawnClaude, 90s cap) and :177 (testCustomAgent spawnClaude, 120s cap / 4000-token ceiling) have no recordInvocation. Callers: profiles-router.ts:510 (POST /profiles/catalog/generate), :482 (POST /profiles/catalog/test — persists tokens/duration into `agent_tests` but never into ai_invocations), and agent-refine-manager.ts:487 `_runAutoTest` which fires AFTER EVERY refine turn when smart-mode auto-test is on — and auto-test defaults ON (startRefine line 156: `autoTest: opts.autoTest !== false`), so every refine session records its refine turns (surface='ai-edit') but silently drops one extra spawn per turn. testCustomAgent already parses usage (tokensIn/tokensOut at 222-226) — the data exists and is discarded for cost purposes.

**Failure scenario.** User iterates 10 refine turns on a custom agent with default auto-test: 10 recorded ai-edit rows + 10 unrecorded test spawns (each sends the full agent body as system prompt + sample task) plus any Studio generate/test clicks. Claude bills 20+ invocations; analytics shows 10.

**Gap contribution.** Modest: doubles the invisible-spawn count of an agent-editing session; ~$0.5-1.5 on a heavy day.


### MED-4 · Sidebar chat (kind='sidebar') is completely unrecorded — every billable sidebar turn (project cwd + live dashboard context) is invisible to analytics

**Location:** `server/chat-manager.ts:974` · **Severity:** medium · **Impact:** undercount · **Category:** capture completeness (documented design exclusion)

**Evidence.** The recording gate is `if (this._projectId && conversation.kind === 'explore')` (chat-manager.ts:974; same gate on the persistent path at :716/1172); test chat-manager.test.ts:907-923 pins that kind='sidebar' writes zero rows. Kinds are clamped to exactly 'sidebar'|'explore' at creation (project-router-chat.ts:145). Sidebar is fully billable: it spawns in the project path (`_resolveSpawnCwd` :349-352, so the project CLAUDE.md auto-loads), prepends the dashboard-context block to every turn (:671-676), and uses the full live-context `_buildSystemPrompt()` (little prompt caching since it embeds live aggregates). CLAUDE.md documents this as intentionally out-of-scope, but versus Claude's own accounting it is a systemic undercount with no UI disclosure, and it is also absent from the jobs table so StatusBar/HOME miss it too.

**Failure scenario.** During the heavy execution the user asks the sidebar chat about job progress. Each turn re-sends CLAUDE.md + dashboard context + history ($0.05-0.50+, more with tools). 10-15 sidebar turns ≈ $1-5 billed by Anthropic, $0 recorded anywhere.

**Gap contribution.** Plausible single-digit dollars on a chat-heavy day; a documented decision that nonetheless directly widens the app-vs-Claude delta.


### MED-5 · Daily-budget PAUSE enforcement sums only status='completed' jobs with a UTC date('now') boundary and reads only the jobs table — failed-but-billed jobs and all non-job surfaces never count, and it disagrees with the /budget meter

**Location:** `server/queue-manager.ts:1937` · **Severity:** medium · **Impact:** undercount · **Category:** budget enforcement aggregation / period boundary

**Evidence.** Per-project enforcement: `SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM jobs WHERE status = 'completed' AND total_cost_usd IS NOT NULL AND started_at >= date('now')` (queue-manager.ts:1936-1938); app-level budget is the same query per project (project-registry.ts:408-410). (a) `status='completed'` excludes failed/canceled rows that carry REAL cost — a claude run ending in result subtype error_max_turns/error_during_execution emits total_cost_usd, exits non-zero, and finishJob persists that cost onto a 'failed' row (queue-manager.ts:1814-1834 writes tokenData for any finalStatus) — while the GET /budget meter sums the same table with NO status filter (project-router-spending.ts:412), so the two disagree; (b) `date('now')` is the UTC calendar date, not the user's local day (spend near local midnight lands on the wrong 'day'; the dailyTimeline got a tzOffsetMinutes fix, this query did not); (c) only the jobs table is read, so quick-spec/explore/ai-edit/file-summary/loop spend never counts toward any daily budget; (d) the whole check runs only inside `if (jobCost != null && finalStatus === 'completed')` (queue-manager.ts:1911), so a day of expensive failures never even triggers evaluation.

**Failure scenario.** Daily budget $30. Day so far: $20 completed + $12 failed-with-cost jobs. The /budget meter shows $32 (over budget) but the enforcement sum is $20 < $30, so the queue keeps launching rails — the app both displays an exceeded budget and keeps spending past the user's cap.

**Gap contribution.** Indirect: doesn't change the Analytics total, but it lets real spend exceed the guardrail by exactly the failed-job/non-job cost — a $12-sized overshoot is plausible on a heavy execution.


### MED-6 · Per-project GET /budget costToday: UTC date('now') boundary + jobs-table-only scope

**Location:** `server/project-router-spending.ts:412` · **Severity:** medium · **Impact:** both · **Category:** period-boundary + surface scope

**Evidence.** `SELECT COALESCE(SUM(total_cost_usd), 0) as costToday FROM jobs WHERE started_at >= date('now')` (project-router-spending.ts:411-413). (a) `date('now')` is the UTC calendar date while started_at is a UTC instant of a local-time event — the day boundary is UTC midnight, not the user's; (b) it reads only `jobs`, excluding all ai_invocations-only surfaces from the daily-budget meter; (c) the lower bound relies on lexicographic prefix comparison, fragile to any started_at format change.

**Failure scenario.** User in UTC+2 runs $8 of jobs between 00:15 and 01:50 local (= previous UTC day). At 09:00 they open the budget meter: those jobs are excluded from 'today' — costToday undercounts by $8 and budgetUtilizationPct is wrong; a user west of UTC gets the mirror overcount. Independently, a day spent mostly in Explore shows costToday ≈ $0.

**Gap contribution.** Plausible partial contributor if the user compared the budget meter against Claude's per-day accounting.


### MED-7 · Multi-ticket jobs attribute 100% of cost to ticketIds[0]: topTickets and /tickets/:id/spending-summary over/under-attribute batch spend

**Location:** `server/queue-manager.ts:1856` · **Severity:** medium · **Impact:** both · **Category:** ticket attribution

**Evidence.** Every ai_invocations job row stamps `ticket_id: ticketIds[0] ?? null` (queue-manager.ts:829, 1072, 1856, 2145). topTickets groups `GROUP BY ticket_id, surface` (spending.ts:581-585) and the per-ticket endpoint sums `WHERE ticket_id = ?` (ai-invocations.ts:149-152, served by project-router-spending.ts:189). CLAUDE.md acknowledges 'primary ticket only' for Code-explorer provenance, but the same truncation silently corrupts per-ticket dollars: the whole batch cost lands on one ticket and the rest read $0.

**Failure scenario.** A batch rail `/specrails:batch-implement #12 #13 #14` costs $9. Ticket #12's spending-summary shows $9.00 (3× overcount); #13/#14 show $0.00. topTickets ranks #12 as the most expensive while the others never appear.

**Gap contribution.** Not for the headline total (hero sums all rows), but yes for per-ticket reconciliation: tickets in a heavy batch read $0 each, easily $12 across a batch.


### MED-8 · App-level cost KPIs (HOME analytics, StatusBar /stats costToday, /api/state) read ONLY the jobs table — all non-job billable surfaces (explore, quick-spec, ai-edit, contract-refine, file-summary, smash, loop-only rows) are invisible

**Location:** `server/desktop-analytics.ts:118` · **Severity:** medium · **Impact:** undercount · **Category:** surface scope / wrong source table

**Evidence.** queryProjectKpi aggregates `FROM jobs ${clause}` (desktop-analytics.ts:111-119), queryProjectTimeline likewise (:137, :246), and getDesktopTodayStats — feeding the always-visible StatusBar and `/api/state` costToday — sums `FROM jobs ${clause}` (:299); getStats (db.ts:1330-1347) likewise computes totalCostUsd/costToday FROM jobs only. None touch ai_invocations, where six additional billable surfaces record. The prior audit patched these queries' estimated-cost split (BUG-24/27/28) but left the jobs-only sourcing untouched, explicitly describing the surface as 're-derives cost from the jobs table' without flagging the coverage undercount. The per-project Analytics page reads ai_invocations, so the app's two 'total spend' numbers structurally disagree.

**Failure scenario.** Heavy day: $22-28 of pipeline jobs plus $12 of Explore sessions, quick-specs, AI edits and file summaries. The StatusBar 'cost today' and the HOME analytics Total-cost KPI show the jobs figure while Claude's accounting shows the full amount — a $12 undercount from a surface-scope hole.

**Gap contribution.** Yes — if the ~$28 figure came from StatusBar/HOME/api-state rather than the per-project Analytics page, the missing $12 is exactly the non-job spend these KPIs never query.


### MED-9 · Per-project /analytics defaults to a 30-day window — windowed total easily read as the all-time total

**Location:** `client/src/pages/AnalyticsPage.tsx:76` · **Severity:** medium · **Impact:** undercount · **Category:** client display / default filter

**Evidence.** `const initialPeriod = (searchParams.get('period') as Period | null) ?? '30d'` — the hero burn meter then shows only the windowed sum.

**Failure scenario.** User compares the hero figure against Claude's all-time/console number; anything older than 30 days is silently missing from the app figure.


### MED-10 · Desktop (cross-project) analytics defaults to a 7-day window for a KPI labelled 'Total cost'

**Location:** `client/src/pages/DesktopAnalyticsPage.tsx:285` · **Severity:** medium · **Impact:** undercount · **Category:** client display / default filter

**Evidence.** `const [period, setPeriod] = useState<AnalyticsPeriod>('7d')`.

**Failure scenario.** Home analytics 'Total cost' shows 7 days of spend; read as a grand total it understates arbitrarily.


### MED-11 · App-level analytics auto-refresh listens for a WS message ('log' + event_type 'job_done') the server never emits — totals go stale

**Location:** `client/src/pages/DesktopAnalyticsPage.tsx:296` · **Severity:** medium · **Impact:** undercount · **Category:** client staleness

**Evidence.** Handler gates on `msg.type === 'log' && msg.event_type === 'job_done'`; server-side grep shows no such broadcast (job completion is `rail.job_completed`; event frames use `type:'event'`).

**Failure scenario.** Job finishes while the Home analytics page is open → KPIs keep the pre-job figure until manual reload/period change.


### MED-12 · Cancelled/disposed AI-Edit refine turns return before recordInvocation — no row (not even aborted) is written

**Location:** `server/agent-refine-manager.ts:377` · **Severity:** medium · **Impact:** undercount · **Category:** capture-loss (cancel path)

**Evidence.** `if (this._cancelledIds.delete(refineId)) return` and `if (this._disposed) return` both precede the `ai_invocations` capture block.

**Failure scenario.** User cancels an AI-Edit turn after tokens streamed → real spend, zero rows.


### MED-13 · file-summary generator discards captured cost on non-zero exit and on empty-summary rejection

**Location:** `server/file-summary-generator.ts:187` · **Severity:** medium · **Impact:** undercount · **Category:** capture-loss (failure path)

**Evidence.** `if (code !== 0) { reject(...) ; return }` and `if (!summary) { reject(...) }` happen before `finaliseInvocationResult(adapter, events, ...)` — the parsed events (with usage) are thrown away with the rejection.

**Failure scenario.** Summary spawn burns tokens then exits 1 → no ai_invocations row; the monthly budget gate also counts less than real spend, allowing overshoot.


### LOW-1 · Auto-title spawns are billable claude invocations that are never recorded (fired on the first turn of every conversation)

**Location:** `server/chat-manager.ts:1417` · **Severity:** low · **Impact:** undercount · **Category:** untracked billable spawn (capture completeness)

**Evidence.** _autoTitle (chat-manager.ts:1404-1448) spawns a fresh CLI child (`spawnAiCli(adapter.binary, args, …)` at :1417) with `adapter.defaultModel()` on the first turn of every conversation — both explore (legacy :1051-1053, persistent :1259-1261) and sidebar. The close handler (:1438-1448) only updates the title and broadcasts; no finaliseInvocationResult/recordInvocation, and the result event's total_cost_usd is never even parsed (:1429-1436 extract text-delta only).

**Failure scenario.** 15 new conversations during a heavy day fire 15 hidden sonnet spawns (~500-char title prompt each). Billed by Claude, invisible to the app — cents, not dollars.

**Gap contribution.** Marginal (<$0.01/event); cannot explain a meaningful share of $12.


### LOW-2 · Setup-wizard AI spawns (Claude /setup chat) are unrecorded on any accounting surface

**Location:** `server/setup-manager.ts:1234` · **Severity:** low · **Impact:** undercount · **Category:** capture completeness (documented design exclusion)

**Evidence.** setup-manager.ts spawns the provider binary via `spawnAiCli(adapter.binary, args, {…})` (line 1234) for the wizard's phase-4 Claude /setup chat; grep for recordInvocation/total_cost_usd in setup-manager.ts → zero hits, and SetupManager writes no jobs row — the spend is invisible to ai_invocations, the jobs table, and every dashboard. Documented out-of-scope in CLAUDE.md.

**Failure scenario.** User adds a project during the same billing window and runs the setup chat through several codebase-aware Claude turns (~$0.50-2); the app's total for the day omits them entirely.

**Gap contribution.** Minor unless a project was added the same day; typically <$2, but non-zero and systematic.


### LOW-3 · Summary CSV '# By model' section is silently top-10-truncated and excludes NULL-model rows — its sum does not reconcile to '# Totals'

**Location:** `server/project-router-spending.ts:274` · **Severity:** low · **Impact:** undercount · **Category:** export truncation / breakdown-vs-total

**Evidence.** byModel is built with `AND model IS NOT NULL` (spending.ts:386) and `.slice(0, 10)` (:408). The summary CSV emits exactly those rows under '# By model' (project-router-spending.ts:272-274) with no truncation marker — unlike the raw export's `# truncated_at=N of M` (line 329). NULL-model rows (every killed/aborted claude run) are absent from the section entirely, and any (provider,model) key beyond the 10th vanishes.

**Failure scenario.** 12 distinct model keys in the window, the two smallest total $1.50. The CSV's '# By model' sums to $26.50 while '# Totals' says $28.00 — a reconciliation script concludes $1.50 is unexplained, with no marker in the file.

**Gap contribution.** Minor: export reconciliation only, bounded by the tail beyond top-10; compounds confusion when auditing the gap.


### LOW-4 · minCostUsd filter compiles to `total_cost_usd >= ?`, so minCostUsd=0 silently drops all NULL-cost rows (not a no-op)

**Location:** `server/spending.ts:261` · **Severity:** low · **Impact:** neutral · **Category:** filter semantics / NULL handling

**Evidence.** `if (typeof filters.minCostUsd === 'number') { conditions.push(`${a}total_cost_usd >= ?`) }` (spending.ts:260-262). In SQLite `NULL >= 0` evaluates to NULL → row excluded. The client's raw-table filter sends 0 as a number, so entering 0 — read by the user as 'no minimum' — removes every unpriced (aborted/killed) row from the invocations table, totalRuns and failureRate for that fetch.

**Failure scenario.** A user investigating the $12 gap types 0 into the min-cost filter to 'show everything'. The NULL-cost aborted rows whose missing cost IS the gap disappear from the table, and the user concludes those runs were never recorded at all.

**Gap contribution.** No direct dollar effect, but it actively hides the NULL-cost rows that explain the undercount, obstructing diagnosis.


### LOW-5 · Gemini Pro long-context (>200k) pricing tier not modeled — flat <=200k rates knowingly under-estimate long-context prompts

**Location:** `server/pricing.ts:52` · **Severity:** low · **Impact:** undercount · **Category:** rate-card tier coverage (long-context)

**Evidence.** In-file comment (pricing.ts:51-52): 'Standard paid tier, <=200k-context prices (Gemini Pro is context-tiered; prompts >200k are under-estimated in v1…)'. PriceEntry has a single input/output pair per model with no context-size dimension; estimateCostUsd (:109-113) applies the flat rate regardless of prompt size.

**Failure scenario.** A gemini-3.1-pro rail with a 600k-token prompt is estimated at the <=200k rate while Google bills the higher tier — every long-context call's estimated cost is systematically below the provider's true billing.

**Gap contribution.** Near-zero for this claude-side incident, but a real acknowledged undercount for gemini-heavy projects.


### LOW-6 · Unkillable-job recovery can double-record the same job: _forceFailUnkillableJob writes an 'aborted' NULL-cost row, then the child's eventual close runs _onJobExit and writes a second row (and double-fires _onJobFinished)

**Location:** `server/queue-manager.ts:2136` · **Severity:** low · **Impact:** both · **Category:** duplicate row

**Evidence.** When SIGKILL escalation fails (queue-manager.ts:2090-2097), _forceFailUnkillableJob records an ai_invocations row status 'aborted', no cost (2136-2151), releases the slot and fires _onJobFinished (2179). The job is NOT removed from `this._jobs` and the child's 'close' listener stays wired — when the process finally dies, _onJobExit runs (the `if (!job) return` guard passes, :1776), finishJob re-stamps the row, recordInvocation inserts a SECOND row for the same surface_ref_id (1850-1862, possibly WITH real cost if a result event streamed), and _onJobFinished fires again (1993) — duplicate webhooks/Jira transitions and inflated totalRuns.

**Failure scenario.** Windows: taskkill fails against a wedged claude tree; the app force-fails the job. Ten minutes later the process exits on its own having emitted a $3 result event. Analytics shows two runs for one job — 'aborted' $NULL and 'failed' $3 — and the rail completion callback ran twice.

**Gap contribution.** Not a contributor to the undercount (run-count overcount; cost captured once at most); accounting-integrity defect adjacent to the kill/timeout paths.


### LOW-7 · Persistent-stdin turns are recorded status='success' even when the result event reports an error (is_error / error subtypes)

**Location:** `server/chat-manager.ts:1221` · **Severity:** low · **Impact:** neutral · **Category:** status accuracy

**Evidence.** The legacy path derives status from the child's exit code (chat-manager.ts:976-980). The persistent path has no per-turn exit code: finishTurn fires on any result event and calls `recordInv(wasAborting ? 'aborted' : 'success')` (:1221) without reading `payload.is_error` or `payload.subtype` (e.g. 'error_max_turns') from the result captured at :1305-1310. Cost/tokens still recorded, so totals unaffected; the row's status is wrong.

**Failure scenario.** With the flag on, a turn hitting max-turns emits is_error=true; the app records status='success'. failureRate under-reports and the failed turn's cost pollutes success-only averages. No effect on the headline total.

**Gap contribution.** None — dollar totals unaffected; distorts failure-rate and per-status breakdowns only, flag-gated.


### LOW-8 · Loop invocation rows never persist num_turns / session_id / duration fields — dropped between the executors and the recorder

**Location:** `server/loop-executors.ts:163` · **Severity:** low · **Impact:** neutral · **Category:** metric completeness (turns/session/duration, not dollars)

**Evidence.** loop-executors.ts:163-184 (runAiStep) and 214-232 (runDecider) build return objects from finaliseInvocationResult's result but omit num_turns, session_id and duration_api_ms (only durationMs survives). loop-run-manager.ts:394-422 then calls recordInvocation without duration_ms / num_turns / session_id — even though `r.durationMs` is in hand one line above (:393) — so the columns are NULL on every surface='loop' row (ai-invocations.ts:97-107 defaults). Downstream: scatter numTurns null, getTicketSpendingSummary.totalTurns and activeDurationMs (ai-invocations.ts:191) exclude all loop steps.

**Failure scenario.** A ticket implemented via a multi-hour loop shows 0 turns and 0 active duration in TicketSpendingLine and blank turns for every loop row in the analytics table, despite dozens of real turns. Cost figures unaffected.

**Gap contribution.** None for dollars — turns/session/duration metadata only.


### LOW-9 · SMASH splitInt floors token and turn splits across children — sum of splits < original (num_turns can collapse to 0)

**Location:** `server/smash-runner.ts:511` · **Severity:** low · **Impact:** undercount · **Category:** split/rounding remainder loss (tokens/turns, not dollars)

**Evidence.** smash-runner.ts:511-514 `Math.floor((v as number) / n)` applied to all four token fields and num_turns (529-534). Cost uses plain float division (:507-510) so per-child costs sum back within epsilon (pinned by smash-runner.test.ts:383). The floored fields lose up to n-1 units each; num_turns regularly rounds to zero because SMASH turn counts (1-30) match the child count magnitude (3-8) — e.g. num_turns=5 with 8 children → 0 per row → 0 total recorded.

**Failure scenario.** Full-mode SMASH finishes in 6 turns producing 8 children → each child row gets num_turns=0; totalTurns and scatter numTurns show 0 for a 6-turn run. Dollar figures NOT affected.

**Gap contribution.** None — cost split is float-exact; only tokens/turns metrics undercount.


### LOW-10 · SMASH failure paths that DO capture real cost never broadcast spending.invalidated — open dashboards keep showing the pre-spend (lower) total

**Location:** `server/smash-runner.ts:779` · **Severity:** low · **Impact:** undercount · **Category:** dashboard invalidation gap (stale undercount in live view)

**Evidence.** smash-runner.ts:779 broadcasts `{ type: 'spending.invalidated' }` only on the fully-successful path. The failure branches that still write a COSTED row — parse failure (:704 recordSafely with result.resultEvent, real cost since the process exited 0 with a result event) and mutation-failed (:729) — return without any broadcast (:705-714, :730-738), violating the 'recordInvocation callsites broadcast spending.invalidated' contract (cf. the BUG-07 fix pattern in loop-run-manager.ts:427-429).

**Failure scenario.** SMASH full-mode burns $2, exits 0, but emits an invalid smash block → row recorded with real $2 (status 'failed') → no invalidation → the open AnalyticsPage keeps displaying a total $2 lower than the DB for the rest of the session.

**Gap contribution.** Only if the user read the figure from an open dashboard without navigating — a transient display undercount.


### LOW-11 · ModelBreakdown percentages use the server-capped top-10 sum as denominator and render only top-5

**Location:** `client/src/components/analytics/ModelBreakdown.tsx:24` · **Severity:** low · **Impact:** neutral · **Category:** client display

**Evidence.** `const total = data.byModel.reduce(...)` over the top-10-capped byModel; `const top = data.byModel.slice(0, 5)`.

**Failure scenario.** With >10 models the bars overstate each model's share; the visible five never reconcile to the hero total.


### LOW-12 · SMASH children share one try/catch around the recordInvocation loop — a mid-loop failure drops all remaining children's cost

**Location:** `server/smash-runner.ts:504` · **Severity:** low · **Impact:** undercount · **Category:** persistence robustness

**Evidence.** Single `try { for (const childId of childrenIds) { recordInvocation(...) } } catch` — first throw (e.g. SQLITE_BUSY) abandons the rest; no retry/durable queue.

**Failure scenario.** DB briefly locked during child 2 of 6 → children 2–6 of the split cost vanish.


### LOW-13 · Salvaged error_max_turns quick-spec (ticket created) is recorded status='failed'

**Location:** `server/project-router-tickets.ts:705` · **Severity:** low · **Impact:** neutral · **Category:** status semantics

**Evidence.** `status: code === 0 && buffer.trim() ? 'success' : 'failed'` — the salvage path that still creates the ticket from the partial buffer records 'failed'.

**Failure scenario.** Cost IS recorded (row always emitted) but success-scoped averages and failureRate are skewed for runs that in fact delivered a ticket.


### LOW-14 · testCustomAgent double-counts token usage (per-message usage + cumulative result usage summed)

**Location:** `server/agent-generator.ts:222` · **Severity:** low · **Impact:** overcount · **Category:** token accounting

**Evidence.** `const usage = (p.usage ?? message?.usage)` accumulates on EVERY stream line — per-assistant-event usage AND the final result's cumulative usage are added together (~2x).

**Failure scenario.** Token ceiling (`tokensIn + tokensOut >= tokenCeiling`) trips at ~half the real budget; reported token counts ~double.


### LOW-15 · Interactive job duration_ms is wall-clock including idle time between turns

**Location:** `server/queue-manager.ts:1063` · **Severity:** low · **Impact:** neutral · **Category:** duration accounting

**Evidence.** `durationMs = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()` for the interactive finalize row.

**Failure scenario.** Interactive job left open 3h with 10 min of real AI activity records 3h — per-ticket 'active duration' analytics inflate.



## Refuted findings (kept for the record)
1. **"Successful SMASH with missing result event records nothing"** (`server/smash-runner.ts:503`) — structurally unreachable: the success path cannot be reached without a result event.
2. **"Native claude `total_cost_usd` of 0 accepted as authoritative"** (`server/result-event.ts:79`) — code observation accurate (0 passes through; fallback gates on `!nativeCostUsd`), but judges found no reachable scenario where the shipped claude CLI emits cost 0 with non-zero usage today. **Latent risk**: becomes real if a CLI version/auth mode ever reports 0.
3. **"PriceEntry has no cache-write tier — fallback prices `tokens_cache_create` at $0"** (`server/pricing.ts:109`) — accurate but latent: claude never takes the fallback today because native cost is always present. **Becomes load-bearing the moment CRIT-1 is fixed with a rate-card estimate — fix them together.**


## Recommended fix order
1. **Stop discarding per-event usage for claude** (`parseClaudeStreamLine`, HIGH-12) and add a kill/abort/timeout finaliser that estimates cost from accumulated usage (fixes CRIT-1 across all surfaces). Add a cache-write tier to `pricing.ts` first (refuted-#3) and mark rows `total_cost_usd_estimated`.
2. **Instrument the worktree merge-back AI steps** (CRIT-2) as `surface='job'` rows tied to the rail job.
3. **Fix the cumulative-vs-per-turn accounting** in persistent-stdin explore + interactive sessions (HIGH-6, MED-15): record per-turn deltas (diff against previous cumulative) or record once at session end.
4. **Flush accounting on shutdown/restart/removal** (CRIT-3/CRIT-4, HIGH-5): write the accumulated row before disposing managers.
5. **Instrument the untracked surfaces** (HIGH-7/8/9/10, MED-17/18, LOW-*): agent chat, AI-Edit route, spec launcher, proposals, agent generator, sidebar chat, auto-titles, cancelled refines, failed file-summaries — or explicitly label them out-of-scope in the analytics UI.
6. **Honest presentation**: label windowed hero figures with the window; make the app-level KPI read `ai_invocations` (not jobs-only); fix the dead `job_done` listener; add an "excludes subagent work reported by the CLI" caveat if that ground-truth gap is confirmed for the shipped CLI version.
