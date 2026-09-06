## Why

A supplied Implement run for one shared Front/Back spec reached verification after Claude's architect was terminated with its design task still running. Missing OpenSpec skill registration delayed the architect, and the repair prompt then treated a missing implementation as if only existing test failures needed fixing. Baseline tests passing must never substitute for delivering the requested feature.

## What Changes

- Keep managed Claude execution alive when a turn returns with outstanding delegated work; continue with an explicit foreground wait instruction, preserve task output, and respect Stop, cancellation, provider limits, and bounded recovery.
- Register the OpenSpec commands required by Specrails agents explicitly for each managed Claude session from packaged official assets, independent of the user's global plugin enablement and without installing files into the implementation repositories.
- Make implementation verification check the requested acceptance criteria and all selected repositories as well as the project's actual test, lint, type-check, and build commands.
- Make repair instructions distinguish missing or incomplete implementation from failing checks and unresolved human decisions, and require fresh verification after repairs.
- Add deterministic regression coverage and an evidence record for the supplied failure chain without invoking paid models or modifying the reported application repositories.

## Capabilities

### New Capabilities

- `claude-managed-skills`: Session-scoped availability of the official OpenSpec skills required by managed Claude implementation and lifecycle steps.

### Modified Capabilities

- `loop-execution`: Outstanding delegated Claude tasks cannot be discarded by an automatic successful step finalization; managed continuation is bounded and preserves terminal controls.
- `factory-loops`: Verification and repair reason about actual implementation completeness and repository scope, including a clean baseline with no requested implementation.

## Impact

- Server-side interactive job session settlement and its Claude event/task bookkeeping.
- Claude spawn preparation, packaged OpenSpec assets, and provider argument regression tests.
- Shared loop command catalog, factory loop goals, OpenSpec lifecycle template goals, and their tests.
- No public API or database migration is required. Existing repository isolation and app-owned Git delivery remain authoritative.
