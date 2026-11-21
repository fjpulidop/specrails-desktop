# Implement benchmark harness

A reusable live benchmark of Specrails Implement. It generates throwaway repositories, each with a
local bare remote. It registers them in an **isolated** Specrails server, creates one ticket per
scenario, launches the Implement loop, answers questions by option id, and can restart or kill the
server mid-run. It samples `/api/health` and `/api/live-board` latency, guards the provider quota
through the app's own `/api/subscription-usage`, and writes a Markdown and JSON report.

It is a developer tool. It lives in `scripts/`, so it is not part of the npm package or the app bundle.

```sh
npm run benchmark -- \
  --scenarios scripts/benchmark/scenarios/bench4.json \
  --home ~/.specrails-dev-bench --port 4660 --client-port 4661 \
  --provider claude --model haiku --budget-runs 25 --stop-at-weekly 95 \
  --start-server --core-bin ../specrails-core/bin/specrails-core.mjs \
  --path-prepend /tmp/bench/shim --work-dir /tmp/bench --report /tmp/bench/report.md
```

## Safety

- **Isolation.** `--home` is required. The harness refuses `~/.specrails`, `~/.specrails-dev`, the
  home directory itself and anything inside `~/.specrails`. It also refuses ports 4200/4201 (the
  person's own app). Before signalling a process, it checks that the listener on `--port` is a
  `server/index.ts` started with that `SPECRAILS_REGISTRY_HOME`.
- **No publishing.** Generated repositories push only to bare remotes under `--work-dir`; any other
  remote is refused. Runs deliver to those bare remotes. Nothing is pushed elsewhere.
- **Quota guard.** Before each launch, the harness refreshes and reads the app's subscription
  usage. It stops launching when the provider's weekly window reaches `--stop-at-weekly`, or when
  any window is at 100 %. The skipped scenarios and the reason are listed in the report.
  `--budget-runs` caps the number of launches.
- **Installers.** Never put a real installer in front of the server. For install questions, pass
  `--path-prepend` with a directory of **fake** installers (for example a `brew` shell script that
  only creates a stub tool and a marker file). The server and its runs inherit that `PATH`.
  `fake-installers/brew` is one: it emulates only `brew install actionlint` (used by the `gha-lint`
  template) and writes the stub into `$BENCH_INSTALLED_DIR`. Pass
  `--path-prepend scripts/benchmark/fake-installers:$BENCH_INSTALLED_DIR` and export
  `BENCH_INSTALLED_DIR` for the server.
  `fake-installers/brew` also emulates `brew install cfgvet` (the `cfg-lint` template). Scenarios
  that reach an install question (an install template, or an `install`/`self` answer) are refused
  unless the running server's first `brew` is in a `fake-installers` directory.
- **Restarts keep the environment.** A `restart`/`kill` action restarts the server with the `PATH`,
  `SPECRAILS_CORE_BIN` and `BENCH_INSTALLED_DIR` it was started with (read from the listener), so a
  harness started without `--core-bin`/`--path-prepend` cannot drop the Core under test or the fake
  installers. Other scenarios' runs that the restart paused are resumed (at most three times each).

## Options

| Option | Default | Meaning |
|---|---|---|
| `--scenarios <file>` | required | JSON (or YAML, via `js-yaml`) scenario file |
| `--home`, `--port`, `--client-port` | required / — | isolated registry home and API port (client port only for the guard) |
| `--provider`, `--model` | per scenario (`claude`/`haiku`) | force one engine for every scenario |
| `--budget-runs N` | 25 | maximum launches |
| `--stop-at-weekly P` | 95 | stop launching at this weekly usage |
| `--parallel N` | 3 | scenarios in flight at once |
| `--only a,b` | all | run only these scenario names |
| `--start-server`, `--stop-server` | off | start `tsx server/index.ts` (no watch) with the isolated env, and stop it at the end |
| `--core-bin`, `--path-prepend` | — | `SPECRAILS_CORE_BIN` and a `PATH` prefix for the started server |
| `--work-dir` | `$TMPDIR/specrails-benchmark` | repositories, remotes, logs, report |
| `--dry-run` | off | generate nothing and launch nothing; only run the quota guard and the sampler |

## Scenario file

```json
{
  "defaults": { "provider": "claude", "model": "haiku", "timeoutMinutes": 25 },
  "scenarios": [{
    "name": "decision-hidden-conflict",
    "group": "features",
    "repo": { "template": "node-lib", "files": { "docs/design.md": "..." } },
    "ticket": { "title": "Return cart totals as integer cents", "description": "..." },
    "approvalBeforeArchive": false,
    "answers": [
      { "asker": "developer", "recommended": true },
      { "match": "actionlint", "optionId": "install" },
      { "kind": "approval", "reject": "Not now" },
      { "text": "free-text answer" }
    ],
    "actions": [{ "when": "phase:build", "do": "restart" }],
    "expect": { "status": "delivered" }
  }]
}
```

- **`repo` / `repos`.** A template name from `lib/repos.mjs` (`node-lib`, `react-vite`, `fastapi`,
  `rust-cli`, `go-api`, `canvas-game`, `godot-game`, `mr-api`, `mr-web`, `docs-site`, `gha-lint`, `cfg-lint`)
  or `{ template, name, files }` to add or override files. Two or more repos make a multi-repo run.
- **`answers`.** The first matching rule answers a pending question card (`job.question`). Rules
  filter by `kind`, `asker` and a `match` regex over the text. They answer with an `optionId`, the
  `recommended` option, free `text`, `approve`, or `reject` (with a reason). An option the card
  does not offer never matches. Unanswered questions end the scenario as `question-unanswered`.
- **`actions`.** `when` is `question`, `phase:<live-board phase>` or `seconds:<n>`. `do` is
  `restart` (graceful SIGTERM, then Resume), `kill` (SIGKILL, then Resume) or `cancel`.
- **`approvalBeforeArchive`.** The harness forks the built-in Implement loop once, turns "Approve
  archive" on, publishes the fork, and launches with it.
- **`expect.status`.** One of `delivered`, `failed`, `stopped`, `declined` or `any`. The report
  marks mismatches.

## Code

| File | Role | Pure |
|---|---|---|
| `lib/isolation.mjs` | home/port/remote guards | yes |
| `lib/quota.mjs` | subscription-usage → launch decision, timeline sample | yes |
| `lib/scenarios.mjs` | parse/validate scenarios, choose an answer for a question card | yes |
| `lib/report.mjs` | Markdown report, latency percentiles | yes |
| `lib/args.mjs` | CLI options | yes |
| `lib/repos.mjs` | templates + repo/bare-remote creation | templates yes |
| `lib/api.mjs`, `lib/server.mjs`, `lib/driver.mjs` | HTTP client, isolated server lifecycle, scenario driver | no |

Tests: `node --test scripts/benchmark/*.test.mjs` (also part of `npm run test:scripts`).

## Soak (long-running) mode

`--soak` runs for `--duration-min` minutes (launches stop at `--launch-until-min`) and is meant for
overnight runs of many hours. `scenarios/make-soak.mjs` generates `scenarios/soak-night.json`.

```sh
node scripts/benchmark/index.mjs --soak --scenarios scripts/benchmark/scenarios/soak-night.json \
  --home ~/.specrails-dev-long --port 4720 --client-port 4721 --start-server --inspect-port 9471 \
  --core-bin <core>/bin/specrails-core.mjs --path-prepend <shim>:scripts/benchmark/fake-installers:$BENCH_INSTALLED_DIR \
  --duration-min 700 --launch-until-min 680 --parallel 8 --budget-runs 40 \
  --stop-at-weekly 70 --pause-at-window 75 --quota-every-s 600 --sample-every-s 60 --max-auto-resumes 12 \
  --limit-sim-file <shim>/../limit-sim/active --work-dir /tmp/soak --report /tmp/soak/soak.md
```

- **Scheduling.** Each scenario launches at its `startAtMin`. `repeat: { count, everyMin }` expands a
  scenario into a trickle of copies (`<name>-<k>`, each with its own repository). An answer rule with
  `delayMinutes` leaves the question pending that long (a person away). `--max-auto-resumes` raises the
  per-run ceiling of restart resumes for a night with several restarts.
- **Quota.** Launching stops for good when the weekly window reaches `--stop-at-weekly`, and **waits**
  while a short window (the 5-hour session) is at or above `--pause-at-window`; it resumes when the
  window drops. Every reading is in the report's quota timeline.
- **Chaos** (the scenario file's `chaos` list, `atMin` after the start): `restart` (SIGTERM, restarted
  with the same environment), `kill` (SIGKILL), `sigstop` (`seconds`, then SIGCONT: a laptop sleep) and
  `fake-limit` (`match`, `resetInMin`): writes `<match>|<reset words>` to `--limit-sim-file`, which a
  `claude` shim first on the server's `PATH` reads to answer "You've hit your session limit · resets …"
  for agents whose working directory contains `match`. It never touches the real account.
- **Sampling** (`lib/soak.mjs`, every `--sample-every-s`, appended to `<report>.samples.jsonl`): server
  RSS, heap/external/active handles over the server's loopback inspector (`--inspect-port`, a tsx
  argument, so children never inherit it), open fds, server-tree and Core-child processes and RSS,
  zombies, orphans naming the isolated home/work dir/Core, SQLite DB and WAL bytes, event rows, logs,
  home and repository disk use, health/live-board latency, stalls, capacity active/queued, and a
  WebSocket client connected all night (reconnects, longest silence).
- **Report** (`lib/soak-report.mjs`, rewritten every 5 minutes): per-metric first/last/min/max/p95 and
  least-squares slope per hour with R²; memory slopes use the longest single server process (restarts
  reset memory). A slope above the metric's threshold with R² ≥ 0.6 is flagged as a leak.

## Speed (A/B) mode

Measures how fast and how well Implement delivers a fixed spec suite (`lib/speed-suite.mjs`): small, medium
and large specs, single and multi-repository, a repository lint in `npm test`, and specs whose edge cases
historically needed correction rounds. Each spec has **hidden acceptance tests** that never enter the
repository the agent sees.

```sh
node scripts/benchmark/scenarios/make-speed.mjs --tag a1 --reps 3 > /tmp/speed-a1.json
npm run benchmark -- --scenarios /tmp/speed-a1.json --parallel 4 --pause-at-window 75 … (as above)
node scripts/benchmark/speed-compare.mjs --a base=/tmp/a1/report.json --b candidate=/tmp/b1/report.json --md /tmp/ab.md
```

- **After each delivered run** the driver waits for the rail delivery to settle (so wall time includes
  delivery), exports the delivered branch with `git archive` into a scratch directory, adds the hidden tests
  there and runs `npm test`, `npm run lint` and the hidden tests (`lib/acceptance.mjs`). It also lists changed
  paths a spec never needs (lockfiles, stray files).
- **Per-run attribution** (`lib/timings.mjs`, from the project databases): time, tokens, cost and tool calls per
  phase from Core's role-context events, every verification command, idle time between steps, and the time
  before the first and after the last step. Every run of an automatic continuation is attributed.
- **Comparison** (`speed-compare.mjs`, pure statistics in `lib/speed-stats.mjs`): median and p90 per variant; each
  run is divided by its spec's baseline median, so specs of different sizes pool into one geometric-mean ratio
  with a spec-stratified bootstrap 95 % CI and a Mann-Whitney p-value. Quality is a floor: delivered, accepted
  (hidden tests), full suite, lint, first-pass review and stray files are compared and any worse count is flagged.
- In normal mode `--pause-at-window` also applies: launches wait while the 5-hour window is at or above it.
