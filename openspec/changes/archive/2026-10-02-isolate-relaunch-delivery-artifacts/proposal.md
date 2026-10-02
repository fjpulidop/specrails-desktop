## Why

New launches can inherit a failed run's dirty checkout, including another OpenSpec change and provider overlay links. Automated delivery then stages unrelated planning artifacts and machine-specific links into a PR.

## What Changes

- Allocate fresh launches in distinct worktrees and branches while preserving prior work for explicit recovery.
- Reuse a branch only for a recorded delivery/PR continuation; same-run recovery preserves its original checkout.
- Reject new active OpenSpec changes and external absolute symlinks before automated delivery commits.
- Give revision/addendum changes a stable, readable, Core-compatible identity and require actual durable delivered work for revision semantics.
- Preserve overlay exclusions across provider switches independently of cleanup permissions.

## Capabilities

### New Capabilities

- `delivery-artifact-isolation`: Fresh-launch isolation, OpenSpec delivery hygiene, stable delta identities and overlay safety.

### Modified Capabilities

None. Existing recovery and delivery guarantees remain intact.

## Impact

Desktop worktree allocation, settlement, revision/addendum admission and change seeding; focused lifecycle/Git/overlay/router tests and delivery documentation. No destructive reset, automatic archival of foreign changes, schema migration or new runtime dependency.
