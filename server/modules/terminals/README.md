# terminals

This module owns the terminals capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## App addresses

A mission's dev server is opened in the device's own browser, not an embedded
one. `domain/app-urls.ts` extracts the `local` and `network` (private LAN/VPN)
addresses a process prints; `runtime/app-urls.ts` attaches them as `appUrls` to
running processes on read (REST, mission MCP tools, WS events). The operator
prompt asks the user before launching a dev server exposed on the local network
(the framework's own host flag); nothing here binds or proxies ports. When a
process announces a new address, the port scan below is invalidated so the next
Resources read sees it.

## Run worktree ports

Rails launched together each start their own dev or e2e server; without a port of
their own they all reach for `:3000` and the loser's checks failed with
`EADDRINUSE`, read as "tests failed".

- **Assignment.** `domain/run-ports.ts` (pure) defines the reserved area (default
  30100–32099, 200 blocks of 10; `SPECRAILS_RUN_PORT_BASE`, `_BLOCK_SIZE`, `_BLOCKS`),
  the hashed home block per worktree and the env: `PORT` (only when unset: a
  pinned port is kept), `SPECRAILS_RUN_PORT`, `SPECRAILS_RUN_PORT_RANGE_START/END`.
  `runtime/run-port-leases.ts` holds one machine-wide lease table (one server hosts
  every project), persisted to `<home>/.specrails/run-ports.json` (0600) so resumes
  keep their ports, and garbage-collected when a worktree directory is gone. Only
  paths under `<home>/.specrails/projects/<slug>/worktrees/` lease. `ensure()` runs
  before a run's first spawn (loop executors: definitions, AI steps, shell steps) and
  skips blocks where something already listens; synchronous env builders then read
  the lease in O(1). Consumers: `loops/runtime/loop-executors.ts` (AI/programmatic/shell
  steps and frozen-host resumes), `delivery/runtime/definition-fork.ts`, the queue's
  provider spawn env and `transient-children.ts` (background processes; POSIX).
- **Attribution.** `runtime/listening-ports.ts` reads listeners off the event loop and
  only on demand: macOS one `lsof -b -w -nP -iTCP -sTCP:LISTEN -F pcn` plus one
  `lsof -a -d cwd -p <pids>`; Linux `/proc/net/tcp{,6}` LISTEN rows, inode → pid via
  `/proc/<pid>/fd`, then `cwd` and `comm`; Windows unsupported. Scans are shared (3 s
  TTL, one in flight) and invalidated by an announced URL. `attributeListeners` maps
  each listener to a leased worktree: `cwd` when the process works inside it,
  `command` when it or an ancestor (process table) names it, else `none`; a foreign
  listener inside a leased block is `squatting`. `GET /api/resources/ports`
  (`server/app-resources-router.ts`) labels them with the rail ledger row.
- **Diagnosis.** `detectPortConflict` recognises `EADDRINUSE`, "address already in
  use" and "Port N is in use". The loop's log sink records the latest one with its
  step (agent conversation events are ignored: the agent's own exploration is not the
  run's checks), and recovery classifies a run that failed in that step as
  `port_in_use`.

Tests: `domain/run-ports.test.ts`, `runtime/run-port-leases.test.ts` (real listener
skips a busy block), `runtime/listening-ports.integration.test.ts` (a real server in
a temp cwd attributed by `cwd`), `server/app-resources-router.ports.test.ts`.

## Intent apps

Inside an active Intent the mission MCP starts background processes in the Intent
worktree and tags them with `flowId` (`BackgroundProcess.flowId`, persisted in
the history metadata). `stopBackgroundProcessesForFlow` (transient children)
stops them, with a bounded wait, when the Intent pauses, is discarded or handed
off. `resolveBackgroundCwd` takes the root's name for its refusal. See
[Intent mode › Running the app](../../../docs/internals/intent-mode.md#running-the-app).

## Mission resources

`GET /:projectId/missions/:chatId/resources` is a read-only view of what a mission
uses. `domain/mission-resources.ts` parses a process-table snapshot and totals the
process tree of each root the mission owns (its agent session, its registered
background processes and any process whose command line references the mission
worktree), counting a shared descendant once. `runtime/resource-sampler.ts` reads the
process table per platform and runs the worktree disk scan only on
`POST .../resources/worktree-scan`, asynchronously, with the result cached per
project and chat. Jobs are measured when they descend from an owned process or their command lines reference the mission worktree. Core provider roots are matched through the mission-specific MCP capability file in their command line; the shared host itself is excluded.

- **macOS/Linux:** one `ps -axo` call; CPU is `ps`'s own percent, disk is `du -sk`.
- **Windows:** one PowerShell `Get-CimInstance Win32_Process` query (`powershell.exe`,
  hidden window). Windows reports cumulative CPU time, so CPU is derived from the
  difference with the previous sample of the same reader: the first reading shows
  0% CPU. Scans are shared (500 ms cache, one query in flight). Worktree paths match
  with either separator and case-insensitively. Disk uses a Node directory walk
  (no `du`) that does not follow symlinks. If PowerShell is unavailable the snapshot is
  reported as `supported: false`. Each router registration creates its own reader so
  CPU baselines are never shared across projects.

The mission composer opens Resources and Processes as non-modal panels. Panels
stay beside their triggers in DOM order: Tab enters their controls and continues
into the composer, while Shift+Tab returns through the trigger. No focus scope
loops keyboard users inside a panel; Escape and outside clicks dismiss it. The
native Popover API places the panel in the browser top layer to escape composer
clipping. Tab propagation is stopped so the ancestor tier shortcut cannot consume
Shift+Tab while leaving these controls.

### History

`runtime/mission-resource-history.ts` records each working mission's totals so the
popover shows the whole run after a reload or restart. A recorder, owned by the
project context (`ctx.missionResourceRecorder`, started by
`startMissionResourceRecording` and stopped with the project), ticks every 3 s. It
measures only conversations with a live turn (plus any still holding processes, so the
closing zero is recorded) and stores `domain/shouldRecordSample` points in
`mission_resource_samples` (migrations 89–90, in the project database). Each
conversation keeps its newest 600 points (30 minutes at the 3 s cadence); an idle mission adds
nothing. `GET .../resources` returns the newest 300 as `history`, oldest first. The
agent chat manager is shared across projects and its conversations live in the desktop
database. It filters active conversation IDs by `pinned_project_id` before handing them
to the recorder; project-local chat IDs come from the project's own chat manager.
Migration 90 preserves existing samples and removes the project-chat foreign key so
desktop missions can be recorded. A trigger still deletes project-chat samples when
their chat is deleted. Desktop mission history survives soft deletion and restoration, with no age-based
expiry for existing missions. Permanent deletion (including expired-trash purge)
notifies all open projects through the router's injected `onPermanentlyDeleted`
callback. Closed projects and failed cleanups recover on their next open: before
sampling starts, the store prunes IDs absent from both project chats and desktop
missions, including their trash. Existence is independent of the current pin, so
moving a mission to another project preserves its earlier history. The recorder
rechecks existence after measuring so an in-flight sample cannot recreate deleted
history. If an existence lookup fails, the sweep leaves all samples untouched.

## App resources

`GET /api/resources` (composed in `server/app-resources-router.ts`) is the app-wide
counterpart behind the status-bar Resources control. `domain/app-resources.ts`
attributes one process-table snapshot with a claimed set, so each process is counted
once, under the first owner that reaches it: agent sessions (desktop missions and
project chats, labelled with the conversation title and project), rails
(`LoopRunManager.listProcessRoots`: each run's step spawn, Core definition runtime
process or resident interactive step; `QueueManager.listProcessRoots`: active,
interactive and force-failed job children), live background
processes, terminal shells (`TerminalManager.listProcessRoots`), then the server's
remaining children classified by command line (agent CLIs, MCP bridge/local runner/MCP
servers, git, other), and finally the server process itself. The `ps`/CIM query is
excluded. `runtime/app-resources.ts` reads the table through
`cacheProcessTableReader` (500 ms, shared in-flight read) and keeps up to 100 totals
points in memory only while a client polls; the history restarts after 30 s without
requests. Nothing is persisted or sampled in the background.

## Leftover processes in run worktrees

Provider CLIs and the tools they drive start test and preview servers in their own
process group (Playwright `webServer` spawns `detached`; Bash-tool commands outlive the
CLI). When the CLI exits, or is tree-killed, those processes are re-parented to
init/launchd: no ppid walk from the run's root reaches them, so they used to keep ports
and memory long after the run settled, invisible to Resources.

`domain/worktree-leftovers.ts` selects a settled run's leftovers from one process-table
snapshot: every top-most process whose command line references the worktree path (the
`findWorktreeRoots` boundary rules: `ticket-4` never matches `ticket-40`; Windows
separators and case are normalized), with its descendants. It never selects, nor descends
into, the trees of live owned roots (`listAppResourceRoots`: agent sessions, loop runs,
queue jobs, registered background processes, terminal shells), the server, its ancestors
or its own `git`/`ps` children. `isReapableWorktreePath` refuses relative or shallow
paths and any path equal to or above the home directory, the Specrails home, the server
cwd or a registered project checkout. The working directory is not read (`lsof` is too
expensive): a process that never names the path is not matched.

`runtime/worktree-process-reaper.ts` sends SIGTERM to each selected pid (Windows:
`taskkill /T` to the top-most ones), logs one `[worktree-reaper]` line per process (pid,
worktree, reason, run, command head), then after 3 s sends SIGKILL (`taskkill /T /F`)
only to pids still present with the same command line. The call resolves after the
first signal; escalation runs on an unreferenced timer. `server/worktree-process-reaper.ts`
installs the app-wide reaper at startup; `reapWorktreeLeftovers` is a no-op without one
and never throws. It runs:

- when an isolated rail run's engine settles (`rail-isolated-run-settlement.ts`, fresh
  and reattached runs, before the settlement's own git work), and when a PR CI run settles;
- before a rail, PR CI or Intent worktree is removed (`releaseRailWorktrees`, Intent
  `release`);
- at startup, once per project, for the newest 200 rail worktrees whose loop run has
  `finished_at` set and no unfinished run shares the path (restart-paused runs are kept).

Runs in the project checkout (non-isolated loops, board jobs) are not reaped: the user's
own processes there carry the same path. No activity event is emitted; the log lines
are the audit trail.

## Reviewed public entry points

- [runtime/app-urls.ts](runtime/app-urls.ts)
- [runtime/background-process-control.ts](runtime/background-process-control.ts)
- [runtime/background-process-service.ts](runtime/background-process-service.ts)
- [runtime/background-process-store.ts](runtime/background-process-store.ts)
- [runtime/background-windows-bootstrap.ts](runtime/background-windows-bootstrap.ts)
- [runtime/terminal-manager.ts](runtime/terminal-manager.ts)
- [runtime/terminal-marks-store.ts](runtime/terminal-marks-store.ts)
- [runtime/terminal-settings.ts](runtime/terminal-settings.ts)
- [runtime/worktree-process-reaper.ts](runtime/worktree-process-reaper.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/terminals` and any affected consumers.
