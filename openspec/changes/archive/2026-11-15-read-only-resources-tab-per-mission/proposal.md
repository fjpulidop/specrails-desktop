# Proposal

## Why

Mission chat did not expose the CPU, memory or worktree disk consumed by its work. Live figures alone also disappear when processes end, making completed runs difficult to understand.

## What Changes

- Add a read-only Resources popover beside Processes, with live totals, per-root process-tree load, on-demand worktree disk scans and persisted CPU/memory history charts.
- Change Processes to an accessible hover/focus/click popover with a compact list, execution inspection and access to the existing full history modal.
- Measure mission-specific provider roots, registered background processes and command lines referencing the mission worktree, deduplicating descendants within each measurement and rejecting worktree paths embedded inside longer paths.
- Bind resource refreshes, including refreshes after disk scans, to the open view so closing or unmounting cancels pending requests and suppresses late results.
- Support POSIX process sampling and Windows PowerShell sampling, with explicit unavailable-metering states.
- Record active mission totals every three seconds independently of the popover, keep the newest 600 samples in project SQLite and return the newest 300. Preserve samples across restart and trash/restore; clean up permanent deletions and orphan records.
- Add resources and process-history entry labels in all eight locale files, boundary declarations and module/platform documentation.
- Extend child-process test mocks in the ticket-cost, Codex and Gemini router suites with execFile so the newly imported resource sampler can initialize during those existing regression tests.

- Add tagged regressions for two-mission Core isolation, cross-project reads and in-flight repinning, polling cancellation/recovery, keyboard panel access, disk scan sharing/retry, worktree argument boundaries and real CPU/memory chart tooltips.

## Capabilities

### New Capabilities

- `mission-resources`: Resource measurement, read-only presentation, bounded persisted history, on-demand disk scanning and history lifecycle.

### Modified Capabilities

- `mission-process-history`: Reach scoped process history through a compact accessible Processes popover while retaining execution inspection and full history access.

## Impact

React mission composition and the background feature gain popovers, resource API types, polling and charts using existing Radix/Recharts dependencies. The terminals module gains pure measurement rules, OS readers and a SQLite recorder; migrations 89–90 add durable samples. Project composition owns recorder startup/stop, routing and deletion cleanup. Session/chat managers expose process IDs and active conversations. New project routes are GET `/api/projects/:projectId/missions/:chatId/resources` and POST `.../resources/worktree-scan`. Core provider roots are resolved from the mission-specific capability marker in process command lines, excluding the shared host. Live attribution and disk access require the desktop mission's current project pin; repinning stops old-project collection while preserving retained history.
