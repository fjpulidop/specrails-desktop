# Verification — Code Explorer observability

Verified on 2026-09-06 in branch `codex/multi-repo-projects`. Existing unrelated branch changes were preserved.

## Automated regression

- Complete server suite: 318 files, **8,020 passing tests**. Main run used a temporary home preload; the two suites that provide their own home isolation were run separately (7,997 + 23 tests). No failures.
- Final tree-snapshot hardening: four affected server suites, **112 passing tests** after adding change-between-pages, expiry/filter and current-exclusion regressions.
- Complete client suite: 377 files, **4,748 passing tests**. No failures.
- `npm run typecheck`: passed for server, CLI, MCP bridge and client.
- `npm run build`: passed for server, client and CLI. Existing large-chunk notices are non-fatal; Monaco remains lazy-loaded.
- OpenSpec strict validation and `git diff --check`: passed.
- All eight Code locale files have matching keys and interpolation variables.

Focused regressions cover late reads and generation completions, repository relocation/selection, embedded and URL history, source hash changes during queueing/generation, provider error results with exit code zero, project disposal, shared budget/concurrency, missing/truncated evidence, snapshot pagination, aborted searches, partial scans, keyboard navigation and independent viewer subscriptions.

## Browser verification

Used an isolated local fixture server rendering the actual production Code page and reader components. It used fictional repositories and responses, without reading project databases or calling AI providers. The temporary server and tab were closed afterwards.

- Wide layout: tree, source reader, summary metadata and construction history render coherently.
- Project-wide search opens the selected secondary repository and exact line; repository identity remains visible.
- Activity opens a stored patch for a deleted path, with a clear historical/partial-evidence notice.
- Compact 560-pixel mission layout gives the reader the full pane width and provides a navigation toggle. The history starts collapsed with an independent user preference.
- Verified the Spanish interface, line navigation and word wrapping. No browser console errors or warnings were recorded during the final check.
- Visual review led to reducing tree metadata width so filenames stay legible, and expanding source space in compact panes.

## Scope and evidence limits

Source reads represent the registered checkout. Stored patches are historical evidence, including changes not yet integrated; they are not complete worktree snapshots. Search/activity bounds and missing or truncated evidence remain explicit. AI quality was verified through prompt, evidence, lifecycle and fake-provider tests, not paid live generations.

Usage and API behavior: `docs/code-explorer.md`.
