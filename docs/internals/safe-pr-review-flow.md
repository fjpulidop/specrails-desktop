# Safe PR review flow (ask-first) — as-built record

> Successor to the shipped `safe-pr-workflow` (#486–#500). That change made every repo-mutating
> rail isolate in worktrees off the integration branch and **auto-deliver** a draft PR at settle,
> surfaced by a one-shot toast. This change replaces the auto-delivery half with an explicit,
> durable, **ask-first** flow: at settle the work stays on its isolated branches and the user
> decides — from the dashboard rail row or from the launching agent-chat conversation — whether a
> PR is created at all. specrails remains a PR producer, never a merge authority.

## The single source of truth

One durable row per rail **launch** in `rail_pr_deliveries` (per-project `jobs.sqlite`,
migration 36; CRUD in `server/rail-pr-store.ts`). Grain is the launch, not the ticket: a delivery
is one PR for the whole launch, keyed internally by `rail_key = ${railIndex}-${loopId}`; the row
is keyed by uuid because a rail slot can be relaunched.

Columns beyond the obvious: `ticket_ids` (JSON `number[]`), `base_branch` (the resolved
integration branch — the "against `<base>`" in the question), `branches` (JSON
`DeliverBranchRecord[]` — per-unit `{ticketId, branch, succeeded}` captured at build-settle),
`worktree_ids` (JSON `string[]` of `rail_worktrees` ledger ids), `loop_name` (PR title/body),
`pr_url`/`pr_number`, `pr_state` (`none | local-only | pushed | pr-created` — the pr-publisher
degradation ladder, independent of `decision`), `origin_surface` (`dashboard | agent-chat`),
`origin_conversation_id` (soft cross-DB reference to `agent_conversations.id` in
`desktop.sqlite`; no FK is possible across SQLite files).

The `branches` + `worktree_ids` columns exist because PR creation is **deferred**: nothing about
the settle survives in memory by the time the user clicks, so `create-pr` and `discard`
reconstruct all their inputs from the row.

## State machine (`decision`)

```
building ──(settle, ≥1 succeeded unit)──▶ on_review      [patch branches/worktree_ids]
building ──(settle, 0 succeeded)────────▶ discarded      (terminal auto-close; per-run settle already reverted tickets)
on_review | pr_failed ──[Create PR]────▶ pr_draft        (delivered)  |  pr_failed (assembly-failed / throw)
pr_draft (pr_url != null) ──[Publish]──▶ pr_ready        (gh pr ready — opens the draft for team review)
pr_draft | pr_ready ──[Check merge]────▶ merged          (gh pr view reports MERGED; else 200 no-op)
on_review | pr_draft | pr_ready | pr_failed ──[Discard]─▶ discarded
```

`merged` / `discarded` are terminal. A **degraded** draft (`pr_state` `pushed`/`local-only`,
`pr_url = null`) offers no Publish — only retry (`create-pr` is legal from a `pr_draft` whose
`pr_url` is null) or Discard. Every transition is the compare-and-set
`transitionDecision(db, id, expected, next, patch)` — one atomic
`UPDATE … WHERE id = ? AND decision = ?` — so two surfaces racing on the same delivery cannot
both win; the loser's `false` return maps to **409 `stale_decision`**.

## Launch wiring (`server/rail-isolated-launch.ts`)

- `prMode = isRailPrDeliveryEnabled()` is captured **once at launch entry** — a mid-flight env
  flip can never split one launch across the two delivery paths.
- In PR mode the row is INSERTed **up front** (`decision='building'`) so the origin link is
  persisted before any await can drop it and late-joining clients hydrate mid-build via
  `GET /rails`. Worktree-allocation failure transitions the row to `discarded` (kept for audit,
  never deleted) so a wedged `building` row can never block the slot.
- Isolation units: `scope='per-ticket'` → one worktree/run per ticket; `scope='all'`
  (implement/batch — one pipeline invocation covers all tickets) → **one** worktree/run covering
  every ticket. `isolationApplies` (`server/rail-isolation.ts`) isolates per-ticket rails always
  and `all`-scoped rails **only when PR delivery is on** (kill-switch off ⇒ byte-identical
  legacy shared-cwd).
- Per-run settle: `ctx.onLoopRunFinished(runId, outcome, { ticketCompletionStatus })` —
  `'on_review'` in PR mode, `'done'` otherwise (`applyJobOutcomeToTickets` gains the analogous
  `{ completedStatus }` option; explicit `'done'` / kill-switch off is byte-identical legacy).
  When the caller passes NO opts (shared-cwd rail runs, standalone loop runs,
  isolation-unavailable fallbacks) the default now derives from `isRailPrDeliveryEnabled()` —
  read once per settle and reused for the Jira split, so one settle can never split across the
  two paths (universal ask-first; the explicit isolated-rail opts are idempotent with it).
  Failures ignore the field (revert `in_progress → todo` as always). In PR mode the completed
  path calls `jiraSyncManager.onRailReview` instead of the done-flavoured `onJobOutcome`.
- All-settle in PR mode: patch `branches` + `worktree_ids`, transition `building →`
  `on_review` (≥1 succeeded) or `discarded` (0 succeeded), broadcast, and — when
  `origin_conversation_id` is set — post the inline decision card into the conversation.
  The legacy merge-back **never runs** in PR mode. Kill-switch off: no row, no `on_review`,
  legacy local merge-back exactly as before.

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

- **create-pr** — deferred `deliverRailAsPr` (`server/rail-pr-delivery.ts`: 1 unit → its
  branch; N → assembled onto the conventional batch branch off the integration branch, one PR
  covering every ticket). The PR **title and canonical body are composed here** (see "Branch
  naming & PR content" below) from the ticket store + `jira_links` + the branch diffs — all
  failure-tolerant. Retry hazard handled first: a prior degraded delivery leaves the batch
  branch behind and `deliverRailAsPr` assembles with `worktree add -b`, so the stale batch branch
  is defensively `-D`'d (never the integration branch); inside `deliverRailAsPr` the batch name
  additionally collide-suffixes `-2`… against the live branch listing. Delivered → `pr_draft`
  (+`pr_url`/`pr_number` when `pr-created`; null when degraded); assembly-failed or a thrown
  guardrail → `pr_failed` (retryable). Tickets stay `on_review` — a draft PR still awaits the
  merge.
- **publish** — `gh pr ready <url>` → `pr_ready` (the draft opens for the team's normal review).
  Requires a real `pr_url`.
- **discard** — best-effort `gh pr close <url> --delete-branch`; remove the launch's worktrees
  (ledger rows closed as `failed`); delete every referenced branch (per-unit sources, assembled
  head, and the possibly-stale batch branch recomputed from the same ticket data create-pr names
  it from — the integration branch is NEVER deleted); → `discarded`; revert
  still-`on_review` tickets → `todo` (a manually re-triaged spec is respected) + Jira
  `onRailDiscard`.
- **poll-merge** — on-demand `gh pr view <url> --json state,mergedAt`; `MERGED` → `merged` +
  tickets → `done` + Jira `onRailMerged` (with a "PR merged: `<url>`" comment); anything else is
  an observation-only 200. There is no background poller (loopback server, no webhooks) —
  detection is click-driven.

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

Neither surface holds authoritative state; both render the last snapshot they received and POST
the same endpoint with the `expectedDecision` they rendered.

- **Durable WS event `rail.pr_state`** (project-scoped, full snapshot — replaces the retired
  one-shot `rail.pr_delivered`): broadcast at row INSERT (`building`), build-settle, and every
  decision mutation. **`GET /rails`** returns `prDeliveries: Record<railIndex, snapshot>`
  (newest non-terminal row per slot) for late-join hydration.
- **Option A — dashboard.** `client/src/context/RailPrDecisionContext.tsx` (registerHandler on
  the shared socket + `GET /rails` seed) feeds `RailPrDecisionStrip` on `RailRow` (both density
  branches): on_review → Create PR / Discard; pr_draft → Open PR + Publish / Discard (degraded →
  retry); pr_ready → Check merge / Discard; pr_failed → Retry / Discard. Buttons disable in
  flight and reconcile to the next broadcast; Discard confirms first.
- **Option B — agent chat.** When the row carries `origin_conversation_id`, settle posts a
  **persisted inline card**: a `'system'`-role `agent_messages` row (role is unconstrained TEXT —
  no migration; TS unions widened) whose content is the `PrDecisionCardEnvelope` JSON.
  `AgentChatManager.postPrDecisionCard` / `updatePrDecisionCard` (update-in-place on every
  transition, so cold-load shows terminal states correctly) are reached from rails code via the
  process-wide `server/agent-chat-registry.ts` singleton (null-safe: tests/disabled builds).
  Live updates ride the app-global `agent_pr_decision` WS event; the client renders
  `AgentPrDecisionCard` and POSTs the same project-scoped `/rails/pr-decision`.
- **Race:** the second answer arrives with a stale `expectedDecision` → 409; the client shows a
  neutral "already resolved" toast and reconciles to the broadcast.

## Relaunch guard

`POST /rails/:i/launch` returns **409 `{ error: 'pr_decision_pending', prDeliveryId }`** when an
active (non-terminal) delivery exists for the slot AND the launch would take the isolated PR
path — a relaunch would append new commits to the undecided branches (worktree creation resumes
existing branches). Legacy / non-isolated launches are unaffected.

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
  `/spawn` jobs, ultracode Finalize, interactive auto-settles. `QueueManager._startJob` reads
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
- **The MCP auto-attach chain (shipped)** — four hops, so an agent-launched rail tags itself
  end-to-end with no manager change (`AgentChatManager` already passes `conversationId` into
  `prepareAgentMcp`):
  1. `agent-mcp-config.ts` `buildSpecrailsMcpEntry` gained `conversationId` in its opts
     (validated against the same launch regex; malformed ⇒ silently omitted) and sets
     `SPECRAILS_AGENT_CONVERSATION` in `entry.env` — threaded at both internal call sites
     (`prepareAgentMcp` and `buildAgentMcpArgs`), so the claude `--mcp-config` file, the codex
     inline `-c mcp_servers.specrails.env.*` overrides and the gemini cwd `.mcp.json` all carry
     it automatically. `mergeSpecrailsIntoWorkspaceMcp` (Part A workspace wiring) deliberately
     stays conversation-less.
  2. `mcp-bridge` forwards the env as the `x-specrails-agent-conversation` header
     (`agentForwardHeaders` in `bridge.ts`, alongside the tier/project forwards). The staged
     bundle `src-tauri/binaries/specrails-mcp.js` must be regenerated via
     `npm run build:mcp-bridge` whenever the bridge source changes — a stale bundle silently
     drops the header (origin degrades to NULL with no error).
  3. `registerTieredTool` (`server/mcp/tools/types.ts`) reads the header into the per-call
     `ctx.originConversationId` next to the project pin (same per-call ctx-copy discipline;
     malformed ⇒ `null`, never throws — the launch degrades to untagged).
  4. `specrails_rails(launch)` (`server/mcp/tools/rails.ts`) adds
     `originConversationId` + `originSurface:'agent-chat'` to the POST body when the ctx
     carries an id (`apiCall` forwards no custom headers, so the id rides the JSON body).
  External MCP clients (Claude Desktop, Cursor, …) spawn the bridge without any
  `SPECRAILS_AGENT_*` env → no header → untagged launches, by design. Covered end-to-end by
  `server/mcp/tools/rails-origin.test.ts` (header → ctx → body → route → persisted row →
  settle fires `postPrDecisionCard` for that conversation).

## Decisions (D1–D11, condensed)

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
- **D3 — state machine**: 0-succeeded settles auto-close to `discarded`; degraded drafts
  (`pr_url` null) have no Publish, only retry/discard; `pr_state` records delivery degradation
  independent of `decision`.
- **D4 — create-pr reconstructs deliverRailAsPr inputs from the row** and defensively deletes a
  stale batch branch first (retry after a degraded delivery would die on "branch already
  exists"); never the integration branch.
- **D5 — relaunch collision** = 409 `pr_decision_pending` only on the isolated PR path.
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
- **D11 — premium decision UI**: disable-on-click reconciled to the broadcast, tooltips (base
  branch, PR url), designed degraded/failed states, 409 → neutral "already resolved" toast;
  English source strings, all 8 locales, locale-parity green.

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
