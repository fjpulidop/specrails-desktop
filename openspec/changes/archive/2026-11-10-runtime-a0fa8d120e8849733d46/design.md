# Design

## Context

See proposal.md for motivation. This is a client-only composition change within the existing jobs feature. JobRunHeader owns live activity, runtime polling/actions, diagnosis eligibility, remedy availability, metrics and Details markup. JobDetailPage and JobDetailModal each render their own evidence/narration branches below it. Neither surface currently offers a graph/raw-log sub-switch: loop jobs substitute LoopStepExplorer for LogViewer. The new Log detail section therefore must explicitly render LogViewer for loop jobs as well.

The supplied navigation map and applicable AGENTS.md, CLAUDE.md and .claude/rules/client.md conventions were inspected, together with frontend ownership, modular architecture, source-boundary and modal guides. Keep capability dependencies unchanged; this is not a new server module or public feature boundary.

Installed packages, checked from client/node_modules package manifests and client/package-lock.json: React/react-dom 19.3.0, TypeScript 7.0.2, Vite 8.3.5, Vitest 5.0.3, Testing Library React 16.3.2 and user-event 14.6.1. The client rule's React 18 line is outdated. No installed/shared Tabs primitive exists; RuntimeRolePrompts supplies an existing accessible button-tab pattern. React exports Activity and @types/react declares ActivityProps.mode as hidden | visible; no added dependency is needed.

## Goals / Non-Goals

**Goals:** Share navigation and bounded panel geometry; preserve truthful metrics, continuation behavior, scope isolation, live evidence and existing remedies. Prove preservation of state and post-render evidence navigation before wiring both surfaces.

**Non-Goals:** See the dedicated Non-Goals section below. No general view-controller framework, context provider or new runtime store.

## Non-Goals

Do not redesign diagnosis wording/remedy content; graph/log internals, search and filtering; narration templates; job/project lifecycle; server APIs, failureDiagnosis schemas or database storage. Do not repair unrelated outdated guides or architecture rules. No external dependency, metric estimate, URL route or top-level tab persistence.

## Clarifications

1. **high; default: null before requester answer.** For a pending question without a failed/canceled diagnosis, should Failure reasons appear, or should the answer form open in Log instead? **Authoritative answer: “Failure reasons appear”.** This is a narrow exception to diagnosis-only tab visibility, not permission to synthesize a diagnosis.
2. **medium; default: state-preserving inactive panels.** Does active-only mounting mean inactive effects stop or literal DOM removal? Use lazy visited Activity boundaries: only the selected evidence panel is visible/effect-active, while visited hidden DOM/state is retained. Literal removal would require out-of-scope snapshot interfaces.
3. **medium; default: retain non-failure Details access.** Where do metrics/continuation controls remain on jobs without a Failure reasons tab? Retain bounded Details in Log only when Failure reasons is unavailable, preserving existing access.

## Assumptions

- Pending question without diagnosis: where should it open? Requester answered “Failure reasons appear”; expose the tab while an answerable pending question exists, and selecting the header affordance selects it and expands Details without creating a diagnosis card. This answer supersedes the original iff-diagnosis visibility invariant.
- Active-only mounting versus state preservation: assume effect-active/visible panels only, with lazy visited Activity boundaries retaining inactive DOM/state. Literal DOM removal is not promised. This is the non-obvious assumption behind medium confidence.
- Non-failure Details access: assume bounded Details remains in Log when Failure reasons is absent; when pending-question content makes Failure reasons available, put Details there only.
- Initial top-level selection: diagnosed failed/canceled runs select Failure reasons; others select Log until the question affordance or tab is activated. Top-level selection is not persisted. Pending-question presence alone does not override an explicit Log choice.
- Initial loop Log sub-section without storage: graph, matching today's loop evidence; plain jobs force detail without overwriting the stored loop preference.

## Local reference patterns

- `client/src/features/jobs/components/job-run/JobRunHeader.tsx`: `JobRunHeader`, `JobRunHeaderProps`, local `showDiagnosis`, `diagnosisHandlers`, `diagnosisOffersRetry`, `runtimeActions`, `Metric`. Retain the existing eligibility calculation here as the sole source: parsed diagnosis + terminal + failed/canceled. Existing tests are actually `components/job-run/__tests__/JobRunHeader.test.tsx`, not the ticket's adjacent path. Their `renderHeader`, `run` and response fixtures cover missing metrics, totals, retry deduplication, question answers and runtime errors.
- `client/src/features/jobs/components/job-run/useRuntimeRuns.ts`: `useRuntimeRuns` is the single runtime polling/action owner per rendered header. It cancels stale polling and tracks action scope; action failures use notifyError, load failures remain runtime.error, drafts live in answers. Leave this hook unchanged and mounted while switching panels; do not duplicate polling in tabs or surfaces.
- `client/src/features/jobs/components/job-run/job-run-model.ts`: `loadJobRunDetailsOpen` / `saveJobRunDetailsOpen`, `JOB_RUN_DETAILS_KEY`, `JobRunSurface = page | glass`, defensive localStorage try/catch and incremental `useJobActivity`. Closest tests: `__tests__/job-run-model.test.ts`. Preserve the existing key and glass entry for modal Details.
- `client/src/features/jobs/pages/JobDetailPage.tsx`: `handleOpenLogs`, eventBuffer retained-tail notice, FEATURE_NARRATED_PROGRESS branches, `JobRunHeader` and InteractiveJobComposer. Current open-logs schedules requestAnimationFrame after selecting raw mode. Retain event/project handling and composer; move only composition. Tests: `pages/__tests__/JobDetailPage.test.tsx`.
- `client/src/features/jobs/components/JobDetailModal.tsx`: the same header, scoped projectId, loading/not-found states and virtualized evidence scrolling in an existing min-h-0 flex region; retain Dialog sizing/layers/focus trap and openFork scope. Tests: `components/__tests__/JobDetailModal.test.tsx`.
- `client/src/features/recovery/lib/failure-diagnosis.ts`: `readFailureDiagnosis` defensively parses wire data; `availableRemedies` retains ranking/limits; `logTailLines` bounds unknown-cause evidence; `openLogsAtFailure(root)` already supports a scoped ParentNode, reduced motion, failed/stalled-step lookup and fallback. Reuse unchanged; its tests are `features/recovery/__tests__/failure-diagnosis.test.ts` and `FailureDiagnosisCard.test.tsx`. No new failure parser or global document navigation.
- `client/src/features/settings/components/RuntimeRolePrompts.tsx`: button tablist/tab/tabpanel, roving tabIndex, ArrowLeft/Right wrapping and Home/End with explicit focus; `components/__tests__/RuntimeRolePrompts.test.tsx` uses async userEvent/findBy and verifies retained drafts. Copy the small pattern, not a cross-feature import or new generic primitive. Use per-instance useId identifiers rather than its fixed ids.
- `client/src/features/loops/components/loop-log/LoopStepExplorer.tsx`: local filter, mode and manualExpanded plus containerRef; its `focusSegment` waits for expansion before scrolling. Tests: `loop-log/__tests__/LoopStepExplorer.test.tsx`, `loop-log-model.test.ts`. `client/src/features/jobs/components/LogViewer.tsx` owns filter, autoScroll, collapsedPhases and containerRef; tests: `components/__tests__/LogViewer.test.tsx`. No existing snapshot/restore API exists in either viewer. Do not invent one in this scope.
- Test setup: `client/vitest.config.ts` uses jsdom and `src/test-setup.ts`; `src/test-utils.tsx` wraps MemoryRouter, TooltipProvider and SidebarPinProvider. Follow adjacent surface mocks for desktop/WS/fetch, clear localStorage between tests, use act/rerender for live updates, userEvent for keyboard/focus, controlled requestAnimationFrame callbacks for post-commit navigation, and explicit DOM scroll dimensions/spies for deterministic scroll assertions. jsdom does not prove pixel geometry; assert overflow/flex bounds structurally without claiming user acceptance or browser measurements.

## Decisions

### Shared tabs with one existing presentation/runtime owner

Create `RunDetailTabs.tsx` under job-run. Export RunDetailTab (failure | log), RunLogSection (graph | detail), RunDetailTabsProps and RunDetailTabs. Use actual repository `JobSummary` and `EventRow` types instead of inventing Job/JobEvent types; React 19 supports React.JSX.Element or inferred return type. Define the persistence-compatible RunLogSection union in job-run-model and re-export it from RunDetailTabs so the model never imports React/UI code. Export RunDetailSurface = page | modal from the model; retain JobRunSurface = page | glass for header chrome and existing callers.

Extend JobRunHeaderProps only additively with optional `renderRunDetails(context: JobRunDetailsContext): ReactNode`. Export the focused context type from the same file. Header retains its current calculations, runtime hook and single showDiagnosis calculation. Context carries diagnosis, showDiagnosis, pendingQuestion (the existing answerable predicate), handlers, bounded unknown-cause tail, hasDetails, detailsContent and a monotonically increasing detailsRequest token for question-button intent. Existing public props/actions callbacks remain source compatible. Rendering returns a fragment: compact header root first, then the callback result as a sibling. Header chrome itself renders neither diagnosis nor Details; it owns no tabs. Both known production callers supply the renderer. There is no second polling hook, effect-driven copying of React nodes or state reported upward during render.

Remove Details state/toggle from the header. Construct its existing metrics/runtime body as detailsContent without changing figures or action closures. The question-pending button increments detailsRequest instead of toggling inline content. The renderer passes the shared context into RunDetailTabs along with the ticket's job/events/surface/isLoop/graphContent/logContent/onOpenLogs props; additive optional props carry diagnosisHandlers, diagnosisTail, hasDetails and detailsRequest because the supplied minimal shape cannot express existing remedies or a repeated header request. A pendingQuestion boolean denotes answerable presence and contributes to tab availability; it is not a navigation trigger. Define failureAvailable = showDiagnosis || pendingQuestion in the shared view. Keep showDiagnosis unchanged in the header as the sole diagnosis/card eligibility predicate; the requester-authorized question exception does not change retry deduplication or create failure data. Tabs own activeTab, logSection and detailsOpen. This keeps content/action authority where it already exists and layout state in the new shared view.

Rejected: duplicating tabs in page and modal (drift); moving runtime ownership into an additional hook/file (unnecessary extraction); duplicating header polling inside tabs (conflicting actions/state); narrowing existing props or renaming glass globally (unrelated breakage).

### Selection and identity

Initialize activeTab from showDiagnosis, logSection from the surface helper (graph default), detailsOpen from the compatible helper. Key the shared view by project identity and job id at each caller, so transient user intent/visited panels reset when either changes. Stored choices contain no job/project data. Use a per-visit explicitLogChoice ref and observed-eligibility ref: on false-to-true eligibility select failure once unless explicitLogChoice is set. Clicking/keyboard-selecting Log counts as explicit even if it was already selected. Delayed diagnosis is treated as an eligibility transition, not merely a status transition. Background transitions never call focus. If failureAvailable disappears while selected, show Log immediately rather than a blank panel. Persistence effects must not write a forced detail selection over a loop graph preference on plain jobs.

Question requests select failure, open/persist Details and reveal the answer field within the bounded panel, including when no diagnosis exists. Pass the existing answerable predicate to pendingQuestion; retain runtime-owned draft, answer validation, busy state and error feedback. A question-only Failure reasons panel contains real Details/question content and no fabricated cause. On question settlement, if neither diagnosis nor another answerable question keeps the tab available, return to Log without moving focus. Keep Details expanded and available in its non-failure Log location. The no-diagnosis pending-question regression remains required. Repeated clicks must work via the request token, even if Details was collapsed since the previous click.

### Panel geometry and accessibility

Use existing class-based theme styles: outer run-detail `min-h-0 flex-1 flex flex-col overflow-hidden`; tablists `shrink-0`; active content `min-h-0 flex-1 overflow-hidden`; failure panel `min-h-0 flex-1 max-h-full overflow-y-auto overscroll-contain`. Its height is bounded by the finite page/modal flex region, not by content. Ensure page's existing h-full chain and evidence region acquire min-h-0 where needed; leave outer app shell unchanged. Tablist is a sibling of the scrolling failure panel, so Details cannot move it off-screen. Non-failure Details uses the same bounded disclosure placement within Log without duplicating content. Log sub-navigation, notices and bounded optional Details consume only their allotted region; evidence retains min-h-0 flex-1 height.

Use the observed button-tab pattern with named separate tablists, aria-selected, aria-controls/labelledby, roving tabIndex and useId. Scope ArrowLeft/Right/Home/End handling to the originating list; do not intercept editing/navigation keys in panel inputs. No hidden panel may be focusable or exposed as active; retain selected-tab focus on ordinary selection. Question/open-logs are deliberate exceptions that reveal their target. Keep modal typography >=12px outside chips.

### State preservation and rendering cost

Thin slice first proves lazy visited Activity wrappers against the real graph and log, not just fake nodes. Never mount an unvisited expensive panel merely to hide it. Once visited, keep stable panel identity under `Activity mode=hidden|visible`; hidden effects disconnect while state/DOM survives. Only one evidence section is visible/effect-active; hidden evidence is inaccessible. This is the stated interpretation of the conflicting active-only mounting instruction. Ordinary literal unmounting is rejected because it discards the very local state the ticket requires preserved. If Core requires literal unmounting, this design needs amendment; do not improvise changes to viewer internals.

Test paused/manual scroll restoration on reactivation because effect reconnection may autoscroll in follow mode. Existing follow behavior should still follow current events; an explicit paused/manual choice must survive. Event buffers already bound the input, and visits can retain at most two evidence panels per surface; assume that cost is acceptable. No speculative cache, event reprocessing loop or benchmark feature. Activity is new locally, so the initial slice must cover cleanup/remount and state preservation before either surface depends on it.

### Scoped post-render remedy navigation

Wrap the existing open-logs handler in RunDetailTabs to request activeTab=log and section=graph for loops/detail for plain jobs. Track a pending navigation request; after the selected panel has committed and become visible, schedule the existing surface callback. Do not query immediately after setState. Cancel pending animation callbacks on unmount/job replacement and collapse rapid duplicate requests. Each surface handler closes over its own run-detail root ref and invokes existing `openLogsAtFailure(root)`, preserving its not-found toast and reduced-motion behavior. The modal must supply this callback explicitly instead of falling back to document-wide lookup. Hidden cached panels must never be selected as navigation targets; scope to the revealed evidence panel within that surface. Loop graph reveal is independent of remembered narration mode; plain Log detail must select raw mode before lookup. Keep resume/retry/edit-spec closures, busy/error handling and diagnosisOffersRetry unchanged.

### Persistence and existing specs

Add loadJobRunLogSection/saveJobRunLogSection with a new UI-only localStorage key, enum validation, independent page/modal entries and defensive failures like current Details helpers. For details helpers, accept RunDetailSurface additively and normalize modal to the existing glass entry; preserve page and glass callers, key shape and values. This is browser preference storage only, not a job/server persisted-format change or migration.

Modify only the first legacy layout requirement in live-job-status; leave duration, aggregation, cost and ticket requirements untouched. Modify only the narration-mode layout requirement in narrated-progress; its former feature-flag byte-identical whole-surface promise cannot coexist with unconditional new tabs, so preserve raw content while explicitly updating that layout promise. Other requirements remain unchanged. Main specs are not edited during this role.

## Blast radius

All paths are relative to the sole in-scope repository. This is the developer edit boundary; no wildcard permission to edit other files.

| File | Action and reason |
| --- | --- |
| client/src/features/jobs/components/job-run/RunDetailTabs.tsx | Create shared tabs, state, panel bounds, accessibility and post-render navigation. |
| client/src/features/jobs/components/job-run/RunDetailTabs.test.tsx | Create contract-named unit/integration tests, including real-view state preservation thin slice. |
| client/src/features/jobs/components/job-run/JobRunHeader.tsx | Modify additive render callback/context, compact chrome and question request; retain runtime/diagnosis ownership. |
| client/src/features/jobs/components/job-run/__tests__/JobRunHeader.test.tsx | Modify actual existing tests to compose tabs for moved Details/diagnosis assertions while retaining chrome/action/question coverage. |
| client/src/features/jobs/components/job-run/job-run-model.ts | Modify additive surface/section types and defensive preference helpers; preserve legacy Details entries. |
| client/src/features/jobs/components/job-run/__tests__/job-run-model.test.ts | Modify helper tests for defaults, invalid/unavailable storage and legacy compatibility. |
| client/src/features/jobs/pages/JobDetailPage.tsx | Modify shared renderer, graph/raw/narrated slots, height chain and scoped failure navigation. |
| client/src/features/jobs/pages/__tests__/JobDetailPage.test.tsx | Modify actual integration tests for tab layout/live transitions/remedies, existing Details and narration/composer behavior. |
| client/src/features/jobs/components/JobDetailModal.tsx | Modify matching renderer with modal surface identity, existing loading handling and scoped remedy callback. |
| client/src/features/jobs/components/__tests__/JobDetailModal.test.tsx | Modify actual integration tests for equivalent tabs, modal persistence, loading and answering/navigation. |
| client/src/locales/en/jobs.json | Add run-detail navigation and accessible tablist labels in English. |
| client/src/locales/es/jobs.json | Add matching Spanish keys. |
| client/src/locales/fr/jobs.json | Add matching French keys. |
| client/src/locales/de/jobs.json | Add matching German keys. |
| client/src/locales/pt/jobs.json | Add matching Portuguese keys. |
| client/src/locales/it/jobs.json | Add matching Italian keys. |
| client/src/locales/zh/jobs.json | Add matching Chinese keys. |
| client/src/locales/ja/jobs.json | Add matching Japanese keys. |
| client/src/features/jobs/README.md | Document shared run tabs, persistence mapping and focused regression command outside generated block. |
| docs/guide/en/pipeline/2-the-job-detail-view.md | Update only layout/navigation/Details paragraphs made stale by tabs. |
| docs/guide/es/pipeline/2-the-job-detail-view.md | Matching localized narrow guide correction. |
| docs/guide/fr/pipeline/2-the-job-detail-view.md | Matching localized narrow guide correction. |
| docs/guide/de/pipeline/2-the-job-detail-view.md | Matching localized narrow guide correction. |
| docs/guide/pt/pipeline/2-the-job-detail-view.md | Matching localized narrow guide correction. |
| docs/guide/it/pipeline/2-the-job-detail-view.md | Matching localized narrow guide correction. |
| docs/guide/zh/pipeline/2-the-job-detail-view.md | Matching localized narrow guide correction. |
| docs/guide/ja/pipeline/2-the-job-detail-view.md | Matching localized narrow guide correction. |
| docs/internals/source-map.md | Refresh new component/test references using existing generator; separate generated diff. |

Planning artifacts authored here, all under openspec/changes/runtime-a0fa8d120e8849733d46/: proposal.md, design.md, tasks.md, specs/job-run-detail-navigation/spec.md, specs/live-job-status/spec.md and specs/narrated-progress/spec.md. These capture the behavior/plan and are not permission to edit main specs during implementation. No schema/API/config/migration files become stale. No public feature subpath/dependency changes require a boundary manifest update. In particular, recovery/lib/failure-diagnosis.ts is inspected and reused unchanged: the requested scoped lookup already exists, so the ticket's suggested edit there is unnecessary.

## Risks / Trade-offs

- Question-only Failure reasons exception → use the requester's explicit answer, keep diagnosis eligibility independent, and cover question arrival/settlement without fabricated failure data.
- Literal unmounting versus retained state → explicit Activity interpretation, real-view regression slice; hidden DOM is retained and bounded, not claimed to be unmounted.
- Reconnecting effects may scroll → exercise paused/manual and follow cases with deterministic dimensions before wiring surfaces.
- Runtime answers/actions disappearing during extraction → keep hook owner mounted, preserve action closures and test failed submissions/empty answers/draft retention.
- Live failure or late diagnosis overriding user intent → per-job explicit-choice/eligibility refs and rerender tests, without imperative focus.
- Both page and modal mounted → useId, scoped root lookup and separate preference entries; test the wrong surface is untouched.
- Long content/small resizable modal → bounded min-h-0 flex chain and internal overflow, structural tests; no claim jsdom validates the one-screen product hypothesis.
- Storage parse/quota/privacy errors → validated enum read and try/catch write; UI continues without persistence.
- Render callback accidentally leaves header shrink wrapping the tabs → return sibling fragment and assert header contains neither card nor Details; tabs own flex growth.

## Security and failure boundaries

Do not add requests or authorization paths; existing project-scoped fetching, WS filters, lifecycle/cancellation and runtime action scope stay untouched. Use parsed diagnosis and existing inert React text rendering; never serialize evidence, answers or identifiers into the preference key. LocalStorage is untrusted: reject unsupported enums and non-object/array payloads. Keep current notifyError/toast and runtime load-error presentation; no new logging/metrics or personal data handling. Dispose scheduled UI callbacks on identity change/unmount.

## Migration Plan

Implement the tested state-preservation/navigation thin slice first, then header seam and page integration, then modal parity and documentation. Ship as normal client code with the requester-resolved question exception and the documented lifecycle interpretation. Existing Details entries continue working without a migration. Reverting the client changes restores the old layout; the new preference key is harmless when ignored. Core owns all execution, verification, archive and delivery.

## Decision status

The requester resolved the sole blocking product conflict: Failure reasons appears for an answerable pending question even without a diagnosis. No blocking questions remain. Confidence is medium because lazy retained Activity boundaries interpret the active-only mounting instruction while preserving the expressly required local state; the first implementation task proves this behavior against the real viewers.

## Out-of-scope findings

The client rules' React 18 statement differs from installed React 19.3.0. The ticket names test locations/types that do not exist at those exact paths; use the actual paths/types listed above. Some existing Job Detail guide content already predates the compact header; update only the paragraphs directly made stale by this change. Broader documentation correction and viewer snapshot APIs are outside scope.

## Evidence for the pending-question exception

JobRunHeader independently computes answerable from pendingQuestion/canResume/recoverableSteps and showDiagnosis from job status/diagnosis. Its existing “surfaces a pending architect question” test uses a failed job with no diagnosis. The runtime controls expose pendingQuestion independently of failure diagnosis; a paused question is not itself a failure. Preserve that behavior and apply the authoritative visibility exception only in client navigation.
