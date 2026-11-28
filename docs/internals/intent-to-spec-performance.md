# Intent → Spec: speed, cost and reliability

Working document for the Intent → Spec optimization (2026-11-27 night). It keeps
the diagnosis, the plan, the benchmark protocol and the measured results, so the
work can resume after an interruption (quota, restart) without losing context.

Status: in progress (set to `complete` when the plan below is done).

How to run: start the dev app (`~/.specrails-dev/.specrails/bench/devprobe/relaunch.sh`,
after `npm run build:sidecar` and a host build when the server changed), then
`node scripts/benchmarks/intent-to-spec.mjs ~/.specrails-dev/.specrails/bench/cases/<case>.json`
(one case; `--provider/--model/--effort` override its engine, `--tag` labels the variant) or
`node scripts/benchmarks/intent-to-spec-matrix.mjs [cases…] --parallel 2 --provider claude --tag <variant>`
(several). Results land in `~/.specrails-dev/.specrails/bench/results/` (`results.jsonl` one line
per run; lines with `invalid` are kept as evidence and excluded from comparisons).

**Case corpus.** `tetris-frame-pacing` replays the real hand-off of spec #10 (its conversation is
forked). Ten synthetic cases replay delivered hand-offs of real projects (arkanoidEX #8 #11 #12 #14,
deckdex #3, tetrisEX #2 #3 #4 #9 #11; 140 to 2,600 changed lines): the Intent starts from the
spec's title and intent (problem, outcome, success signals, constraints) with the code fixed at
the handed-off commit, and no conversation. Each case runs in its own fixture clone, registered
as a `bench-<case>` project, whose `main` is the case base and which has **no remote** (an Intent
branches from the remote default branch when there is one).

## Baseline: the failed run of spec #10 (tetris, dev)

Run `213f7ec7` (`factory:flow-spec`, codex gpt-6.2-sol), 2026-11-27 21:38–22:00:

- **21.5 min, 7.27 USD, 14.1 M tokens, outcome: failed** (`changes-requested`).
- 8 sequential AI turns, each a fresh session that re-reads the project
  (0.9–4.0 M input tokens per turn, mostly cache reads):

| Round | derive | check | review (score, issues) | fix |
|---|---|---|---|---|
| 1 | 182 s | 1 s | 134 s (65, 6 issues: mostly test coverage) | 258 s |
| 2 | 126 s | 1 s | 130 s (78, 2 **new** issues) | 204 s |
| 3 | 91 s | 1 s | 159 s (68, 3 **new** issues) | budget exhausted |

**Root cause: the review does not converge.** Every round the fixer resolved
all the previous findings, but the reviewer — a fresh session
(`sessionContinuity: 'none'`) whose prompt never sees its previous verdict —
re-reviewed from scratch and found different things each time (edge-case
experiments such as a simulated 2,500 ms stall), until the 2 correction rounds
ran out. Speed and cost follow from the extra rounds; reliability fails because
the target keeps moving.

## Plan

1. **Convergent review** (Desktop recipe, `loop-flow-spec-recipe.ts`):
   - First review: one complete pass. Blocking `issues` only for what must hold
     for the change to be delivered (acceptance criteria and requirements,
     broken requested behaviour, failing checks, unfaithful artifacts,
     unexplained files, an ADDED/MODIFIED requirement without a tagged test).
     Hardening, extra edge cases and nice-to-have tests go to `followUps`
     (non-blocking, reported to the person).
   - Re-review (round ≥ 2): receives the previous verdict and the fixer's
     summary; verifies each previous issue and the fix for regressions. A new
     blocking issue only for a defect the fix introduced or a blocking defect
     the first pass could not have seen.
2. **Benchmark harness** reproducing a real Intent → Spec hand-off on a fixed
   commit (case A: tetris #10 at hand-off commit `12eb985`), measuring
   duration, cost, tokens, turns, rounds, outcome and review convergence.
3. Iterate on the next bottlenecks once convergence holds (context size per
   turn, re-derivation after a fix, reviewer exploration budget).
4. Nightly run of the benchmark.

## Results

### 2026-11-27 23:10 — run 1, convergent review (case tetris-frame-pacing)

Run `45b765d0` (bench project `bench-tetris-frame-pacing`, codex gpt-6.2-sol):
derive 161 s (0.57 USD), then the second turn hit **Codex's 5-hour usage
limit** (100 % used, resets 2026-11-28 01:43 UTC) and the run paused.

**Reliability bug found:** the pause recorded `resumeAt: null, autoResume:
false`, so it would never resume by itself. Codex says "try again at Nov 28th,
2026 2:43 AM": `extractLimitReset` cut it at the comma (`Nov 28th`) and
`resolveResetText` did not understand dated resets. Fixed (dated reset, local
time or a named zone): from now on a limit-paused Intent → Spec run resumes on
its own at the provider's reset. This run was recorded before the fix, so it is
resumed with `--resume 45b765d0-587f-4049-a4e5-4b78fd88d9f3` after the reset.

### 2026-11-28 01:40 — corpus, two reliability fixes, and run 1 invalidated

- **Fixture bug (benchmark):** the first runs of the night (run 1 `45b765d0`, and the first
  Claude runs of tetrisex-9 and arkanoidex-14) were based on the source repository's current
  `origin/main`, not on the case base: the derived change "reverted" every feature merged since,
  and the reviewer correctly stopped at `scope-decision`. Fixtures no longer have a remote and the
  harness refuses to hand off an Intent based elsewhere. Those results are marked `invalid`; run 1
  is stopped and the case runs again from scratch (the real baseline run `213f7ec7` had the right
  base, `df8d881`).
- **Quota bug (product):** a refusal whose prose gave no reset stayed "rejected indefinitely" even
  though the usage window at 100 % said when it resets. It now takes that window's reset and
  expires with it.
- Codex is out of quota until 02:43, so the night starts on Claude (default model `sonnet`); the
  Codex comparison with the baseline follows when it resets.

### Experiment 2 (pending measurement) — the reviewer keeps its session

From commit "perf(intent-spec): the reviewer keeps its session across rounds",
the review node uses `sessionContinuity: 'run'` (Core reuses the reviewer's
provider session within the run): a re-review remembers what it read and asked
for. The fixer still starts fresh, so the effect is attributable. Runs launched
before this commit (run 1, `45b765d0`) froze the earlier graph and measure the
convergent review alone. Measure it with a new run of the case (not `--resume`).

