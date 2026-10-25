# Companion inbox decisions

BB3 turns the paired companion from a monitor into a decision remote for the
[Needs-you inbox](../../server/modules/inbox/README.md). It adds no authentication
mechanism: it rides the Mobile Gateway (`/v1`, per-device bearer token bound to the
current certificate fingerprint, per-device project grant) over the same WebRTC RPC
and WebSocket bridge as the rest of the companion.

Code: [mobile-inbox.ts](../../server/mobile/mobile-inbox.ts) (routes and the pure action policy),
[mobile-ws.ts](../../server/mobile/mobile-ws.ts) (the `inbox.changed` nudge), tests in
[mobile-inbox.test.ts](../../server/mobile/mobile-inbox.test.ts). Endpoints are listed in the
[API reference](api-reference.md#companion-inbox-decisions-v1inbox-paired-devices-only).

## Safe actions

| Action | Offered when | Same use case as Desktop | Tier |
| --- | --- | --- | --- |
| Answer | `question` item (run paused for a human decision) | run "Answer" (`resume` with an answer, pinned to the pending question) | `write` |
| Resume | `resume-run` item (budget paused, interrupted), or a failed / blocked run whose primary remedy is `resume`; a run paused at its per-run cap takes Continue (`runCap: ignore`) or Raise (`runCapUsd`) | run card Resume | `ai-spawn` |
| Retry | failed / blocked item whose first remedy a phone can act on (not `open-logs` / `edit-spec`) is `retry`, with a known rail | the recovery cockpit's relaunch (`/rails/:n/relaunch`) | `ai-spawn` |
| Create draft PR | delivery `on_review` | PR decision `create-pr` | `destructive` |

The server computes the offered actions per item (`companion.actions`) so the phone never
shows what the gateway would refuse. `enabled: false` means the permission tier is off.

## Not exposed

Merge, Discard, Publish, force-push, settings, delete, raising a spend cap and Jira retry have
no companion route; `/v1/projects/:pid/inbox/<other>` answers `403 action_not_allowed_for_companion`
and the raw `pr-decision`, `loop-runs/*/cancel` and settings routes are not in the gateway allow-list
(`404`). Tests assert both.

**Discard is deliberately excluded.** Desktop's Discard closes the PR, releases the worktree and
deletes the owned branches. It has no undo and no soft state, so it cannot honour "undoable from the
phone". Adding it requires a server-side grace window in the delivery decision first.

## Isolation and failure

Every action is addressed to one project in the path; the gateway's project grant gates it, and the
desktop route re-checks that the run / delivery belongs to that project. `GET /v1/inbox` drops items
and project counts outside the grant. Retry and Create PR rely on the desktop's own stale-source and
`expectedDecision` checks, so a repeated tap is rejected rather than duplicated.
