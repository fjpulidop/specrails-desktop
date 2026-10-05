## Context

Jira has arbitrary workflow statuses grouped into three categories. Desktop's explicit map accepts status names or IDs, but the outbound walker tests identity only inside the default category and the inbound materializer honors only on_review. The per-project durable outbox retains dead transitions after newer intentions and permits replaying them.

## Goals / Non-Goals

**Goals:** Respect explicit identity in both directions, preserve workflow gates, make obsolete recovery safe, and expose actionable issue-specific errors.

**Non-Goals:** Discover workflow paths by making speculative Jira changes; change the documented failed-job-to-todo policy; edit external issues or stored credentials during development; introduce project-specific mappings.

## Decisions

1. Compare configured status ID/name before category fallback. An explicit match completes without a write regardless of category. Successful walks report destination category (null if absent) and require the explicit destination, not merely an intermediate category. Status IDs must never be interpreted as transition IDs: the namespaces can collide and the public mapping contract only accepts status identity. Keep bounded category-monotonic traversal; unknown workflow edges remain blocked.
2. Apply all explicit inbound mappings. Preserve on_review precedence for existing duplicate mappings. For other ambiguous mappings, prefer the existing category-derived state when among the matches and otherwise retain category fallback instead of guessing. Unconfigured behavior remains unchanged.
3. Use a distinct terminal outbox state, superseded, for obsolete failed status intentions. Reconcile historical dead transitions against later transition intentions for the same issue and prevent manual replay. Preserve rows as history; never conflate superseded with applied. Normal pending/inflight FIFO, independent comments/edits, retries and project isolation stay intact. Guard legacy old retries when a newer status transition is already done.
4. Add issue identity to outbox responses without secrets. Show target and bounded current/available destination diagnostics, refresh authoritative counts and protect project switches from stale responses. Discovery errors remain visible with a retry action.

## Risks / Trade-offs

- A workflow can genuinely prohibit reopening or returning to To Do → retain actionable failure and never manufacture a transition.
- Multiple logical states can intentionally map to the same status → documented deterministic ambiguity handling, keeping review precedence.
- A later failed intention still supersedes an older failed one → require a fresh user status action for an intentional rollback; never silently revive history.
- New state consumers need updating → audit all unions, count consumers, route filters and fixtures; existing SQLite state text has no CHECK constraint.

## Migration Plan

No schema rewrite: the existing outbox stores state as unconstrained text. Reconciliation is idempotent and project-local. Older clients ignore additive count and identity fields; the current UI exposes only actionable failures. Rollback must retain superseded rows as terminal history.

## Open Questions

The user's exact Jira mapping and workflow permissions remain unknown. Local regressions prove implementation defects but do not establish that every one of the 28 reported operations can be applied in Jira.
