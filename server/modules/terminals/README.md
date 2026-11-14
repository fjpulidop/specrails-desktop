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
(the framework's own host flag); nothing here binds or proxies ports.

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
project and chat. Jobs are measured only when they descend from an owned process.

- **macOS/Linux:** one `ps -axo` call; CPU is `ps`'s own percent, disk is `du -sk`.
- **Windows:** one PowerShell `Get-CimInstance Win32_Process` query (`powershell.exe`,
  hidden window). Windows reports cumulative CPU time, so CPU is derived from the
  difference with the previous sample of the same reader: the first reading shows
  0% CPU. Scans are shared (500 ms cache, one query in flight). Worktree paths match
  with either separator and case-insensitively. Disk uses a Node directory walk
  (no `du`) that does not follow symlinks. If PowerShell is unavailable the snapshot is
  reported as `supported: false`. Each router registration creates its own reader so
  CPU baselines are never shared across projects.

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

## Reviewed public entry points

- [runtime/app-urls.ts](runtime/app-urls.ts)
- [runtime/background-process-control.ts](runtime/background-process-control.ts)
- [runtime/background-process-service.ts](runtime/background-process-service.ts)
- [runtime/background-process-store.ts](runtime/background-process-store.ts)
- [runtime/background-windows-bootstrap.ts](runtime/background-windows-bootstrap.ts)
- [runtime/terminal-manager.ts](runtime/terminal-manager.ts)
- [runtime/terminal-marks-store.ts](runtime/terminal-marks-store.ts)
- [runtime/terminal-settings.ts](runtime/terminal-settings.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/terminals` and any affected consumers.
