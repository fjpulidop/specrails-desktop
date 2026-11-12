# Design

## Context

See proposal.md for motivation. Missions are app-global, stored in desktop SQLite and exposed under `/api/agent`; project pins are grouping/execution defaults, not authorization. Current store rows use snake_case fields and optional `deleted_at`; the new contract deliberately exposes `archivedAt` while persisting `archived_at`. Current DELETE soft-deletes, stops work and supports Undo; permanent deletion cleans attachments and process history. Migration 37 added trash; the new migration must append as 38 without rewriting shipped SQL.

## Clarifications investigated

1. **medium** — How does “filter without refetching” coexist with server-scoped lists and no unbounded archive payload? **Default:** fetch a scope on first use and refresh, reuse loaded scope results for immediate local filtering. This is the one non-obvious assumption; default payloads must exclude archives.

The four original open questions are answered by the final frozen acceptance/contract: live archive is refused, archived history is read-only, scope persists, and favorites survive. No further requester question is needed. Delete means the existing soft-delete path, not immediate purge, as explicitly required by the criteria.

## Assumptions

- How does local filter switching coexist with server-scoped payloads? A previously unloaded scope may require a request; cached results can be filtered immediately, with refresh in the background. No eager all-history request is added.

## Goals / Non-Goals

**Goals:** extend existing persistence and admission seams, preserve trash recovery ownership, share scope state through the existing mission context, and make stale-client failures explicit.

## Non-Goals

No bulk/automatic archive, mobile archive controls, retention changes, new dependency, generic repository layer, module extraction, mission search redesign or unrelated cleanup. No telemetry for validating the product hypothesis is added.

## Local reference patterns

- `server/modules/agents/runtime/agent-store.ts`: `mapConversation`, `listAgentConversations`, `softDeleteAgentConversation`, `restoreAgentConversation`, `listExpiredAgentConversationIds`. Store coverage already lives in `server/agent-chat.test.ts`; trash integration in `server/modules/missions/runtime/agent-chat-trash.test.ts` uses `initDesktopDb(':memory:')`, Express and Supertest.
- `server/desktop-db.ts`: append-only numbered migrations, especially migration 37. `server/desktop-db.test.ts` checks migration count and upgrade fixtures; retain the established temporary-file pattern only for reopen/upgrade persistence tests.
- `server/modules/missions/runtime/agent-chat-manager.ts`: synchronous `sendMessage` admission before its first await, `isBusy` (including reservations), `sessionState` (aggregated mission and Intent sessions). `client/src/features/missions/context/MissionSessionsContext.tsx` derives background IDs when `residentPhase !== 'idle' || liveSubagents > 0`; match this server-side rather than treating an idle resident process as live work. `server/transient-children.ts:listBackgroundProcesses({chatId})` supplies separately owned background processes; starting/running work also blocks archive.
- `server/modules/missions/runtime/agent-chat-router.ts`: app-level routes and synchronous send conflict handling; cleanup must remain exclusively in existing delete paths. `server/agent-chat-router-background-cleanup.test.ts` asserts abort/process cleanup.
- `client/src/features/missions/context/AgentChatContext.tsx`: `refreshConversations`, `loadConversation`, `selectConversation`, `send`, `deleteConversation`, context memo and fallback. Current refresh prunes favorite IDs against its response; this is unsafe for partial archive scopes and must stop. Current `conversationCacheRef`/selection tokens and window guards own history loading and transfers; preserve them.
- `client/src/features/missions/lib/agent-api.ts` owns global `${API_ORIGIN}/api/agent` requests, using `readApiJson`/`ApiResponseError` from `client/src/lib/api-response.ts`. Do not convert these global routes to project `getApiBase()` URLs. Tests: `lib/__tests__/agent-api.test.ts`.
- `client/src/components/ArcSidebar.tsx`: `ConversationRow`, its inline timed confirmation, `grouped`, `favoriteConversations`, `visibleGrouped`, `visibleFavorites`, `loadActiveOnly` and `filterActiveConversations`. Preserve open-mission exception within archive scope. `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx` uses shared `client/src/test-utils.tsx`, mutable mocked context and live sets, `fireEvent`, `act` and fake timers. Async action assertions need `waitFor`/`act`, not immediate post-click reads.
- `client/src/features/missions/context/AgentChatContext.test.tsx` renders the real provider with mocked API and WS handler; use deferred promises for out-of-order fetch and failure tests. `components/__tests__/agent-mission-selector.test.tsx` similarly covers the other delete affordance. The shared `AgentComposer` is used by inline, floating and window mission views; gating there covers every message entry surface without changing each shell.
- Installed packages checked: React 19.3.0, Express 5.3.0, Vitest 5.0.3, Radix Select 2.2.6. The client rules' React 18 description is stale; use installed React test conventions. A native labeled select is sufficient for ArchiveScopeFilter; no new UI library needed.
- No dedicated application browser E2E harness was found. Use an API-to-real-SQLite journey with Supertest plus a real-provider UI journey in the existing RTL setup, rather than adding browser infrastructure.

## Decisions

### Persistence and contract

Add migration 38 with a PRAGMA-guarded `ALTER TABLE ... ADD COLUMN archived_at TEXT`; existing/fresh rows get NULL. Do not edit the old table creation migration. Map raw archive timestamp to required `AgentConversation.archivedAt: string | null` (avoid leaking a second competing archive field), and keep all previous fields unchanged. Export `ArchiveScope = 'active' | 'archived' | 'all'` from the store; the client mirrors the union in its existing API types without importing server code.

Extend `listAgentConversations(db, opts)` with `{archiveScope?: ArchiveScope; limit?: number}` and preserve the existing numeric-limit overload for external compatibility; the only production caller found is the mission router, other callers are tests. Default active; every branch includes `deleted_at IS NULL`, retains existing ordering and limit 100. Whitelist the SQL predicate, parameterize values. No pagination or speculative index is introduced; assume current list volumes and limit remain adequate, and avoid loading all archives by default.

`archiveAgentConversation(db,id,now?: Date)` synchronously updates `archived_at = COALESCE(archived_at, ?)` on non-trashed rows and returns the mapped row or null; unarchive clears only archive state on non-trashed rows and returns row/null. Do not bump updated_at merely for archiving, so ordering remains based on mission activity. Unknown/trashed targets return null. Preserve existing archive stamp on retry.

Guard `softDeleteAgentConversation` with archived state for live rows. Do not add an archive guard to the unconditional hard-delete primitive: existing expired/legacy trash must remain purgeable. Route guard rejects active non-trashed soft AND permanent requests before any abort/cleanup; legacy trashed rows may still be purged/restored. Restoring trash only clears deleted_at, so a newly archived-then-deleted mission returns to Archived on Undo. Unknown soft DELETE keeps its existing idempotent success; unknown permanent DELETE remains 404.

### HTTP, concurrency and read-only admission

Add `POST /conversations/:id/archive` and `/unarchive`, returning `{conversation}`; 404 for missing/trashed. Parse `GET /conversations?archiveScope=...` strictly (400 for invalid/repeated/non-string values). Archive checks manager.isBusy, aggregated session resident phase/liveSubagents and active transient background work before the synchronous store write. Return 409 `{error,code:'MISSION_LIVE'}` without stopping anything; do not await between the liveness check and write. A repeated already-archived request returns the unchanged row. Idle resident processes alone do not block archive.

DELETE of an active non-trashed row returns 409 `{error,code:'NOT_ARCHIVED'}` on both variants. Archive/unarchive errors propagate using current route conventions; no history or personal content is logged.

Reject `/send` on archived rows before admission, with 409 and a stable explanatory error (`MISSION_ARCHIVED` for this additional conflict). Also guard `AgentChatManager.sendMessage` before enqueueing so internal callers cannot bypass it; retain its existing synchronous error conventions. Queue edit/steer routes must reject archived targets before mutation/execution; cancellation and read endpoints remain available. No messages or input records are created on refusal. Since live work cannot be archived, pending/reserved admission is rejected by liveness rather than silently canceled. Preserve same-process synchronous ownership; do not introduce locks or change lifecycle cleanup. Server restart has no new archive replay operation.

Mobile list adds `archived_at IS NULL`; existing paired-device/project authorization and response redaction remain intact. Known-ID history reads retain access rules; upstream send guard enforces read-only. No mobile archive routes or controls.

### Context, scope caching and favorites

Expose `archiveScope`, `setArchiveScope`, `archiveConversation(id):Promise<void>`, `unarchiveConversation(id):Promise<void>` through the existing useAgentChat context (including memo/fallback). Persist scope under `specrails-desktop:missionArchiveScope`, validating exact enum and catching storage errors. Keep live-only storage untouched. Provider-owned caches per scope avoid global mutable data and support immediate switching when loaded; do not merge mismatched scopes into the visible list. Request generation/scope refs prevent slower old responses from overwriting newer selections or mutations. Initial uncached scope shows loading, not a false empty message; failed loads preserve useful cached data and expose retry/error via existing notifyError conventions. No timeouts/retry loop beyond current fetch behavior.

Successful mutation patches/invalidate affected cached scopes and active snapshot, then refreshes the selected scope; mutations are committed to UI only after server success. Clear stale history snapshots for that ID so restored/read-only state cannot remain cached. Refusal leaves lists, favorite membership, windows and selection unchanged. Preserve favorite IDs across partial results; only explicit unfavorite/delete behavior removes membership, never an omitted scope/limit result.

When archiving the open mission, select the next active mission in current ordering (previous when at end), or fetch Active if none loaded, then use existing selection/window guards. If none exists, use existing empty Mission state. Never choose an archived fallback. Do not discard archived history or forcibly stop work. Stale selection/load completions must not reopen the just-archived mission. UI send handler also refuses archived active snapshots without clearing composer drafts; server remains authoritative.

### Sidebar and other removal affordances

Add `ArchiveScopeFilter.tsx`, a localized keyboard-accessible three-option select beside Projects, expanded Mission mode only. Scope first, then existing live-only/open exception, then favorites/Home/project grouping and rollups. Active cannot be bypassed by the open-row exception. Keep project rows, theme classes, keyboard row navigation and focus styles. Archive and Restore stop row-selection propagation; confirmed Delete stays restricted to archived rows and calls current soft-delete handler. Add muted styling and an Archived marker in All. Use per-scope empty strings; live-only plus archive scopes does not reset either control.

Add async `handleArchiveConversation` and `handleUnarchiveConversation` with localized failures including MISSION_LIVE; disable duplicate in-flight actions. Shared AgentComposer renders a localized read-only/restoration notice instead of message entry for archived snapshots (preserving stored drafts), and context send refuses stale entry attempts. The floating AgentMissionSelector is the only other production deleteConversation consumer: remove active Delete there too, reuse archive/restore and archived-only confirmed Delete without adding a second scope selector. Update its focused tests and the existing user guides describing its delete icon.

### Rejected alternatives

- Reuse deleted_at: would expire retained history and violate orthogonal archive/trash semantics.
- Eagerly fetch all archives: violates default payload constraint; use lazy scope caches.
- UI-only guards: stale clients/internal send paths could mutate archived missions.
- Guard hard-delete indiscriminately: breaks pre-existing legacy trash purge.
- New service/port/module: no real substitution boundary is introduced by timestamp visibility.
- Browser E2E framework: no existing harness; the requested journey is covered through existing HTTP and provider integration seams.

## Blast radius

Only these repository files may change; no source moves or boundary dependencies are needed.

| File | Reason |
| --- | --- |
| `server/desktop-db.ts` | Append migration 38 |
| `server/desktop-db.test.ts` | Migration count, idempotent upgrades/reopen, NULL defaults |
| `server/modules/agents/runtime/agent-store.ts` | Archive types/mapping/functions, scope queries and soft-delete guard |
| `server/agent-chat.test.ts` | Existing store assertions and route/delete compatibility fixtures |
| `server/modules/agents/runtime/agent-store-archive.test.ts` (new) | Focused store invariants and scope/trash tests |
| `server/modules/missions/runtime/agent-chat-router.ts` | Scope, archive routes, conflicts, send/queue guards |
| `server/modules/missions/runtime/agent-chat-manager.ts` | Guard internal admission before enqueue |
| `server/modules/missions/runtime/agent-chat-manager.test.ts` | No input/spawn on archived internal send |
| `server/modules/missions/runtime/agent-chat-archive.test.ts` (new) | HTTP-to-SQLite journey and liveness/failure matrix |
| `server/modules/missions/runtime/agent-chat-trash.test.ts` | Archive setup for delete and legacy trash/Undo/expiry regressions |
| `server/agent-chat-router-background-cleanup.test.ts` | Archived-delete fixtures; refused archive/delete never stops work |
| `server/mobile/mobile-missions.ts` | Explicit exclusion in mobile list |
| `server/mobile/mobile-missions.test.ts` | Archive exclusion and authorization regression |
| `client/src/features/missions/lib/agent-api.ts` | ArchiveScope, archivedAt, scoped list/mutation requests/errors |
| `client/src/features/missions/lib/__tests__/agent-api.test.ts` | URLs, encoding, scopes and conflict propagation |
| `client/src/features/missions/context/AgentChatContext.tsx` | State/cache/storage/mutations, preserved favorites, selection and send guards |
| `client/src/features/missions/context/AgentChatContext.test.tsx` | Async races, favorites, selection, persistence and provider journey |
| `client/src/components/ArcSidebar.tsx` | Scope filter, actions, rollups, empty/loading/error states |
| `client/src/components/ArchiveScopeFilter.tsx` (new) | Accessible three-option selector |
| `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx` | Scope composition, actions, confirmation, errors and placement |
| `client/src/features/missions/components/AgentComposer.tsx` | Shared archived read-only notice/message entry guard |
| `client/src/features/missions/components/__tests__/mission-composer-clear-on-send.test.tsx` | Archived send/attachment entry blocked; drafts retained and restore enables send |
| `client/src/features/missions/components/AgentMissionSelector.tsx` | Other removal affordance respects archive-only Delete |
| `client/src/features/missions/components/__tests__/agent-mission-selector.test.tsx` | Floating selector archive/restore/delete behavior |
| `client/src/locales/en/agent.json`, `client/src/locales/de/agent.json`, `client/src/locales/es/agent.json`, `client/src/locales/fr/agent.json`, `client/src/locales/it/agent.json`, `client/src/locales/ja/agent.json`, `client/src/locales/pt/agent.json`, `client/src/locales/zh/agent.json` | All archive action/error/read-only strings |
| `client/src/locales/en/nav.json`, `client/src/locales/de/nav.json`, `client/src/locales/es/nav.json`, `client/src/locales/fr/nav.json`, `client/src/locales/it/nav.json`, `client/src/locales/ja/nav.json`, `client/src/locales/pt/nav.json`, `client/src/locales/zh/nav.json` | All sidebar filter/marker/empty/loading strings |
| `server/modules/agents/README.md` | Store archive and scope contract |
| `server/modules/missions/README.md` | Admission and archive/trash semantics |
| `client/src/features/missions/README.md` | Context scope/read-only behavior |
| `docs/internals/api-reference.md` | New routes/query/conflict shapes and delete precondition |
| `docs/guide/en/integrations/6-agent-chat.md`, `docs/guide/de/integrations/6-agent-chat.md`, `docs/guide/es/integrations/6-agent-chat.md`, `docs/guide/fr/integrations/6-agent-chat.md`, `docs/guide/it/integrations/6-agent-chat.md`, `docs/guide/ja/integrations/6-agent-chat.md`, `docs/guide/pt/integrations/6-agent-chat.md`, `docs/guide/zh/integrations/6-agent-chat.md` | Replace stale direct-delete journey, document archive/restore/read-only/filter |
| `docs/internals/source-map.md` | Register new component/test files via existing generator |

Planning artifacts for this change: `proposal.md`, `design.md`, `tasks.md`, `specs/mission-archive/spec.md`, `specs/mission-sidebar-active-filter/spec.md` beneath `openspec/changes/runtime-b079e387b3f23065b3eb/`. No main-spec synchronization is part of this role. No migrations/config examples/WS payloads beyond the additive conversation field become stale. No boundary manifests change: new production component is shared UI, existing imports use already-reviewed public seams.

## Risks / Trade-offs

- Partial lists currently prune favorites → remove response-based pruning; test across every scope and limit omission.
- Old async list/history responses can undo mutations → request generations and ID-aware invalidation; deterministic deferred-promise tests.
- Client/server liveness drift → manager busy + same aggregated session predicates + starting/running process check, tested separately; no awaits before archive write.
- Read-only bypass → reject before server enqueue and in shared composer/context; test no input/message/spawn effects.
- Older clients can no longer delete active missions → intentional 409 NOT_ARCHIVED; document it and fix both existing removal controls.
- Global filter versus pinned projects/windows → scope cache remains provider-local; preserve project switching refs, selection tokens and window ownership.
- Unlimited archive growth → bounded server queries and lazy scopes; new pagination is out of scope, preserving current list limit behavior.

## Migration Plan

Append and apply migration 38 through existing desktop initialization; cover fresh DB, upgraded existing rows, repeated initialization and reopen persistence. No backfill timestamps or trash conversions. Roll back application changes without dropping archived_at; dropping would lose the user's archive choices. An older binary ignores archive state and may list archived rows, so operational rollback is data-preserving but loses archive visibility protection until upgrade.

## Verification approach

Core runs existing commands after implementation: root `npm run typecheck`; `npx vitest run server/modules/agents server/modules/missions server/desktop-db.test.ts server/agent-chat.test.ts server/agent-chat-router-background-cleanup.test.ts server/mobile/mobile-missions.test.ts`; client focused tests via `npm run test --prefix client -- ...`; and `npm run audit:architecture`. Add no standalone verification task. HTTP journey archives a pinned mission with history, lists every scope, reads history, refuses send, restores, then archives/deletes/undoes with preserved timestamp/history and 30-day behavior. Provider/UI tests cover the same archive/filter/restore journey. No tests run during this planning role.

## Out-of-scope findings

The client rules describe React 18 while installed React is 19.3.0; do not update the rules in this feature. ArcSidebar's project-removal comment conflicts with ticket background; preserve existing grouping fallback and existing project-removal semantics rather than changing them. Mission search remains a read-history entry point; this change does not add archive filtering to search.
