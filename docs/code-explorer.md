# Exploring files and recorded changes

The Files workspace is a read-only way to navigate a project's repositories, understand source files and inspect the work recorded by Specrails. It is available as a full page and in the mission Files pane.

## Navigation

- **Files** starts with all eligible files. The AI-touched filter and spec/run filters remain available. The tree supports arrow keys, Home, End, Enter and Space, reveals the selected file, and retains folder preferences per repository.
- **Search** finds filenames or literal source text. Multi-repository projects can search all repositories or the selected one. Content search supports case sensitivity and a folder/file restriction. Results carry repository identity and open the matching line.
- **Activity** lists recorded changes across repositories or within the selected repository, grouped by run and spec. It includes additions, modifications and deletions. Open a record to inspect its stored patch.

The repository selector, breadcrumbs and navigation history preserve file identity. URL links use `repositoryId`, `path`, optional `line`, and optional `changeJobId` for a recorded patch. `jobId` and `ticketId` remain list filters. Embedded mission navigation keeps its own history and does not change the mission URL.

In narrow panes, opening a file gives the reader the full pane width. The navigation toggle returns to Files, Search or Activity. The mission pane can also be resized or maximized. File names take priority over metadata in the tree.

## Reading and understanding

The source reader provides syntax highlighting, line numbers, find-in-file, line navigation, word wrap, Markdown preview and path copying. It does not expose editing or saving. Legacy write endpoints are retained for compatibility.

File summaries explain purpose, responsibilities and contracts visible in the supplied source. Their metadata identifies the model, generation time, freshness and whether the source snapshot was partial. The source remains readable while a summary is absent or unavailable. Regeneration still uses the existing budget confirmation flow.

Construction stories connect interventions to their specs and runs and can explain stored patch evidence. Explanations with missing evidence are refused, incomplete evidence is disclosed, and cached explanations can be refreshed. Existing summary caches remain readable; language, prompt and evidence changes can make them stale.

## Current source and recorded evidence

**Current file** reads the registered checkout. **Recorded change** displays a patch captured during a past Specrails run. A patch can remain available after file deletion or before worktree changes have been integrated. It is not a complete worktree snapshot and cannot reconstruct omitted content.

Missing patches and truncated evidence are explicit. The diff viewer bounds rendered evidence to 2,000 lines or 256,000 characters and reports when its preview is limited. Only recorded provenance is attributed to Specrails; this view does not infer authorship for arbitrary local edits.

Specs list touched files from all member repositories. Links retain the repository ID, including when different repositories contain the same relative path.

## Reliability and limits

Reads and generation callbacks are scoped to project, repository and file. Abandoned reads are cancelled; late responses cannot replace a newer selection. Independent full-page and mission viewers have independent WebSocket subscriptions. Repeated provenance events are coalesced into bounded refreshes.

Tree and search limits are visible instead of appearing as exhaustive results. Tree pages share a snapshot (up to four snapshots per repository router, retained for two minutes); expired pages ask for a refresh instead of silently mixing different scans. Each page rechecks current path exclusions. Activity uses a stable snapshot and keyset pagination; each page rechecks project membership and path exclusions. Its defaults are 50 records per page, at most 100 requested records, and a 2,000-row/2-second scan budget. The activity UI retains at most 1,000 records. Narrow the repository or spec/run scope to continue exploring large histories.

Source discovery and activity respect excluded paths, Git ignore policy and repository boundaries. Unavailable repositories or unverifiable exclusions produce an incomplete-result state. A partial result never proves that no matching file or change exists.

Summary and story work share concurrency and spending controls. A summary stores the hash of the actual source snapshot sent to the provider and rechecks current freshness at completion. Disposing a project settles queued work and cancels running provider processes. Explicit provider errors cannot be saved as successful explanations.

## API additions

- `GET /api/projects/:projectId/code/activity`: project-wide recorded activity.
- `GET /api/projects/:projectId/repositories/:repositoryId/code/activity`: repository-scoped activity.
- Query fields: `repositoryId`, `ticketId`, `jobId`, `limit`, `cursor`.
- Response: `{ entries, nextCursor, truncated, warnings? }`. Each entry includes repository identity, path, change kind, spec/run IDs, timestamp and patch availability.

The UI also uses the existing repository `/code/find`, `/code/search` and project `/code/discover` APIs. No language server, source-editing process or new model invocation is needed to search or inspect recorded changes.
