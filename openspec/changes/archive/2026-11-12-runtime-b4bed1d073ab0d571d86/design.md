# Design

## Context

See proposal.md for motivation. The five notifications already share one app-level hook. The change extends that hook and two pure builder helpers; it does not introduce a service, port, component, timer, database field or dependency. Existing requirements in milestone-launch-chain and milestone-progress remain intact; additive delta requirements refine notification content.

## Goals / Non-Goals

Goals: preserve emission timing and actions while making every existing toast identify its project, milestone, event, current status and total chain time when those facts are available.

## Non-Goals

No per-rail duration, notification navigation redesign, live ticker, timeline, new OS notifications, launch-engine changes, general toast redesign, migrations, or unrelated cleanup.

## Clarifications

The request's later detailed UX and invariants resolve its initial open questions: durations are static and delivered/completed use chain updatedAt, not receipt time. The explicit acceptance criterion resolves contradictory future-start prose: clamp to zero. Server createdAt is a string; the normalized client property is string | null, as required for older servers.

Remaining interpretation choices, ordered by consequence:
1. **high** — What does delivered elapsed mean if progress is delivered before the chain is terminal? Default: honor the frozen contract's snapshot updatedAt as the delivered event's frozen end sample. Evidence below shows this is not necessarily the later integration-completion time.
2. **medium** — Does “no history on reconnect” require changing the existing first chain-frame rules? Default: no; preserve current conditions and do not synthesize history from progress hydration. The content-only constraint is authoritative.
3. **low** — How does the fixed formatter input carry existing rail/count/reason copy? Default: add optional event-context fields to the named input without changing its required fields or function signature.

## Assumptions

- What is the delivered end when integration is pending? Use that delivery progress snapshot's chain.updatedAt, exactly as specified; this may precede integration completion. This is the one non-obvious assumption and confidence is medium.
- Does reconnect suppression replace current first-frame guards? Preserve existing guards; no REST hydration or progress cache shall generate chain-event toasts.
- How does the helper retain event details? Add optional railProgress { current: number; total: number }, reviewCount: number and pauseReason: string fields to FormatMilestoneToastInput; old callers need only the required contract fields.

## Local reference patterns

- client/src/features/builder/hooks/useMilestoneNotifications.ts: useMilestoneNotifications registers a shared WS handler once, reads navigation/action callbacks through refs, stores observed chains and milestone states, and unregisters on cleanup. Keep that lifecycle. Notification content is constructed synchronously in the WS callback; no React state update or async render is required. Status descriptions use Sonner's existing description option, confirmed in client/node_modules/sonner/dist/index.d.ts.
- client/src/App.tsx: projectsById already memoizes project id → name for useOsNotifications. Pass the same map to useMilestoneNotifications through an additive optional projectsById option. client/src/hooks/useOsNotifications.ts: useOsNotifications retains the map in a ref updated by an effect, the closest exact pattern. Do not import App or useDesktop into a pure formatter.
- client/src/features/builder/hooks/__tests__/useMilestoneNotifications.test.tsx captures registerHandler, uses renderHook with MemoryRouter and act, and mocks Sonner/resumeChain/setChainAutoAdvance. Retain that setup. Action promises retain existing notifyError responses and id reuse; Review retains project selection and the existing delayed navigation.
- client/src/features/builder/lib/milestone-progress.ts: coerceChain and coerceMilestoneProgress are pure defensive parsing seams. client/src/features/builder/lib/__tests__/milestone-progress.test.ts covers legacy/malformed inputs. Extend them without rejecting an otherwise valid old chain.
- server/modules/builder/runtime/milestone-chain-store.ts: createChain writes created_at and updated_at as ISO values; updateChain preserves created_at and updates updated_at under compare-and-set. toChainSnapshot is the shared serialization seam for milestone.chain_changed, control responses and listForProgress.
- server/modules/builder/runtime/milestone-chain.ts: advance sets completed with the injected clock after the last chunk; listForProgress selects the newest chain per milestone. resume, cancel and setAutoAdvance reject terminal rows; active settlement loops exclude them, so terminal updated_at stays stable in ordinary runtime paths. No new end column is needed.
- server/modules/builder/runtime/milestone-progress.ts: deriveMilestoneProgress can report delivered based on ticket counts even with a running/waiting chain. MilestoneProgressBroadcaster.flush broadcasts progress before milestone_completed, allowing completion to use the associated progress snapshot rather than changing that event's payload. server/modules/builder/runtime/milestone-progress.test.ts already covers that order and once-only persistence.
- server/modules/builder/runtime/milestone-chain-store.test.ts uses initDb(':memory:') and explicit NOW. Extend its snapshot test with distinct creation/update times and rejected terminal control updates through existing lifecycle tests.
- client/src/lib/__tests__/locale-parity.test.ts compares all supported locale key trees. client/src/lib/i18n.ts initializes English synchronously and lazy-loads other languages. Test Spanish using explicitly loaded resources or an isolated i18next instance so assertions do not depend on prior tests' language.
- Installed client versions confirmed from package files: React 19.3.0, Sonner 2.0.7, i18next 26.4.3, TypeScript 7.0.2, Vitest 5.0.3, Testing Library React 16.3.2. The React 18 statement in .claude/rules/client.md is stale; do not change that unrelated file. client/vitest.config.ts uses jsdom and src/test-setup.ts.
- No existing builder helper provides the requested two-line milestone format or exact Hh MMm duration format. Add the two explicitly requested pure files.

## Decisions

### Additive snapshot contract

Add required server createdAt: string from row.created_at in toChainSnapshot and its server interface. The WS chain type in server/types.ts imports that interface and needs no duplicate edit. All existing projection routes inherit the field. Add required client createdAt: string | null; coerceChain accepts only nonempty strings with a finite parsed date and otherwise returns null for this property, keeping the chain. Do not change updatedAt parsing or persisted rows. Update typed fixtures, not every raw historical payload.

### Pure formatting

Export formatElapsed(ms: number): string in lib/format-duration.ts. Clamp negative values to zero, truncate fractional seconds/minutes, use Ns below 60 seconds, Nm below 60 minutes, Hh MMm otherwise (two-digit minutes). Guard nonfinite values defensively to prevent NaN output.

Export MilestoneToastEvent with chunk_launched, checkpoint, paused, delivered, completed and FormatMilestoneToastInput in lib/milestone-toast.ts. Preserve all required names/types and the requested formatMilestoneToast(input, t) → { title, description: string | null } signature. Optional context fields supply k/n, localized pause reason and review count; do not hide those facts in milestoneLabel. Only supply validated context segments, never interpolate undefined. The helper owns localized title composition and event/status templates under builder:milestoneProgress.toast.*. Retain legacy toast keys for exact missing-context fallback and any other consumers.

Use localized event bodies for rail k of n launched, rail k of n delivered/checkpoint prompt, paused with its existing reason, delivered with review count, and complete/every spec merged. Title composition is project · milestone — event text. Missing/blank project omits only its prefix; missing timing keeps meaningful legacy event wording, including reason/count. Status descriptions map event semantics to Running, Awaiting approval, Paused, Delivered — awaiting review and Completed; never call a delivered milestone completed just because its launch chain is completed. Completed-with-elapsed uses Completed in duration. Other descriptions use Status · duration total, with status alone when elapsed is unavailable.

For active/checkpoint/paused use max(0, now - start). For delivered/completed use max(0, end - start). Invalid start omits elapsed. Missing/invalid end for delivered/completed omits elapsed, never silently uses now. Future start clamps to zero including when beyond end. now is captured once when building the toast; no interval, effect ticker or mutation of an already shown elapsed value.

### Project-safe integration

Pass the existing projectsById map from App. Read its latest value through a ref so renames/list refreshes apply to subsequent notifications without re-registering handlers or resetting transition state.

Keep chain transition bookkeeping separate from timing lookup: the existing chainsRef remains the basis for existing chain-change guards. Use project-qualified keys for observations to prevent identical ids across projects interfering; keep externally visible toast ids exactly unchanged, including suffixes. Keep a separate per-project/milestone timing association populated from both valid chain messages (milestoneN) and progress (milestone id and n). A progress snapshot must refresh this association before the existing first-observation/state-equality early return, without producing a toast. Prefer m.chain for delivered; for completed prefer the immediately preceding progress association by milestoneId, then project-qualified milestone n / last observed chain. Never borrow another project's chain or an unrelated milestone's end. A null chain in authoritative progress clears that association to avoid stale reuse. A new chain for the same milestone replaces the prior association.

Preserve all conditions that emit toasts, including first chain messages currently eligible under !prev. No added baseline suppression, REST fetch, replay loop or extra completion dedupe. Existing id prefixes and full ids, toast.success/warning choice, launch default duration, checkpoint 60s, pause/delivery 30s, completion 15s, button labels and handlers remain intact. Format only the initial five events; action-result/error toasts retain their existing behavior.

## Blast radius

Paths are relative to the repository root (the ticket's specrails-desktop prefix denotes this repository, not a nested directory). Only these implementation files may change:

| File | Reason |
| --- | --- |
| server/modules/builder/runtime/milestone-chain-store.ts | Serialize created_at as createdAt. |
| server/modules/builder/runtime/milestone-chain-store.test.ts | Assert creation timestamp and separation from later update time. |
| server/modules/builder/runtime/milestone-progress.ts | Extend server snapshot interface. |
| server/modules/builder/runtime/milestone-progress.test.ts | Update typed chain fixtures and assert timestamp survives projection/broadcast ordering. |
| client/src/features/builder/lib/milestone-progress.ts | Nullable client field and defensive parsing. |
| client/src/features/builder/lib/__tests__/milestone-progress.test.ts | Historical/invalid timestamps and typed fixture compatibility. |
| client/src/components/__tests__/MilestoneProgressCard.test.tsx | Add nullable timestamp to its typed chain fixture only. |
| client/src/features/builder/lib/format-duration.ts | New requested pure duration formatter. |
| client/src/features/builder/lib/format-duration.test.ts | Boundary/flooring/clamping tests. |
| client/src/features/builder/lib/milestone-toast.ts | New requested pure localized formatter and input/event contracts. |
| client/src/features/builder/lib/milestone-toast.test.ts | Test every event, context fallback, terminal elapsed and es/en copy. |
| client/src/features/builder/hooks/useMilestoneNotifications.ts | Map project/timing context and format five existing toasts. |
| client/src/features/builder/hooks/__tests__/useMilestoneNotifications.test.tsx | Five-event integration, identity/timing and action regression cases. |
| client/src/App.tsx | Pass existing projectsById into the hook. |
| client/src/locales/en/builder.json | English event/layout/status/elapsed templates. |
| client/src/locales/es/builder.json | Matching Spanish translations. |
| client/src/locales/fr/builder.json | Matching French templates, required by locale parity. |
| client/src/locales/de/builder.json | Matching German templates, required by locale parity. |
| client/src/locales/pt/builder.json | Matching Portuguese templates, required by locale parity. |
| client/src/locales/it/builder.json | Matching Italian templates, required by locale parity. |
| client/src/locales/zh/builder.json | Matching Chinese templates, required by locale parity. |
| client/src/locales/ja/builder.json | Matching Japanese templates, required by locale parity. |
| server/modules/builder/README.md | Document additive snapshot timestamp source. |
| client/src/features/builder/README.md | Document static formatter/fallback and existing public hook option outside generated block. |
| docs/internals/project-builder.md | Update existing milestone notification paragraph with layout and timing policy. |
| docs/internals/source-map.md | Regenerated entries for four added helper/test files only. |

Planning artifacts: openspec/changes/runtime-b4bed1d073ab0d571d86/{proposal.md,design.md,tasks.md,specs/milestone-launch-chain/spec.md}. No main-spec edits in this role. No boundary-manifest change: existing public hook entry remains, new helpers are private within builder, no capability dependency changes. API reference has no chain snapshot field listing to make stale; document the addition in the existing builder guide.

## Risks / Trade-offs

- Delivered before integration completes → use captured chain.updatedAt as the ticket mandates; this is a sampled delivered duration, not a newly introduced timestamp of final integration. No change to emission timing or engine ordering.
- Old server or dropped WS messages → omit unavailable project/time segments; no network request or invented start/end.
- Reload/reconnect → initial progress only seeds state/timing; preserve server event order and existing chain-event guards. The existing !prev chain guards can toast a first late-chain event; fixing that is explicitly outside this content-only change.
- Project switches/renames and colliding ids → refs for latest name lookup and project-qualified internal associations; keep public toast ids stable.
- Arbitrary project/reason strings → plain text interpolation in Sonner, no HTML, no new logs or persisted data.
- Async action failure → existing notifyError paths, project-specific resume calls and Review delay are untouched.
- Performance → bounded work per received milestone message plus formatting; no new polling, queries, timers or hot-path optimization.

## Rejected alternatives

- Derive start from first launched chunk: loses initial waiting time and fails before first launch.
- Put project names on server events: duplicates existing client state and expands the wire contract.
- Read useDesktop inside formatter/hook: unnecessary coupling; reuse App's existing name-map injection seam.
- Live durations: conflicts with static UX and adds lifecycle/timer ownership.
- Add an endedAt column or change integration scheduling: expands persistence/lifecycle scope.
- Infer terminal time from client receipt or completion message timestamp: violates chain-end timing.
- Rewrite historical chain rows or main specs wholesale: violates backward compatibility and delta semantics.

## Migration Plan

Deploy additive server projection and tolerant client together; either side can roll back independently. Older clients ignore createdAt; new clients receiving old payloads omit elapsed. No data backfill, migration or runtime configuration change.

## Validation design

The first implementation slice proves creation/update timestamp separation and old-payload normalization. Pure formatter tests then cover 0/45/59 seconds, 60 seconds, 59 minutes, 1h 00m and 2h 05m, fractional inputs, negatives, invalid timestamps, future start, terminal end before start and end-vs-now selection. Hook tests send deterministic frames through the existing captured callback, freeze system time, assert all five title/description pairs, exact ids/durations and unchanged buttons, errors, registration cleanup, project-map rerender, cross-project/milestone isolation, repeat frames, progress hydration and completion with/without a cached chain. Spanish uses loaded resources and restores test language. Existing parity tests cover all eight locales; existing BuilderSidebarEntry and MilestoneProgressCard suites protect neighboring toast/action behavior. Host commands are proposed in the role response; running checks and delivery belong to Core.
