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
  `rust-cli`, `go-api`, `canvas-game`, `godot-game`, `mr-api`, `mr-web`, `docs-site`, `gha-lint`)
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
