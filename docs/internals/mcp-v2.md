# MCP v2: foundations and the contracts every work package follows

MCP v2 lets a person drive all of Specrails from Claude Code or Codex without the GUI: 15 resource-style tools,
decision-ready state, bound confirmations, one blocking `wait`, localized text and hard response budgets. This page
freezes the shared contracts built in WP0 (`server/mcp/v2/core/**`). Work packages WP1–WP14 build on them in parallel
and must not change them. A contract change is a WP0 change: it goes through its own reviewed commit and this page.

The v1 catalog (`server/mcp/tools/**`, [response envelope](mcp-response-envelope.md)) stays the default until the
phase 4 cut-over.

## Feature flag

| Switch | Effect |
|---|---|
| `desktop_settings.mcp_v2 = 'true'` | New MCP sessions get v2 |
| `SPECRAILS_MCP_V2=true` / `false` | Wins over the setting (tests, dogfooding, rollback) |
| unset (default) | Exactly the v1 catalog. No instructions, no v2 tool, no change for current clients |

With the flag on, `McpServerManager.buildServer` (`server/mcp/mcp-server.ts`) calls `registerV2Surface`
(`server/mcp/v2/index.ts`). That call:

- advertises the 15 v2 tools;
- sends the server `instructions` (`v2/instructions.ts`, ≤ 600 tokens);
- keeps every v1 tool callable but hidden from `tools/list` (`v2/legacy.ts`);
- lists the first-party `specrails_mission` to in-app sessions only.

`buildServer` also registers, with the flag on, the v2 prompts (`v2/prompts.ts`: start-my-day, review-waiting,
ship-milestone, why-stuck — short recipes over the v2 tools, `prompts.test.ts`) and the v2 guide topics
(`v2/guide.ts`: served by `specrails_system(help, topic)` and as `specrails://guide/{topic}` resources, each ≤ 2k
tokens). The person-facing agent reference `docs/agents/mcp.md` is generated from the live catalog by
`v2/docs-reference.ts`; `docs-reference.test.ts` fails on drift (regenerate with
`UPDATE_MCP_DOCS=1 npx vitest run server/mcp/v2/docs-reference.test.ts`).

One-command connect lives in `server/mcp/connect/` (`client-config.ts` edits only the `specrails` entry of
`~/.claude.json` / `.mcp.json` or Codex `config.toml`, with a backup; `connect.ts` detects clients and applies;
`verify.ts` runs the registered entry over stdio: `initialize`, `tools/list`, `specrails_overview(app)`), served by
`/api/mcp-admin/connect` (`mcp-admin-router.ts`) for `specrails-desktop mcp connect|status|disconnect`
(`cli/mcp-connect.ts`) and **Settings ▸ MCP ▸ Connect**. The name `specrails` is reserved: Explore turns never load
the person's own `specrails` entry (`server/user-mcp-config.ts` drops it from the approved servers and switches off a
Codex `[mcp_servers.specrails]` table; the high Explore tier disallows `mcp__specrails`), because that entry carries
their unrestricted access.

The flag is read per session, so new sessions pick up a change without a restart.

### v1 compatibility while v2 is on

- **A v1 tool name that v2 does not reuse** (`specrails_jobs`, `specrails_status`, …): it is registered as before and
  hidden from the list. Every result adds `warnings: ["deprecated: use <v2 call>"]`.
- **A v1 name that v2 reuses** (`projects`, `specs`, `rails`, `runs`, `inbox`, `missions`, `settings`): its v1
  actions become hidden actions of the v2 tool. They run the v1 handler, validated against the v1 schema, with the
  same deprecation warning. This applies until the owning WP implements the v2 action.

  The advertised schema stays v2-only. A field both versions define (for example `confirm`, boolean in v1 and a
  token in v2) accepts either value at runtime.

  **Rule for WPs:** when you implement a v2 action whose name collides with a v1 action of the same tool, the v2
  handler wins. The registry keeps the common v1 argument names working before the `required` check
  (`normalizeV1Args`): `projectId` → `project`, `q` → `query`, and `id` / `jobId` / `itemId` / `runId` /
  `conversationId` → a bare `ref` (numbers become strings). A tool adds its own unambiguous names in `v1Aliases`
  (missions: `text` and `question` → `message`), applied first under the same rules. An alias maps only when the tool
  declares the v2 field and not the alias, and only when the v2 field is absent; the alias is then removed, so
  handlers and confirmation bindings see one shape. Any other v1 name is the WP's to accept, or to drop and say so in
  its PR. Dropped at phase 2: the v1 `settings` shapes (top-level fields on set, a flat get); v2 takes
  `section` + `values`.
- **Blank values:** the registry treats `""` (and whitespace) as absent, for `required`, `oneOf` and the aliases. No
  v2 field gives `""` a meaning; a "default target" is a named value instead (`insights(preflight)` uses
  `"primary"`). Keep that convention rather than special-casing empty strings.
- **The deprecation table** is `V1_TO_V2` in `server/mcp/tools/actions.ts` (the alias bridge). `v2/aliases.test.ts`
  proves every v1 action maps to an existing v2 call and snapshots the table. A v2 action that is still a stub
  answers `not_implemented` and names the v1 call that serves it today (`v1EquivalentOf`).

## File ownership

Every v2 file has one owner. Shared contracts are WP0's; nobody else edits `v2/core/**`, `v2/legacy.ts`,
`v2/index.ts`, `v2/flag.ts`, `v2/__fixtures__/harness.ts`, `v2/tools/index.ts`, `v2/i18n/catalog.ts` or the budget
test.

| WP | Owns (create or edit only these) |
|---|---|
| WP0 | `v2/core/**` (phase 2 added `loopback`, `bus`, `forecast`, `commit-tracker`), `v2/{index,flag,legacy}.ts`, `v2/tools/index.ts`, `v2/i18n/{catalog.ts,sources.json,en/core.json,*/core.json}`, `v2/catalog-budget.test.ts`, `v2/{aliases,surface}.test.ts`, the alias bridge in `server/mcp/tools/actions.ts`, the v2 hook in `mcp-server.ts` |
| WP1 events | `server/modules/events-journal/**`, `v2/tools/wait.ts`, `v2/i18n/en/wait.json` |
| WP2 overview, inbox, projects | `v2/tools/{overview,inbox,projects}.ts`, `v2/i18n/en/{overview,inbox,projects}.json`, `server/mobile/mobile-inbox.ts` |
| WP3 runs, rails | `v2/tools/{runs,rails}.ts`, `v2/projectors/run-state.ts`, `v2/i18n/en/{runs,rails}.json`, `server/modules/delivery/runtime/rails-launch-http.ts` |
| WP4 deliveries | `v2/tools/deliveries.ts`, `v2/projectors/delivery-state.ts`, `v2/i18n/en/deliveries.json` |
| WP5 specs | `v2/tools/specs.ts`, `v2/i18n/en/specs.json`, `server/project-router-tickets-bulk.ts` |
| WP6 blueprint | `v2/tools/blueprint.ts`, `v2/projectors/chain-state.ts`, `v2/i18n/en/blueprint.json` |
| WP7 missions | `v2/tools/missions.ts`, `v2/projectors/mission-state.ts`, `v2/i18n/en/missions.json`, the first-party `v2/tools/mission.ts` (moved from `tools/mission.ts`) |
| WP8 insights | `v2/tools/insights.ts`, `v2/i18n/en/insights.json` |
| WP9 settings, providers | `v2/tools/{settings,providers}.ts`, `v2/i18n/en/{settings,providers}.json` |
| WP10 integrations | `v2/tools/integrations.ts`, `v2/i18n/en/integrations.json` |
| WP11 system | `v2/tools/system.ts`, `v2/i18n/en/system.json`, `server/desktop-router-updates.ts`, `client/src/hooks/useDesktopUpdateRemote.ts` |
| WP12 i18n | `v2/i18n/{es,fr,de,pt,it,zh,ja}/<area>.json` (except `core.json`, generated) and their imports in `catalog.ts` |
| WP13 connect, docs | `cli/mcp-connect.ts`, `server/mcp/connect/**`, `v2/instructions.ts` (wording; the protocol rules stay), `v2/prompts.ts`, `v2/guide.ts`, `v2/docs-reference.ts`, `docs/mcp.md`, `docs/agents/mcp.md` (generated), the MCP settings section |
| WP14 eval | `eval/mcp/**` |

The design assigned no owner to `specrails_projects` and `specrails_rails`. WP0 assigns `projects` to WP2 (app-level
reads, next to overview and inbox) and `rails` to WP3 (launch goes through runs). Server-side additions go into the
owning domain module, one WP per module. A WP that needs a new shared helper asks WP0 for it and does not add it to
`core/`.

### One owner per setting (decided at phase 2)

Where two tools reached the same data, one implements it and the other delegates through `ctx.v2.dispatch` (the
target's tier, preview and confirmation apply; `confirm` / `dryRun` pass through, so the agent resends the call it
made):

| Data | Canonical | Delegates |
|---|---|---|
| Budgets and caps | `settings(set, section budget)` | `insights(budget_set)` maps `options.limits` onto it (a cap raise now confirms as costly); `insights(budget_get)` stays a read |
| Webhooks, mobile gateway | `integrations(webhooks)`, `integrations(mobile)` (status, enable, disable, revoke) | `settings(get/set, section webhooks|mobile)` and `settings(webhook_test)` |
| Machine-install approvals | `settings(section machine_installs)` | `system(machine_installs)` |

## The 15 tools

Every stub in `v2/tools/<area>.ts` already has its final name, description, fields and action table. A WP fills in
handlers (and previews). It does not rename or re-type a field; it may add an action, an optional field or an enum
value. Each one is checked by the budget test.

| Tool | Owner | Always loaded | Actions |
|---|---|---|---|
| `specrails_overview` | WP2 | yes | app, project, live, context |
| `specrails_inbox` | WP2 | yes | list, open, answer, approve, reject, snooze, done, act |
| `specrails_wait` | WP1 | yes | until, events |
| `specrails_projects` | WP2 | | list, get, select, add, clone, provision, install_status, abort_install, repositories, repository_add/update/remove, unregister, sample_create/remove, prerequisites |
| `specrails_specs` | WP5 | yes | list, get, search, create, update, bulk_update, delete, restore, trash, purge, refine, ai_edit, smash, smash_undo, triage, addendum_add/update/dismiss/reopen/delete, attach, detach |
| `specrails_blueprint` | WP6 | | sessions, start, send, repair, abort, get, commit, milestones, milestone_generate, milestone_commit, chain_launch/get/resume/auto_advance/cancel, settings_get/set |
| `specrails_rails` | WP3 | | list, create, remove, rename, configure, prepare_worktrees, release_worktrees, overlaps, forecast |
| `specrails_runs` | WP3 | yes | list, get, launch, launch_all, pause, resume, stop, cancel, answer, approve, reject, limit, remedy, fork, steer, diagnose, recovery_inspect/read/diff/patch/check, settle, dismiss, queue, delete_history |
| `specrails_deliveries` | WP4 | yes | list, get, decide (17 decisions, `DECISION_POLICY`) |
| `specrails_missions` | WP7 | | lifecycle, queue_*, attachments, subagents, card_decide, limit_continue, intent_*, chat_* |
| `specrails_insights` | WP8 | | spend, analytics, export, usage, quota, capacity, preflight, forecast, what_if, budget_get/set, resources |
| `specrails_settings` | WP9 | | get, set (by `section`), env_scan, env_status, webhook_test |
| `specrails_providers` | WP9 | | list, models, test, runtime_*, profiles_*, catalog_* |
| `specrails_integrations` | WP10 | | jira_*, plugins_*, loops_*, code_*, git_* |
| `specrails_system` | WP11 | | health, help, triage, report, crashes, crashes_ack, stalls, updates, continuity, worktrees, machine_installs, background, terminals, browser, docs (sub-ops in `op`) |

## Writing a tool action

```ts
// v2/tools/runs.ts (excerpt)
get: {
  tier: 'read',
  required: ['ref'],                  // checked by the registry; dots reach into options (`options.path`)
  handler: async (ctx, args) => {
    const run = ctx.v2.target(args, 'run')            // ref or bare id + project/pin/session default
    const facts = await readRunFacts(ctx, run)        // existing read models / loopback routes only
    const state = ctx.v2.state(projectRunState(run.ref, facts))   // your projector, core sources
    return result(viewOf(facts, ctx.v2.view, resolveFields(args, RUN_FIELDS)), {
      summary: ctx.v2.t('runs.summary.get', { title: facts.title, status: state.label }),
      refs: { spec: formatRef('spec', facts.ticketId, run.project!.slug) },
      state,
      untrusted: untrusted('/data/logs/*', '/data/title'),
    })
  },
},
```

Rules:

- **Reuse the server.** Read app-level read models, or call the existing routes through `apiCall` (loopback, master
  token held server-side). Add no new policy in MCP. When a route is missing, add it in the owning domain module.
- **Tier and class are per action.** Use a function of `args` for mixed actions (`specs.create` with `mode: request`
  is `ai-spawn` + `costly`; `deliveries.decide` reads `DECISION_POLICY`). A destructive tier always carries a
  confirmation class. A reversible soft delete is `write` with no class.
- **Writes answer decision-ready.** A write returns the fresh status and `state` of what it changed (offers,
  recommended, hold), so the agent never re-reads it: run controls reload the run (`accepted`), `pause` answers once the
  run holds (`options.waitMs`, default 25 s), a triage offers the one-call launch of what it triaged. A common detour
  answers directly instead of erroring: `specs(list)` for deleted specs serves the trash, `runs(list)` with kind
  `intent` serves the Intent sessions. Provider words map to ids (`gpt`/`openai` → `codex`, `anthropic` → `claude`).
- **Reads stay small.** A Builder turn answers lean (reply and snapshot); `blueprint(get)` detail is an outline (one
  line per M1 spec), one spec in full is `fields:["spec"]` + `options.spec`.
- **No new top-level field for a rare argument.** It goes in `options`, documented in `doc` and by
  `specrails_system(help)`. Field descriptions are at most 8 words.
- Handlers return plain data or `result(data, meta)`. Throw `V2ToolError(code, message, extra)`. v1 errors
  (`McpToolError`, `McpApiError`) map automatically.
- Shared helpers live in core; do not copy them into a tool:
  - `present`, `asRecord`, `clip`, `clipDeep` (`core/text.ts`);
  - `neutralize`, `reveal` (shows invisible characters as `⟦U+XXXX⟧` in diffs and file contents instead of removing
    them) and `clipUntrusted` (`core/untrusted.ts`);
  - `apiRow` / `api` / `maybe` for loopback routes (`core/loopback.ts`; `api` throws a typed `V2ToolError` with the
    route's own text);
  - `listen` and `waitMsOf` for a bounded wait on a bus frame (`core/bus.ts`; subscribe before you trigger);
  - `launchForecast` / `scaledCost` for a launch's cost and `turnCostFromLedger` for a conversational turn's
    (`core/forecast.ts`: runs, rails, blueprint chains, missions, Intent);
  - `relay(envelope)` to serve a dispatched call's envelope as your result (`core/envelope.ts`);
  - `registerTools(h, tools, options)` in tests that dispatch between tools (`__fixtures__/harness.ts`).

### Tiers decided at integration

| Action | Tier, class | Why |
|---|---|---|
| `deliveries(decide approve)` | destructive, irreversible | WP4: accepting a delivery cannot be taken back |
| `deliveries(decide refresh_on_base)` | ai-spawn, costly | WP4: the resolver and verification run an agent |
| `runs(recovery_check)` | destructive, irreversible | It executes the project's own commands in the run's worktree (v1's check was destructive too); its preview names the check and binds to the run's state version |
| `inbox(act)` | read | The dispatched offer applies its own tier and confirmation |
| `settings(set)` lowering a safeguard (subagents, env inherit, guardrails off, an MCP server, the confirm threshold) | write, risky | WP9 had `irreversible`, whose sentence ("cannot be undone") was wrong: the change can be set back |
| `specs(bulk_update {trash: true})` over 20 specs | write, risky | Restorable, but many specs at once |
| `integrations(mobile enable)` | write, risky | Opens a LAN listener; `disable` undoes it. `revoke` is destructive, irreversible (the device must pair again) |
| `integrations(webhooks create)`, `update` with a `url` | write, external | The URL receives the app's events (settings' rule, kept at the canonical owner) |
| `system(terminals run)`, `system(updates apply)` | destructive, irreversible | WP11: runs a command / installs an update |
| `system(continuity resume)`, `blueprint(chain_resume)` | ai-spawn, costly | Unknown or launch forecast; `chain_resume` is free for `complete`, `follow_run`, `answer_run` |

### Handler context (`ctx.v2`)

| Member | Meaning |
|---|---|
| `tool`, `action` | the call |
| `lang`, `t(key, params)` | resolved language and translator |
| `view` | `summary` (default) or `detail` |
| `projects()` | registered project rows (no per-project DB opens) |
| `project(args)` | project of the call: explicit > mission pin > session default; `ambiguous` + `choices` when none |
| `target(args, kind, kinds?)` | entity from `ref` (a full ref wins) or a bare id; `{ kind, id, project, ref }` |
| `state(input)` | `DecisionState` with this call's language, the catalog's policies and the spend threshold |
| `confirmAboveUsd` | "Ask before spending" threshold |
| `catalog` | the catalog this call was registered with (`system(help)` reads it; no import of `v2/index.ts`) |
| `dispatch(call)` | runs another catalog call (an offer's `call`) through its registered callback, legacy delegate included, with this call's capability; returns the target's v2 envelope (a v1 result is read as v2). `inbox(act)` uses it |
| `progress(progress, total?, message?)` | `notifications/progress` for the request's `_meta.progressToken`; a no-op without one (`wait(until)` reports elapsed ms) |

The v1 context (`registry`, `desktopDb`, `apiCall` through `ctx`, `requestProjectId`, `firstPartyAgent`, `signal`)
stays available. `sessionState` adds `sessionKey` (confirmations bind to it) and `lang`. For an external session the key
is the client named at initialize (`client:<clientInfo.name>`, `confirmationKey`), not the connection: the person's yes
arrives in the agent's next turn, and headless clients (`claude -p --resume`, `codex exec resume`) reconnect per turn.
In-app sessions, and clients that announce no name, keep a per-connection key.

## Envelope v2 (`core/envelope.ts`)

```ts
{ v: 2, ok: true, summary, data, refs?, state?, page?: { cursor, total?, truncated }, warnings?, untrusted? }
{ v: 2, ok: false, summary, error: { code, message, retryable, choices?, next?, preview?, confirmToken?, state?, reason? } }
```

- `structuredContent` is the envelope. `content[0]` holds the same JSON, minified. Clients on a protocol older
  than 2025-06-18 get `summary` + newline + JSON instead (`textModeFor`).
- **Error codes:** the v1 codes plus `stale`, `held`, `budget_exceeded` and `not_implemented`. `held` carries the
  entity's `state`. `confirmation_required` and `stale` carry `preview` and `confirmToken`.
- **Output schema:** `{ v?, ok, summary }` loose. Keep it that small; it is repeated in every `tools/list` entry.

## Views, fields, pagination and the size guard

- `view: summary` is the lean shape. `detail` adds the sections in `fields`, or all of them when `fields` is absent
  (`resolveFields`).
- **Response caps (o200k, estimated by `approxTokens`, conservative at about 2.9 bytes per token):**
  - summary: 1,500
  - detail: aim for 6,000, hard cap 10,000
  - logs pages: 4,000 (`maxTokens` on the action)
  - wait wake-up: 800
  - write accept: 600
- `guardSize` runs on every success. It drops trailing whole items of the largest array first and sets
  `page.truncated` plus a cursor at the first dropped item. It shortens long strings only after that, and as a last
  resort replaces `data` with `{ omitted: true }`. `summary`, `refs` and `state` always survive.
- **List convention:** `data.items` plus `page` from `pageOf` (in-memory) or the store's keyset cursor wrapped as
  `inner` (`encodeCursor`).
  - Pass where the page starts as `result(data, { page, pageBase: { offset, key } })` (`pageOf` returns it as
    `base`). When the guard cuts `/items` it then writes an absolute cursor (`offset + kept`) stamped with your
    query key, which your own `decodeCursor(args.cursor, key)` resumes from. Without it a cut restarts at the page's
    first item. A list filtered after the store read (`runs(list)`) cannot give an absolute offset and keeps its
    pages small instead.
  - A tool that accepts `cursor` decodes it with `decodeCursor(args.cursor, key)`. A guard cursor carries `offset`,
    and `path` when it cut an array other than `/items`.
  - Keep pages small (default 25, max 100) so the guard rarely fires.

## Global refs (`core/refs.ts`)

- **Project-scoped:** `<kind>:<projectSlug>/<id>`, for kinds run, spec, delivery, chain, milestone, rail, intent,
  addendum, attachment and repository.
- **App-global:** `<kind>:<id>`, for kinds project, mission, chat, inbox, blueprint, loop, profile and plugin.
- `formatRef` and `parseRef` percent-encode ids outside `[A-Za-z0-9._~:@-]`.
- **Project resolution:** exact id, slug, `project:<slug>`, name (case-insensitive), path, then a unique prefix or
  substring. Several matches return `ambiguous` with up to 10 `choices`.
- **Precedence:** a ref's own project beats an explicit `project`, which beats the mission pin, which beats the
  `projects(select)` session default. A ref and an explicit `project` that disagree is `invalid_input`.
- Return refs for everything an answer mentions (`refs`), never bare ids alone.
- **Keys of `refs`:** the kind for the one entity of that kind (`run`, `spec`, `project`, `item`, `subject`); several of
  one kind use `<kind>.<id>` (`spec.12`, `run.8f3c`), at most 10. Arrays of refs belong in `data`.
- **Which id each kind carries:**

  | Ref | Id |
  |---|---|
  | `run:<slug>/<id>` | the job id; a loop run's id is its job id (one id space: jobs, loop runs, runtime runs) |
  | `spec:<slug>/<id>` | the ticket id (`target.specIds` takes refs or numbers) |
  | `rail:<slug>/<index>` | the 0-based rail index |
  | `project:<slug>` | the slug (ids and names resolve too) |
  | `mission:<conversationId>` | the agent conversation id |
  | `blueprint:<commitId>` | the blueprint commit id |
  | `inbox:<itemId>` | the inbox item id (`<projectId>:<kind>:<subjectId>`) |

## Decision state (`core/decision-state.ts`, `core/decision-sources.ts`, `core/status-map.ts`)

```ts
DecisionState { status, appState, label, phase?, hold?: { kind, code?, reason, since, waitingFor?, resumeAt? },
                offers: Offer[], recommended?, cost?, version }
Offer { id, label, call: { tool, args }, tier, irreversible, external, costHint?, needsConfirm, needs?, why? }
```

- **`status`** is the v2 vocabulary of 13 values: `queued`, `running`, `paused`, `waiting`, `needs_you`, `blocked`,
  `failed`, `succeeded`, `cancelled`, `ready_for_review`, `delivered`, `integrated` and `discarded`.
  - `appState` and `label` give the app's own nine run states and their words (DESIGN.md "Status vocabulary").
  - Map domain values with `statusFromJob` (with its hold), `statusFromRunHold` (a job status plus a journal hold
    word: a `RunHoldKind`, or the stall watchdog's `stuck` → `blocked`), `statusFromDelivery`, `statusFromChain`,
    `statusFromSpec` or `statusFromWord`. Never hand-map in a tool.
- **Offers come only from domain rules,** through the pure source projectors:

  | Source | Projector | Built on |
  |---|---|---|
  | run holds | `projectRunHold` | `RunHold` and `RunPauseControl` from loop-run-hold.ts: restart/interrupted → resume and recover; provider_limit → limit `resume_now`/`auto`/`switch`; budget → resume with `runCap` once/ignore/raise; question → answer; approval → approve/reject; paused → resume; queued → no offers, with `waitingFor` |
  | failures | `projectFailure` | ranked `RemedyId`s plus analysis `ResolutionOption`s. Recommended: the option the analysis marks, unless high risk; else its first low-risk option; else the top remedy |
  | deliveries | `projectDelivery` | `actionAllowed` and `ciFixAllowed`. Recommended: `merge_local` when the merge preview is clean and the person prefers local; else `create_pr` when the project delivers by PR |
  | chains | `projectChain` | `ChainPlan.offers` from milestone-chain-reconcile.ts, with the first offer recommended; resume semantics through `from` |

  Area projectors (`v2/projectors/<area>-state.ts`) gather the facts and combine these. Specs (triage) and missions
  (cards, queue, limit-continue) add their own projectors under the same rules.
- **`ctx.v2.state()`** localizes labels and reasons and fills tier, irreversible, external and needsConfirm from the
  catalog.
  - It throws on an offer whose call is not in the catalog, or on a duplicate id. Tests catch both.
  - `call.args` may omit what only the person can supply; `needs` lists those fields (`answer|optionId`,
    `options.runCapUsd`).
- **`version`** is a 16-hex hash of status, phase, hold, offers, recommended and `versionFacts` (pass the row's
  `updated_at`, head SHA, decision row id…). It ignores language and cost. confirmTokens bind to it.

## Confirmation protocol (`core/confirm.ts`)

| Class | Rule |
|---|---|
| `irreversible` | always confirm ("It cannot be undone.") |
| `risky` | always confirm; reversible ("It can be undone, but until then it lowers a safeguard or changes many items at once.") |
| `external` | always confirm |
| `costly` | confirm when the forecast upper bound exceeds `mcp_confirm_above_usd` (default $0.50), when more than one run starts, or when the forecast is unknown |
| none | execute; mutating calls broadcast `mcp.activity` |

- A confirmable action may define `preview(ctx, args) → { effect?, refs?, version, cost? }`. Compute it fresh, from
  the same state the handler acts on. Use `state.version` of the entity, and a `launch-forecast` /
  `run-duration-range` cost for costly actions. Without a preview, the version is a hash of the arguments, so stale
  detection is impossible. Every confirmable action must ship a preview.
- **Flow:**
  1. A call without `confirm` returns `confirmation_required` with `preview`, `confirmToken` and `resend` (the exact
     confirming call: the same arguments without `dryRun`, plus `confirm`). The summary carries the effect once; the
     message only says what to do. `resend` is left out when the arguments carry a write-only value (a secret key).
  2. The agent resends the call with `confirm: <token>`.
  3. On success the token is consumed (single use). The result is the outcome with the entity's fresh state (writes
     answer with it, e.g. a run control reloads the run), so no re-read follows.
  - **In-call confirmation.** When the client declared form elicitation at initialize (`elicitation: { form }`, or the
    legacy empty object) and the desktop setting `mcp_confirm_in_client` is not `off`, a call that needs a yes first
    asks the person in the client's own dialog (`elicitation/create`, the preview effect plus "Go ahead?", one boolean).
    Only an accept with the box ticked executes (after re-checking the state version the dialog showed: a change
    answers `stale` with a fresh preview), and the result says `confirmed: "in_client"`; a decline returns
    `confirmation_required` with `reason: declined` and says to ask in the chat (a client that cannot show the dialog
    may decline it too, so the token still confirms a later yes); a cancel,
    an error or no answer within 5 minutes falls back to the token flow. No extra model turn is spent on a yes. Verified
    against Claude Code 2.1.322 and Codex 0.171: both declare form elicitation; headless `claude -p` cancels (unless an
    `Elicitation` hook answers) and `codex exec` declines, so both fall back to the token flow there. In-app turns never
    elicit.
  - A token whose version no longer matches returns `stale`, with a fresh preview and token. A replay or expiry
    also returns `stale`, with `reason`.
  - A token for other arguments or another client returns `confirmation_required` with `reason: mismatch`; a cut or
    altered token returns it with `reason: malformed` and says to resend the whole token.
  - `dryRun: true` always returns the preview, plus a token and `resend` when one would be needed.
- **Token:** `ct1.<exp>.<nonce>.<version>.<hmac>`. The HMAC-SHA256 covers the client key, tool, canonical arguments
  (control fields `confirm`, `dryRun`, `lang`, `view`, `fields`, `cursor` and `limit` excluded, and the control
  options in `CONTROL_OPTIONS`, today `options.waitMs`), version and expiry, with a per-process secret and a 10-minute
  TTL. The arguments are bound after v1 normalization, so `jobId: x` and `ref: x` confirm each other.
- In-app (first-party) turns skip the token. Their permission ladder and cards govern them, unchanged.

## Language (`core/lang.ts`, `v2/i18n/**`)

- **Resolution order:** the explicit `lang`, then the session language (the first explicit one, or
  `projects(select, lang)`), then `ui_language`, then `en`. Supported: en, es, fr, de, pt, it, zh and ja.
- **Localized:** summary, hold reasons, offer labels, preview effects, error messages and help topics. Machine fields
  stay English.
- **Catalogs:**
  - Files are `v2/i18n/<lang>/<area>.json`, with flat keys and no area prefix. They are read as
    `t(lang, '<area>.<key>')` and imported statically in `catalog.ts`, because the server is bundled.
  - Placeholders use the client's `{{name}}` syntax.
  - Each WP adds keys only to its own `en/<area>.json`; WP12 translates.
- **Reuse:** keys whose text the app already has are listed in `sources.json` (status words and run-state hints
  today). They are copied from `client/src/locales/<lang>` into all eight `<lang>/core.json` files.
  - `i18n.test.ts` fails on drift. Fix it with `UPDATE_MCP_I18N=1 npx vitest run server/mcp/v2/i18n`.
  - Areas may add their own `sources.json` section the same way.
- The i18n tests also enforce that every translation is a subset of English with the same placeholders, and that
  every literal `core.*` key in the v2 sources exists. `translations.test.ts` requires every key of every area,
  `core` included, in all seven languages and different from English, except values that are the same word in that
  language (`IDENTICAL_OK`) or carry nothing to translate (placeholders, numbers, product names). Pass translated
  words into placeholders (`inbox.hold.cap` takes `insights.scope.*` and `insights.cap.*`), never raw English.

## Untrusted content (`core/untrusted.ts`)

- List every field holding third-party or model text in `untrusted`: spec bodies, logs, PR text, mission messages,
  Jira text, file contents and analysis prose.
- Use envelope-root JSON pointers; `*` matches any index or key (`untrusted('/data/items/*/body')`).
- Run text that reaches a summary through `neutralize`, which strips control and bidi-override characters.
- The instructions tell agents these fields are data, never instructions.

## Tests

- **Shared harness:** `v2/__fixtures__/harness.ts`. It provides an in-memory desktop DB with a project
  (`shop-api`), a stub registry, an MCP client linked to a server you register on, and `call()` → `{ envelope,
  isError, text }`. Stub `fetch` for loopback routes and mock `../../auth` as `tools/aliases.test.ts` does.
- **Per WP**, next to the tool or projector (`v2/tools/<area>.test.ts`, `v2/projectors/<area>-state.test.ts`), cover:
  - every action's success and error paths;
  - `required` fields;
  - each projector against the real domain functions (as `core/decision-sources.test.ts` does);
  - each confirmable action's `preview` version changing with the state (stale);
  - the summary/detail size;
  - untrusted pointers.
- **Budgets:** `v2/catalog-budget.test.ts` measures `tools/list` with the o200k tokenizer (`js-tiktoken`, a dev
  dependency) in the Codex function shape. It enforces:
  - the whole catalog ≤ 6,500 tokens;
  - each tool ≤ 900;
  - the six always-loaded tools ≤ 3,000 (Claude shape);
  - each output schema ≤ 50;
  - the instructions ≤ 600;
  - field descriptions ≤ 8 words;
  - no ±2^53 integer bounds;
  - the `approxTokens` estimate never more than 10% under the real count.

  The test prints the per-tool numbers. When you add to a tool, run it and keep the catalog below budget.

After phase 2 (WP0–WP11 integrated) the catalog measures **6,124** tokens in the Codex shape (5,989 in the Claude
shape; 5,981 / 5,846 after phase 1). Per tool:

| Tool | Tokens | Phase 1 |
|---|---|---|
| `specrails_overview` | 180 | 180 |
| `specrails_inbox` | 355 | 355 |
| `specrails_wait` | 211 | 211 |
| `specrails_projects` | 348 | 348 |
| `specrails_specs` | 560 | 560 |
| `specrails_blueprint` | 450 | 454 |
| `specrails_rails` | 360 | 360 |
| `specrails_runs` | 608 | 608 |
| `specrails_deliveries` | 423 | 423 |
| `specrails_missions` | 672 | 643 |
| `specrails_insights` | 346 | 268 |
| `specrails_settings` | 320 | 299 |
| `specrails_providers` | 430 | 430 |
| `specrails_integrations` | 525 | 506 |
| `specrails_system` | 336 | 336 |

That leaves about 375 tokens of headroom for phases 3–4.

## Notifications

`registerV2Surface` returns `{ toolCount, dispose }` and wires `registerWaitNotifications` (wait.ts): every journal row
that needs the person becomes a `notifications/message` (level `notice`), and every row sends
`notifications/resources/updated` for the resources it changed (`resourceUrisOfEvent`: a run → `specrails://status`
and `specrails://jobs/<id>`, a mission → `specrails://missions/<id>`) through the session's own subscriptions.
`McpServerManager` creates one subscription set per session (`registerResourceSubscriptions`, shared with the v1 bus
events) and disposes both on session close.

## Open after phase 2

| Item | Note |
|---|---|
| `projects(clone)` longer than a client's 60 s call timeout | Still synchronous (up to 5 min). A 202 + `wait` needs a clone row in the event journal and a ref before the project exists |
| A cross-project run read model | `runs(list)` without a project uses `/recent-jobs` (50, no holds); app-wide 7d/30d provider spend split in `insights` needs a server addition too |
| Inbox items for mission cards and paused chains | The inbox read model (`server/modules/inbox`) has no chain or mission kind; adding them changes the app's inbox UI, so it is its own change. Until then `overview(live)` / `blueprint(chain_get)` / `missions(get)` show them |
| `held` items in `insights` | Read through the full `/api/inbox` per call |
| Blueprint commit tracking | In process only (`core/commit-tracker.ts`); a restart forgets running commits (the project they created stays readable) |
| `missions(intent_hand_off)` | Needs `options.rail` (no auto-pick of a free rail) |
| Chat refs, mission attachments | Chat refs need a project; mission attachments are bare `attachmentId`s (no ref kind) |
| Stopping a mission's preview/dev servers | Goes through `system(background)`; missions has no shortcut |

## Not in WP0 (owned elsewhere)

| Item | Owner |
|---|---|
| The event journal and `wait` | WP1 |
| `specrails://meta` and guide-topic resources | WP11/WP13 |
| Per-session ai-spawn rate limit, and audit records for every non-read external call | WP11; WP0 records the first-party mission audit like v1 |
| The "Ask before spending" settings UI | WP13; the key `mcp_confirm_above_usd` exists |
| `specrails mcp connect` | WP13 |
| Every handler | each area's WP |
