# Verification

The provided errors identify category-only transition failures, but do not expose
the user's exact status map or workflow permissions. Regressions reproduce the
confirmed defects using synthetic workflows and isolated databases; no live Jira
issues, credentials or the user's queued operations were accessed or changed.

## Behavior

- Explicit To Do outside the default category and status-ID no-op, including
  repeated inbound polls after pending-write protection ends.
- All five inbound mappings, review precedence and deterministic ambiguity.
- Intermediate destinations never count as reaching an explicit target; valid
  reverse transitions remain supported and unknown categories remain unknown.
- An unrelated transition whose ID equals the configured status ID cannot be
  applied, even when the configured destination is unavailable.
- No-path errors retain current/target/available status context inside the
  existing 500-character storage budget, with explicit omitted-destination counts.
- Superseded history preserves payload, error and attempts. Tests cover different
  issues/databases, old retries after later completion, failed requests with a
  newer intention queued in flight, normal FIFO and independent comments/updates.
- UI tests cover actionable issue links and targets, fresh counts after recovery,
  project-filtered WebSocket events, late responses after project switches,
  discovery retry, update labels and superseded history without retry controls.

## Checks

- `npx vitest run server/jira server/jira-router.test.ts server/modules/architecture.test.ts --maxWorkers=4`: **851 tests pass, 20 files**.
- Integrations plus PluginsPage client suites: **73 tests pass, 11 files**; the
  seven panel tests also pass after the final localized empty-state wording.
- `npm run typecheck`: pass.
- `npm run build`: pass.
- `npm run audit:architecture`: pass; no new capability dependencies.
- `npm run docs:source-map`: updated for the private outbox panel and its test.
- `git diff --check`: pass.
- Strict OpenSpec validation: pass.

Tests first demonstrated failing mapping, recovery and UI behavior before the
production changes. The router tests require local HTTP listeners and were run
outside the filesystem sandbox after the sandbox rejected listening with EPERM.

## Limits

Real Jira workflows can forbid a transition; this implementation does not invent
edges or explore lateral states by modifying issues. Existing failures are not
mass-retried. After installation, obsolete failures are reconciled into retained
history; current failures can be retried after correcting their mapping or
workflow. Delivery is a source PR, not a published Desktop release.
