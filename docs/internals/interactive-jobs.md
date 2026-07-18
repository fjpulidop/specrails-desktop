# Interactive jobs (as-built)

Every claude job — Job Detail (board) and the mission-mode job modal alike — renders a bottom
agent-style composer while the job runs. This doc is the as-built record of the session model
behind it: the transport, the two settle modes, the loop-step ownership design, the accounting
reconciliation, and the failure interplay. User-facing behaviour: the in-app guide's
[Job Detail view](../guide/en/pipeline/2-the-job-detail-view.md) page. Code:
`server/interactive-job-session.ts`, `server/queue-manager.ts` (the interactive branch of
`_startJob`), `server/loop-executors.ts` `planInteractiveAiStep`, `server/loop-run-manager.ts`
`_runInteractiveAiStep`, `server/project-router-jobs.ts` (the two manager-agnostic routes),
`client/src/components/InteractiveJobComposer.tsx`.

## Session model

A standard job spawns `claude -p <prompt>` once and settles when the child closes. An
**interactive** job instead keeps ONE `claude -p --input-format stream-json` child resident
across many user turns — the same persistent-stdin transport `ExploreStdinSessions` uses for
Explore chat. Each user prompt is a newline-delimited stream-json message written to stdin; the
agent works; the turn ends on a `result` event **without killing the child**. A prompt that
arrives mid-stream queues behind the active turn and runs next (`job.turn_user` carries
`queued: true`); the job still tends to continue its plan — messages are steering, not
interruption.

`InteractiveJobSession` owns the transport plus per-turn streaming/persistence/accounting. The
owner (QueueManager or the loop engine) owns spawn-arg construction and the terminal settle
(slot release, rail/ticket completion, `ai_invocations`) via the `onSettle(SettleInfo)`
callback. Turn-id tagging (`_activeTurnId` / `_lastSettledTurnId`) guarantees a stray, late, or
duplicate `result` frame can never be folded into the next turn's totals (BUG-INTJOB-03).

### The spike that unlocked the flip

The original interactive path was freestyle-only because freestyle sends prose, not a slash
command. Spike-verified 2026-07-03 against **claude 2.1.198**: the claude CLI expands slash
commands arriving as stream-json stdin user frames **exactly like the argv `-p "/cmd"` path**
(evidence pointer: the dated comment block above the interactive gate in
`server/queue-manager.ts` `_startJob`, and `loop-executors.ts` `planInteractiveAiStep`). That
makes every job — `/specrails:implement`, `/specrails:batch-implement`, distilled loop commands,
custom commands — transport-compatible, so the default flipped to interactive for every
persistent-stdin-capable provider.

## Gating

Derived at **spawn time** (not enqueue) in `QueueManager._startJob`, so a queued job that
survives a server restart (the in-memory selection map is lost) still spawns interactive:

```
spawnInteractive = isInteractiveJobsEnabled()            // SPECRAILS_INTERACTIVE_JOBS !== 'false'
                && adapter.capabilities.persistentStdin  // claude only today
                && (EnqueueOptions.interactive ?? true)  // tri-state per-job override
```

- `EnqueueOptions.interactive`: `false` = force the legacy one-shot spawn, `true` = force
  interactive where capable, `undefined` = default ON.
- codex/gemini (`persistentStdin: false`) always take the one-shot path — graceful, no
  composer, byte-identical to before.
- The rails launch body still accepts a legacy `interactive` param; it is **ignored** (wire
  compat — the spawn-time gate decides).

## `settleMode` semantics

| | `'finalize'` | `'auto'` |
|---|---|---|
| Who gets it | freestyle/Freestyle QueueManager jobs (claude) | every other interactive job + ALL loop ai-steps |
| End of session | explicit human **Finalize** only (SIGTERM → 2s → SIGKILL) | **quiescence**: a turn `result` arrived, nothing queued, no write in flight — torn down GRACEFULLY: stdin EOF (the CLI exits itself, flushing its session transcript so the next loop step can `--resume`), SIGTERM only after a grace window (`quiescentEofGraceMs`, default 5s) or when stdin is already gone |
| Idle between turns | by design (awaiting the human) | only transiently (microtask window) |
| Wedge detector | never armed | the queue's zombie-timeout budget, reset on any raw child output; silence for the whole budget → fold in-flight turn, settle `crashed` |
| Composer action | **Finalize Job** | **Wrap up now** (QueueManager) / **Settle this step** (loop step) |

**Quiescence detail:** the auto-settle is deferred to a microtask after the `result` so anything
in the same synchronous stdout batch is observed first, and re-checked — a user prompt that
slipped in meanwhile queues/writes a new turn and **extends the session** instead. An explicit
`finalize()` always settles immediately in either mode.

## Loop-step ownership and routing

All dashboard rail launches (factory `Implement`/`Batch`/`Freestyle` and custom loops) run
through the `LoopRunManager`. When interactive jobs are enabled and the provider supports
persistent stdin, each claude **ai-step** runs as its own `InteractiveJobSession`
(`planInteractiveAiStep` builds the spawn plan; `_runInteractiveAiStep` owns the lifecycle):

- **`runId` = the job row id.** The loop run's backing `jobs` row is created with `id = runId`,
  so `/jobs/:id/*` routes address the run directly. `markJobInteractive` stamps the row when the
  first interactive step goes live (idempotent), so `GET /jobs/:id` advertises the affordance.
- **Turns go to the ACTIVE step's session** (`_interactiveSteps: Map<runId, session>`). Between
  steps — decider, shell nodes, step boundaries — there is no session: `POST /messages` 409s,
  and the composer shows a gentle waiting state instead (driven by the `job.interactive`
  broadcast, `acceptingTurns: false` at step settle / `true` at step start). A between-steps
  `GET /jobs/:id` still reports `interactiveSettleMode: 'auto'` via the `loop_runs` row so the
  client can phrase the waiting state truthfully.
- **Finalize settles the current STEP**, not the run: the session settles `'finalized'`, the
  `SettleInfo` maps onto the same `AiStepResult` shape the one-shot executor returns, and the
  loop advances with whatever the step produced (history, changeId capture, fail-fast all
  untouched).
- **Shared event seq:** the session draws event seq numbers from the engine's monotonic
  allocator (`nextEventSeq`) because the loop engine persists its own step-boundary/log events
  on the same job id — private counters would collide/replay out of order.
- **Teardown matrix** (never leaks the child, never double-settles — `_settle` is idempotent):
  quiescence / explicit finalize → `'finalized'` (step ok); step timeout → `session.abort()` →
  fold in-flight turn → `'crashed'`; run cancel → `abort()` → `'crashed'` → engine settles the
  run `'stopped'` at the next boundary; manager shutdown / project removal → `dispose()` (kill,
  NO settle; the startup orphan sweeps reconcile rows on next boot). No zombie timer is armed on
  loop steps — the loop's ai-step timeout bounds the whole step and is the sole watchdog
  (byte-parity with the one-shot loop path, which has no zombie detector either).

## Accounting reconciliation

Two writers, one clean split — nothing double-records:

- **The session feeds live job-row totals.** Every completed turn's REAL usage is summed onto
  the `jobs` row as it lands (`accumulateInteractiveTurn`), so the live Job Detail totals are
  honest (never an estimate) and the composer's `N turns · $X` line is real money. The
  persistent transport reports `total_cost_usd`/`num_turns` **cumulatively** per turn, so the
  session records deltas against a per-child baseline (clamped ≥ 0) — summing raw readings
  would count turn 1 N times (COST-ACCOUNTING-AUDIT HIGH-2). Token fields are per-turn and sum
  directly.
- **The engine/owner is the sole `ai_invocations` authority.** QueueManager writes one row at
  settle from the summed `SettleInfo` totals; the loop engine writes one `record()` row per
  step the same way. The session itself never writes an invocation row.
- **Mid-turn kill = fold, not drop.** A finalize/crash/timeout mid-turn folds the in-flight
  turn's streamed per-assistant-event usage via `finaliseInvocationResult` and prices it from
  the rate card (`estimated: true` → the row and job get the estimated badge; CRIT-4). Idempotent
  (`_inflightFolded`) so a settle and a shutdown snapshot can't fold twice.
- **Active duration ≠ wall clock.** `activeDurationMs` sums only write→result segments,
  excluding idle time between turns, so a long-open `'finalize'` session doesn't inflate
  per-ticket duration analytics (LOW-15).

## Zero-work settles (failure semantics)

Live evidence (run `01f41203`): a mistyped `/specrails:implement` made the claude CLI emit a
**synthetic** terminal result frame — `{subtype:'success', is_error:false, num_turns:0,
total_cost_usd:0, duration_api_ms:0, result:'Unknown command: /specrails:implement'}` — and exit
cleanly. No model ever ran, yet the settle looked like a success (the job "completed" at $0; a
factory loop then "succeeded" via verify/fix without implementing). Strictness rule: **if the
command didn't actually run, the settle is FAILED.**

- **The predicate is shared and whole-life.** `isZeroWorkSettle` (exported from
  `server/interactive-job-session.ts`) judges the session/step's WHOLE accumulated life: it is
  zero-work when `num_turns === 0` accumulated AND no assistant-derived event was ever observed
  (`isModelWorkEvent`: text-delta / tool-use / assistant frames / usage-carrying events; `result`
  frames do NOT count — the synthetic no-op IS a result frame) AND all four token counters are
  zero. Belt-and-braces: a final result text matching `/^Unknown command:/` marks zero-work even
  if the numeric accounting drifted — but only when no assistant event was seen, so a multi-turn
  session that did real work earlier and merely **ended** on a synthetic frame (the user sent
  `/help` late) is NOT zero-work and still completes.
- **The session evaluates it at settle** and hands `SettleInfo.zeroWork` to the owner. It also
  surfaces the reason as a visible stderr transcript line (`✖ Zero work performed — the command
  never ran: Unknown command: …`) — necessary because `extractDisplayText` drops `result` frames,
  so the synthetic text would otherwise never appear in the log.
- **QueueManager** (`_settleInteractiveJob`): a zero-work `'finalized'` settle stamps the job
  `'failed'` (exit code 1, failed `ai_invocations` row, dependents skipped) — **in both settle
  modes**, so an freestyle Finalize after only the synthetic frame is also a failure. A canceled
  job stays `'canceled'`.
- **LoopRunManager** (ai-steps): a zero-work settle makes the step's `AiStepResult` `failed` and
  its `loop_step_end` `status:'failed'`, and it **routes exactly like a crashed step** — the run
  policy is unchanged (graph-dependent continue + the `AI_FAILFAST_THRESHOLD` consecutive-failure
  abort); zero-work counts toward that streak like a no-output crash (its `Unknown command:` text
  is a CLI synthetic, not model output), so a persistently-unresolvable command aborts the run the
  same way a dead provider does. The one-shot loop path derives the same predicate at the engine
  from the step result's accumulated signals (one-shot `text` accumulates only from assistant
  text-deltas, so non-empty text ⇒ assistant events were seen).

## Zombie / timeout interplay

- **One-shot jobs**: unchanged — the queue's zombie timer kills a silent child.
- **Interactive `'auto'`**: the same zombie budget is armed *inside* the session (reset on any
  stdout/stderr `data`); firing folds the in-flight turn and settles `'crashed'`.
- **Interactive `'finalize'`**: no timer at all — an idle session awaiting Finalize is the
  feature. QueueManager's queue-level timer is never armed for interactive jobs.
- **Loop ai-steps**: no zombie timer; the step timeout aborts the session (`'crashed'`,
  `errorText: 'AI step timed out'`), partial work accounted.
- **Finalize hard-deadline**: SIGTERM → 2s → SIGKILL, plus a forced settle if the child never
  emits `close` (D-state / signal-swallowing) so the queue slot can never leak.
- **Undeliverable turns**: a confirmed-failed stdin write (destroyed/EPIPE) is surfaced as a
  delivery-failure note and settles `'crashed'` — a turn is only echoed to the transcript after
  delivery is confirmed. Prompts still queued when the session ends are surfaced in the
  transcript (`N queued prompt(s) were not sent`), never dropped silently.

## Surface state on the wire

- `GET /jobs/:id` → `interactiveSettleMode: 'finalize' | 'auto' | null` +
  `interactiveAcceptingTurns: boolean` (S3 — lets the composer phrase Finalize vs wrap-up vs
  waiting truthfully; `null`/`false` while queued, refetched on the queued→running flip).
- `POST /:projectId/jobs/:id/messages` / `POST .../finalize` — **manager-agnostic**: QueueManager
  is tried first, then LoopRunManager. `202` accepted/scheduled, `403` kill-switch off, `409` no
  live session.
- WS: `job.turn_user` (echo + `queued` flag), `job.turn_done` (running totals), `job.finalized`
  (final totals + terminal status), `job.interactive` (`acceptingTurns` flip on loop-step
  start/settle).
- Provenance: interactive QueueManager jobs snapshot the repo working tree pre-spawn and diff at
  settle, exactly like one-shots (Code Explorer attribution intact).

## Kill-switch matrix

| Setting | Effect |
|---|---|
| `SPECRAILS_INTERACTIVE_JOBS=false` (server) | Byte-identical legacy everywhere: every job spawns one-shot, `/messages` + `/finalize` return 403, loop ai-steps one-shot, no `job.*` interactive events. |
| `VITE_FEATURE_INTERACTIVE_JOBS=false` (client build) | Hides the composer UI; the server behaviour is unchanged (pair it with the server flag for a full opt-out). |
| `EnqueueOptions.interactive: false` (per job) | That one job spawns one-shot; everything else unaffected. |
| Provider without `persistentStdin` (codex, gemini) | Automatic one-shot fallback, no error, no composer. |
| Default (nothing set) | Interactive ON for every claude job and every claude loop ai-step. |

## Bare-mode launches (same branch)

Also part of this change: a `POST /rails/:i/launch` carrying a bare legacy `mode` and **no
`loopId`** (MCP tools, mobile, direct REST) now derives the matching **factory loop** when Loops
are enabled (`rails-router.ts`), so every launch door runs through the LoopRunManager like the
dashboard — identical worktree isolation and ask-first PR flow. Without this, an agent-launched
implement landed in the bare QueueManager branch: shared cwd, `SPECRAILS_GIT_AUTO=false`, no
delivery row — stranded uncommitted work. Loops disabled ⇒ the legacy QueueManager path,
unchanged. Relatedly, the agent-chat operator prompt gained the ask-confirmation-once
turn-discipline rule (`server/agent-operator-prompt.ts`): a confirmation question is asked
exactly once and ends the reply — the answer arrives as the next user message.
