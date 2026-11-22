# inbox

Read-model behind the "Needs you" inbox (see the
[frontend feature](../../../client/src/features/inbox/README.md)). It owns no table:
every item is projected from state other capabilities already persist, one project at a time.

## Where to change behavior

| Change | Owner |
| --- | --- |
| Item vocabulary, ordering, id/version rules | [domain.ts](domain.ts) (pure) |
| Per-project source port | [ports.ts](ports.ts) |
| Collect across projects, isolate failures, cap per project | [application.ts](application.ts) |
| SQL/store reads for one project (deliveries, loop runs, Jira outbox, reached spend caps, paused milestone chains) | [adapters/project-source.ts](adapters/project-source.ts) |
| The project's mission cards that wait for the person, read from the app database | [adapters/mission-source.ts](adapters/mission-source.ts) |
| `GET /api/inbox`; `createInboxSources` (one source per project, also projected by the [live board](../live-board/README.md) so both agree) | [adapters/http.ts](adapters/http.ts), registered by [desktop-router.ts](../../desktop-router.ts) |
| Attention notification prefs (defaults, tolerant read, validated PATCH) | [attention-prefs.ts](attention-prefs.ts) (pure); `GET/PATCH /api/attention-prefs` in [desktop-router-settings.ts](../../desktop-router-settings.ts) |

## Invariants

- Project isolation: a source is bound to ONE project's database and the collector drops
  any item whose `projectId` is not its own. Nothing is cached between calls.
- Read-only. The desktop's Snooze / Done and unseen marks never reach the server; they are per viewer, keyed by
  item id and `version` (see the client README). Remote surfaces without local storage (the paired phone, MCP
  clients) share one server-side record instead (`inbox_dismissals`, [mobile-inbox.ts](../../mobile/mobile-inbox.ts)),
  keyed the same way; this read-model never filters by it.
- The attention prefs are one app-wide record (`desktop_settings` key `attention_notifications`); the server only
  stores and validates them and broadcasts `desktop.attention_prefs` on change. Whether to notify is decided by
  the client (`client/src/lib/attention`).
- A broken project or a missing table costs that source only; the others still answer.
- A run a delivery already represents (`rail_pr_deliveries.run_ids`) is left to the delivery.
- An attempt that a later attempt continued (an adopted fork, `supersededAttemptSql` in
  `loops/runtime/run-attempts.ts`) never counts on its own: the chain is one item, its latest attempt,
  with `attempt: { number, of }`. The live board and `GET /jobs` share the rule.
- A failed or blocked run (and a failed delivery, through its last run) carries the [failure diagnosis](../recovery/README.md) read from `loop_runs.failure_diagnosis`; a high-confidence provider limit or environment problem is listed as `blocked`, not `failed`, and the item `version` moves with the cause.
- A reached spend cap (daily, weekly or monthly; project or app-wide) is a `budget` item with action `raise-cap` and a structured `cap`; it leaves on its own once raised or after the reset, and an app-wide cap is listed once (under the first project).
- A delivery or run item may carry `railIndex`, and a delivery item its `decision`; the paired companion's decision remote ([docs](../../../docs/internals/companion-inbox-decisions.md), [mobile-inbox.ts](../../mobile/mobile-inbox.ts)) uses them to offer Retry and Create PR. They are hints for that surface; the desktop routes still re-validate.
- A milestone chain that stopped for the person (`milestone_launch_chains.status` `paused`, or `awaiting_approval` at a
  wave checkpoint) is a `chain` item with action `resume-chain` (the chain row's own Resume) and a structured `chain`.
  A rail-caused pause (`chunk_*`, `provider_limit`) folds its in-flight rail's failed / blocked / limit item (run or
  delivery) into the chain item, keeping that item's diagnosis; a question stays its own item.
- A mission card that waits for a decision is a `mission` item (action `open-mission`, `card`, `conversationId`): an
  undecided ```rail-launch or ```flow-offer of a mission pinned to the project with no message from the person after it,
  or a `pr-ci-offer` row about one of the project's deliveries still `offered` (newest copy per delivery). Archived and
  deleted missions and cards older than 7 days never count; a PR decision card is left to its delivery's review item.
  Mission cards are read from the app database (`createInboxSources` passes `registry.desktopDb`), filtered to the
  source's own project.
- `version` changes whenever the underlying state changes, which re-arms a dismissed item.

Run `npx vitest run server/modules/inbox`.
