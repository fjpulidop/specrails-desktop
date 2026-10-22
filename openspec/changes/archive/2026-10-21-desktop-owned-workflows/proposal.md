## Why

Implement is currently a single Desktop node wrapping a Core-owned workflow. Its agents inherit project configuration, so the loop cannot describe or control the workflow users actually run. Desktop must own composition and editable agent definitions; Core must execute independent operations with durable recovery.

## What Changes

- Expand the builtin Implement into individually editable architecture, development, verification, review, correction and archive steps. Core supplies independent operations preserving the existing quality gates; Desktop owns their edges.
- Store agent definitions, engine selections and workflow policy in each loop's published graph. The same loop uses the same agents in every project; duplication copies the entire configuration.
- Remove agent editing from project settings. Keep repository verification and infrastructure settings project-scoped. Preserve old project configuration for explicit import into a duplicated loop and retained-run recovery.
- Freeze loop configuration at admission and preserve the existing package/definition/configuration snapshots on resume.
- Apply loop-owned bindings to Freestyle, Quick SDD and custom definition loops, including deciders.
- Retain compatibility for historical graphs/runs; advertise the old Core implementation wrapper as deprecated rather than silently rewriting user-edited graphs.

## Capabilities

### New Capabilities
- `desktop-owned-workflows`: Visible workflow composition, independent Core operation execution, loop-owned agent definitions and safe migration.

### Modified Capabilities

None. The new contract supersedes project-role inheritance for loops opting into the new graph configuration; historical execution contracts remain recoverable.

## Impact

Paired branches in specrails-desktop and specrails-core. Desktop loops, runtime admission, settings UI, loop editor, publication/migration, locales and documentation. Core piece catalog, operation state/checkpoints, compatibility and package contracts. No changes to provider transports, project connection ownership, Git delivery, billing semantics or shipped database migration history.
