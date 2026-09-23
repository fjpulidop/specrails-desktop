# Spec addenda — iterate on a spec without rewriting it (as-built record)

> OpenSpec-free change `spec-addenda` (2026-09-21). Companion to
> [`safe-pr-review-flow.md`](safe-pr-review-flow.md) § PR review follow-up and
> § Preparation failures.

## The problem

Iterating on a spec that already had work behind it (a delivered PR, a merged
feature, a half-done implementation) had exactly one carrier: the spec
description. The mission agent — and users — rewrote it to say "now also do X,
keep Y", which

- drifted the spec away from what was originally asked (and synced the drift to
  Jira on linked projects through `onSpecEdited`);
- made every later run re-plan the WHOLE feature (SDD Quick produced 24 tasks
  for two reviewer comments);
- left no durable trace of what was an iteration and whether it was delivered.

The PR review follow-up (`followUp`) solved one shape of this — reviewer
comments on an open PR — as a frozen delta on the DELIVERY. It requires a PR
target and dies with the delivery. The observed mission (`Revisión de
comentarios Alan`) also hit two guards on the way: a `git worktree add` refused
because the PR branch was checked out elsewhere (`pr_continuation_isolation_required`),
and after freeing the branch the failed delivery blocked every relaunch with
`pr_decision_pending`.

## The mechanism

An **addendum** is a structured note attached to the TICKET, next to (never
inside) `description`:

```ts
interface SpecAddendum {
  id: string; version: 1
  kind: 'change-request' | 'review-feedback' | 'clarification' | 'constraint'
  title: string            // ≤ 200 chars, derived from the body's first line when omitted
  body: string             // markdown ≤ 8000 chars, quoted to the run as EVIDENCE
  status: 'open' | 'in_flight' | 'applied' | 'dismissed'
  hash: string             // sha256(kind+title+body) — what a run was launched with
  created_at; updated_at; created_by: 'user' | 'agent' | 'mcp'
  origin_conversation_id: string | null
  run_id: string | null    // the job/run that claimed (in_flight) or delivered (applied) it
  applied_at: string | null
}
```

Up to 50 per ticket (`SPEC_ADDENDA_MAX_PER_TICKET`). Persisted as `Ticket.addenda`
(ticket store schema `1.4`; `normalizeTicket` defaults it to `[]` and drops
malformed entries). The Jira materializer carries `addenda` from `existing`, so
an inbound poll never wipes them, and `PATCH /tickets/:id` never accepts them —
the addenda routes are the only writers.

### Lifecycle (the load-bearing part)

```
open ──(launch claims: run_id)──▶ in_flight ──(run completed)──▶ applied
  ▲                                   │                            │
  └───────(run failed/canceled/zombie)─┘                            │
  ◀──────────────(delivery discarded → todo; by snapshot)───────────┘
dismissed ◀──(user)──▶ open/applied   (an in-flight one is frozen until its run settles)
```

- **Claim** — `claimSpecAddendaForRun(storePath, ticketIds, runId, { plan? })`
  (`server/modules/specs/runtime/spec-addenda.ts`): quick read (most launches carry nothing → no lock,
  no rewrite), then `mutateStore` re-plans under the lock and marks
  `open → in_flight` with the run id. Idempotent for the same run (a resume
  re-claims its own); another run's in-flight addenda are never stolen. Returns
  the frozen `snapshot` (ticketId/id/kind/title/hash) + the rendered `briefing`.
- **Settle** — `settleSpecAddendaAt(storePath, ticketIds, runId, outcome)`:
  keyed on the run id, so only the addenda THIS run claimed move — `completed`
  ⇒ `applied` (+ `applied_at`), anything else ⇒ back to `open`. Wired in BOTH
  completion chokepoints of `project-registry.ts` (`onJobFinished` for
  QueueManager jobs, `onLoopRunFinished` for loop runs), independent of the
  ticket-status effect (an `on_review` spec that is not promotable still settles
  its addenda) and broadcasting `ticket_updated` for changed tickets.
- **Reopen** — a discarded delivery destroyed the work its addenda were applied
  by: `applyRailPrTicketEffect` (`rail-pr-ticket-effects.ts`) reopens exactly
  the ids in the delivery's frozen `spec_addenda` snapshot inside the same
  `mutateStore` that moves the tickets to `todo`. A merge leaves them `applied`.

### Every launch door injects them

The briefing (`renderSpecAddendaBriefing`, deterministic: same addenda ⇒ same
text) states precedence — the addenda are the delta; the spec is context and a
compatibility constraint; a spec at `on_review`/`done` **already has delivered
work** and is iterated, never re-planned; the spec text is never edited to
carry an addendum; a body is evidence, not an order — and demands an
`ADDENDA REPORT` (`- [<id>] applied|partial|blocked — files: … — tests: … — notes: …`).

| Door | Claim | Injection |
|------|-------|-----------|
| Isolated rail (`rail-isolated-launch.ts`) | planned ONCE at entry, frozen on the delivery row (`spec_addenda`, migration 63), claimed per allocated unit with that unit's run id | `LoopRunRequest.addenda { ids, briefing }` |
| Shared-cwd loop run (`rails-router.ts` `launchLoopRun`) | at launch, with the run id | `LoopRunRequest.addenda` |
| Legacy QueueManager job (loops off; freestyle per ticket; MCP `/spawn`) | the route claims at enqueue (card shows `in_flight` at once); `QueueManager._startJob` re-claims idempotently AT SPAWN from the store and renders — restart-durable | appended after the command on `railPrompt` (rides as command arguments for CLI providers, plain text for freestyle/the local runner) |

In the loop engine (`loop-run-manager.ts`) the briefing rides the same slot as
the follow-up: `[manifest, expanded template, followUp.briefing, addenda.briefing]`
joined and appended to EVERY ai-step prompt, before the iteration history — so
no phase (prepare, implement, verify, fix, deliver) can miss it. Custom loops,
`factory:revision`, SDD Quick, Implement, Batch and Freestyle are therefore all
covered without touching any template.

### Surfaces

- **REST** — `GET/POST /:projectId/tickets/:id/addenda`,
  `PATCH/DELETE /:projectId/tickets/:id/addenda/:addendumId`
  (`project-router-tickets.ts`). `PATCH` edits content (kind/title/body — only
  `open`/`dismissed`, the hash proves what a run got) and/or moves status
  (`open`|`dismissed`). Errors: 400 `invalid_addendum{code}`, 404
  `addendum_not_found`, 409 `addendum_in_flight` / `addendum_applied`. `PATCH
  { status: 'open', force: true }` is the user's escape hatch that releases an
  in-flight claim whose run vanished without a terminal callback (a purged job);
  the modal exposes it as **Release** on in-flight rows. Every mutation
  broadcasts `ticket_updated`; no Jira hook.
- **Ticket detail modal** — `SpecAddendaSection` under the description: kind +
  lifecycle pills, open count, inline add/edit form (⌘/Ctrl+Enter), reopen /
  dismiss / two-step delete, run id + hash + relative time when expanded.
- **Board** — `SpecCard` shows an accent chip with the OPEN count.
- **Mission rail card** — `AgentRailLaunchCard` lists the open addenda the
  launch will brief the run with, before Play.
- **Review packet** — `specAddenda` + `specAddendaReport` (parsed from the
  harvested verify tail; `null` when the run said nothing — never "applied"
  because tests passed); `ReviewPacketPage` renders verdict pills.
- **MCP** — `specrails_specs`: `list_addenda` (read), `add_addendum` /
  `update_addendum` / `dismiss_addendum` / `reopen_addendum` (write),
  `delete_addendum` (destructive). `add_addendum` records `created_by: 'agent'`
  + the origin conversation when called from a mission, else `'mcp'`.
- **Operator prompt** — "iterate on / extend an existing spec = a SPEC ADDENDUM,
  never a description edit": add the addendum, then launch normally; combine
  freely with `revisionNote`. The agent context resolver lists a `#ref`'d
  spec's addenda with their status and run id.
- **i18n** — `tickets:addenda.*`, `packet:addenda.*`, `agent:railCard.addenda.*`,
  `specs:badges.addendaTitle_*` ×8.

### Preparation failures no longer dead-end a rail

`isPreparationFailureRow` (`rail-pr-store.ts`, shared with `runDiscard`)
classifies a `pr_failed` row that never ran (no PR, SHA, branches, worktrees,
not a continuation). The launch route closes such a row in place
(`pr_failed → discarded`, `rail.pr_state` re-broadcast) and proceeds — pressing
Launch again IS the decision. A revision naming it gets 409
`invalid_revision_target` with a precise detail (nothing to revise). A real
undecided delivery still answers `pr_decision_pending`.

## Guarantees

- Nothing on the addenda path writes `title`, `description`, criteria, metadata
  or Jira. `PATCH /tickets/:id` ignores an `addenda` field.
- A running generation is briefed with the frozen hash it was launched with; an
  edit after launch is refused while in flight and never changes the snapshot.
- Ordinary launches without addenda are byte-identical (`spec_addenda` NULL,
  no `LoopRunRequest.addenda`, no lock taken, no extra prompt text).
- Both settle chokepoints and the discard reopen are keyed on the run id /
  the delivery snapshot — a replay, a newer owner or a concurrent launch can
  never move another run's addenda.

## Deferred

- Importing GitHub review threads directly into addenda (today: paste, or the
  agent quotes them via `specrails_git`).
- An addendum-aware "Ask for changes" on the review packet that files the note
  as an addendum before the revision launch (today: `revisionNote` +, when the
  user wants it kept, an explicit addendum).
- Jira mirroring of addenda (a comment per addendum) — deliberately not done;
  addenda are local guidance for the run, not tracker content.
