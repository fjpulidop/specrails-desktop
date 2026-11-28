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

### 2026-11-28 02:35 — convergent review + reviewer session, on Claude (sonnet)

Five synthetic cases (the night's first valid runs; Codex was out of quota):

| Case | Changed lines | Outcome | Minutes | USD | AI turns | Rounds | Reviews (score, blocking issues) |
|---|---|---|---|---|---|---|---|
| tetrisex-9 | 143 | success | 2.6 | 1.51 | 5 | 1 | 78 (1) → 88 (0) |
| arkanoidex-14 | 297 | success | 5.2 | 2.75 | 6 | 1 | 62 (5) → 86 (0) |
| arkanoidex-12 | 171 | success | 4.1 | 2.20 | 5 | 1 | 58 (4) → 84 (0) |
| tetrisex-4 | 388 | success | 1.8 | 0.66 | 2 | 0 | 90 (0) |
| tetrisex-11 | 335 | success | 5.1 | 3.05 | 6 | 1 | 62 (5) → 86 (0) |
| deckdex-3 (python) | 408 | failed | 1.4 | 0.43 | 1 | 0 | — (check could not start) |
| deckdex-3, setup fix | 408 | scope-decision | 2.3 | 0.67 | 2 | 0 | 80 (2 "unrequested") |

- **The review converges**: every correction round ended in approval at the second review, with
  no new blocking issue (the baseline found new ones every round and never approved). The
  re-review takes 9–17 s (the reviewer keeps its session) against 22–45 s for the first.
- **Most first-round issues are requirement tags**: the Intent's tests cannot carry the ids
  `[spec:<capability>/<slug>]` before derive invents them, so the first review always asked for
  them, and a whole round (fix, re-derive, check, re-review: about half of each successful run)
  was spent on it. The rest are real gaps (a requirement no test demonstrates). → experiment 3.
- **Python projects could not pass Intent → Spec at all** (deckdex-3): the configured check is
  `.venv/bin/python -m pytest`, but the flow-spec verify nodes, unlike the implement and PR CI
  recipes, never ran the configured setup that builds the git-ignored venv in the fresh Intent
  worktree (`spawn .venv/bin/python ENOENT`). Fixed in the recipe and the Core reference
  definition (fjpulidop/specrails-core#489): both verify nodes take `setup: 'configured'`.
- **Test scaffolding was treated as a scope question** (deckdex-3, second run): the reviewer
  listed mocked `setUp` and new isolation tests as `unrequested`, which stops the run for the
  person. `unrequested` is now product behaviour only. (A synthetic case has no conversation, so
  its scope evidence is thinner than a real hand-off's.)

### 2026-11-28 02:55 — experiment 3: a tag step between derive and check

After each derivation a `tag` role-turn (developer, fixer stance; test titles and tag comments
only, no assertions, tests, production code or `openspec/`) tags the existing tests with the
derived requirement ids, so the first review judges real gaps instead of missing ids. Mirrored in
the Core reference definition. Same run also has the setup and `unrequested` fixes.

**Baseline case on its own engine (Codex gpt-6.2-sol, real conversation forked):**

| Run | Outcome | Minutes | USD | Tokens | AI turns | Rounds | Reviews |
|---|---|---|---|---|---|---|---|
| baseline `213f7ec7` | **failed** | 21.5 | 7.27 | 14.1 M | 8 | 2 (budget spent) | 65 → 78 → 68, new issues every round |
| `58357f6f` | **success** | 10.9 | 4.68 | 6.8 M | 8 | 1 | 67 (4 issues) → 91 approved |

The four first-round issues were real (the benchmark run aborting on pause, the report dialog's
keyboard priority, two requirements without a test), the re-review verified them and approved.

**Ten synthetic cases on Claude (sonnet):**

| Case | Outcome | Minutes | USD | AI turns | Rounds | Reviews |
|---|---|---|---|---|---|---|
| tetrisex-2 (2,595 lines) | success | 1.4 | 0.76 | 3 | 0 | 86 |
| tetrisex-9 | success | 2.2 | 0.74 | 3 | 0 | 88 |
| arkanoidex-11 | success | 2.2 | 0.82 | 3 | 0 | 86 |
| arkanoidex-8 (1,485 lines) | success | 2.2 | 0.89 | 3 | 0 | 86 |
| tetrisex-4 | success | 2.7 | 0.97 | 3 | 0 | 90 |
| deckdex-3 (python) | success | 3.0 | 0.86 | 3 | 0 | 88 |
| tetrisex-3 | success | 5.7 | 3.60 | 8 | 1 | 72 → 84 |
| arkanoidex-14 | success | 5.9 | 3.32 | 8 | 1 | 66 → 86 |
| tetrisex-11 | success | 6.1 | 3.65 | 8 | 1 | 72 → 86 |
| arkanoidex-12 | changes-requested | 3.1 | 1.17 | 4 | 1 | 68 (1 issue for the deriver) |

- 9/10 succeed; 6 need no correction round at all (one derive, one tag, one review). Before the
  tag step 4 of 5 comparable cases needed a round. The rounds left are real gaps (requirements no
  test demonstrated).
- Quality check of the fastest (tetrisex-2): the reviewer compared each of the 14 ADDED
  requirements against the code, all tagged by a test, 91/91 tests green, three followUps.
- **Dead end found (arkanoidex-12):** the one blocking issue was for the deriver (a baseline
  requirement the code now contradicts). The fixer rightly changed no code (it may not edit
  `openspec/`), and `fix-progress` ended the run as "no progress". Fixed: it re-derives either way
  (the correction budget still bounds the rounds); mirrored in Core. → experiment 4.

### 2026-11-28 03:20 — experiment 4 on Codex: re-derive on no progress; experiment 2 reverted

Codex (gpt-6.2-sol), with the tag step and the re-derive fix:

| Case | Outcome | Minutes | USD | Rounds | Reviews | Slowest steps |
|---|---|---|---|---|---|---|
| tetrisex-11 | success | 15.6 | 4.47 | 1 | 66 (7) → 94 | fix 167 s, derive 140 s + 99 s |
| arkanoidex-12 | failed | 8.6 | 3.95 | 1 | 64 (3) → invalid output | fix 109 s, derive 97 s |
| arkanoidex-14 | failed | 11.3 | 4.48 | 1 | 67 (7) → invalid output | fix 207 s, derive 148 s |

- Both failures are the same new bug: the **resumed** Codex reviewer (experiment 2,
  `sessionContinuity: 'run'`) answered its re-review outside the structured schema
  (`invalid_role_output`: missing `unrequested`/`followUps`, extra properties), and Core's repair
  turn in the same session failed too. Its re-review text approved the correction. Fresh Codex
  reviewers never did this tonight.
- Experiment 2's gain was small: re-reviews 9–17 s instead of 22–45 s on Claude, and 47–59 s
  instead of 57–69 s on Codex. **Reverted**: the reviewer starts fresh each round; convergence
  comes from the prompt (the previous verdict and the re-review rules). Follow-up for Core: a
  repair of invalid structured output could start a fresh session instead of resuming.
- Codex quota: four Codex runs used ~60 % of its 5-hour window, so the matrix stopped at its
  quota gate (by design). Claude cases are about 3 % of Claude's 5-hour window each.
- Codex's slowest steps are the fixer (109–224 s) and each derivation (74–148 s); the tag step
  takes 41–58 s on Codex (8–20 s on Claude).

### 2026-11-28 03:45 — experiments 5 and 6 on Claude

**Experiment 5** (fresh reviewer each round, re-derive on no progress), the four cases that
needed a round: all four succeed, arkanoidex-12 included (its artifact finding now goes through
the re-derivation). Fresh re-reviews still take 13–30 s.

| Case | Outcome | Minutes | USD | Rounds | Reviews |
|---|---|---|---|---|---|
| tetrisex-11 | success | 2.8 | 0.97 | 0 | 84 |
| arkanoidex-14 | success | 5.7 | 2.82 | 1 | 68 (3) → 86 |
| arkanoidex-12 | success | 6.1 | 2.96 | 1 | 68 (2) → 84 |
| tetrisex-3 | success | 6.5 | 3.44 | 1 | 62 (5) → 86 |

Every remaining first-round issue was a requirement no test demonstrated (the tag step listed
them as incomplete). **Experiment 6**: the tag step also adds one focused, tagged test per such
requirement, in a test file the change already touches (never production code, existing
assertions or `openspec/`); the reviewer still judges them.

| Case | Exp. 5 | Exp. 6 |
|---|---|---|
| arkanoidex-14 | 5.7 min, 2.82 USD, 1 round | **3.6 min, 1.07 USD, 0 rounds** (84) |
| arkanoidex-12 | 6.1 min, 2.96 USD, 1 round | **4.1 min, 1.16 USD, 0 rounds** (86) |
| tetrisex-3 | 6.5 min, 3.44 USD, 1 round | 7.4 min, 4.00 USD, 1 round (72 (3) → 86) |

tetrisex-3's round was the side effect to expect: the tests the tag step added made three
artifact lines stale (tasks.md "no direct test", a design assumption), a finding for the
deriver that the re-derivation fixed (fixer 20 s, no code). Re-deriving after every tag step
would cost ~60 s on each run to save it in one of three, so it is not done.

### 2026-11-28 05:12 and 07:50 — final pass with experiment 6 (commit 85d87090)

**Claude (sonnet), all ten synthetic cases: 10/10 success**, seven without a correction round.

| Case | Minutes | USD | Rounds | Reviews |
|---|---|---|---|---|
| tetrisex-2 | 1.3 | 0.74 | 0 | 88 |
| arkanoidex-11 | 2.0 | 0.77 | 0 | 86 |
| tetrisex-9 | 2.2 | 0.90 | 0 | 88 |
| arkanoidex-8 | 2.6 | 1.05 | 0 | 84 |
| tetrisex-4 | 2.8 | 1.02 | 0 | 90 |
| deckdex-3 | 3.0 | 0.92 | 0 | 88 |
| arkanoidex-14 | 3.6 | 1.18 | 0 | 87 |
| tetrisex-3 | 6.7 | 3.45 | 1 | 80 → 86 |
| tetrisex-11 | 8.0 | 3.70 | 1 | 82 → 88 |
| arkanoidex-12 | 8.9 | 2.80 | 1 | check failed → 86 |

**Codex (gpt-6.2-sol), the spec #10 replay and the cases that had needed a round: 3/4 success**
(tetrisex-3 not launched: the quota gate stopped the pass at 70 %).

| Case | Minutes | USD | Rounds | Reviews |
|---|---|---|---|---|
| tetris-frame-pacing (spec #10) | 10.3 | 3.40 | 1 | 83 → 92 |
| arkanoidex-14 | 10.8 | 3.18 | 1 | 88 → 90 |
| arkanoidex-12 | 11.7 | 3.18 | 1 | check failed → 91 |
| tetrisex-11 | 14.5 | 5.61 | 2 | 74 → 84 → 89, **failed** (budget spent) |

Against the baseline (spec #10 on Codex: 21.5 min, 7.27 USD, failed) the same hand-off now
succeeds in 10.3 min for 3.40 USD.

What the remaining rounds were:

- **arkanoidex-12 (both providers): a real defect.** The handed-off code exposed the title's
  Play button as "Play ↗" (a decorative arrow in its accessible name), and 14 end-to-end tests
  looking for "Play" failed. The tag step reported it instead of touching production code,
  `check` failed, and the fixer gave the button an explicit accessible name. That round is the
  flow doing its job.
- **Every other round, on both providers, had one finding in common: tasks.md and design.md
  still said a behaviour had no automated test, or left a changed test file out of the files
  the change touches**, because they were derived before the tag step tagged or added those
  tests. On Codex tetrisex-11 the third review's only issue (score 89) was exactly that, and it
  ended the run.

### 2026-11-28 08:33 — experiment 7: the tag step cites its tests as evidence

The tag step now also updates the change's tasks.md and design.md: their test evidence cites the
tests it tagged or added, and the files the change touches include every test file it changed.
It still never edits the delta specs, the proposal, production code or existing assertions.
(Mirrored in Core: fixture, docs and engine test.)

Claude, the three cases where it mattered or as control:

| Case | Final pass (exp. 6) | Exp. 7 |
|---|---|---|
| tetrisex-11 | 8.0 min, 3.70 USD, 1 round | **3.5 min, 1.20 USD, 0 rounds** (88) |
| tetrisex-3 | 6.7 min, 3.45 USD, 1 round | **6.5 min, 1.75 USD, 0 rounds** (88) |
| arkanoidex-14 | 3.6 min, 1.18 USD, 0 rounds | 3.6 min, 1.09 USD, 0 rounds (88) |

A first exp. 7 pass at 07:22 ran with a sidecar that had not been rebuilt, so it executed the
exp. 6 recipe (its runs' `definition_json` still had the old prompt); its three results are kept
as `final-claude-repeat` samples of the final configuration (tetrisex-11 5.5 min / 1 round,
tetrisex-3 6.9 min / 1 round, arkanoidex-14 3.5 min / 0 rounds, the same artifact findings). The
harness now records each run's definition hash so a stale build shows in the results.

Exp. 7 on the other seven cases (08:40): 7/7 success, 0 rounds (1.6–4.8 min, 0.74–1.15 USD).
**Exp. 7 on Claude: 10/10 success, all without a correction round.**

But one of them hid a defect: arkanoidex-12 succeeded in 4.8 min with the Play button still
named "Play ↗". The tag step ran the e2e suite, saw 12 tests fail and only mentioned it in its
summary; the deriver had proposed no e2e command this time, so `check` and the final `verify`
ran without it, and the reviewer approved at 86. The cause is older than exp. 7 (which
commands the deriver proposes varies), but it is a hole in the quality floor.

### 2026-11-28 09:05 — experiment 8: the reviewer sees the tests the tag step saw fail

The tag step runs every test file it touched in full and lists each failing test (command and
error) under `incomplete`. A new `tag-report` assign node keeps that report in `run.tagReport`
(reset at `init` and every correction round; a tag turn that ends `invalid` skips it, so the
review never fails on a missing output), and the review prompt treats a failing test in it as a
failing check. Mirrored in Core (fixture node, docs, two engine tests).

**Claude, all ten cases: 10/10 success, 9 without a round.**

| Case | Exp. 7 | Exp. 8 |
|---|---|---|
| tetrisex-2 | 1.6 min, 0.81 USD | 1.1 min, 0.64 USD (86) |
| tetrisex-9 | 2.1 min, 0.74 USD | 2.2 min, 0.76 USD (88) |
| tetrisex-4 | 2.5 min, 1.00 USD | 2.8 min, 1.02 USD (88) |
| arkanoidex-11 | 2.7 min, 0.91 USD | 3.1 min, 1.00 USD (86) |
| arkanoidex-8 | 2.5 min, 0.97 USD | 3.2 min, 1.11 USD (86) |
| deckdex-3 | 3.5 min, 0.97 USD | 3.2 min, 0.95 USD (88) |
| arkanoidex-14 | 3.6 min, 1.09 USD | 4.3 min, 1.23 USD (88) |
| tetrisex-11 | 3.5 min, 1.20 USD | 5.5 min, 1.14 USD (86) |
| tetrisex-3 | 6.5 min, 1.75 USD | 6.2 min, 1.60 USD (86) |
| arkanoidex-12 | 4.8 min, 1.15 USD, **defect shipped** | 11.8 min, 3.36 USD, 1 round, **defect fixed** (86) |

In this arkanoidex-12 run the deriver did propose the e2e suite, so `check` itself failed and the
fixer gave the button its accessible name back; either way the defect can no longer reach the
review unnoticed. Running the touched suites in full makes the tag step slower where they are
end-to-end (tetrisex-11 207 s, tetrisex-3 182 s, arkanoidex-14 138 s) at about the same cost: the
price of the quality floor, accepted.

### Experiment 2 (reverted, see above) — the reviewer keeps its session

From commit "perf(intent-spec): the reviewer keeps its session across rounds",
the review node uses `sessionContinuity: 'run'` (Core reuses the reviewer's
provider session within the run): a re-review remembers what it read and asked
for. The fixer still starts fresh, so the effect is attributable. Runs launched
before this commit (run 1, `45b765d0`) froze the earlier graph and measure the
convergent review alone. Measure it with a new run of the case (not `--resume`).

