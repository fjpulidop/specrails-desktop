# Safe PR review flow (ask-first) — as-built record

> Successor to the shipped `safe-pr-workflow` (#486–#500). That change made every repo-mutating
> rail isolate in worktrees off the integration branch and **auto-deliver** a draft PR at settle,
> surfaced by a one-shot toast. This change replaces the auto-delivery half with an explicit,
> durable, **ask-first** flow: at settle the work stays on its isolated branches and the user
> decides — from the dashboard rail row or from the launching agent-chat conversation — whether a
> PR is created at all. specrails remains a PR producer, never a merge authority.

## The single source of truth

`rail_pr_deliveries` (per-project `jobs.sqlite`, migrations 36/38/48–50; CRUD in
`server/rail-pr-store.ts`) stores one durable **generation** per implementation launch. A partial
unique index enforces one non-terminal generation per rail. Reimplementing an attached PR creates
generation B and atomically moves generation A to terminal `superseded`; A can never reappear after
B closes. `supersedes_delivery_id` preserves that lineage and `is_continuation` records that the
PR/head branch is borrowed review state rather than a resource this generation owns.

The important rule is that no single enum carries all truth. The row has orthogonal axes:

- `implementation_outcome`: `running | succeeded | partially_succeeded | failed | unknown` —
  derived **only** from loop terminal outcomes.
- `delivery_outcome`: `pending | ready | delivered | partial | no_changes |
  retryable_failure | blocked | not_started | unknown` — commit/ref/push readiness.
- `decision`: the user/action lifecycle (`building`, `on_review`, `no_changes`, `pr_draft`,
  `pr_ready`, `pr_closed`, `pr_failed`, `implementation_failed`, plus terminal `completed`,
  `merged`, `discarded`, `superseded`).
- `status_code` + bounded `status_detail`: localized stage/reason and secondary diagnostics.
- `delivery_sha`: the exact verified object used by an existing-PR push or retry.
- `pr_state`: `none | local-only | pushed | pr-created`, independent of all three axes.

`branches` is the durable per-unit record: ticket/run, branch, actual implementation result,
delivery eligibility, initial/final SHA, changed/no-change evidence, and failure code. Together
with `worktree_ids` it lets deferred decisions and both cards reconstruct full/partial outcomes
after refresh. `cleanup_warnings` reports best-effort cleanup honestly. `operation*` columns form
a leased single-winner claim around decision-side Git/GitHub effects.

## Outcome and decision matrix

```
engine failed (all units)             → implementation_failed / not_started
engine succeeded + clean verified diff→ on_review (fresh) or pr_draft|pr_ready (continuation)
engine succeeded + no branch delta    → no_changes
mixed clean units                     → on_review / partial (explicit subset)
engine succeeded + commit/ref unsafe  → pr_failed / blocked (worktree preserved)
verified existing-PR push failed      → pr_failed / retryable_failure (exact SHA retained)
GitHub reports CLOSED, not merged      → pr_closed
new generation replaces prior one     → prior generation superseded (terminal)
fresh no-change accepted              → completed (terminal; no merge claimed)
```

Only a real engine failure uses `implementation_failed`. A successful log can therefore coexist
truthfully with “delivery needs attention”. A fresh no-op never offers Create PR. A continuation
no-op leaves the existing PR untouched. Partial cards name the included and failed units before
delivery.

Continuation cleanup is ownership-aware: **Dismiss** clears the follow-up card/worktree but never
closes the pre-existing PR, deletes its head branch, or returns its tickets from review. A blocked
dirty follow-up requires an explicit destructive “Discard local result” confirmation, while still
preserving the external PR/branch. Fresh deliveries keep the full discard semantics.

Fresh no-change cards offer explicit **Mark done** and **Refine** outcomes. Mark done uses terminal
`completed` and moves review tickets to Done without claiming a merge; Refine explicitly returns
them to the backlog. Existing-PR no-change cards only dismiss their borrowed follow-up state.

**`merge-local` (remote-less acceptance).** Legal only without a real PR. Both surfaces confirm
because it changes the user's checkout. Source branches are first assembled away from the user's
checkout; only a complete conflict-free result may advance a still-clean, still-at-the-original-
HEAD integration branch. A conflict leaves the user's checkout byte-identical and the delivery
actionable.

## Launch and recovery wiring (`server/rail-isolated-launch.ts`)

- `prMode` is captured once. Admission is rechecked inside the per-repository allocation lock;
  two requests cannot both create a generation or reuse the ticket-keyed worktree.
- A continuation supersedes its prior generation and creates the new `building` row in one DB
  transaction. Allocation failure closes the new row and restores the prior generation atomically.
- Isolation units remain `per-ticket` or one `all`-scope batch unit. Initial/final SHAs plus commit
  verification distinguish changed, resumed, and no-change results.
- Per-unit settlement returns structured execution + delivery results. `onLoopRunFinished` receives
  the engine outcome only; commit/status/ref/provenance/push failures cannot rewrite it.
- Clean, committed worktrees may be released. Dirty, unknown, or ref-mismatched worktrees become
  `needs-review` and are never force-removed automatically. Push failure retains the exact SHA.
- Project admission remains closed while startup reconciliation runs under the repo lock. Every
  stale `building` shape becomes actionable; successful interrupted work is preserved and labelled
  `settlement_interrupted`, while only all-failed runs become `implementation_failed`.
- Operation leases are process capabilities. Startup clears every prior-process lease before card
  projection, marks the still-active delivery `operation_interrupted`, and leaves its durable SHA,
  PR and unit evidence intact so the user can safely retry.
- `GET /rails` is hydration-only and never invokes crash recovery. This avoids misclassifying the
  normal live window between durable loop completion and commit/ref/push settlement.
- Startup retries pending terminal ticket effects in-process and re-projects active and terminal
  origin-linked rows into Agent Chat before admission opens, repairing cards left stale by a crash
  or migration. Admission remains closed and cards show `cleanup_incomplete` until every JSON/Jira
  phase is durably settled.
  An already-identical card is neither rewritten nor broadcast, so old terminal history does not
  create fake unread activity on every launch.
- PR mode never invokes legacy merge-back. Kill-switch-off behavior remains the legacy path.

## Per-run worktree overlay (`server/worktree-overlay.ts`)

`git worktree add` materializes only TRACKED files — so a RELOCATED project's framework
surface (`.claude/commands/specrails/*.md`, sr-* agents, skills, rules, `.mcp.json`, the
seeded instruction file), which lives in `~/.specrails/projects/<slug>/workspace/`, was
absent from the worktree: the claude CLI reported `Unknown command: /specrails:implement`
and the loop "succeeded" through verify/fix without implementing (live evidence: run
01f41203). Legacy projects have the sibling gap for their UNTRACKED on-disk `.claude`
entries. Each allocated worktree therefore gets `applyWorktreeOverlay(...)` at launch:

- **Source root** = the project's effective artifact root, resolved once per launch via
  `resolveProjectExecution`: the workspace when relocated, else the repo itself.
- **Merge-only symlinks** under `<worktree>/<providerDir>/`: dir links where a dir is
  wholly absent, per-file/per-child where the checkout is partially present; checkout
  content is NEVER overwritten. `agent-memory` is linked (all runs share memory — the
  pre-isolation shared-cwd semantics, deliberate). The providerDir root and the source's
  `worktrees/` entry are never linked (nested pipeline worktrees stay local). `.mcp.json`
  and the instruction file (CLAUDE.md/AGENTS.md/GEMINI.md per provider) are COPIED when
  the checkout lacks them. Windows: junction → dereferencing-copy fallback.
- **Never on the PR**: every overlay-owned path lands in a worktree-local manifest
  (`.sr-rail-overlay.json`, unioned across passes so a RESUMED worktree keeps prior
  entries claimed) and is excluded from `commitWorktree`'s stage via `:(exclude)`
  pathspecs. Excluded paths are untracked by construction, so no real work can be lost;
  a no-op overlay keeps the byte-identical `git add -A`. Worktree removal (`git worktree
  remove --force`) deletes the symlinks as entries without following them.
- **Degrade, don't abort**: entry-level failures produce `warnings` — surfaced as a
  server log line plus the project-scoped `rail.overlay_degraded` WS event — and the
  spawn proceeds (a partial surface beats an aborted rail). `applyWorktreeOverlay` never
  throws.
- **Env correctness**: `SPECRAILS_REPO_DIR` = the WORKTREE per run (loop-executors
  `aiStepEnv` — writes/git land in the worktree, never the live repo), while the
  relocated workspace artifact indirection (`SPECRAILS_TICKETS_PATH` /
  `SPECRAILS_BACKLOG_CONFIG_PATH` / `SPECRAILS_PROFILES_DIR` / `SPECRAILS_STATE_DIR` /
  `SPECRAILS_WORKSPACE_DIR`) rides the executors' lazily-resolved base env
  (`workspace-resolution.ts` `resolveLoopBaseEnv`, wired per project in
  `project-registry.ts`) — the worktree's cwd-relative `${ENV:-legacy}` defaults would
  otherwise resolve to nothing. Legacy projects keep `process.env` untouched.

## The one decision endpoint

`POST /rails/pr-decision` `{ prDeliveryId, action, expectedDecision }` (replaces the stateless
v1 `POST /rails/pr-review`). The route validates and delegates to
`server/rail-pr-decision.ts` `executePrDecision` (deps injected — db/git/exec/broadcast/jira/
agent-chat — so the whole matrix unit-tests without git/gh/network).

Before any Git, GitHub, cleanup or ticket effect, the endpoint atomically claims the row's leased
`operation_token`. A second window loses **before** it can perform an effect. The token is cleared
before the new snapshot is persisted to the agent card/broadcast; a dead-process lease is bounded
and reclaimable, and the final CAS verifies that the caller still owns it. Every response also
contains the authoritative post-action snapshot, so losing a WebSocket frame cannot leave the
initiating card stale. While startup recovery owns the project, decision and checkout endpoints
return a specific retry-later conflict. Every decision that can mutate refs/worktrees shares the
same repository lock as recovery, launch allocation and checkout, revalidates its admission epoch
after waiting for that lock, and uses bounded Git/GitHub command timeouts so a wedged child cannot
block the repository forever.

- **create-pr** — deferred `deliverRailAsPr` (`server/rail-pr-delivery.ts`: 1 unit → its
  branch; N → assembled onto the conventional batch branch off the integration branch, one PR
  covering every ticket). The PR **title and canonical body are composed here** (see "Branch
  naming & PR content" below) from the ticket store + `jira_links` + the branch diffs — all
  failure-tolerant. Each unit is pushed/merged from its immutable settled `finalSha`, never from a
  later mutable or historical ticket branch. A degraded multi-unit retry reuses its owned assembled
  head, preserving exact head/base PR identity; unrelated name collisions suffix `-2`… and are never
  pre-deleted. Delivered → `pr_draft`
  (+`pr_url`/`pr_number` when `pr-created`; null when degraded). `publishDraftPr` adopts an exact
  existing head/base PR when `gh pr create` returns no URL, says it already exists, or a retry
  follows an ambiguous interruption. Assembly/ref failures are blocked; only safe stages are
  labelled retryable. Tickets stay `on_review`.
- **publish** — `gh pr ready <url>` → `pr_ready` (the draft opens for the team's normal review).
  Requires a real `pr_url`.
- **discard** — for a fresh delivery, best-effort `gh pr close <url> --delete-branch`; remove the launch's worktrees
  (ledger rows closed as `failed`); delete only branches durably recorded as created by this
  delivery (owned per-unit sources plus its exact assembled head; preferred names are never
  recomputed, and the integration branch is NEVER deleted); → `discarded`; revert
  still-`on_review` tickets → `todo` (a manually re-triaged spec is respected) + Jira
  `onRailDiscard`. Failures are retained in `cleanup_warnings` and disclosed. For a continuation,
  discard can remove only the explicitly confirmed blocked local iteration: it preserves the
  borrowed PR/head and review ticket state.
- **dismiss** — continuation acknowledgement. Clears the generation and owned clean
  worktree while preserving the existing PR, head branch and `on_review` tickets.
- **acknowledge-no-changes** — fresh no-change acceptance → terminal `completed`, tickets Done,
  with no PR/merge claim. Jira receives its own no-PR completion comment. Refine remains the
  explicitly backlog-returning path and always uses Jira `todo`; it never inherits the configured
  discard/cancellation status.
- **poll-merge** — observes state, exact head/base/head OID, merge commit and PR commit set;
  `MERGED` becomes `merged` only when that immutable evidence contains `delivery_sha`, then tickets
  → `done` + Jira `onRailMerged`. `OPEN` is observation-only; `CLOSED` without merge → `pr_closed`.
- **reopen** — `gh pr reopen` from `pr_closed`, returning to draft or ready according to GitHub.
- **merge-local** — builds the complete merge in an isolated temporary checkout and advances the
  user's revalidated clean base only after all branches succeed.

Terminal discard/merge/completion inserts `rail_pr_ticket_effects` in the same SQLite transaction
as its decision and snapshots each ticket's non-null outcome owner. Before crossing into ticket JSON
the worker durably freezes only IDs still `on_review` whose owner still matches that snapshot, then
checkpoints the JSON phase and Jira-outbox handoff separately. An old terminal row therefore cannot
change or enqueue Jira work for a newer iteration. Jira's idempotency keys make a crash after enqueue
safe to repeat; the effect becomes complete only after that durable handoff. Startup retries every
unfinished phase, including causally provable migrated terminal rows, before admission opens.

`gh` failures return 502 `gh_failed` with **no transition**. Illegal action for the current
state → 409 (`stale_decision` + `reason: 'illegal_action'`).

## Branch naming & PR content (pr-naming.ts / pr-body.ts)

Conventional, open-source-style naming for everything the user sees on GitHub. All pure string
logic in `server/pr-naming.ts` (branches + titles) and `server/pr-body.ts` (canonical body +
diff collection), fully unit-tested.

- **`<ref>`** — the ticket's Jira key when Jira-linked, else the local ticket number. **JIRA
  ALWAYS PREVAILS**, resolved per ticket at naming/body time with no HTTP: the authoritative
  `jira_links` row (`getLinkByLocalId`, tombstoned links ignored) wins over the ticket's
  `jira_key` field; a missing link degrades to the local id.
- **`<type>` heuristic** (labels checked before the title; first match wins): bug|bugfix|fix|
  hotfix → `fix`; chore|refactor|cleanup → `chore`; docs|documentation → `docs`; else `feat`.
  Batch type = `feat` unless ALL tickets map to the same other type.
- **Per-unit branch** — `<type>/<ref>-<kebab-title>` (e.g. `feat/SKILLS-101-add-dark-mode`,
  `fix/37-crash-on-save`). The kebab is ascii-folded (NFKD, diacritics stripped, `ß`→`ss`),
  capped ~40 chars at a word boundary, never a leading/trailing dash; emoji-only titles fold to
  nothing (`<type>/<ref>`). Every generated name passes `isValidBranchName`.
- **Batch branch** (N>1 assembled delivery) — `<type>/<primary-ref>-batch-<n>-tickets`.
- **Collisions** — bounded suffixing `-2`, `-3`… (20 attempts). At worktree allocation
  (`rail-isolated-launch`) a branch that a PRIOR rail run allocated for the SAME ticket (per the
  `rail_worktrees` ledger) is **resumed**, not suffixed — preserving the stop/relaunch resume
  semantics; exhaustion falls back to the legacy `sr/<slug>/ticket-<id>`. The **integration
  branch is never used** (reserved in the resolver + asserted in tests). `createWorktree` stays
  generic: an optional preferred `branch` input with the legacy fallback when absent.
- **PR title** — `[<ref>]<type> - <change>` (e.g. `[SKILLS-101]feat - darkmode added`); the
  `<change>` clause is the ticket title, control-stripped, trailing-period-free and
  first-letter-lowercased unless it reads as an acronym/CamelCase. Batch:
  `[<primary-ref> +<n-1>]<type> - <loop summary>` (e.g. `[SKILLS-101 +2]feat - implement batch
  of 3 tickets`). The per-ticket type matches its branch type.
- **PR body** (`buildCanonicalPrBody`, composed at create-pr time) — one summary paragraph
  (loop, N tickets, base branch), then per ticket `## <ref> — <title>` (Jira key verbatim,
  `#<id>` for local) with **Problem** (the spec's leading narrative / problem-ish heading;
  omitted when missing), **Solution** (a tight digest of the solution-ish sections; overflow in
  a collapsed `<details>` block — never a full spec dump; the Contract Layer appendix is
  stripped first), and **Tests** (HONEST: touched `*.test.*`/`*.spec.*`/`__tests__/` files from
  `git diff --name-status <base>...<branch>`; "No test files changed in this diff." when none;
  an explicit unavailable note when the diff failed — never invented). A final `## Changes`
  section lists the per-branch diffstat (`git diff --shortstat`), omitted entirely when git
  fails — diff problems can only degrade the body, NEVER block PR creation. The v1
  `buildBatchPrBody` and its "_Draft PR produced by specrails — the engineer owns the merge._"
  footer are gone.

## The sync contract (two surfaces, zero desync)

SQLite remains authoritative. Both surfaces render a full snapshot and POST the same endpoint with
the `expectedDecision` they rendered.

- **Durable WS event `rail.pr_state`** (project-scoped, full snapshot — replaces the retired
  one-shot `rail.pr_delivered`): broadcast at row INSERT (`building`), build-settle, and every
  decision mutation. **`GET /rails`** returns `prDeliveries: Record<railIndex, snapshot>`
  (newest non-terminal row per slot) for late-join hydration.
- **Option A — dashboard.** `client/src/context/RailPrDecisionContext.tsx` (registerHandler on
  the shared socket + `GET /rails` seed) feeds `RailPrDecisionStrip` on `RailRow` (both density
  branches): on_review → Create PR / Discard; pr_draft → Open PR + Publish / Discard (degraded →
  retry); pr_ready → Check merge; no_changes → Done/refine; pr_closed → Reopen; pr_failed derives
  retry-vs-blocked actions from `delivery_outcome`. Logs remain available after settle. Buttons
  disable in flight and apply the authoritative HTTP snapshot immediately.
- **Option B — agent chat.** When the row carries `origin_conversation_id`, settle posts a
  **persisted inline card**: a `'system'`-role `agent_messages` row (role is unconstrained TEXT —
  no migration; TS unions widened) whose content is the `PrDecisionCardEnvelope` JSON.
  `AgentChatManager.postPrDecisionCard` / `updatePrDecisionCard` (update-in-place on every
  transition, so cold-load shows terminal states correctly) are reached from rails code via the
  process-wide `server/agent-chat-registry.ts` singleton (null-safe: tests/disabled builds).
  Live updates ride the app-global `agent_pr_decision` WS event; the client renders
  `AgentPrDecisionCard` and POSTs the same project-scoped `/rails/pr-decision`.
- **Race:** a stale generation or occupied operation lease returns 409 before effects. Clients
  distinguish `operation_in_progress` from a stale decision, show the active operation, disable
  actions, apply the response snapshot, ignore terminal events for an older delivery id, and
  hydrate again on focus/reconnect.

## Relaunch guard

`POST /rails/:i/launch` returns **409 `{ error: 'pr_decision_pending', prDeliveryId }`** for an
unresolved fresh delivery. An active `pr_draft`/`pr_ready` generation covering the same tickets is
a verified continuation contract instead: launch revalidates it again under the repo lock,
supersedes it atomically and runs only on that PR head. A stale concurrent request receives 409
before it can allocate or claim anything. Legacy / non-isolated launches are unaffected.

## Ticket lifecycle — `on_review`

New status in `TicketStatus` / `VALID_STATUSES` (`server/ticket-store.ts`), between
`in_progress` and `done`. Pipeline-owned:

**Universal ask-first (both completion chokepoints).** Under the default-on PR-delivery flag
EVERY completed job/run promotes its tickets `todo|in_progress → on_review`, never `done`:

- **Loop runs** (`project-registry.ts` `onLoopRunFinished`): explicit `ticketCompletionStatus`
  from `launchIsolatedRail` (launch-captured `prMode`); absent opts default to the flag (see
  "Per-run settle" above) — covering shared-cwd rail launches, standalone loop runs, and the
  isolation-unavailable fallback.
- **QueueManager jobs** (`project-registry.ts` `onJobFinished`): bare-mode launches, MCP
  `/spawn` jobs, freestyle Finalize, interactive auto-settles. `QueueManager._startJob` reads
  `isRailPrDeliveryEnabled()` ONCE per job at spawn — the SAME read that injects
  `SPECRAILS_GIT_AUTO=false` — records it in the in-memory `_jobPrDelivery` map (restart-durable
  by construction, like the interactive gate: a queued job surviving a restart recomputes at its
  own spawn), and both settle paths (`_onJobExit` / `_settleInteractiveJob`) consume it and
  thread `{ ticketCompletionStatus }` into `onJobFinished` on COMPLETED exits (failure statuses
  keep the legacy 3-arg call shape). A mid-flight env flip can never split one job between the
  spawn-env methodology and the settle parking. The Jira write-back splits identically:
  completed + on_review → `onRailReview(changedIds, jobId)`; failed/canceled/zombie → the
  legacy done-flavoured `onJobOutcome`.

`done` is reachable ONLY via the PR-decision `poll-merge`, a manual context-menu move, or the
kill-switch-off legacy path. The `needs_review`-clearing and failure-revert branches of
`applyJobOutcomeToTickets` are byte-identical to legacy.

- Board: lives in the ToDo bucket with an accent-warning "On review" pill
  (`TicketStatusIndicator` et al.); auto-stripped from rails; not draggable onto rails; a rail
  containing one cannot launch.
- Users can move OUT of it manually (`todo`/`done` via the ticket context menu) but never INTO
  it. Explore "Continue Editing" excludes it (Jira-mirror specs keep their any-column rule).
  `validatePriorityForStatus` unchanged (priority null only for `draft`).
- Merge → `done`; discard → `todo`; both applied only to tickets still sitting at `on_review`.

## Jira mapping

- `SpecLogicalState` gains `on_review` (server `server/jira/types.ts` + client `jira-api.ts`);
  `sanitizeStatusMap` accepts the new key (it silently dropped unknown keys before); the connect
  **wizard** and the **connected card** both expose a `statusMap.on_review` editor.
- Resolver (`jira-status-resolver.ts`): explicit `statusMap.on_review` first, else
  `statusCategory` fallback `indeterminate`. **Same-category-walk fix:** when an explicit target
  is configured and the current status *name* differs, the walk transitions even if both statuses
  share a category (previously a same-category no-op made e.g. In Progress → In Review
  impossible). Unconfigured `statusMap.on_review` still no-ops (issue stays In Progress).
- Materializer (`jira-materializer.ts`): an inbound issue whose status name equals the mapped
  `on_review` status (case-insensitive) materializes as `on_review` instead of being reverted by
  the `indeterminate` category ~one poll after the outbox drained.
- Hooks (`jira-sync-manager.ts`, all outbox-only — the local cache write belongs to the caller):
  `onRailReview(ticketIds, refId)` at PR-mode settle; `onRailMerged(ticketIds, refId, prUrl)`
  (Done transition + "PR merged" comment — NOT `onJobOutcome`, whose completion comment assumes
  cost/duration); `onRailDiscard(ticketIds, refId)` (configured `discardStatus`, else logical
  todo).

## Origin link (as-built)

Persisted end state: `rail_pr_deliveries.origin_surface` + `origin_conversation_id`, written at
the launch INSERT. As-built:

- `POST /rails/:i/launch` accepts `originConversationId` (validated `/^[A-Za-z0-9-]{1,64}$/`) and
  `originSurface` (`'dashboard' | 'agent-chat'`), threaded into `launchIsolatedRail`.
  Dashboard launches default to `origin_surface='dashboard'`, `origin_conversation_id=NULL`.
- **The authenticated MCP auto-attach chain (shipped)** — an agent-launched rail tags itself
  end-to-end without trusting caller-controlled context headers:
  1. `AgentChatManager` mints an unguessable, turn-scoped capability. The server stores only
     its hash and binds it to the actual conversation, pinned project and permission level.
  2. `prepareAgentMcp` writes the bearer to an app-owned `0600` capability file. Claude,
     Codex and Gemini MCP configs carry only `SPECRAILS_AGENT_CAPABILITY_FILE`, so the raw
     bearer never appears in command-line arguments. Workspace MCP wiring deliberately carries
     no capability.
  3. `mcp-bridge` reads that file and forwards the bearer as
     `x-specrails-agent-capability`. Legacy tier/project/conversation env vars and headers are
     ignored. The staged bundle `src-tauri/binaries/specrails-mcp.js` must be regenerated via
     `npm run build:mcp-bridge` whenever the bridge source changes.
  4. `registerTieredTool` (`server/mcp/tools/types.ts`) verifies the bearer and derives the
     per-call tier, project and `ctx.originConversationId` from its server-side binding. The
     manager revokes the capability and removes its file when the turn settles.
  5. `specrails_rails(launch)` (`server/mcp/tools/rails.ts`) adds
     `originConversationId` + `originSurface:'agent-chat'` to the POST body when the ctx
     carries an id (`apiCall` forwards no custom headers, so the id rides the JSON body).
  External MCP clients (Claude Desktop, Cursor, …) have no capability, so launches remain
  untagged and Settings tiers govern them. Covered end-to-end by
  `server/mcp/tools/rails-origin.test.ts` (capability → ctx → body → route → persisted row →
  settle fires `postPrDecisionCard` for that conversation).

## Decisions (D1–D17, condensed)

- **D1 — three extra columns** (`branches`, `loop_name`, `worktree_ids`) on migration 36:
  deferred create-pr/discard must be reconstructible from the row; nothing survives in memory
  after settle.
- **D2 — the on_review divert intercepts `onLoopRunFinished`**, not `onJobFinished`: isolated
  rails settle per-run through `rail-isolated-launch`, and an opt-in
  `ticketCompletionStatus`/`completedStatus` option keeps the default path byte-identical.
  **Superseded (universal ask-first):** the divert now lives in BOTH chokepoints — the
  `onLoopRunFinished` default derives from the flag when opts are absent, and `onJobFinished`
  receives the spawn-captured flag from QueueManager — see "Ticket lifecycle" above. The opt-in
  option shape survives unchanged; only its defaults moved from hardcoded `'done'` to
  flag-derived.
- **D3 — orthogonal outcomes**: only loop outcomes determine implementation success; delivery,
  decision and PR lifecycle are independent. Zero actual successes becomes
  `implementation_failed`; successful blocked/no-change runs retain their truth.
- **D4 — create-pr reconstructs deliverRailAsPr inputs from the row** using each unit's exact
  settled object. It reuses an owned degraded batch head and never deletes a merely name-matching
  branch.
- **D5 — relaunch admission**: unresolved fresh work returns 409; a matching open-PR generation
  is superseded atomically and continued on its exact verified head.
- **D6 — `rail.pr_delivered` retired**, replaced by the durable `rail.pr_state` + the
  `GET /rails` `prDeliveries` hydration; `Map<railIndex, …>` on the client keyed to the newest
  active row.
- **D7 — no SQL migration for the `'system'` role** (`agent_messages.role` is unconstrained
  TEXT); the card is a system-role row updated in place; rails code reaches the manager via the
  new `agent-chat-registry` (no circular import of `index.ts`).
- **D8 — origin rides the rails launch only**; the `jobs.ts /spawn` hop is dropped (QueueManager
  jobs have no delivery row — the id would go nowhere). The full MCP auto-attach chain is
  shipped — see "Origin link" above.
- **D9 — Jira**: two real bug fixes (sanitizeStatusMap whitelist, same-category walk) plus
  inbound preservation and the three outbox hooks.
- **D10 — on_review everywhere**: server union + every client `Record<TicketStatus, …>` map,
  board bucketing (ToDo tab), drag/launch guards, context-menu out-only, pill, i18n ×8.
- **D11 — premium decision UI**: disable-on-click reconciled to authoritative snapshots, tooltips
  (base branch, PR url), designed degraded/failed states, distinct stale-vs-operation-busy 409 UX;
  English source strings, all 8 locales, locale-parity green.
- **D12 — no automatic data loss**: dirty, unknown and ref-mismatched worktrees are
  `needs-review`; only explicit consequence-specific cleanup may force-remove them.
- **D13 — one active generation**: migration 48 supersedes historical duplicates and a partial
  unique index enforces one active row per rail.
- **D14 — operation lease before effects**: a decision claims before Git/GitHub/ticket work;
  the loser has no external side effects and HTTP returns the authoritative snapshot.
- **D15 — exact/idempotent delivery**: continuation retry pushes `delivery_sha`; ambiguous PR
  creation resolves exact open head/base identity; CLOSED is distinct and reopenable.
- **D16 — crash recovery before admission**: startup preserves successful interrupted work and
  makes every stale `building` generation actionable before another launch can reuse its path.
- **D17 — ownership-aware continuation cleanup**: dismiss/discard never closes or deletes the
  pre-existing PR/head and never reverts its review tickets.
- **D18 — terminal ticket outbox**: terminal decision + ticket intent commit atomically; startup
  replay closes the SQLite/JSON crash window, exact causal ownership prevents old generations from
  mutating newer work, and terminal Agent cards are re-projected.
- **D19 — truthful no-change completion**: fresh no-change has Mark done (`completed`) and Refine;
  a continuation only dismisses its borrowed follow-up.

## Kill-switch

`SPECRAILS_RAIL_DELIVER_PR` (default ON; `0`/`false`/`off` disables) — off means: no
`rail_pr_deliveries` rows, no `on_review` (completed jobs/runs promote straight to `done` with
the done-flavoured Jira `onJobOutcome` — byte-identical legacy at BOTH chokepoints), no
decision surfaces, `all`-scope rails fall back to the shared cwd, and the legacy local
merge-back runs — byte-identical pre-change behaviour. Capture grain: once per isolated LAUNCH
(`launchIsolatedRail` entry), once per JOB at spawn (`QueueManager._startJob`), once per
shared-cwd run SETTLE (`onLoopRunFinished` default) — a mid-flight flip only affects
lifecycles that start (or, for the settle-grain default, finish) after it.
PR mode also injects `SPECRAILS_GIT_AUTO=false` into rail spawns (loop-executors +
queue-manager); bundled specrails-core ≥ 4.11.0 honours it, so implement no longer self-ships.

## Deferred by this change

- A background merge poller for `pr_draft`/`pr_ready` rows (`poll-merge` is on-demand only).
- An origin hop for QueueManager `/spawn` jobs (no delivery row exists at job grain).

(The relocation per-run workspace overlay — formerly on this list — has SHIPPED; see
"Per-run worktree overlay" above.)
