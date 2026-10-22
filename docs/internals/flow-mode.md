# Flow mode

Flow is a mode complementary to Implement: the user builds working code with
an agent in an isolated worktree, by conversation and without a spec. When
the user decides the result is right, a rail adopts the worktree and derives
the spec (the Flow → Spec loop). Implement is for delegating; Flow is for
discovering.

This guide covers the server and the client: the Flow lifecycle, the
`factory:flow-spec` loop, the delivery settlement (spec rewrite, Jira create
and review transition) and the client (Flow bar, cards, composer, board
label). User guide: [Flow](../guide/en/integrations/8-flow-mode.md).
OpenSpec change: [`flow-mode`](../../openspec/changes/flow-mode/).

## Where each responsibility lives

| Concern | Owner |
| --- | --- |
| Lifecycle, sagas, reconciliation, routes | [Flow module](../../server/modules/flow/README.md) (hexagonal, like project settings) |
| Worktree machinery | delivery: `prepareIsolatedWorktree` (reservation), `launchIsolatedRail` with `requiredFlowWorktree` (adoption) |
| Flow turn (cwd, persona, permissions, interrupt) | missions, through the injected `FlowTurnContext` port |
| Interrupting a running turn | Core sessions (`session.send { delivery: 'interrupt' }`) |
| Placeholder spec | specs ticket store (`source: 'flow'`, schema 1.5) |
| Accounting | `agent_invocations.surface = 'flow'` |

Core is the engine and Desktop the product: Desktop never branches by
provider for Flow. Flow turns run only on Core agent sessions; there is no
legacy transport.

## Capability gating

`GET /api/projects/:id/flow/availability` is the client's switch. Flow is
available only when Core sessions are usable and the selected Core runtime
advertises `flowSessions` (interrupt delivery, Core PR #435) and
`deriveChange` (the derive-change node). Starting also requires a session
host whose `initialize.capabilities.flowSessions` is 1 and a Core session
driver for the mission's provider. Otherwise the routes answer
`409 feature_unavailable` with the missing capabilities and nothing changes
for missions. The anti-corruption layer (`agent-sessions/domain/protocol.ts`)
reads the new `deliveries`/`capabilities` contract fields additively;
`checkSessionContract` stays compatible with older Cores.

## Lifecycle

```
          start          pause            hand-off          delivered
(none) ─────────► active ◄─────► paused ───────────► handed_off ─────────► delivered
                    │  resume      ▲                  │
                    │ discard      │ returned         │ launch failed
                    ▼              │ (Back to Flow)   ▼
                discarded          └──────────────  paused
```

`needs-review` is set only by startup reconciliation, when the Flow's
worktree disappeared. The state machine (`flow/domain.ts`) is pure; it returns
effects that the use cases execute through ports.

### Start (saga)

1. Insert the `flow_sessions` row (`active`, step `start:ticket`). The partial
   unique index allows one active/paused Flow per conversation.
2. Create the placeholder spec through the non-promoting path:
   `status: in_progress`, `source: 'flow'`, title and description from the
   idea, `metadata.flow = { conversationId, flowId, worktreeId, startedAt,
   state: 'active', chosenMode: 'flow' }`.
3. Reserve the worktree with `prepareIsolatedWorktree` (branch from the
   ticket; mount `~/.specrails/projects/<slug>/worktrees/<flowId>/ticket-<id>`).
   `flow_sessions` owns it; `rail_worktrees` does not see it.
4. Record the Core session id `flow:<flowId>`. The Core session opens lazily
   on the first Flow turn, with the worktree as cwd.

A failure compensates in reverse order (release the worktree, delete the
spec) and marks the Flow `discarded`; when compensation itself fails the row
stays `needs-review`.

### Turns

While the Flow is `active`, `FlowTurnContext.forConversation` returns
`{ cwd, coreSessionId, systemPrompt, policy }` and the mission turn becomes a
Flow turn:

- its own Core session `flow:<flowId>` (cwd is fixed at open, so the
  mission's session stays intact and resumes after the Flow);
- `permissions: 'bypass'`, `tools: { mode: 'default' }` (see
  [Permissions](#permissions)), the same Specrails MCP the mission presents;
- sub-agents follow the mission's project policy: "Allow sub-agents" off (the
  default) keeps them disabled; on, the session runs them natively or, with
  "Run sub-agents with" another provider, Core-delegated
  (`resolveSubagentRuntime`). Native sub-agents run inside the provider
  process (the worktree cwd); Core opens delegated children with the parent
  session's cwd and permissions (`DelegationCoordinator.delegate`), so they
  also write only in the worktree. The sub-agent tools of `specrails_mission`
  act on the Flow session while a Flow turn ran last. When enabled, the static
  `FLOW_SUBAGENTS_ADDENDUM` (plus the delegation guidance when delegated) is
  appended to the persona: split truly independent work, then integrate and
  verify it. The Flow session has its own projection and bills `flow` (see
  [agent sessions](agent-sessions.md));
- the static Flow persona ([agent-flow-prompt.ts](../../server/modules/missions/runtime/agent-flow-prompt.ts))
  as the session `systemPrompt`, never a file in the worktree; per-turn facts
  (worktree path, branch) ride the user turn. Its **Choices** rule ends every
  reply that offers a choice with the mission's fenced `options` block (2-6
  short, actionable labels; never otherwise), rendered as chips;
- the conversation history is sent once, on the first turn of the Flow
  session; Core's journal keeps the rest;
- every mid-turn input is delivered as `delivery: 'interrupt'` (the send
  route accepts `deliveryMode: 'interrupt'` only in an active Flow). Desktop
  never calls `session.interrupt` first. The runner follows the correction's
  turn and records ONE invocation with the usage of both turns;
- the provider session reference never overwrites the mission's
  `session_id`; usage is recorded with `surface: 'flow'`.

When the Flow is paused or ended the port returns null and turns are normal
read-only mission turns again.

### Permissions

A Flow session runs with the same permission level as a rail's write roles:
`FLOW_SESSION_BOUNDARY` is `permissions: 'bypass'`, which Core's drivers map
to Claude `--dangerously-skip-permissions` and Codex
`--sandbox danger-full-access`. Rails pick the same level for every provider
(Core's CLI executor); no adapter declares a narrower write-role mapping.

The previous `workspace-write` boundary mapped Claude to
`--permission-mode acceptEdits`: every shell command then waited for an
interactive approval that a headless Core session cannot get, so the agent
could not run the typecheck, the tests, an install or the app. That was the
"you can't run or preview the app while in Flow" report.

Containment is the same as a rail's, not an operating-system sandbox:

- the session cwd is the Flow worktree (fixed when the Core session opens;
  delegated sub-agents inherit it);
- the static persona forbids editing, creating or deleting anything outside
  the worktree, switching branches, rewriting history and pushing;
- the worktree has its own branch, and Flow commits and delivers only that
  worktree (hand-off freeze), so the main checkout is not involved;
- long-lived processes go through Specrails background processes (below),
  which are confined to the worktree and stopped with the Flow.

A command the agent runs can technically reach outside the worktree, as in
a rail. Normal (non-Flow) mission turns keep their read-only boundary
([read-only missions](mission-read-only-policy.md)).

### Running the app

The persona tells the agent to verify its work with its own shell
(typecheck, tests) and to run every long-lived process (dev server, watcher)
through `specrails_jobs background_start`, never from its shell. It offers it
first with the option chips **Start the app** / **Start and expose on the
local network** / **Not now**. LAN exposure follows the operator rule: the
framework's own host flag and a warning that anyone on that network can reach
the app. Once the app is listening it gives the `appUrls` (local, then
network) as links.

`background_start` resolves the conversation's ACTIVE Flow through the
project's Flow use cases (`ProjectContext.flow.getByConversation`, bound at
composition; the authenticated capability supplies the conversation). Inside
an active Flow:

- the process runs in the Flow worktree (`cwd` may only name a folder inside
  it; `repositoryId` is ignored) and carries `flowId`;
- the project's busy guard (a running job or loop) does not apply: the
  worktree is isolated from the checkout those runs use;
- the call is admitted below the Autonomous level when the user confirmed it
  (`confirmed: true` after picking a start chip). Entering Flow already
  granted write and execution in that worktree, so asking for Autonomous
  would only push the agent back to a raw shell. `background_kill` is admitted
  the same way for a process tagged with that Flow. The exception is the
  tool's `tierException` (`server/mcp/tools/types.ts`), consulted only for
  in-app agent turns; external MCP clients keep the Settings ▸ MCP tiers.
  Outside an active Flow, or without confirmation, the ladder applies as before.

The `stopProcesses` effect runs first on pause, discard and hand-off
(`FlowProcesses.stop` → `stopBackgroundProcessesForFlow`, which requests stop
and waits up to 4 s for exit) because the worktree is about to be frozen,
removed or handed to a rail. It is best effort: a failure is logged and never
blocks the user's decision. Processes never survive a restart (their history
is marked `interrupted`), so startup reconciliation needs no extra step.

### Pause, resume, discard

Pause stops the Flow's apps, closes the Core session (stopping a running
Flow turn) and labels the spec `paused`. Resume reopens it lazily (Core
resumes a closed session from its journal). Discard stops the apps, closes the
session, removes the Flow-owned worktree and branch and deletes the
placeholder spec. Discard after a hand-off is illegal.

### Hand-off

`POST /flow/:flowId/hand-off { railIndex, loopId?… }`:

1. Stop the Flow's apps and close the session; step `handoff:freeze`.
2. Commit the worktree (overlay and warm `node_modules` excluded) and record
   the frozen HEAD; step `handoff:launch`.
3. Assign the spec to the free rail and call the rails launch route over
   loopback with `flowId` (the single launch authority keeps every guard).
4. The launch passes `requiredFlowWorktree` to `launchIsolatedRail`, which
   reuses the exact mount (`reuseBranchWorktree: true`, `fresh: false`) and
   verifies path, branch and `HEAD == headSha` (else
   `FlowWorktreeMismatchError`, 409). Ownership becomes `adopted` (released
   like `created` once the rail owns it, never removed by an allocation
   rollback). The `rail_worktrees` row and `flow_sessions.state = handed_off`
   commit in one transaction; a rollback after adoption returns ownership.
5. Any failure before that commit reverts the Flow to `paused`.

See [Flow → Spec loop](#flow--spec-loop) and [Settlement](#settlement) for
what happens after the hand-off, and [Back to Flow](#back-to-flow-and-relaunch)
for a run that stopped with requested changes.

### Restart

At project startup, after rail worktree reconciliation and before admission
opens: `active` Flows become `paused` (sessions never survive a restart);
`start:ticket`/`start:worktree` are compensated; `start:session` and
`handoff:*` complete as `paused`; a missing worktree becomes `needs-review`
(nothing is deleted). Handed-off and terminal Flows are untouched.

## Flow → Spec loop

`factory:flow-spec` ([recipe](../../server/modules/loops/runtime/loop-flow-spec-recipe.ts))
is a built-in `mode: 'loop'` factory that exists only when Core advertises
`engineV2`, `workflowDefinitions` and `deriveChange: 1`. It is listed by
`GET /api/loops/factory` with `launchable: false`, is not an editable built-in
(not in `EDITABLE_BUILTIN_LOOP_IDS`, never seeded into the loop library) and
runs only from a Flow hand-off: the rails route answers `400 flow_id_required`
without `flowId` and `409 engine_unsupported` when the selected Core lacks
`deriveChange` (the run itself re-checks in `assertDefinitionSupport`).

The graph mirrors Core's reference definition (`flow-spec.json`); a parity
test compares node kinds, routing and the closed params:

```
init → derive (derive-change) ─pass→ check (verify) ─pass→ review → review-policy ─true→ archive → verify → done
         │fail                       │fail                            │false
         └→ repair-guard (1 repair)  └──→ check-findings   review-findings ←┘
                                                 └──→ correction-budget ─exhausted→ changes-requested
                                                          │ (2 rounds)
                                          begin-correction → fix (developer, fixer stance, WRITE)
                                                          → fix-progress ─no change→ changes-requested
                                                          └→ derive (the change is updated in place)
```

- Strict `openspec validate` and the archive preflight run inside the
  `derive-change` piece; its `fail` outcome is the one-visit repair loop, so
  there is no separate `openspec-validate` node. Each correction round resets
  that repair budget.
- A rejected review or a failing `check` is not a dead end. Their findings
  (`{{outputs.review.structured}}`, or the failing host verification) become
  `$vars.latestFindings` and a bounded correction round runs: `fix` is a
  `role-turn` of the built-in `developer` role with `stance: 'fixer'` (Core's
  fixer instructions, the configured fixer engine when there is one, WRITE
  access in the worktree). It fixes the named defects, adds the tests the
  review asks for (tagged `[spec:<capability>/<slug>]` for the ADDED/MODIFIED
  requirement they prove) and never expands scope or edits `openspec/`.
  `derive` then runs again with `feedback: {{run.latestFindings}}`: the
  deriver updates the existing change in place so the artifacts describe the
  code (including behaviour the review said the spec omitted). A round that
  changes nothing (`fix-progress`) or an exhausted budget
  (`FLOW_CORRECTION_ROUNDS = 2`) ends at `changes-requested`, a `failure` end
  whose reason carries the latest findings.
- Roles: `deriver` (always added for a `derive-change` node), `developer`
  (the fixer) and `reviewer`. The reviewer receives
  `{{outputs.derive.derivation}}` and treats every unexplained file as an
  issue; the policy gate is `approved == true`.
- Config: `change: 'new'`, `journal: 'ledger-only'`, `reviewerStepId: 'review'`.

Before the run, Desktop prepares the derivation inputs:

- **Change id.** Named after the spec title, never after addenda or the run:
  kebab-case, diacritics folded, at most 64 characters cut at a word
  (`flowChangeId`). A name another change holds (present at the Flow base, or
  archived) gets `-2`, `-3`…; an active change that is absent at the base is
  this Flow's own earlier derivation and is reused, so a relaunch re-derives
  it in place. No addenda "delta" briefing applies to Flow.
- **Base.** `requiredFlowWorktree.baseSha` (the Flow reservation commit)
  travels as `LoopRunRequest.flowDerivation.baseSha` and becomes
  `repositories[].baseSha` in the frozen Core context, so Core measures the
  change from the reservation, not from the frozen hand-off commit (which
  would be an empty change set).
- **Summary.** The hand-off authority builds a bounded summary of the Flow
  conversation (`buildFlowSummary`): the idea, every message the person typed
  since the Flow started (automatic briefings excluded), the first line of
  the agent's final reply to each (`↳ Agent: …`) and the persona's
  `Decision:` lines; ≤ 32 KB of UTF-8, the oldest messages (with their reply)
  dropped first, then the oldest decisions; front matter
  `transcriptTurns: <n>` counts the messages kept. Message times are SQLite
  `datetime('now')` stamps and the Flow start is ISO 8601: the window compares
  them as instants (`inFlowWindow`, the start floored to its second). Comparing
  the strings once put every message of the Flow's own day before its start
  and produced an empty summary. The executor writes the summary once,
  `0600`, to `.specrails/pipeline/<runId>/flow-summary.md`, which the node
  reads as `summaryPath`. A summary failure never blocks the hand-off: Core
  then derives from the diff alone.

## Back to Flow and Relaunch

When the run ends at `changes-requested` (or the latest review rejected, or
the latest checks fail), settlement reads the settle evidence
(`flowReviewOutcome`, delivery) and records `status_code =
review_changes_requested` with the reviewer's first issue as `statusDetail`
instead of the generic "Programmatic workflow stopped" failure. The
snapshot, the `rail.pr_state` message and the mission card envelope carry
`flowReview` (`reason` review|check, summary, ≤ 20 issues, score, failing
host checks). The mission card shows "The reviewer requested changes" with
those issues and two actions (the Flow extension's `RunCardActions` slot);
the rail strip shows a "Changes requested" pill and never offers Discard
(the Flow worktree must survive). The run-failure briefing offers the same
two actions.

- **Back to Flow** — `POST /flow/by-delivery/:deliveryId/return`. Delivery
  owns ONE transaction (`returnFlowWorktree`): it deletes the adopted
  `rail_worktrees` row, closes the delivery as `discarded` /
  `returned_to_flow` (the rail is free again) and, inside it, the Flow saves
  `handed_off → paused` (`returned`: `deliveryId` kept for idempotency,
  `railIndex` cleared). Any failure rolls both back. The worktree, its branch
  and the run's changes (the derived change included) are never touched. The
  spec goes back to in progress, "In Flow" (`reopenTicket`), the agent
  session reopens (a session that cannot open leaves the Flow paused; the
  Flow bar resumes it) and `flow_sessions.return_briefing` (migration 78)
  holds the review: the next Flow turn carries it on the USER turn (never
  the system prompt) and the Flow clears it once that turn completes
  (`briefingDelivered`); a new hand-off drops an undelivered one.
- **Relaunch** — `POST /flow/by-delivery/:deliveryId/relaunch`: the same
  return, then the ordinary hand-off (freeze, launch) on the same rail with
  the stopped launch's engine choices. The new run re-derives the existing
  change in place.

## Settlement

When the Flow's delivery reaches review, the Flow settles. Triggers:

- a `rail.pr_state` broadcast for the Flow's `deliveryId` whose decision is
  `on_review`, `pr_draft`, `pr_ready`, `completed` or `merged` with a
  succeeded implementation (`observeDelivery`);
- without a PR delivery row (PR delivery disabled), the completed run itself
  (`onRailRunCompleted`, keyed by the run id);
- at startup, `replaySettlement` settles handed-off Flows whose delivery
  reached review while the app was down and resumes pending effects; a 30 s
  scheduler retries due effects.

`onFlowDelivered` records `delivered`, labels the spec `delivered` and
enqueues three durable effects in `flow_effects` (migration 75, project
database) with keys `flow:<flowId>:rewrite-spec`, `:jira-create`,
`:jira-review`. They run in `seq` order with attempts and exponential backoff
(15 s doubling, capped at 5 min); a pending effect that is not due blocks the
ones after it, and a failure never reverts the delivery.

| Effect | Does | Gives up |
| --- | --- | --- |
| `rewrite-spec` | Reads the derived change from the delivered commit (`proposal.md`, `design.md` of the archived change, diffstat), sets `metadata.flow.state = 'delivered'`, `metadata.openspecChangeName` and status `on_review`, then rewrites the spec in place with `generateSpecFromText({ ticketId })` (current format, surface `flow`) and an awaited Contract Layer | 3 attempts → `failed`: the spec keeps its Flow draft and the packet says so |
| `jira-create` | Projects with an active Jira connection only: `enqueuePromote(ticketId, 'flow:<flowId>:create')` (durable outbox create with marker recovery) | 8 attempts; `skipped` when not connected |
| `jira-review` | Once the issue link exists: `onRailReview([ticketId], deliveryId)` → the status mapped for `on_review` | 60 polls while the outbox creates the issue; `skipped` when no issue was created |

Why a dedicated table instead of the Jira outbox or `rail_pr_ticket_effects`:
the spec rewrite is not a Jira operation, the three effects are ordered across
two systems (specs, then Jira) and keyed by the Flow rather than the delivery
decision. The Jira writes still go through the Jira outbox, so retry, marker
recovery and dead-lettering stay where they are.

Nothing reaches Jira during Flow or on discard: `isFlowHeldTicket` blocks every
create while the Flow is `active`/`paused`, and the run settlement in
`project-registry` excludes Flow-held specs from its own `onRailReview`, so a
Flow spec is never transitioned before its issue exists nor transitioned twice.

## Jira

`isFlowHeldTicket` (metadata.flow state `active` or `paused`) blocks every
Jira create: promote returns an error and a durable `create` outbox op is
retried until the Flow settles (dead-lettered after the normal attempt
limit). Unlinked tickets never receive outbound writes otherwise.

## Events and cost

`flow.state { projectId, conversationId, flowId, flow, timestamp }` is
broadcast on every committed change (and when a settlement effect finishes).
`GET /flow/:flowId/cost` sums only provider-billed Flow turns in the Flow's
lifetime (user turns, continuation turns after sub-agents and delegated
sub-agents' own spend, all recorded with surface `flow`) and reports
`unpricedTurns` separately; project spending exposes
`flowCostUsd` and `flowTurns` inside the agent-mission summary. The spec
rewrite is recorded with surface `flow`.

## Review packet

A Flow → Spec delivery adds a **Derivation** section before "What to watch
out for": coverage (`explained/files`, Core's measurement from git), the
unexplained files, requirements added/modified and the deriver's confidence
(AI-reported). It comes from the derive-change scope in `runtime status`
(`output.derivation`, or `derivation.json` at `output.derivationPath`),
harvested into the settle evidence. A missing report renders as unavailable,
never silently. The draft PR body gets one derivation line. See
[review packet](review-packet.md).

## Client

Feature [`client/src/features/flow`](../../client/src/features/flow/README.md).
Missions never import it: the composition root mounts `FlowMissionsBridge`
around the mission chat and fills the missions extension seam
([MissionExtensionsContext](../../client/src/features/missions/context/MissionExtensionsContext.tsx)):
a `flow-offer` fence card, a conversation mode (`data-flow="active"`, worktree
branch in the git strip, interrupting sends) and a dock above the composer.

| Piece | Behaviour |
| --- | --- |
| Offer | The operator classifies pre-launch work as Freestyle / SDD Quick / Implement / Flow. The user turn carries `Flow: offerable` only when `FlowTurnContext.offerable` says so (Flow available, conversation pinned, no open Flow), so the static prompts stay byte-stable. The `flow-offer` block ({idea, reason, recommended}) renders `FlowOfferCard`; fence promotion re-tags it from generic JSON on both sides. |
| Entry | `FlowEntryCard` explains the isolated worktree and starts `POST /flow`. Unavailable ⇒ disabled with the missing capabilities in plain words. A `409 repository_has_no_commits` shows a localized message and **Create initial commit** (`POST /git/initial-commit`, an empty commit); on success Start is retried. |
| Decision record | `agent_messages.intent` kinds `flow-offer` (`accepted`/`dismissed`, `recommendedMode`, `chosenMode`, `config.flowId`) and `flow-hand-off`; unique per (kind, proposalIndex). Flow kinds are accepted even with mission rail cards off. |
| Active | Surface treatment (`flow.css`, theme tokens, reduced motion), `FlowBar` (branch, files ±, provider-billed cost or `—`, View changes, Pause, Discard with confirmation, This is it). Busy sends use `deliveryMode: 'interrupt'`; a 409 `interrupt_requires_flow` is resent normally. Option chips on the newest settled reply stay clickable while the agent is busy; a pick then interrupts (idle picks send normally). |
| Preview | While an app the agent started for this Flow (a background process tagged `flowId`, from the mission's `BackgroundProcessesContext`) announces `appUrls`, `FlowAppPreview` shows **Preview** with a live dot: it opens the local address in the system browser, like the mission's app chips (Desktop has no embedded preview for mission apps). Its menu has the network address (or says the app only listens on this computer) and **Stop app**. Hidden when nothing runs and on a paused Flow. |
| Paused / needs-review | Compact bar: Resume Flow; needs-review explains the missing worktree, no destructive action. |
| This is it | Client-only: bar and treatment animate out and `FlowHandOffCard` (the rail launch card in hand-off mode: Flow spec, `factory:flow-spec`, a free empty rail) calls `POST /flow/:id/hand-off`. Refusals render inline; "Not yet" returns to the Flow. |
| Board | `metadata.flow.state` `active`/`paused` ⇒ "In Flow" label linking to the conversation; the spec cannot be dragged to a rail; inside a rail (handed off) or `delivered` ⇒ no label. |
| Analytics | `flow` surface label; agent missions show the Flow share (`flowCostUsd`, `flowTurns`). |

`flow.state` events are applied only for projects a mounted view watches; a
reconnect refetches the watched Flows.

## Known limitations

- A conversation re-pinned to another project while a Flow is open stops
  resolving the Flow (turns become normal mission turns).
- Flow's containment is the cwd, the persona and the worktree's own branch,
  as for rails; it is not an operating-system sandbox.
- The Preview control follows the mission whose processes the app tracks:
  in a split view it shows the Flow apps of the active conversation.
- Without PR delivery, the derived change is read from the run's branch,
  which the legacy merge-back may already have removed; the rewrite then
  fails and the spec keeps its draft.
- End-to-end coverage uses unit and integration tests with fakes; the paired
  Core harness does not exercise `derive-change` until Core ships it.
- The diff dialog lists files and line counts; the server does not return
  patch bodies yet.
- "This is it" is session-local: after a reload an open Flow shows its bar
  again (nothing was sent to the server).
