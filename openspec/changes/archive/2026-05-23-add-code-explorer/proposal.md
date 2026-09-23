## Why

Non-developer users of specrails-hub (PMs, designers, domain experts) currently have no way to make sense of the code that the AI rails generate on their behalf. They can see jobs succeed in the dashboard, but the actual files produced are opaque — they cannot tell which ticket created `LoginForm.tsx`, which subsequent specs modified it, or what the file actually does in human terms. This gap forces every code-comprehension question to flow through a real developer, breaking the promise of specrails as an end-to-end spec-driven product. A read-first **Code** section that pairs each source file with its ticket provenance and an AI-generated, plain-language summary turns the generated codebase into a navigable artifact instead of a black box.

## What Changes

- Add a new **Code** entry to the project's left sidebar (under `ProjectLayout`), rendering at route `/code` and gated by `VITE_FEATURE_CODE_EXPLORER` (client) and `SPECRAILS_CODE_EXPLORER !== 'false'` (server).
- Track file ⇄ ticket provenance: a new per-project table `file_provenance` records which tickets created and modified each file, populated by `QueueManager` at job-completion time from the git diff of the job.
- Generate and persist AI-written summaries per source file: a new server module `FileSummaryManager` spawns a low-cost model (Haiku 4.5 by default) on every AI-driven file change, with hash-gated invalidation so unchanged files never re-spend tokens. Summaries persist under `<project>/.specrails/file-summaries/<sha256-of-path>.json`.
- Render a virtualized file tree on the left, with chip badges showing the tickets that created/modified each file, plus filters "Tocado por IA" (default ON) and "Por spec".
- Render a Monaco-based read-only file viewer on the right with a prominent AI Summary header card above the code, including the originating ticket, the list of tickets that modified the file, a "Stale" flag when the persisted file hash differs from the current content, and a manual ↻ regenerate button.
- Wire summary regenerations through the existing `ai_invocations` table with `surface='file-summary'` so cost is visible in `/analytics`, and broadcast `file.summary_updated` / `file.provenance_updated` WebSocket events scoped by `projectId`.
- Add a hub-wide setting `summary_language` (default: project locale or `en`) and a hub-wide monthly budget cap for summary generation, both surfaced in `GlobalSettingsPage`.
- Out of scope for v1 (deferred): in-app editing of files, per-symbol/per-function summaries, narrative diff view, conversational "ask the AI about this file", directory-level summaries.

## Capabilities

### New Capabilities
- `code-explorer`: The Code section's user-facing behavior — sidebar entry, file tree with provenance badges, read-only viewer with the AI summary header, filters, navigation between tickets and files, feature-flag gating.
- `file-provenance`: Per-project tracking of which tickets created and modified each file, populated from job-completion git diffs, exposed via REST and WebSocket, queried by both the Code section and (future) analytics surfaces.
- `file-summaries`: Server-side generation, persistence, hash-gated invalidation, budget capping, and broadcast of AI-written plain-language file summaries; integration with `ai_invocations` for cost tracking.

### Modified Capabilities
<!-- None — all behaviour added here is net-new. The hook into QueueManager to compute diffs is an additive callback in the existing job-completion path and does not change the requirements of any current capability. -->

## Impact

- **Server**: new modules `server/modules/code/runtime/file-provenance.ts` and `server/modules/code/runtime/file-summary-manager.ts`; new router `server/modules/code/runtime/code-explorer-router.ts` mounted under `/api/projects/:projectId/code`; additive hook in `server/modules/execution/runtime/queue-manager.ts` post-job-completion to compute and persist provenance + enqueue summary regeneration; new migrations adding `file_provenance` table to the per-project SQLite; extension of `ai_invocations` `surface` enum to include `'file-summary'`.
- **Client**: new page `client/src/features/code/pages/CodePage.tsx`, components under `client/src/components/code-explorer/` (file tree, viewer, summary header, badges, filters), new route in `App.tsx`, new sidebar entry in `ProjectLayout`, integration with the existing `TicketDetailModalProvider`. Monaco editor added as a lazy-loaded dependency.
- **Filesystem (per project)**: `<project>/.specrails/file-summaries/*.json` (hub-owned, additive — does not conflict with specrails-core reserved paths or with user files). Added to project `.gitignore` on first write (opt-out via setting).
- **Dependencies**: add `monaco-editor` to `client/`; add `ignore` (or reuse existing) for `.gitignore` parsing in the tree walker; reuse `chokidar` already in the server for hash-based stale detection on user edits.
- **WebSocket**: two new project-scoped event types `file.provenance_updated` and `file.summary_updated`; consistent with existing `projectId`-scoped routing.
- **Settings**: two new hub-wide settings in `hub_settings`: `summary_language` (string) and `summary_monthly_budget_usd` (numeric). Defaults preserve current behaviour when feature flag is off.
- **Bundle size**: Monaco adds ~3 MB minified. Lazy-loaded behind the feature flag — when `VITE_FEATURE_CODE_EXPLORER` is false (default in v1 staging), Monaco is not in the main chunk.
- **Coverage**: new code paths must satisfy the project's coverage gates (80% server lines/functions/statements, 80% client lines/statements). New tests required for `file-provenance`, `file-summary-manager`, the router, and the client tree + viewer components.
