## 1. Feature flags and settings scaffolding

- [x] 1.1 Add `SPECRAILS_CODE_EXPLORER` server env-flag read helper in `server/feature-flags.ts` (create if absent), defaulting to enabled unless explicitly `"false"`
- [x] 1.2 Add `VITE_FEATURE_CODE_EXPLORER` client flag read helper in `client/src/lib/feature-flags.ts`, defaulting to off in `v1`
- [x] 1.3 Add hub-wide settings `summary_language` (string, default `"en"`) and `summary_monthly_budget_usd` (numeric, default `5.00`) to `hub_settings` via a new server migration
- [x] 1.4 Expose the two settings via `GET/PATCH /api/hub/code-explorer-settings` with input validation (language enum, non-negative numeric)
- [x] 1.5 Surface the two settings in `GlobalSettingsPage` under a new "Code section" card, hidden when `VITE_FEATURE_CODE_EXPLORER` is off

## 2. Database migrations

- [x] 2.1 Add per-project migration creating `file_provenance(id INTEGER PRIMARY KEY, file_path TEXT NOT NULL, ticket_id INTEGER, job_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('created','modified','deleted')), at INTEGER NOT NULL)`
- [x] 2.2 Create indexes `idx_fp_path(file_path)`, `idx_fp_ticket(ticket_id)`, `idx_fp_at(at DESC)`
- [x] 2.3 Extend `ai_invocations.surface` allow-list in the application layer to include `'file-summary'` (no schema migration needed if the column is unconstrained `TEXT`)
- [x] 2.4 Verify the migrations are idempotent against an existing project SQLite that already has the tables

## 3. File provenance module (`server/modules/code/runtime/file-provenance.ts`)

- [x] 3.1 Implement `snapshotWorkingTree(cwd): Promise<string>` using `git stash create --include-untracked` to capture a no-op snapshot ref
- [x] 3.2 Implement `diffAgainstSnapshot(cwd, snapshotRef): Promise<DiffEntry[]>` returning `{ path, status: 'A'|'M'|'D'|'R', renamedFrom? }` parsed from `git diff --name-status`
- [x] 3.3 Implement `recordProvenanceForJob(db, projectId, jobId, ticketId, diff)` performing the inserts within a single transaction
- [x] 3.4 Implement `listProvenanceByTicket(db, projectId, ticketId)` returning rows ordered by `at DESC`
- [x] 3.5 Implement `listProvenanceByPath(db, projectId, filePath)` for tree-row badge enrichment
- [x] 3.6 Add `broadcastProvenanceUpdated(boundBroadcast, row)` helper
- [x] 3.7 Unit tests covering: A/M/D/R status normalisation, tombstone insertion for renames and deletes, transaction rollback on error, empty-diff fast path

## 4. QueueManager hook

- [x] 4.1 Add a `pre-spawn` callback that calls `snapshotWorkingTree(cwd)` and stores the ref on the job record (in-memory or a small `job_snapshots` table)
- [x] 4.2 Add a `post-exit` callback (runs regardless of exit status) that calls `diffAgainstSnapshot`, then `recordProvenanceForJob`, then broadcasts events
- [x] 4.3 Guard both callbacks behind `SPECRAILS_CODE_EXPLORER` check at the call site
- [x] 4.4 Enforce per-job cap of 50 rows; log a single `provenance.large_job` warning when exceeded; continue inserting beyond the cap (cap applies only to summary enqueue, not provenance rows — re-verify against design D7)
- [x] 4.5 Resolve `ticket_id` as the primary ticket from the existing `tickets[]` extraction on the job command
- [x] 4.6 Tests: end-to-end with a fake git repo, multi-file diff, deletion, rename, and a job that touches zero files

## 5. File summary manager (`server/modules/code/runtime/file-summary-manager.ts`)

- [x] 5.1 Define the on-disk JSON schema (TypeScript type + ajv validator) for `schemaVersion: 1`
- [x] 5.2 Implement `readSummary(projectPath, relPath)`, `writeSummary(projectPath, relPath, payload)` with atomic temp+rename
- [x] 5.3 Implement `computeFileHash(absolutePath): Promise<string>` (sha256 of contents)
- [x] 5.4 Implement `pathHash(relPath): string` (sha256 of UTF-8 bytes of relPath) for filename derivation
- [x] 5.5 Implement an in-memory queue with per-project concurrency 2 and hub-wide concurrency 8
- [x] 5.6 Implement per-job cap of 50 enqueues with `file.summary_skipped` emission on overflow
- [x] 5.7 Implement monthly budget check against `ai_invocations` aggregated by `surface='file-summary'` for the project, scoped to the current calendar month
- [x] 5.8 Implement the model call using the existing `claude-api` skill conventions, with prompt caching enabled and the byte-stable system prompt from design D4
- [x] 5.9 Implement head+tail truncation at 8000 tokens with marker, recording `truncated: true` in `generatedBy`
- [x] 5.10 On success, write the summary, insert the `ai_invocations` row with `surface='file-summary'`, broadcast `file.summary_updated` and `spending.invalidated`
- [x] 5.11 On failure, insert the `ai_invocations` row with `status='failed'`, broadcast `file.summary_failed`
- [x] 5.12 Implement the chokidar attach/detach lifecycle keyed by project id, with stale-only marking (no auto regenerate)
- [x] 5.13 Implement the orphan sweep capped at 200 deletions per pass
- [x] 5.14 Unit tests for: hash gating no-op, hash mismatch regeneration path, budget cap skip, override-budget bypass, per-job cap, concurrency cap queue draining, truncation, orphan sweep cap

## 6. Code explorer router (`server/modules/code/runtime/code-explorer-router.ts`)

- [x] 6.1 Mount the router under `/api/projects/:projectId/code`, gated by `SPECRAILS_CODE_EXPLORER`
- [x] 6.2 Implement `GET /tree?withProvenance=1&filter=touched-by-ai|all&cursor=…` with pagination (max 2000 entries per response, opaque cursor), deny-list (`node_modules`, `dist`, `.git`, `coverage`, `*.lock`, `*.log`, dotfiles), `.gitignore` respect via `ignore` npm package
- [x] 6.3 Implement `GET /file?path=…` returning `{ content, encoding, language, provenance, summary, summaryStale }`, refusing binary files and files larger than 2 MB with descriptive payloads
- [x] 6.4 Implement `GET /summary?path=…` returning summary-only payload (lighter than `/file`)
- [x] 6.5 Implement `POST /file/regenerate-summary?path=…` accepting `{ overrideBudget?: boolean }`, returning HTTP 202 with `{ enqueued: true }`
- [x] 6.6 Implement `GET /provenance?ticketId=…` returning rows ordered by `at DESC`
- [x] 6.7 Path traversal guard: reject any `path` parameter that escapes the project root after normalisation
- [x] 6.8 Unit + integration tests: feature-flag 404, pagination cursor stability, binary refusal, oversize refusal, traversal guard, regenerate-with-override

## 7. Client: lazy Monaco wiring

- [x] 7.1 Add `monaco-editor` to `client/package.json` and `client/package-lock.json`
- [x] 7.2 Configure `MonacoEnvironment.getWorkerUrl` in `client/src/features/code/lib/monaco-setup.ts` without Vite plugin, importing `editor.worker?worker`-style worker URLs explicitly
- [x] 7.3 Create `client/src/features/code/components/code-explorer/CodeViewerMonaco.tsx` as a lazy-loaded component using `React.lazy` + dynamic `import()` of `monaco-editor/esm/vs/editor/edcore.main`
- [x] 7.4 Add a "Cargando editor…" skeleton displayed during the suspense fallback
- [x] 7.5 Configure Monaco read-only mode, theme bound to `useActiveTheme()`, line numbers on, minimap off
- [x] 7.6 Confirm that with the feature flag off, Monaco is not in the main route chunk (verify via `vite build --report` in CI step or local check)

## 8. Client: file tree component

- [x] 8.1 Create `client/src/features/code/components/code-explorer/FileTree.tsx` with virtualisation (use `@tanstack/react-virtual` or existing virtualisation primitive)
- [x] 8.2 Implement filter toggle "Tocado por IA" (default) ⇄ "All files"
- [x] 8.3 Render provenance chips per row with the creating ticket visually distinct from modifying tickets
- [x] 8.4 Wire chip clicks to `TicketDetailModalProvider.open(ticketId)`
- [x] 8.5 Implement fetch with `getApiBase()` + `useProjectCache` stale-while-revalidate
- [x] 8.6 Empty-state copy explaining no AI-touched files yet, with switch CTA to "All files"
- [x] 8.7 Tests: filter switch, badge rendering, virtualised render stability, project-switch no-flicker, modal open on chip click

## 9. Client: file viewer with summary header

- [x] 9.1 Create `client/src/features/code/components/code-explorer/FileViewer.tsx` orchestrating header + Monaco
- [x] 9.2 Create `client/src/features/code/components/code-explorer/SummaryHeader.tsx` rendering the summary card with ticket chips, stale flag, ↻ regenerate button, generation-timestamp humanised
- [x] 9.3 Implement "Generar resumen" CTA when no summary exists
- [x] 9.4 Wire ↻ to `POST /file/regenerate-summary`; show confirmation modal "Override budget?" when the response indicates a budget block
- [x] 9.5 Show binary-file and oversize-file empty states without loading Monaco
- [x] 9.6 Add an "Edit in external editor" secondary button that copies the absolute path to clipboard (stopgap noted in design)
- [x] 9.7 Tests: header states (no summary, fresh, stale), regenerate flow, budget override, binary and oversize empty states

## 10. Client: page, route, sidebar

- [x] 10.1 Create `client/src/features/code/pages/CodePage.tsx` composing the tree on the left and viewer on the right inside `ProjectLayout`
- [x] 10.2 Register the `/code` route in `App.tsx`, gated by `VITE_FEATURE_CODE_EXPLORER` (the route returns null/redirect when the flag is off)
- [x] 10.3 Add the **Code** sidebar entry to `ProjectLayout`, hidden when the flag is off
- [x] 10.4 Wire `useProjectRouteMemory` so `/code` is restored on project switch
- [x] 10.5 Smoke test: navigate to `/code` for a project with no provenance and confirm empty state copy + filter switch

## 11. Client: WebSocket subscriptions

- [x] 11.1 Add handlers for `file.provenance_updated`, `file.summary_updated`, `file.summary_failed`, `file.summary_skipped` in the existing WS layer
- [x] 11.2 Filter all events by `activeProjectId` via ref (not stale closure), per existing convention
- [x] 11.3 On `file.provenance_updated`: invalidate the tree row's cached badges and trigger a soft re-render within 500 ms
- [x] 11.4 On `file.summary_updated`: if the file is currently open, re-render the summary header
- [x] 11.5 On `file.summary_failed`: show a sonner error toast with the reason
- [x] 11.6 Tests: per-project isolation (events for other project must not affect active project state)

## 12. TicketDetailModal: files-touched section

- [x] 12.1 Add a "Files touched by this ticket" section to `client/src/features/specs/components/TicketDetailModal.tsx`
- [x] 12.2 Fetch from `GET /provenance?ticketId=…` lazily on modal open
- [x] 12.3 Render rows with path + kind (created/modified); hide the entire section when the list is empty
- [x] 12.4 Wire row click to navigate to `/code` and open the file in the viewer; close the modal
- [x] 12.5 Tests: presence/absence of the section, click navigation behaviour

## 13. `.gitignore` integration and orphan paths

- [x] 13.1 On first write to `<project>/.specrails/file-summaries/`, append `.specrails/file-summaries/` to the project `.gitignore` (idempotent, only when absent)
- [x] 13.2 Document opt-out in `CLAUDE.md` (commit the summaries to share with team)
- [x] 13.3 Confirm `.specrails/file-summaries/**` is in the hub-managed reserved-paths list

## 14. Cleanup and analytics integration

- [x] 14.1 Confirm `ai_invocations` rows with `surface='file-summary'` appear correctly in `/analytics` Hero, By Surface, By Model, Daily Timeline blocks
- [x] 14.2 Confirm the surface colour mapping in `AnalyticsPage` includes `file-summary` (use one of the existing semantic accent tokens — recommend `accent-warning`)
- [x] 14.3 Confirm `spending.invalidated` debounce on the analytics dashboard already covers the new surface

## 15. Tauri packaging and Windows smoke test

- [x] 15.1 Verify Monaco web workers load correctly in the Tauri webview on macOS
- [x] 15.2 Verify Monaco web workers load correctly in the Tauri webview on Windows 11 (the open question from design)
- [x] 15.3 Add a CI build-size guard for the lazy-loaded Code chunk (reject if > 5 MB)

## 16. Coverage and CI

- [x] 16.1 Achieve ≥ 80% server lines/functions/statements for `file-provenance.ts`, `file-summary-manager.ts`, `code-explorer-router.ts`
- [x] 16.2 Achieve ≥ 80% client lines/statements for `FileTree.tsx`, `FileViewer.tsx`, `SummaryHeader.tsx`, `CodePage.tsx`
- [x] 16.3 Document the Monaco exclusion in `client/vitest.config.ts` with the inline reason ("dynamically loaded, not testable in jsdom")
- [x] 16.4 Run `npm run typecheck && npm test && npm run test:coverage && (cd client && npm run test:coverage)` and confirm all thresholds pass locally before pushing

## 17. Documentation

- [x] 17.1 Add a "Code explorer" section to `CLAUDE.md` describing flags, paths, settings, REST surface, WS events, and the v1 read-only constraint
- [x] 17.2 Add release-notes copy for the feature: target audience (non-devs), what it does, what it does not do
- [x] 17.3 Cross-reference from the "Project spending analytics" section the new `surface='file-summary'`
