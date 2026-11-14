# Design

## Context

See proposal.md for motivation. This is a derivation of the existing diff against 7d1dc4a05bfacd8459998e3caccbd5d14c397bc2, not a plan for additional implementation. The project already has scoped background process ownership, full history/log modals, local chat databases and desktop-wide mission conversations. Core turns can execute in a shared project session host.

## Goals / Non-Goals

**Goals:** Keep pure process-table interpretation in the terminals domain, effectful OS/SQLite work in its runtime, and routing/lifecycle wiring in project composition. Keep resource presentation independent of collection so a closed popover does not interrupt active-turn history.

## Non-Goals

- No resource stop, kill, delete or cleanup actions, limits, runaway detection or automated remediation.
- No new job-to-conversation ownership model or dedicated job-row classification.
- No OS-wide attribution based on process working-directory inspection; worktree discovery inspects command lines.
- No accounting for the shared Core host process itself; Core provider attribution requires mission-specific command-line evidence.
- No unlimited history, persisted per-entry history, persisted disk scan result or automatic disk scanning.
- No changes outside specrails-desktop and no claim of executed Windows device validation.

## Decisions

1. **Separate pure attribution from effects.** The domain parses POSIX/Windows tables, finds worktree command references, walks descendant trees and claims each PID once within a snapshot. Root order is mission-specific provider, registered background processes, then discovered mission activity. A missing selected PID stays as a zero/not-running entry. This reuses existing ownership and PID seams rather than introducing a new execution ownership system.
2. **Resolve mission-specific providers without controlling processes.** Chat managers expose direct provider PIDs; Core sessions match their specrails MCP capability-file marker against process command lines. Windows matches normalize slash direction and case; filename suffix extensions are rejected. A shared host without the marker is never substituted as a provider root. The session-host registry's added hostPid getter remains in the diff but is no longer consumed by resource attribution. Desktop active conversations are filtered by their current pin before recorder selection; route measurement and worktree access independently enforce that pin, and recording rechecks it after the asynchronous table read.
3. **Use platform readers behind injectable functions.** POSIX uses ps for CPU/RSS and du for disk. Windows uses hidden powershell.exe with Win32_Process JSON, per-reader cumulative CPU baselines, a 500 ms result cache and one in-flight query. Its asynchronous Node disk walk ignores symlinks. Query failures become unsupported snapshots; disk failures remain separate scan states.
4. **Collect independently from presentation.** Each project context starts a three-second recorder and stops it before teardown. Active local and project-pinned desktop/Core turns seed collection; an in-memory draining set follows observed processes to a closing zero. Ticks do not overlap. Null readings/errors remove a draining target; a later active turn can seed it again. Repinning returns a null measurement to the old project after its table read, stops draining there and preserves saved rows.
5. **Persist bounded totals in project SQLite.** The store transactionally replaces a same-timestamp point and trims to 600 per conversation. GET returns the newest 300 oldest first. A connection-keyed WeakMap holds prepared stores. Migrations 89–90 preserve v89 rows while removing the local-chat FK to accommodate desktop mission IDs; a trigger preserves local-chat cleanup.
6. **Tie cleanup to permanent deletion, with reopen recovery.** The mission router invokes an injected callback after permanent removal, including expired-trash purge. Composition tries every open project independently. Opening a project prunes IDs absent from both conversation stores, without filtering existing missions by pin or trash state. All existence checks precede prune writes; pending samples recheck existence after awaiting measurement and honor recorder stop.
7. **Use accessible popovers with scoped polling.** HoverPopover uses a non-modal Radix surface with hover, focus and click opening, pointer-transfer delay and viewport-clamped placement. Forward Tab from an open trigger focuses its first available panel control; focus inside keeps it open and leaving both surfaces closes it. The composer shows both controls only with mission/project context. The hook fetches on open and every three seconds, aborts on close/scope change and guards responses by a current scope key. Requests use explicit encoded project/chat paths with API_ORIGIN.
8. **Retain readable completed-run figures.** The panel uses live totals while processCount is positive; otherwise it selects the last active history point. Separate Recharts CPU/memory lines show titles, peaks, time range and time/value tooltips. Current entries sort by memory. The only Resources action starts/rescans disk and then refreshes. Processes previews eight rows and retains existing inspector/full-history paths.

9. **Keep composed-router test mocks compatible.** The resource sampler calls promisify(execFile) at import time. Three existing project-router suites fully mock child_process; each now exports an execFile mock alongside spawn and execSync. This repairs their import surface without changing production sampling, provider behavior or existing assertions.

## Rejected alternatives

Recorded conversation decisions superseded resource/process modals with popovers, a manual Refresh button with refresh-on-open, client-only history with project SQLite, and zero-only completed displays with last-active figures and charts. The conversation chose permanent-deletion cleanup while retaining trash/restorable history. The code correction rejects attributing a complete shared Core host tree in favor of capability-marker provider matching. No other alternatives were recorded; no unimplemented improvements are proposed here.

## Risks / Trade-offs

- [Core provider command lacks its capability marker] → No shared-host fallback is used; unmatched Core providers are not attributed. The two-mission regression verifies distinct provider roots and host-only exclusion.
- [Command-line discovery does not prove all mission ownership] → Attribution is limited to the selected roots and matching command lines; no dedicated job linkage is claimed.
- [Long Windows scans and unavailable utilities] → Readers are asynchronous, failures are surfaced, Windows concurrent process reads share a query, and duplicate disk scans join the running scan.
- [Bounded history loses earlier points] → The store keeps 600 points and the API returns 300; peaks and charts summarize only those returned points.
- [Pending work outlives deletion/project closure] → Existence and stopped checks suppress late writes; callback failures leave mission deletion intact and reopen pruning recovers orphan samples.
- [A restart loses the in-memory draining set] → Saved history survives restart, but the code does not reconstruct inactive process tracking from historical rows.
- [Test evidence is narrower than full device behavior] → Tagged regressions cover focus/Tab/blur access, immediate polling, cadence, cancellation, stale scope responses, recovery, disk pending/failure/rescan states, Core root isolation and project repinning. Chart tests still mock Recharts, and real OS commands, tooltip rendering and translation quality are not proven by these tests. No execution is claimed by this derivation.

## Migration Plan

Existing database initialization applies appended migrations 89 and 90. Migration 90 copies existing samples before replacing the table and adds the local-chat deletion trigger. The changed migration/reopen test exercises preservation and desktop IDs. No down migration or rollback procedure is implemented by this diff.

## Assumptions

- No non-obvious product intention is assumed for the corrected attribution: the code and two-mission/project regressions explicitly select mission-specific roots and enforce current-pin ownership. The earlier shared-host aggregate interpretation no longer describes this diff.
- The frozen early intent says jobs only descend from owned trees; the actual diff additionally discovers worktree command-line roots. Detached jobs/subagents can therefore count when their commands match that worktree, but processes with neither linkage remain unmeasured. This is not evidence of comprehensive job ownership.
- “Whole run” in the conversation is bounded by the implemented 600 stored/300 returned points; it is not unlimited history. Displayed finished time is the last returned sample's timestamp, not a separately persisted completion event.
- All listed source changes have an identifiable purpose. Test files were inspected, not executed by this derivation role; automated verification belongs to Core.

## Blast radius

- `client/src/components/ui/__tests__/hover-popover.test.tsx`: Covers tagged hover, focus/Tab/blur access, delayed closing, pointer transfer and click opening.
- `client/src/components/ui/hover-popover.tsx`: Adds the shared non-modal hover/focus/click primitive and forward-Tab access to panel controls.
- `client/src/features/background/components/__tests__/BackgroundProcessesPanel.test.tsx`: Covers refresh, ordering, execution selection, full-history navigation and empty state.
- `client/src/features/background/components/__tests__/MissionResourcesPanel.test.tsx`: Covers figures, read-only controls, completed-run summaries, charts, disk request and unsupported state.
- `client/src/features/background/components/BackgroundProcessesPanel.tsx`: Adds an eight-row process preview and full-history entry.
- `client/src/features/background/components/MissionResourcesPanel.tsx`: Renders resource totals, breakdown, history charts and disk scan states.
- `client/src/features/background/hooks/useMissionResourceHistory.ts`: Polls the selected mission while open and rejects stale scope responses.
- `client/src/features/background/lib/__tests__/mission-resource-history.test.ts`: Tests last-active and peak summaries.
- `client/src/features/background/lib/mission-resource-history.ts`: Computes retained-history summaries.
- `client/src/features/background/lib/mission-resources-api.ts`: Defines snapshot types and explicit project/chat resource requests.
- `client/src/features/background/README.md`: Documents public entry points and server-owned history.
- `client/src/features/boundaries.json`: Declares new background feature entry points.
- `client/src/features/missions/components/__tests__/agent-chat.test.tsx`: Updates draft-preserving full-history navigation through the popover.
- `client/src/features/missions/components/AgentComposer.tsx`: Mounts Processes and Resources popovers and binds resource polling.
- `client/src/locales/de/agent.json`: Adds localized resource labels and View all processes.
- `client/src/locales/en/agent.json`: Adds localized resource labels and View all processes.
- `client/src/locales/es/agent.json`: Adds localized resource labels and View all processes.
- `client/src/locales/fr/agent.json`: Adds localized resource labels and View all processes.
- `client/src/locales/it/agent.json`: Adds localized resource labels and View all processes.
- `client/src/locales/ja/agent.json`: Adds localized resource labels and View all processes.
- `client/src/locales/pt/agent.json`: Adds localized resource labels and View all processes.
- `client/src/locales/zh/agent.json`: Adds localized resource labels and View all processes.
- `docs/internals/source-map.md`: Indexes the added implementation files and nearby tests.
- `docs/platforms/windows.md`: Documents PowerShell sampling, baseline CPU and disk traversal.
- `server/db/migrations.ts`: Appends migrations 89–90 for resource samples and local-chat deletion cleanup.
- `server/index.ts`: Wires permanent mission deletion cleanup across open projects.
- `server/modules/agent-sessions/runtime/session-host-registry.ts`: Adds a read-only session-host PID getter; corrected mission-resource attribution does not use it.
- `server/modules/architecture.test.ts`: Protects the pure mission-resource domain import boundary.
- `server/modules/boundaries.json`: Declares resource domain/runtime dependencies and public subpaths.
- `server/modules/conversations/runtime/chat-manager.ts`: Exposes active conversation IDs and provider PIDs.
- `server/modules/missions/README.md`: Documents permanent-deletion cleanup and project-open recovery.
- `server/modules/missions/runtime/agent-chat-manager.test.ts`: Tests desktop/Core active-turn filtering by current project pin.
- `server/modules/missions/runtime/agent-chat-manager.ts`: Exposes active turns, direct provider PIDs and mission-marker Core provider PIDs.
- `server/modules/missions/runtime/agent-chat-router.ts`: Invokes best-effort cleanup after permanent removal.
- `server/modules/missions/runtime/agent-chat-trash.test.ts`: Tests retained trash history, cross-project deletion and expired-trash failure handling.
- `server/modules/missions/runtime/mission-core-sessions.ts`: Exposes active Core conversations and resolves provider PIDs from mission-specific capability markers.
- `server/modules/terminals/domain/mission-resources.test.ts`: Tests parsing, tree totals, deduplication, path matching and recording decisions.
- `server/modules/terminals/domain/mission-resources.ts`: Adds pure sampling models, attribution, platform parsing and sample eligibility.
- `server/modules/terminals/README.md`: Documents measurement, Windows support, history retention and cleanup.
- `server/modules/terminals/runtime/mission-resource-history.test.ts`: Tests SQLite retention, migration/reopen, recorder lifecycle and cleanup races.
- `server/modules/terminals/runtime/mission-resource-history.ts`: Adds bounded SQLite persistence and a non-overlapping activity recorder.
- `server/modules/terminals/runtime/resource-sampler.test.ts`: Tests tagged Windows deltas/cache/failure recovery, portable disk traversal, pending disk-scan sharing and failed/successful rescans.
- `server/modules/terminals/runtime/resource-sampler.ts`: Reads OS process tables and performs asynchronous cached disk scans.
- `server/project-registry.ts`: Owns recorder startup and stop on project teardown/shutdown.
- `server/project-router-jobs.ts`: Registers mission resource routes.
- `server/project-router-mission-resources.test.ts`: Tests tagged scoped routes, cross-project live exclusion, pin changes and in-flight draining, disk scanning, persisted history and orphan pruning.
- `server/project-router-mission-resources.ts`: Composes mission-specific root selection, current-pin route/scan guards, post-read recorder ownership checks and history cleanup.
- `server/project-router-tickets-cost.test.ts`: Adds execFile to the child_process mock so the composed router can import the resource sampler while retaining ticket-cost regression assertions.
- `server/project-router.codex.test.ts`: Adds execFile to the child_process mock for sampler import compatibility in the existing model/tool-policy router regressions.
- `server/project-router.gemini.test.ts`: Adds execFile to the child_process mock for sampler import compatibility in the existing Gemini stream regression.
- `client/src/features/background/hooks/__tests__/useMissionResourceHistory.test.ts`: Adds tagged behavioral tests for open/reopen fetch, three-second polling, cancellation, delayed scope responses and failure recovery.
- `server/modules/missions/runtime/mission-core-sessions.test.ts`: Adds tagged two-mission shared-host isolation and marker-suffix/host-only exclusion regression.
