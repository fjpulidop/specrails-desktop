## Why

Mission launch cards hide repository assignments and only expose workspace paths. A stale agent proposal can therefore fail with `repository_scope_incomplete` without giving the user a way to inspect or repair the spec's scope in the card.

## What Changes

- Show launch repository selections, including projects with a single repository.
- Show the saved repository assignments for every selected spec and allow explicit save/cancel edits in place.
- Reconcile stale proposal scope with live specs, preserve additional launch targets, and trim workspace selections when targets are removed.
- Block incomplete or unavailable scope before launching; retain the server's authoritative admission checks.

## Capabilities

### New Capabilities
- `mission-launch-repository-scope`: Inspect and edit spec and launch repository scope from a mission launch proposal.

### Modified Capabilities

None. Existing spec persistence and repository admission contracts remain intact.

## Impact

Mission launch card, shared repository selector, translated copy for all supported languages, adjacent client tests and mission guides. Uses existing project repository GET and ticket PATCH routes; no migrations, runtime changes or new dependencies.
