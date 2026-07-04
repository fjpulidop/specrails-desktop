# Loop-step log explorer

The premium log surface for **loop runs**. When a job's `command` starts with `loop:`, both job views — the board's Job Detail page (`client/src/pages/JobDetailPage.tsx`, `variant="page"`) and the mission-mode job modal (`client/src/components/JobDetailModal.tsx`, `variant="glass"`) — mount `LoopStepExplorer` (`client/src/components/loop-log/LoopStepExplorer.tsx`) instead of the flat `LogViewer`. Non-loop jobs keep the legacy `LogViewer` byte-identical.

The explorer does **not** introduce a second log pipeline. It consumes the exact same `events` array (persisted rows + live WS frames) and the exact same line parser (`parseEvent → mergeAssistantLines → applyDiffDetection` from `LogViewer`), then *segments* the result by three structured events the loop engine already persists on the run's backing job row.

## Event contract

Emitted by `server/loop-run-manager.ts` (payload interfaces are exported there — `LoopStepEventPayload`, `LoopStepEndEventPayload`, `LoopGraphEventPayload`). All three ride the run's job row as ordinary persisted `events` rows plus `event` WS broadcasts (`event_type` below, `payload` = JSON of the interface). Purely additive to the existing stream — no DB migration.

### `loop_graph` — once, at run start

Emitted after the run-header log lines, before the first `loop_step`. It is the run's graph **snapshot**, verbatim, so historical replay stays faithful when the loop is later edited or deleted (`loop_runs` stores no graph).

```ts
interface LoopGraphEventPayload {
  graph: LoopGraph
  loopId: string
  loopName: string       // display name; falls back to the loop id
  provider: string
  model: string
  iterationLimit: number
}
```

### `loop_step` — appended + broadcast BEFORE each step spawns

```ts
interface LoopStepEventPayload {
  index: number          // 1-based ordinal within the WHOLE run (monotonic across iterations)
  kind: 'ai-step' | 'shell' | 'decider'
  title: string
  nodeId: string         // resolves against loop_graph's snapshot
  iteration: number      // 1-based pass at emission; increments when a Decider evaluates
                         // (the Decider itself belongs to the pass it closes)
  template?: string      // ai-step only — the AUTHORED prompt (raw {{cmd:X}} string),
                         // present only when rendering changed it (a plain free-text
                         // prompt would duplicate command). Capped at ~1000 chars + '…'.
  command?: string       // ai-step only — the RENDERED prompt actually sent (magic
                         // commands expanded, spec/run/const tokens resolved; excludes
                         // the injected cross-iteration history). Capped at ~2000 chars + '…'.
}
```

**Removed flat-log lines (log hygiene).** The engine used to open every ai-step with two log lines — `Template: …` and `Command: …`. Once the explorer landed those were pure noise (they duplicated what belongs to the step header), so they are **no longer emitted for any step**; the information rides the `loop_step` payload fields above instead, and the step body opens directly on real output. The per-kind *signal* lines are unchanged: the decider's `Goal: …` and the shell's `$ <command>` / `(exit N)` still stream in the flat log, as does the `🧑 <command>` echo of an interactive session (that is the real transcript — not deduped). Legacy runs recorded before this change simply lack the payload fields (client tolerates `undefined` → no disclosure) and keep their old `Template:`/`Command:` lines in the replayed body.

The client surfaces `template`/`command` as a subtle **ⓘ disclosure** in the step-box header (`LoopStepSection`): collapsed by default, expands a compact monospace detail block with per-field copy controls, rendered independently of the body collapse state.

### `loop_step_end` — appended + broadcast at each step's tail

```ts
interface LoopStepEndEventPayload {
  index: number          // matches the opening loop_step's index
  nodeId: string
  status: 'ok' | 'failed'
  exitCode: number | null   // shell steps: the real exit code; ai-step/decider: null
  durationMs: number         // executor-reported, else the step's wall-clock
  decision?: 'continue' | 'stop'  // decider steps only — the verdict the run routed by
}
```

A step torn down by manager shutdown / project removal (disposed, never settles) gets **no** end event — that absence is meaningful (see the status model). A traversal exception, by contrast, *does* close the open step as `failed` on the settle path.

**Zero-work steps end `failed`.** An ai-step whose settle consumed no model work — the claude CLI's synthetic `Unknown command:` result frame (`num_turns` 0, no assistant events, zero usage; run `01f41203`) — ends `status:'failed'`, never `'ok'`: the step's command never actually ran (`isZeroWorkSettle`, shared with QueueManager — see [interactive-jobs.md](interactive-jobs.md)). Because the `Template:`/`Command:` flat-log lines are gone and `result` frames carry no display text, the reason is surfaced as a stderr-style line **inside the step's segment** (before its `loop_step_end`): `✖ Zero work performed — the command never ran: Unknown command: …` — emitted by the interactive session at settle, or by the engine itself on the one-shot path. Run-level routing is unchanged: the step routes exactly like a crashed step (graph-dependent continue + the consecutive-failure fail-fast abort, which zero-work steps count toward).

### Seq guarantees

The run owns a single monotonic seq allocator (`takeSeq` in `runLoop`), **shared with an interactive step session** that persists its own provider events/logs on the same job id:

- `loop_graph` precedes the first `loop_step`.
- Each `loop_step_end` is appended **after its step's last persisted output line** — every emit site sits past the step's settle `await`, and the interactive session takes its seqs from the same allocator synchronously as it streams, so the end event's seq is always greater.
- Live WS frames carry no reliable seq, so the client groups in **arrival order**; a refetch (which replays `getJobEvents ORDER BY seq`) reconciles naturally because the model is derived from whatever `events` currently holds.

The engine also still emits the flat-log divider line per step (`━━━━━━ Step N · title ━━━━━━`) so the plain `LogViewer`/export view stays readable. Inside the explorer that divider duplicates the step-box header, so `groupByLoopStep` drops it (`STEP_DIVIDER_RE`).

## Grouping model (`loop-log-model.ts`)

`groupByLoopStep(events)` is a pure function returning a `LoopLogModel`:

- **Setup bucket** — every line seen before the first `loop_step` (run banner, worktree notice…) lands in `setup`, rendered as a collapsible **Setup** section.
- **Segments** — each `loop_step` opens a new bucket; ordinary events are bucketed to the last-seen step. A `loop_step_end` attaches to the **last** segment with a matching `index` (arrival-ordered). Malformed/unparseable payloads are tolerated and skipped.
- **Live activity** — while a step streams, `deriveFrameActivity` keeps the segment's `lastActivity` (the "Reading file…"-style label shown on the running step's header).
- **Legacy tolerance** — runs recorded before the enrichment may lack `nodeId`/`iteration` (both tolerated as `null`) and lack `loop_graph` entirely; iteration badges and the iteration counter simply hide, and the strip falls back (below).

## Status model

`segmentStatus(seg, { isLast, jobSettled })`:

| Condition | Status |
|---|---|
| `end` present | `end.status` (`ok` / `failed`) |
| No end, last segment, job running | `running` |
| No end, last segment, job settled | **`interrupted`** |
| No end, earlier segment | `unknown` (the loop advanced past it — no status glyph; overview chips render it as done) |

**Interrupted rule.** The contract says an end event may only be missing when the step was torn down mid-flight (dispose/shutdown/project removal), so *missing end + settled run* renders the dashed amber **Interrupted** treatment on both the step box and its overview chip.

**Legacy caveat (accepted v1).** Completed runs recorded **before** the enrichment have no `loop_step_end` rows at all, so their *final* step renders as Interrupted even though the run finished normally (mid-run steps are `unknown` → shown as done). Accepted for v1 — enriching historical rows was judged not worth a backfill.

## Overview strip (`LoopOverviewStrip.tsx`)

One chip per graph node, states `pending → running → ok / failed / interrupted`:

- **With `loop_graph`**: chips follow `traversalOrder(graph)` — DFS from Start, continue-branch first — so the strip reads start → body… → decider → end (the loop-back edge is implied). The End chip derives from the job outcome (`pending` until settled, then ok/failed).
- **Decider chips** carry the latest verdict as an icon (continue = loop-back, stop = exit).
- **Iteration counter** (right-aligned): `Iteration {current}/{limit}` when a limit is known, else a compact `iter {count}` badge; hidden entirely on legacy runs with no iteration data.
- **Legacy fallback (no `loop_graph`)**: a linear strip derived from the `loop_step`s actually seen, one chip per distinct node identity in first-seen order. Node identity is `nodeId` when present, else `kind::cleanedTitle` with the legacy `"(iteration N)"` suffix stripped (`nodeKeyForSegment`), so repeat passes over the same node collapse into one chip.
- Clicking a chip focuses that node's **latest** step box (expands + smooth-scrolls to it).

## Follow-mode interaction design

- **Follow (default)**: exactly the latest section is open — the running step, the final step once settled, or Setup when no step has started — with autoscroll pinned to the bottom. A "Following live" pulse shows in the toolbar while the job runs.
- **Any manual interaction pauses follow**: toggling/focusing a section, expand/collapse-all, or scrolling more than 80px up from the bottom (programmatic scrolls land *at* the bottom so they never trip this — same idiom as `LogViewer`'s autoscroll). The current expansion state is captured as the manual set.
- **Resume follow**: while paused on a running job (and not filtering), a floating pill re-enters follow mode and scrolls back to live.
- **Filtering** searches every section: while the filter is non-empty, all sections are treated as expanded; clearing it restores the previous mode.
- **Copy**: each step header carries its own copy button (per-step lines only; the control lives outside the toggle so the header stays a valid button), and the toolbar copy grabs the whole log with `── Step N · title ──` separators.

## Performance

- **Collapsed sections render nothing** — the body subtree is not mounted, so a 10k-line settled step costs one header row.
- `LoopStepSection` is memoized with a custom comparator over `(segment.key, lines.length, tail-line content, end fields, lastActivity, status, collapsed, filter)` — a WS flush that only grows the running step never re-renders settled boxes. The tail-content check matters because a streamed assistant continuation merges *into* the last line (no length change).
- Both surfaces already batch incoming WS events via `requestAnimationFrame` before they reach the model; `groupByLoopStep` recomputes per flush, memoized on `events` (and UI language, since `parseEvent` localises the result summary line).

## Ticket refs in log lines

`#N` ticket refs in prose log lines (both the flat `LogViewer` and the step boxes here, which share `LogLine`) linkify into a quiet underline-dotted affordance opening the board's `TicketDetailModal` — ticket-only (`components/log-ticket-refs.tsx` feeds `splitAgentRefs` an empty job-uuid set, so job ids never linkify — no modal-in-modal), with diff-styled/stderr lines and markdown code excluded; project scope threads via one optional `projectId` prop (mission `JobDetailModal` passes its own; the board page defaults to the active project) through `useLogTicketActions`, which reuses the agent-chat verify-then-open flow and `agent:refs.*` copy.

## The JobDetailModal stdout fix

Shipped with this feature: the mission-mode modal's WS handler previously appended only `stderr` `log` frames as synthetic events. Loop-run engine lines (`▶ Loop … started`, shell output, step dividers) stream as **stdout** `log` frames, so a live loop in the modal never grew — the log looked frozen until reopen. The handler now appends both stdout and stderr, matching `JobDetailPage`'s behaviour.

## i18n

All explorer strings live under the `jobs` namespace, `loopExplorer.*` (16 keys — setup, iteration, iterationBadge, follow, resumeFollow, expandAll, collapseAll, copyStep, copied, stepDetail, stepDetailTemplate, stepDetailCommand, copyCommand, interrupted, waiting, stepMapAria), translated in all 8 locales. Chip fallback labels reuse `loops:builder.nodes.*`.

## Files

| File | Role |
|---|---|
| `server/loop-run-manager.ts` | Event emission (`emitStep` / `emitStepEnd` / `loop_graph`), exported payload types, seq allocator |
| `client/src/components/loop-log/loop-log-model.ts` | Pure grouping/status/chip model |
| `client/src/components/loop-log/LoopStepExplorer.tsx` | Container: follow mode, filter, copy, toolbar |
| `client/src/components/loop-log/LoopOverviewStrip.tsx` | Live chip strip + iteration counter |
| `client/src/components/loop-log/LoopStepSection.tsx` | Per-step / Setup collapsible sections (memoized) |
| `client/src/components/loop-log/loop-node-visuals.ts` | Node-kind icon + accent mapping |
| `client/src/components/loop-log/__tests__/` | Model + explorer tests |
