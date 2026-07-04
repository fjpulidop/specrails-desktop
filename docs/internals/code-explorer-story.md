# Code explorer: the construction story

> Companion to the "Code explorer (read-only)" section of `CLAUDE.md`. This doc
> covers the per-file **construction story** — the narrative layer that tells a
> non-developer, for any file, HOW it was built: which specs intervened and what
> each one contributed.

## Problem

`file_provenance` (migration 22) records *that* a job touched a file, and
`file_provenance_diffs` (migration 23) stores the raw patch — but nothing told
the *story*: no per-intervention line stats, no plain-language "what did spec
#37 change in THIS file" narrative, and — critically — **loop runs recorded no
provenance at all**. Both loop paths settle outside `QueueManager` (whose
post-exit hook was the only provenance producer):

- **Isolated worktree rails** (`rail-isolated-launch.ts`) — the run's writes
  happen in a per-ticket worktree and settle in the launch's own promise chain.
- **Shared-cwd rails** (`rails-router.ts` `launchLoopRun`) — the run settles in
  the router's `.then`/`.catch`.

So the entire loop-based implement path (the default rail mode) was invisible
to the Code explorer.

## Persistence (migration 37)

`file_story_contributions` in the per-project `jobs.sqlite`:

| column | meaning |
| --- | --- |
| `provenance_id` (PK) | 1:1 with `file_provenance.id` |
| `job_id`, `file_path` | denormalised identity for path-scoped queries |
| `added_lines`, `removed_lines` | unified-diff stats (`computeDiffStats`) |
| `patch_excerpt` | ≤ 4 KB excerpt (`excerptPatch`; full patch stays in `file_provenance_diffs`) |
| `summary` | nullable — the AI contribution paragraph |
| `summary_model`, `summary_generated_at` | generation metadata |

Stats rows are written **inside `recordProvenanceForJob`'s transaction**
(`server/file-provenance.ts`), for every provenance row that has a collected
patch. That means every producer — QueueManager jobs AND the loop seam — gets
stats with zero extra calls. The prepare is guarded (like the migration-23
`insertPatch`) so a pre-37 DB degrades cleanly.

## The loop-run seam (`server/file-story.ts`)

`recordLoopRunProvenance({ db, projectId, runId, ticketId, repoDir, snapshot,
broadcast })` is the single chokepoint that mirrors QueueManager's
`_recordProvenance`: gated by `isCodeExplorerEnabled()`, diff + patches +
`recordProvenanceForJob` + per-row `file.provenance_updated` broadcast, and the
`provenance.large_job` warn at >50 files. It never throws. `job_id` is the
**loop run id**, so the existing `/code/diff?jobId=` endpoint and job-context
filters key off it unchanged.

Wiring:

- `rail-isolated-launch.ts` — snapshots each fresh worktree at allocation
  (after the overlay, so overlay files land in the snapshot's untracked set and
  are never attributed to the run) and records at settle, on BOTH the success
  and failure paths, before `commitWorktree`. Once-per-run guard (the `.catch`
  also catches commit failures thrown after the `.then` recorded). Injectable
  via `IsolatedLaunchIO.snapshot` / `.recordProvenance`.
- `rails-router.ts` `launchLoopRun` — snapshots the **repo**
  (`loopExec.repoDir` when relocated, else the cwd — never the workspace) and
  records in `.then`/`.catch` with the same once-guard.
- `queue-manager.ts` — **unchanged**. Its existing `recordProvenanceForJob`
  call now also writes stats because the insert rides the same function.

## Story assembly + generation

- `getFileStory(db, path, getTicketSpec)` (`file-story.ts`) — provenance rows
  (oldest-first: a construction story reads forward in time) LEFT JOINed with
  contributions, enriched with the spec's live title/status via
  `ProjectContext.getTicketSpec` (failure-tolerant, memoised per call).
- `FileStoryManager.explain(...)` (`file-story-manager.ts`) — the on-demand,
  budget-gated contribution generator. Prompt = spec title + change kind + the
  stored patch (full patch preferred, excerpt fallback, honest "(not stored)"
  note otherwise). Reuses `createFileSummaryGenerator`'s spawn/parse skeleton
  via the new `systemPrompt` override — same haiku-class default model, same
  timeout/kill/partial-usage semantics. **Deliberate decisions:** it shares the
  file-summary monthly budget (`summary_monthly_budget_usd`) and records
  `ai_invocations.surface = 'file-summary'` — one budget and one analytics
  bucket cover the whole Code-section AI spend; no new Surface member. In-flight
  dedupe per `provenanceId`; the synchronous gates (not-found/budget) run
  BEFORE registering in-flight so a budget skip is never cached. Persists via
  `setContributionSummary` (inserts a summary-only row for patchless historical
  touches).

## REST + WS

- `GET  /api/projects/:id/code/file/story?path=` → `{ path, story: FileStoryEntry[] }`
  (same traversal/deny-list/gitignore guards as `/summary`; works for deleted
  files — their story is still told).
- `POST /api/projects/:id/code/file/story/explain?path=` body
  `{ provenanceId, overrideBudget? }` → `{ ok:true }` | 200 `{ skipped:'budget' }`
  (client shows the inline override) | 404 | 500.
- WS `file.story_updated` `{ projectId, path, provenanceId, ok, reason? }` —
  open viewers of that file refetch; `spending.invalidated` fires alongside.

The `FileStoryManager` is constructed per-`ProjectContext` at the code-router
mount site (`project-router.ts`), memoised with the router.

## Client

`ConstructionStory.tsx` (in `client/src/components/code-explorer/`) renders the
premium vertical timeline: glass cards on a dotted rail, each with kind
icon/label, the spec chip (`#id · title`, click → `TicketDetailModal` via the
`onOpenTicket` prop), status pill, `+N/−N` stats, date, and the contribution
paragraph — or the honest fallback (kind + spec + date, spec-less variants for
`ticket_id IS NULL`) with the **Explain this change** button (budget skip →
inline "Generate anyway" override). The run-id footer filters the Code page by
job. `FileViewer`'s bottom panel hosts it behind a **Story | Log** toggle
(default `story`, persisted per project at
`localStorage['specrails-desktop:code-history-mode:<projectId>']`); Log is the
pre-existing `ProvenanceTimeline` with on-demand diffs, unchanged.

**Agent-Mode parity is free**: the mission **Files** pane
(`AgentModeCodePane.tsx`) embeds `CodePage` → `FileViewer`, so the story panel
appears there with no extra code (the component only uses `getApiBase()`,
props, and WS — nothing route-dependent).

i18n: the `story.*` block in the `code` namespace, all 8 locales (parity test
enforced).

## Fallback ladder (locked design)

Contribution text sources, in order: (a) the persisted AI `summary`; (b) the
honest fallback — kind + spec + date only, never an invented claim. Diff stats
render whenever migration-37 rows exist; historical (pre-37) touches show the
bare provenance facts.

## Out of scope / future

Auto-generating contributions at provenance-record time (cost); a
whole-file "biography" paragraph synthesised from all chapters; multi-ticket
attribution (primary ticket only, unchanged from the base feature).
