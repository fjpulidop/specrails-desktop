## 1. Membership and shared specs

- [x] 1.1 Add desktop membership migration, stable primary backfill and strict repository helpers.
- [x] 1.2 Implement atomic project creation and membership CRUD with canonical path validation and reference guards.
- [x] 1.3 Resolve project paths across members and refresh live project contexts without replacing shared stores.
- [x] 1.4 Validate and preserve spec repository selections across ticket, draft, prompt and Jira workflows.

## 2. Project and spec interface

- [x] 2.1 Extend client project contracts and project creation to accept several roots.
- [x] 2.2 Add repository management to existing project settings with useful validation feedback.
- [x] 2.3 Add repository scope selection to shared spec authoring and editing.
- [x] 2.4 Add an explicit repository target to custom shell node configuration.

## 3. Mission context and code exploration

- [x] 3.1 Expose repository inventories and strict scoped operations through MCP and mission context.
- [x] 3.2 Add repository-aware code and Git routes with invalidation on membership changes.
- [x] 3.3 Namespace provenance and summary caches by repository while retaining project budgets and legacy primary data.
- [x] 3.4 Add a repository picker to code exploration and preserve repository identity in references and drafts.

## 4. Coordinated implementation

- [x] 4.1 Persist immutable execution manifests and grouped delivery metadata in migration 59.
- [x] 4.2 Prepare all selected worktrees before one coordinated provider execution and clean up failed preparation safely.
- [x] 4.3 Apply frozen write roots, repository context, progress detection and explicit shell routing to all loop types.
- [x] 4.4 Wire board, mission, batch and standalone launches to validated repository scope.
- [x] 4.5 Canonicalize repository locks across linked worktrees and shared project memberships.

## 5. Grouped delivery

- [x] 5.1 Compose guarded per-repository delivery decisions with durable partial success and retry.
- [x] 5.2 Defer ticket, Jira and milestone completion until all required repository outcomes are accepted.
- [x] 5.3 Expose grouped snapshots and repository-specific review and delivery controls in mission and board cards.
- [x] 5.4 Preserve recovery, checkout and cleanup ownership across interruption and restart.

## 6. Integration and verification

- [x] 6.1 Register project migrations 59 and 60 and verify legacy database compatibility.
- [x] 6.2 Cover membership, shared backlog, scoped code identity and mission reference regressions.
- [x] 6.3 Exercise real temporary multi-repository Git execution, failed preparation, partial delivery and retry.
- [x] 6.4 Verify single-repository regressions, configured coverage, type checks and builds.
- [x] 6.5 Smoke-test the project, spec, code and delivery interface and document the final behavior and limits.
