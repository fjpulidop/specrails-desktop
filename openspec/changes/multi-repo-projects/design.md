## Context

`ProjectRow.path` currently identifies both the logical product and its Git checkout. Its workspace owns the shared ticket JSON, Jira configuration, settings and provider framework. Loops, code caches and delivery evidence assume one code root. The user confirmed a single backlog whose specs can span several repositories, including adding members to existing projects.

## Goals / Non-Goals

**Goals:** create and manage multi-repository projects, preserve existing projects, expose all members to missions/MCP, implement a spec in coordinated isolated checkouts, and review/deliver the complete change with durable partial outcomes. Built-in Implement, Batch Implement, Freestyle, SDD Quick and custom loops consume the same scope contract.

**Non-Goals:** cloning remote repositories, merging existing backlogs automatically, atomic Git merges across independent repositories, changing Core's registry schema, or granting the provider write access to every project member merely to explore it. Additional non-Git folders provide context; isolated multi-repository delivery targets Git repositories.

## Decisions

### Project identity and membership

Keep project ID, slug, primary `path`, workspace, database and integration configuration stable. Desktop migration 26 adds `project_repositories`; each project receives a deterministic primary membership `primary-${project.id}`. Memberships have `{id, projectId, name, path, isPrimary, kind, integrationBranch, addedAt}`. `kind` is `git` or `folder`; `integrationBranch` is nullable. `ProjectRow.repositories` and `primaryRepositoryId` are additive, optional in compatibility types but populated in normal responses. Shared helpers provide a legacy primary fallback.

Canonicalize paths and identify the Git common directory when validating membership and taking Git locks. Reject duplicate or overlapping roots within one project. A physical repository can be a secondary member of several projects, each with its own backlog. Existing primary-path uniqueness and Core `registry.json` v1 remain intact; additional members never replace another project's workspace or ticket configuration.

Project creation accepts `repositories: [{path, name?, integrationBranch?}]` alongside the existing primary `path`. Member CRUD lives below `/api/projects/:projectId/repositories`. Editing names preserves IDs. Detachment never deletes files. Primary replacement and removal are blocked; secondary removal/relocation is blocked while referenced by active execution, pending delivery or specs. Path resolution honors explicit project context and reports ambiguous secondary membership instead of guessing.

### Shared specs and integrations

Use `Ticket.repositoryIds?: string[]`. Absence preserves the primary-only meaning of historical specs; explicit selections are nonempty, unique and belong to the project. Validate at all authoring boundaries and again at launch. Jira refreshes preserve this local field. Backlog IDs, milestones, attachments, Jira mappings and outbox transitions remain project-owned.

### Immutable execution scope

`RunExecutionManifest` contains `version: 1`, `groupId`, `projectId`, `primaryRepositoryId`, `artifactRepositoryId`, `selectedRepositoryIds` and repository snapshots. Each snapshot records repository ID/name, source path, canonical Git common directory, base branch/SHA, local integration branch, worktree path/branch and ledger ID. Persist it before invoking a provider. Adding a project member later does not expand a running process's scope.

Resolve launch scope from the union of the specs' selections. An explicit validated launch selection may expand that union but cannot omit a required member; changing targets requires editing the shared spec first. Prepare every required worktree before starting the coordinator. On allocation failure, release only the resources allocated by that attempt and start no provider. A spec/batch receives one coordinated implementation context with every selected worktree, not independent copies of its full implementation in each repository. Provider write roots come from that manifest. The project workspace supplies the shared backlog/framework; the primary owns OpenSpec artifacts when selected; otherwise the first selected Git repository owns them, so an unselected primary is never granted write access.

AI and Decider prompts include a compact repository map and frozen paths. Progress fingerprints cover all selected code roots. Shell nodes add `repositoryId`; an omitted target remains compatible in single-repository runs and is rejected as ambiguous before a multi-repository launch. Shell targets must be selected write repositories. Aggregate verification must cover every affected repository and the common spec.

### Delivery composition

Reuse the existing guarded delivery engine for each repository. A public parent delivery owns hidden child `rail_pr_deliveries` rows with `parent_delivery_id`, `repository_id` and the frozen manifest. Active-delivery indexes and ordinary card lists consider public parents. Each child retains its own branch, base, SHA, worktree, PR and operation lease. Sequential milestone chunks resolve per-member bases from durable delivery IDs and verify their recorded heads before allocation. Their local integration branch is frozen separately from a preceding chunk branch and is preserved through revisions and partial acceptance. Execute child decisions against the frozen repository path while using the parent's shared ticket store.

Children never independently complete project tickets, invoke Jira completion or advance milestone chains. The parent aggregates their durable outcomes and applies terminal effects only when the entire required delivery satisfies the existing acceptance contract. A failed second integration retains the first result and exposes the outstanding repositories. Retry skips completed child operations. Checkout and per-repository review remain explicit; each child action includes repository identity. Git cannot supply an atomic merge across repositories, so preflight and durable partial outcomes are required.

Public snapshots add `executionManifest` and `repositoryDeliveries`; each entry carries repository ID/name/path, delivery ID, base/branch/SHA, decisions/outcomes, status detail, PR fields, worktree IDs and run IDs. Existing single-repository snapshots remain valid.

### Git identity and mutation ordering

Normalize existing `withRepoLock` calls to canonical Git common-directory identity, falling back to real paths for non-Git roots. Multi-root locking deduplicates and sorts identities. Do not nest the existing non-reentrant decision lock inside a group lock. Existing recorded-SHA checks, compare-and-set leases, safe archives and checks against external Git writers remain mandatory.

### Mission, MCP and code identity

Use the field name `repositoryId` consistently in route arguments, results and reference scope. Project/context tools expose the inventory and the shared project context. MCP reads requiring a particular file or Git repository demand an explicit member in multi-repository projects; bounded find/search can discover across all members under one aggregate result budget. An unknown or foreign ID never falls back to the primary. Existing REST code/Git endpoints preserve the primary default; explicit repository routes serve newer clients.

File provenance, summary cache keys, in-flight summary work and watchers include repository identity. Keep primary historical rows readable and preserve project-level cost/concurrency budgets. Roots are resolved on each scoped request; removed members invalidate cached access. File references retain repository identity across saved mission drafts. Reading a member through MCP grants no additional provider write roots.

### Schema ownership

Desktop migration 26 belongs to membership storage. Project migration 59 is exported by the new execution store and introduces manifests/group delivery/ledger metadata. Project migration 60 handles repository-aware code/provenance/summary identity. The central numbered migration array registers both functions in order. Migrations are additive or copy existing rows transactionally under the current migration lock; no real user data is used in tests.

## Risks / Trade-offs

- Ambiguous file names or Git branches across repositories → include stable repository IDs in discovery, references, evidence and actions.
- Partial Git side effects → persist child outcomes and retry only outstanding actions; never fake rollback or completion.
- Membership changes during work → immutable manifest and reference checks on destructive membership edits.
- Shared repository used by two projects → common-directory locks plus the existing external-writer checks; independent backlogs remain independent.
- Multi-root shells with different build systems → explicit shell repository selection and per-repository verification context.
- Legacy consumers rely on one path → preserve the primary projection and additive optional fields, with dedicated migration and compatibility tests.

## Migration Plan

Backfill primary memberships without filesystem writes. Introduce repository CRUD and spec scope, then wire execution and delivery, MCP/code identity and UI. Validate temporary projects with multiple Git repositories, including shared membership, failed preparation, partial integration and restart/retry. Run existing single-project suites and the configured coverage/build checks. Rollback of binaries preserves membership/manifest data; older clients continue to use the primary projection but must not operate unfinished multi-repository deliveries without their new server support.

## Open Questions

No user decision blocks implementation. Additional behavior discovered during integration will be resolved within the contracts above and recorded here.
