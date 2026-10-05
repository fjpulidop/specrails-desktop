## Why

A registered repository can be a package inside a Git monorepo. Git creates a whole-checkout worktree, but warm dependency preparation currently treats that package as the checkout root. Registering `apps/busuu-courses` consequently links its dependencies into worktree-root `node_modules`, leaving the package without its Yarn state or installed modules and preventing verification from starting.

## What Changes

- Project dependencies from the registered source directory to its matching subdirectory in the full Git worktree.
- Reuse the checkout-relative path calculation already used by Core execution scope without changing registration, manifests or writable scope.
- Apply the same mapping to live cleanup evidence, preserving exact authentication of historical links and refusing symlinked destination ancestors.
- Cover nested registrations with real Git worktrees, package resolution, restart authentication and release regressions; document the behavior.

## Capabilities

### New Capabilities

### Modified Capabilities

- `implementation-delivery-lifecycle`: warm dependencies and cleanup evidence preserve registered subdirectory coordinates in isolated worktrees.

## Impact

Desktop's warm dependency helper and shared checkout path resolution, related tests, delivery documentation and source map. No Core protocol, dependency installation, database migration or environment setting changes.
