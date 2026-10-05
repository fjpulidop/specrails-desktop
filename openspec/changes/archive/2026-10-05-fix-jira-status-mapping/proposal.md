## Why

Explicit Jira status mappings are inconsistently interpreted: an issue already at its configured To Do state can fail with a category-only transition error, and inbound polling ignores most mappings. Historical failed transitions can also be retried after a newer status intention has replaced them, producing repeated errors or reverting newer work.

## What Changes

- Honor configured status identity (name or ID) for outbound idempotency and inbound mapping across all logical states.
- Only report explicit-target success when that status is reached; preserve valid reverse transitions and genuine workflow restrictions.
- Retain obsolete failed transitions as superseded history and prevent stale retries from changing Jira.
- Show issue identity and useful target diagnostics in pending updates, refresh counts safely across projects, and expose status-discovery failures with retry.

## Capabilities

### New Capabilities
- `jira-status-sync`: Consistent configured status identity, safe outbox recovery and actionable connector diagnostics.

### Modified Capabilities
None.

## Impact

Desktop Jira resolver, materializer, durable outbox, project Jira routes and integration UI with existing adjacent tests and localized strings. Adds an outbox terminal state and additive issue identity without changing storage schema or Core. No project-specific rules, credential changes, live Jira operations or mass retry of existing failures during development.
