## Why

A product often spans several repositories, but Specrails currently equates one project with one filesystem root. Users must split their backlog or ask the mission agent to navigate unrelated project registrations, and a single spec cannot reliably coordinate implementation and delivery across those repositories.

## What Changes

- Introduce stable repository memberships within a logical project. Support multiple folders at project creation and adding, editing or detaching members later while preserving existing project IDs, history, settings and primary paths.
- Keep one shared backlog, Jira integration, ticket store and mission context per project. Specs select affected repositories and retain that selection across editing and Jira refreshes.
- Expose repository identity throughout mission context, MCP, code exploration and Git operations. The agent can discover the complete project and target a particular member without registering another project or guessing a path.
- Freeze repository scope in execution manifests. Prepare isolated worktrees for all selected repositories before invoking a provider and carry their paths, base commits and verification context through built-in and custom loops.
- Present grouped delivery with per-repository evidence and actions, durable partial outcomes and retryable integration. A spec is complete only after all required repository deliveries are accepted.
- Preserve existing single-repository behavior and treat additional non-Git folders as explicit context rather than silently offering isolated Git delivery for them.

## Capabilities

### New Capabilities

- `project-repositories`: Stable project membership, additive migration, repository management and filesystem identity.
- `spec-repository-scope`: Shared backlog and explicit repository targets preserved through authoring and integrations.
- `multi-repo-execution`: Frozen execution scope, coordinated worktrees, provider access, verification and grouped delivery.

### Modified Capabilities

- `code-explorer`: Repository-scoped file identity, caches, summaries and project-wide discovery through the UI and MCP.
- `loop-execution`: Repository-aware execution context and explicit shell targets for multi-repository runs.

## Impact

Desktop SQLite and project registry; project CRUD and resolution APIs; local ticket/Jira serialization; mission prompts and MCP façades; code provenance and summary identity; provider working directories and access arguments; loop execution and rail/worktree delivery; project creation/settings, spec scope, Code Explorer and delivery cards. Existing endpoints and primary-path defaults remain compatible. New behavior is additive and requires no external account, remote cloning service or new subscription.
