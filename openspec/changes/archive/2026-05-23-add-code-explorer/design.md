## Context

specrails-hub already accumulates rich per-project state: jobs, tickets, AI invocations, chat conversations, plugin snapshots, telemetry blobs. What it does **not** yet have is a bridge from any of that state back to the actual *source files* the rails produce. The dashboard tells a non-developer that "Ticket #42 ran successfully and cost $1.20"; it cannot tell them which files came out the other side, nor what those files do.

This change introduces that bridge. The user-facing surface is a new **Code** section in the project sidebar. Behind it sits two new server primitives — file⇄ticket provenance, and AI-generated plain-language file summaries — both designed to be authoritative for future code-comprehension features (narrative diff, ask-the-AI-about-this-file, directory summaries) without re-architecting.

Three constraints shape every decision below:

1. **Read-first.** v1 must not let a non-developer accidentally break the codebase. The viewer is read-only. Editing is explicitly out of scope and will be its own change.
2. **Cost-bounded.** AI summaries cost real money per generation. The system must never regenerate redundantly, must cap spend, and must surface cost in the existing `/analytics` dashboard so users see the bill.
3. **Additivity.** The change must not modify existing capabilities' requirements. Hooks into `QueueManager` are additive callbacks; `ai_invocations` gains a new `surface` value but no schema-breaking change; new tables and new files live in hub-owned namespaces (`<project>/.specrails/file-summaries/**`).

The relevant existing infrastructure to lean on:

- `QueueManager` already spawns the rail process, knows the job's `ticket_id`(s) from command parsing, and emits a completion event. Provenance computation hooks in here.
- `ai_invocations` already tracks `surface`, `model`, `total_cost_usd`, `tokens_*`, broadcast `spending.invalidated`. Summaries become another surface and inherit budget visibility for free.
- `WebSocket` is already project-scoped via `projectId`-injecting closures. New events follow the same pattern.
- `TicketDetailModalProvider` already exists at App root and opens tickets over the current route — chip clicks in the tree reuse it.
- `useProjectCache` already implements stale-while-revalidate per project — the tree and summaries adopt it so project switches feel instant.

## Goals / Non-Goals

**Goals:**

- Give non-developers a navigable, comprehensible view of the codebase produced by AI rails: tree + provenance + plain-language summary per file.
- Maintain provenance as a first-class, queryable concept (`file_provenance` table) so future features can consume it without scraping git history.
- Generate summaries at the right time (whenever a file is meaningfully changed by AI) and **not** at any other time (no idle batches, no re-runs on identical content).
- Surface summary cost in the existing analytics dashboard with `surface='file-summary'`, with no extra UI work.
- Ship behind feature flags on both sides so the change is invisible to current users until ready.
- Preserve all existing capability requirements unchanged.

**Non-Goals:**

- In-app file editing, save semantics, dirty-buffer management, undo. The viewer is read-only in v1.
- Per-symbol or per-function summaries. v1 summarises whole files only.
- Narrative diff view ("the AI added validation because ticket #51 said…"). Deferred.
- Conversational chat scoped to a file ("ask the AI what this does"). Deferred.
- Directory-level summaries. Deferred.
- Summarising every file in the repo on first install. v1 summarises only files touched by AI rails; user-triggered summaries for arbitrary files are a button on the viewer (opt-in per file), never an automated batch.
- LSP, IntelliSense, error squiggles, code navigation by symbol. v1 is read-only viewing, not editing infrastructure.
- Coexistence semantics with the user's external editor. v1 does not write files, so external editor wins by default. File-watcher only used to mark summaries stale.

## Decisions

### D1. Provenance is a first-class table, not parsed from git on demand

A new per-project table `file_provenance` stores `(project_id, file_path, ticket_id, job_id, kind: 'created' | 'modified', at)`. It is populated by a post-job hook in `QueueManager` that:

1. Snapshots the working-tree state at job start (or relies on the existing pre-job state).
2. At job exit (regardless of success), diffs the working tree against the pre-job snapshot via `git diff --name-status`.
3. For each touched path, inserts a row with `kind='created'` for `A`-status, `kind='modified'` for `M`-status. `D` (deleted) and `R` (renamed) are normalised: `D` writes a tombstone row, `R` writes a `modified` row at the new path plus a tombstone at the old.
4. The `ticket_id` is the *primary* ticket associated with the job (the first id from the existing `tickets[]` resolution on the job's `command`). If multiple tickets are resolved, only the primary is associated — pragmatic v1 simplification noted in Open Questions.

**Alternative considered:** parse `git log` on demand and join commits to tickets via commit-message trailers. Rejected because (a) the rails do not yet commit per ticket reliably, (b) the join is fragile, (c) on-demand parsing scales poorly with repo size, (d) we lose information for jobs that never committed.

**Indexing:** `(project_id, file_path)` and `(project_id, ticket_id)`, partial `(project_id, at DESC)`. All queries from the Code section and analytics surfaces should hit one of these.

### D2. Summary storage on disk, pointer-free

Summaries live at `<project>/.specrails/file-summaries/<sha256-of-relative-path>.json`. **No SQL pointer table.** Reasons:

- Summaries are append-on-update, never queried by arbitrary attributes — only ever fetched "summary for path P". The hash-of-path filename gives O(1) lookup without an index.
- Surviving a delete-all SQLite migration is desirable for user-visible content.
- Disk is fine: even 5000 files × 2 KB JSON ≈ 10 MB, trivial.

The on-disk shape:

```json
{
  "schemaVersion": 1,
  "path": "src/components/LoginForm.tsx",
  "fileHash": "sha256:abc123…",
  "summary": "Formulario de inicio de sesión con email y contraseña…",
  "language": "es",
  "generatedAt": "2026-05-22T10:30:00Z",
  "generatedBy": { "model": "claude-haiku-4-5", "promptVersion": 1 },
  "triggeredBy": { "kind": "job", "id": "job_xyz", "ticketId": 42 }
}
```

`schemaVersion` future-proofs migrations. `fileHash` is the sha256 of the file *contents at generation time* and is the authoritative invalidation key.

**Alternative considered:** store summaries in SQLite blob column. Rejected — no querying needed, file-level atomic writes are simpler, and `.specrails/` is the right hub-owned namespace.

### D3. Hash-gated generation, never re-generate identical content

Generation is the only meaningful cost driver. Algorithm:

```
on file change (AI-driven OR user-edit observed by chokidar):
  newHash = sha256(fileContents)
  existing = readSummary(path)
  if existing && existing.fileHash === newHash:
    return  # no-op
  enqueue regeneration(path, triggeredBy)
```

Regeneration concurrency: max **2 in-flight per project**, max **8 hub-wide**. Anything beyond queues with a soft TTL of 5 minutes; expired entries drop silently with a single `file.summary_skipped` event for analytics.

**Budget cap.** Hub-wide setting `summary_monthly_budget_usd` (default `5.00`). Before enqueuing, the manager checks the current month's spend from `ai_invocations` where `surface='file-summary'`. If above budget, the regeneration is skipped, a `file.summary_skipped` event is emitted with `reason='budget'`, and the viewer shows a banner offering "↻ regenerate anyway" which bypasses the cap for that specific request only.

### D4. Default model is Haiku 4.5, prompt is deterministic

Generation uses `claude-haiku-4-5` by default. The cost-per-summary at typical file sizes is in the ~$0.0005–$0.003 range, putting 5000 summaries comfortably under $5.

The prompt is byte-stable (no timestamps, no file paths in the system part) so Anthropic prompt caching gives meaningful hits across batches of files in the same project. Caching uses the existing `claude-api` skill conventions.

Prompt structure (system part is cached):

> *System:* You are explaining code to a non-developer. Output 2–4 sentences in plain language about what the file does. No code. No jargon. No bullet lists. Output only the explanation.
>
> *User:* `<file path>\n<file contents truncated to 8000 tokens>`

Truncation strategy: if the file exceeds 8000 tokens, take the first 4000 + the last 2000 + a marker `// … truncated … //`. Tracked in `generatedBy.truncated: true` so the UI can surface a "Resumen parcial" hint.

**Alternative considered:** Sonnet 4.6 for higher quality. Rejected for v1 — cost is 10× and the gain on "summarise file in 3 sentences" is marginal. Settings-configurable model is a future change.

### D5. Detect file changes from two sources, treat them differently

Two paths cause a file to need a new summary:

- **AI-driven:** populated by the QueueManager hook. Always enqueues regeneration with `triggeredBy = { kind: 'job', id, ticketId }`.
- **User-driven (external editor):** a chokidar watcher in `FileSummaryManager` listens for content changes in tracked files. On change, the summary is **marked stale** (a flag bit in the JSON), but regeneration is **not** automatic. The viewer renders the stale flag and the user clicks ↻ to regenerate. Reason: AI-driven edits are batched (one regeneration per job), but user edits could fire 50 times during a 1-minute editing session. Manual regeneration avoids the bill spike.

Chokidar lifecycle: watcher attached lazily when the Code section is opened for that project, torn down when the panel is closed or the project is switched. Reuses the existing watcher pool if one is already running for another feature.

### D6. WebSocket events follow the existing per-project pattern

Two new event types, both project-scoped, both passed through `boundBroadcast`:

- `file.provenance_updated` → `{ projectId, path, kind: 'created'|'modified'|'deleted', ticketId, jobId, at }`. Emitted once per touched file per job.
- `file.summary_updated` → `{ projectId, path, summaryAvailable: true, stale: false, generatedAt }`. Emitted on successful regeneration. Failures emit `file.summary_failed` with `{ reason }`.

The client handler filters by `activeProjectId` via ref-not-closure, per existing convention.

### D7. New REST surface under `/api/projects/:projectId/code`

A new router `server/modules/code/runtime/code-explorer-router.ts` is mounted alongside the existing per-project routes:

- `GET /tree?withProvenance=1&filter=touched-by-ai|all` — virtualised: returns up to 2000 entries per request with pagination cursor. Each entry: `{ path, kind: 'file'|'dir', sizeBytes, hasSummary, provenance: { createdByTicketId?, modifiedByTicketIds[] }, lastModifiedAt }`.
- `GET /file?path=…` — returns `{ content: string, encoding, language, provenance, summary, summaryStale }`. Refuses binary files (returns `{ binary: true, sizeBytes, mime }`) and files larger than 2 MB.
- `POST /file/regenerate-summary?path=…` — explicit user-triggered regeneration. Bypasses the budget cap with a confirmation toggle in the body (`overrideBudget: true`).
- `GET /summary?path=…` — summary-only, lighter than `/file`.
- `GET /provenance?ticketId=…` — reverse lookup: list of files created/modified by a ticket. Powers a future "Files from this ticket" surface in `TicketDetailModal` (lands in v1 as a small section).

All endpoints are gated by `SPECRAILS_CODE_EXPLORER !== 'false'`. When disabled, the router returns 404 for the entire prefix.

### D8. Tree filtering defaults to "touched by AI"

The vast majority of files in a project are not interesting to a non-developer (`node_modules`, `dist`, `.git`, lockfiles, generated output). Even after filtering those, large hand-written legacy areas of the codebase are noise.

The tree therefore defaults to **filter=touched-by-ai**: only files with at least one row in `file_provenance` are visible. A toggle in the tree header switches to **filter=all**, with a respected `.gitignore`-driven exclusion plus a hard-coded hub deny-list (`node_modules`, `dist`, `.git`, `coverage`, `*.lock`, `*.log`, dotfiles by default with override).

This is a UX decision with sharp edges: a user might open a freshly imported project and see an empty tree because no AI jobs have run yet. The empty state copy explicitly says "Once you run a job, the files it touches will appear here. Switch to **All files** to browse everything."

### D9. Monaco is lazy-loaded behind the feature flag

Adding Monaco adds ~3 MB to the client bundle. To avoid penalising users who never open the Code section (and especially anyone with the flag off), Monaco is imported via dynamic `import()` inside the `CodeViewer` component, gated by the flag check. The initial route load of `/code` shows a small "Cargando editor…" skeleton for the first visit per session.

`monaco-editor/esm/vs/editor/editor.api` is the import target; web workers are configured via the standard `MonacoEnvironment.getWorkerUrl` shim. Vite's `monaco-editor-vite-plugin` is **not** used (it produces large eager chunks); we hand-configure the worker resolution to keep granularity.

### D10. Coverage strategy

The change must satisfy the project's hard coverage gates (80% server lines/functions/statements, 80% client lines/statements). Critical paths to test:

- `file-provenance.ts`: git-diff parser, status-letter normalisation, multi-ticket job edge cases, tombstone handling.
- `file-summary-manager.ts`: hash gating, budget cap enforcement, concurrency limit, chokidar staleness, prompt truncation.
- `code-explorer-router.ts`: feature-flag gating, binary file refusal, large-file refusal, pagination cursors.
- Client tree component: filter switching, badge rendering, virtualisation, empty states.
- Client viewer: lazy Monaco load (mocked in tests), summary header rendering, stale banner, regenerate action.

Monaco itself is excluded from coverage via a documented entry in `client/vitest.config.ts` — it is a third-party module loaded dynamically and not testable in jsdom.

## Risks / Trade-offs

- **[Risk] Hallucinated summaries drift from real behaviour over time.** The hash gate prevents regeneration on unchanged content, but a user may read a stale-but-not-flagged summary if a teammate edits and commits without the hub running. → **Mitigation**: on every `/file` request the server compares the on-disk file's current hash against the stored hash and sets `summaryStale=true` in the response even if no chokidar event was observed. The UI shows the stale banner unconditionally based on this server-computed flag.

- **[Risk] Cost spike on large repos.** A misconfigured QueueManager hook (e.g., job that touches 500 files because of a Prettier run) could enqueue hundreds of regenerations. → **Mitigation**: per-job cap of 50 file regenerations. Excess emit `file.summary_skipped` with `reason='per-job-cap'`. The budget cap is the second line of defence.

- **[Risk] Coexistence with the user's external editor.** If the user edits a file in VSCode while a rail is running, the QueueManager-driven regeneration may race with chokidar's user-edit detection. → **Mitigation**: the manager applies a 1.5-second debounce window per file; the latest write within the window wins, with the `triggeredBy` of the last enqueue used. Conflict is benign — the summary always reflects current content.

- **[Risk] Provenance is wrong if rails make commits within the job.** Diff against working-tree state at job start is correct; diff against `HEAD` would miss intermediate commits. → **Mitigation**: snapshot is the working-tree state, not a commit. The hook captures `git stash create --include-untracked` at start and diffs against that stash blob at end. No commits, no working-tree pollution.

- **[Risk] Monaco bundle inflates initial load even with lazy import.** Webpack/Vite tree-shaking on Monaco is notoriously poor. → **Mitigation**: import only `monaco-editor/esm/vs/editor/edcore.main` (read-only language services subset) rather than the full `editor.main`. CI build-size guard added in `client/vite.config.ts` rejects bundles over 5 MB for the Code chunk.

- **[Risk] `.specrails/file-summaries/` grows unbounded.** Deleted source files leave orphan summary JSONs. → **Mitigation**: on every Code section open, an idle sweep removes summary files whose `path` no longer exists on disk. Bounded to 200 deletions per sweep; trace-logged.

- **[Risk] Feature flag turned off mid-session leaves stale provenance writes.** If `SPECRAILS_CODE_EXPLORER=false` is set after data has been written, the QueueManager hook should not write more rows. → **Mitigation**: the hook checks the flag at every job completion (cheap env read). Writes are skipped cleanly; existing rows remain readable.

- **[Trade-off] No editing in v1.** Users who realise they want to fix a typo cannot do it here. They must drop to their editor. We accept this — editing requires save semantics, dirty buffers, and conflict handling none of which fit the v1 budget. The viewer surfaces an "Edit in external editor" button that copies the absolute path to the clipboard as a stopgap.

- **[Trade-off] Primary-ticket-only provenance.** Jobs that resolve multiple tickets only record provenance against the first. Multi-ticket attribution is deferred to a future change. The UI shows the primary ticket only; advanced users querying the API can still infer co-attribution via job_id.

## Migration Plan

1. **Phase 1 (feature flag off, default).** Ship the server modules, router, and migrations. With `SPECRAILS_CODE_EXPLORER=false`, no QueueManager hook runs, no router responds. Zero user-visible change. Verify in staging by toggling on a single project.

2. **Phase 2 (opt-in).** Add the client sidebar entry and route under `VITE_FEATURE_CODE_EXPLORER`. Document the flag in the README. Internal dogfood: hub developers and a handful of pilot non-devs.

3. **Phase 3 (default on).** Flip `VITE_FEATURE_CODE_EXPLORER` default to `true` and `SPECRAILS_CODE_EXPLORER` default to allow. Update CLAUDE.md and ship release notes.

**Rollback strategy.** Set both flags to off. No data is harmed: `file_provenance` rows and `file-summaries/` JSONs remain on disk for the next time the feature is enabled. The migration is purely additive — no rollback DDL needed.

## Open Questions

- Should provenance attribute the file to **all** resolved tickets for a job, or only the primary? v1 ships primary-only; a multi-ticket join could land in a future change without breaking the table schema (the column is already `ticket_id` not `ticket_ids`).
- Should the empty state offer a "Generate summaries for all AI-touched files" action? Probably yes, but it is a budget hazard — defer to v2.
- Summary language: hub-wide setting today, but per-project override might be desirable when a team operates bilingual repos. v1 ships hub-wide.
- Does the `TicketDetailModal` get a "Files this ticket touched" mini-list in v1, or just in a follow-up? Proposal says yes; if scope tightens, this is the first thing to cut.
- For Tauri packaging, Monaco's web workers need an explicit asset-import strategy. The exact webview behaviour on Windows under Tauri v2 needs a smoke test before flag-default-on.
