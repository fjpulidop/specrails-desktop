## Context

The explorer already has bounded filename/content search APIs, repository-scoped source/summary/provenance storage and a lazy Monaco reader. The UI exposes only a tree and per-file history; compact mission panels overflow, navigation races can show the wrong file, and spec links omit secondary repositories. AI explanation workers have source-hash, cancellation and evidence gaps.

## Goals / Non-Goals

**Goals:** useful read-only exploration, search across project repositories, navigable recorded activity, dependable source identity, grounded explanations and visible partial/error states in every supported language.

**Non-Goals:** a code editor/IDE, remote code search, inventing attribution for manual changes, or treating stored patches as complete worktree snapshots. Existing write APIs remain compatible.

## Decisions

1. Use Files / Search / Activity navigation and reuse existing `/find`, `/search` and project `/code/discover` bounded engines. Search results carry repository, path and line identity. Keep filename and literal content search explicit; expose limits and errors instead of pretending exhaustive results.
2. Keep source and recorded changes distinct. Add bounded activity listing from provenance with repository/run/spec identity and stored patch availability. Historical diffs remain inspectable when a current file is gone or unintegrated. Spec file links aggregate memberships and retain repository IDs.
3. Make CodePage a responsive shell: a collapsible navigation pane in narrow mission surfaces, breadcrumbs, push-based URL history on deliberate navigation and line selection. Reader controls use Monaco's read-only capabilities; no extra language-server dependency or editor workflow.
4. Each async read/generation is owned by a project/repository/path identity. Cancel obsolete reads, clear mismatched state immediately, and prevent late POST completions from launching stale GETs. Tree pagination keeps explicit failures and scan limits, and respects cancellation.
5. Summaries describe purpose, responsibilities and observable contracts using supplied source only. Keep cached schema compatibility, show model/date/truncation/freshness, snapshot actual bytes at execution and recheck freshness after completion. Provider error events cannot become successful summaries.
6. Bound summary/story work and cancel it on project disposal. Story explanations require patch evidence and disclose incomplete evidence; current ticket titles are context, not proof of historical intent. Preserve old caches and use versioned generation metadata where needed.

## Risks / Trade-offs

- Large repositories return partial results → bounded scans, explicit limits and narrower search controls.
- Stored diffs may be absent/truncated → explain availability and never synthesize missing full-file content.
- UI changes could regress mission width or keyboard use → narrow-panel and interaction tests plus browser verification.
- Legacy summaries lack metadata → render them safely and allow regeneration without deleting existing data.
- Source changes while AI runs → store the generation snapshot hash and return stale state when current bytes differ.

## Migration Plan

Deploy additive APIs and backward-compatible metadata with the client changes. Keep existing read/write routes and legacy-primary provenance behavior. Test with temporary repositories/databases and fake providers; do not incur model spend during verification. Rollback removes new presentation/API additions without deleting stored summaries or provenance.

## Open Questions

None blocking implementation. Performance and evidence bounds are surfaced in the UI rather than hidden.
