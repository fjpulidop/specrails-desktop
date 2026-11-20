# capacity

Machine-wide run admission: how many rail runs this machine works on at once,
and why a launched run waits. One queue per server process, shared by every
project and provider. A Core run takes a slot before Core starts working on it
(`LoopRunManager._admit`); over capacity it starts **queued**, its run log and
hold say what it waits for, and it starts by itself in launch order when a slot
frees or the machine/quota allows it again.

| File | Role |
| --- | --- |
| [domain.ts](domain.ts) | Pure: limits and their defaults, environment overrides, the admission verdict, the per-run usage-window burn estimate |
| [admission.ts](admission.ts) | The queue (injected limits, machine and quota samples, timers) |
| [runtime/machine.ts](runtime/machine.ts) | CPU busy fraction from `os.cpus()` tick deltas (lower of the last two 3 s windows); available memory where the platform reports it honestly (not macOS) |
| [runtime/composition.ts](runtime/composition.ts) | Production wiring (bound in `server/index.ts`), quota from `provider-quota`, `loop.run_queue` announcements |
| [adapters/http.ts](adapters/http.ts) | `GET /api/capacity`: limits, active and queued runs, learned burn |

## Rules

Checked in this order; the first that fails is the run's `waitingFor`:

1. `run_slots`: runs working on the machine (`maxRuns`, default 1.2 per core, 2–24).
2. `project_slots`: runs working in the run's project (`maxRunsPerProject`, half of `maxRuns`).
3. `provider_slots`: runs on the run's provider (`perProvider`, none by default).
4. `cpu` / `memory`: the machine stays saturated (≥ 98 % busy on two samples) or has less than 1.5 GB available. Never holds the machine's first run.
5. `provider_quota`: the account refuses requests, or the runs of that provider working now plus this one, each at the learned per-run share of the usage window, would not fit under 100 % minus a 5-point reserve. Never holds the provider's first run.

A run blocked only by its own project or provider never blocks a later run of
another one. The per-run share is learned from the window's growth while runs
worked, divided by the average number of runs of that provider that overlapped.

The defaults come from the parallel benchmark (`scripts/benchmark`, burst mode):
on 10 cores, deliveries per hour grew up to 12 equivalent runs and fell at 16,
where verification turns and server stalls dominated.

Overrides: `SPECRAILS_MAX_ACTIVE_RUNS`, `SPECRAILS_MAX_RUNS_PER_PROJECT`,
`SPECRAILS_MAX_RUNS_PER_PROVIDER` (`claude=8,codex=2`); `SPECRAILS_RUN_ADMISSION=off`
starts every run at once. Verification turns inside runs are Core's
(`SPECRAILS_VERIFY_SLOTS`, one per four cores).

## Restarts and cancellation

A run cancelled while queued settles `stopped` having run nothing. A shutdown
leaves a queued run `running` in its row; startup recovery pauses it like any
run of the restart, and continuing it starts it afresh (it has no Core context
to resume) after it takes a slot again.

Run `npx vitest run server/modules/capacity server/modules/loops/runtime/loop-run-admission.test.ts`.
