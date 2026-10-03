## Context

The mission card's specs belong to a launch generation; the rail slot is mutable and its assignments are released at settlement. The current empty POST loses generation identity and request-only options. Isolated delivery already provides atomic retry supersession with allocation rollback.

## Goals / Non-Goals

**Goals:** Relaunch an identified settled attempt with its recorded settings, restore empty assignments, retain failed work and reject stale or conflicting requests with an actionable error.

**Non-Goals:** Automatically retry providers, clean failed worktrees, or replay a delivered PR as fresh implementation.

## Decisions

- Add a project-scoped `POST /rails/:railIndex/relaunch` accepting `sourceId` and optional mission origin. Resolve authoritative source data before entering the existing launch validation path. Never accept launch overrides on this route.
- Add nullable launch configuration JSON to deliveries and loop runs. Persist bounded validated request options with the resolved loop/engine/model/profile and repository selection. Historical attempts use their delivery/loop/request evidence; missing workflow evidence blocks instead of defaulting to Implement.
- Only an empty rail or one holding the exact source spec set can be relaunched. Restore empty assignments immediately before spawn after all admission checks, with a final recheck against concurrent edits. Keep normal ticket ownership claims and terminal release semantics.
- Shared per-ticket siblings have separate spec ownership. The stale-source query checks later overlapping specs rather than the latest run on the whole rail. Units reporting no changes do not count as delivered work.
- An undelivered failed active generation uses `retryOfDelivery`, retaining its checkout and atomically replacing its active row. Delivered work requires existing recovery or delivery actions. Allocation failure restores the predecessor through the existing rollback path.
- Guard duplicate clicks synchronously and disable Relaunch after acceptance. Keep error text inline in addition to the toast.

## Risks / Trade-offs

- [Historical attempts have fewer saved options] → Recover only recorded loop/runtime/manifest fields; never borrow a different slot's engine or workflow.
- [Configuration or repository membership changed] → Existing launch validators still run; errors identify the needed correction.
- [Concurrent relaunch, dismissal or slot edits] → Recheck source identity and assignments before allocation; existing DB generation uniqueness and ownership claims remain authoritative.

## Migration Plan

Append migration 71 adding nullable columns. Existing data remains unchanged. Deploy Desktop normally; Core needs no change.
