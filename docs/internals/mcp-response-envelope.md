# MCP response envelope

How every Specrails MCP tool answers, so any client (Claude Code, Codex,
Gemini, Kimi, a custom agent, a desktop mascot) can relay results and chain
calls without knowing each tool's payload. User-facing overview:
[The Specrails MCP server](../mcp.md).

Source: [envelope.ts](../../server/mcp/tools/envelope.ts) (pure contract),
[summaries.ts](../../server/mcp/tools/summaries.ts) (hand-written summaries),
[types.ts](../../server/mcp/tools/types.ts) (`registerTieredTool` applies it to
every tool), [status.ts](../../server/mcp/tools/status.ts),
[inbox.ts](../../server/mcp/tools/inbox.ts),
[missions.ts](../../server/mcp/tools/missions.ts),
[job-logs.ts](../../server/mcp/tools/job-logs.ts),
[actions.ts](../../server/mcp/tools/actions.ts) (hidden aliases and per-action
fields), [board.ts](../../server/mcp/tools/board.ts),
[spend.ts](../../server/mcp/tools/spend.ts),
[resources.ts](../../server/mcp/tools/resources.ts) (the tool),
[summaries-catalog.ts](../../server/mcp/tools/summaries-catalog.ts) (read-action
summaries), [resources.ts](../../server/mcp/resources.ts) (MCP resources and
subscriptions), [prompts.ts](../../server/mcp/prompts.ts).

## Success

```ts
{ ok: true, summary: string, status?: string, data: unknown,
  ids?: Record<string, unknown>, links?: Record<string, string>,
  next?: Array<{ tool: string, args: object, why: string }>,
  truncated?: boolean, cursor?: string | number | null, partial?: boolean }
```

- Returned twice: as pretty JSON text in `content[0]` and as `structuredContent`.
  Each tool advertises the shape as its `outputSchema` (SDK 1.32 validates
  structured content of non-error results against it). A prose payload (the
  guide) keeps its readable text; the structured envelope still carries it.
- `data` is the tool's pre-envelope payload, unchanged. Consumers that parsed the
  old text now read `data`.
- `summary`: one or two plain sentences. Tools without a hand-written summary
  get a generic one (`specrails_jobs(list) returned 50 of 212 jobs.`).
  Every read action has a hand-written summary (`summaries.ts` for the most
  used ones, `summaries-catalog.ts` for the rest, keyed `tool:action`); the
  generic one remains the fallback when a payload has an unexpected shape.
  An alias call is summarized as the call it stands for.
- `next` suggests follow-up calls with exact arguments. A suggestion is never a
  permission: ai-spawn and destructive suggestions still need the person.
- A handler opts into its own metadata by returning `toolResponse(data, meta)`;
  plain data still works.

## Errors

```ts
{ ok: false, summary: string,
  error: { code, message, retryable, choices?, next?, http?, backendCode?, resend? } }
```

The result also sets `isError: true`. Codes are stable:

| Code | From |
| --- | --- |
| `invalid_input` | HTTP 400/422, a missing or malformed argument |
| `unauthorized` | HTTP 401/403, a disabled tier, an expired agent capability |
| `not_found` | HTTP 404, an unknown project/item/conversation (with `choices` when known) |
| `conflict` | HTTP 409/412, a busy rail, an already answered question |
| `rate_limited` | HTTP 429 (retryable) |
| `provider_unavailable` | HTTP 502/503/504, timeouts, an unavailable project database (retryable) |
| `ambiguous` | No project selected, `repository_required`; `choices` lists the valid values |
| `confirmation_required` | An external destructive call without `confirm:true`; `resend` has the exact arguments |
| `internal` | Anything else |

`message` is the backend's prose (`error`/`detail`/`message`), never the raw
`API GET … → 404: {json}` dump; `backendCode` keeps a machine code such as
`rail_busy`, and `http` names the loopback route that answered.

## Destructive confirmation and dry run

Tools with at least one destructive action (by evaluating the action tier) get
two optional inputs, `confirm` and `dryRun`, added in `buildToolSpecs`.

- External client, destructive tier, no `confirm:true` → `confirmation_required`
  with `resend: { tool, args: { …, confirm: true } }` and a dry-run suggestion.
  Nothing executes.
- `dryRun:true` (any tier) → `{ status: 'dry_run', data: { tool, action, tier,
  args, effect, wouldExecute: false, requiresConfirm } }`. Nothing executes.
- The tier check runs first: a disabled Destructive tier still refuses.
- The in-app agent (a verified capability) is governed by its live permission
  ladder and its own cards, so it is not asked again.
- The control fields never reach the handler or the activity broadcast.

The Destructive tier remains on by default.

## Hidden aliases and per-action validation

`actions.ts` keeps moved actions working without advertising them:

- `actionEnum(advertised, hidden)` accepts every value at runtime; zod v4
  metadata overrides the generated JSON-schema `enum` with the advertised ones.
- `McpToolSpec.aliases` maps a hidden action to `{ tool, action, args? }`.
  `linkAliases` (run by `buildToolSpecs` and by `jobsTools` / `specsTools`
  themselves, idempotent) routes the alias's tier, Intent `tierException` and
  handler to the target, so a direct handler call works too.
- `registerTieredTool` registers an aliased tool's schema as a loose object (the
  moved arguments must survive the SDK's parse), then parses an alias call with
  the target tool's own zod schema, validates its per-action fields and
  summarizes it under the target's name.
- `McpToolSpec.actionFields` declares `required` / `oneOf` / `optional` per
  action. Missing fields fail with `invalid_input` before any REST call; fields
  an action ignores are tolerated for older clients. `specrails_describe`
  publishes them per action.
- Annotations stay conservative for a tool that still accepts write aliases
  (`specrails_specs`), because clients may auto-approve `readOnlyHint` tools.

## Pagination

`GET /api/projects/:id/tickets` and `GET /api/projects/:id/rails` accept
optional `limit` (tickets ≤ 200, rails ≤ 100) with `cursor` (opaque, from the
previous `nextCursor`) or `offset`; without `limit` their answer is unchanged.
A paged tickets answer adds `matched`, `statusCounts` (of the whole match),
`offset`, `limit`, `nextOffset`, `nextCursor` and `cursorStale` when the cursor
predates the store revision; `groupBy=status&perGroup=N` returns per-status
`groups` for boards. Paged rails keep only the page's entries in
`activeJobs` / `activeLoopRuns` / `prDeliveries` and add `total`. A malformed
cursor is `400 invalid_cursor` ([page-cursor.ts](../../server/util/page-cursor.ts)).
`specrails_specs(list)` still pages in memory when an older server ignores
`limit`.

## `specrails_board`, `specrails_spend`, `specrails_resources`

- Board: `GET /tickets?groupBy=status`, `GET /rails`, `GET /queue` in parallel;
  each source fails independently (`partial`, `sources`). Columns follow the
  workflow order, then unknown statuses.
- Spend: app-wide `GET /api/analytics` (period; `today` is the local day as
  exact UTC instants, like `specrails_status`) + `GET /api/budget/caps`; with
  `projectId`, `GET /projects/:id/spending` (with the local `tzOffsetMinutes`) +
  `/budget/caps`. `top` lists the costliest projects (app) or specs and missions
  (project). `status: 'cap_exhausted'` when any cap is exhausted.
- Resources: `GET /api/resources`, or with `conversationId`
  `GET /projects/:id/missions/:chatId/resources` (project from the argument,
  else the mission pin, else the active project). It never starts a disk scan.

## Resources, subscriptions and prompts

`registerResources` serves `specrails://status` (`collectStatus`),
`specrails://projects/{id}/board` (`collectBoard`, listed per project),
`specrails://jobs/{jobId}` (the jobs `get` handler with 20 events, trying each
loaded project until one does not answer 404) and
`specrails://missions/{conversationId}` (the missions `get` handler).
`registerResourceSubscriptions` declares `resources.subscribe`, keeps the
session's subscribed URIs, listens to the in-process event bus that mirrors
every WebSocket broadcast and maps events with the pure `resourceUrisFor`
(status: queue, rail, loop-run, mission-turn, spending and inbox triggers;
board: spec, rail, loop-run and queue events of that project; job: any event
with its `jobId`; mission: `agent*`/`mission*` events of its conversation; log
and token-stream frames never notify). One notification per URI per second;
the session's disposer stops it on close. Prompts (`prompts.ts`) render
fixed text with the tool calls to make.

## `specrails_status`

One app-wide glance, read tier. Sources, fanned out with at most 4 in flight and
a 2.5 s timeout each (loopback REST, master token):

| Field | Source |
| --- | --- |
| `active.missions` | `GET /api/agent/active-turns` (+ `GET /api/agent/conversations` for titles, provider/model, context usage). A 404 (Agent chat off) is "no missions", not a failure |
| `active.rails` | `GET /api/projects/:id/rails` per project (first 12): `activeJobs`, `activeLoopRuns` |
| `active.jobs` | `GET /api/recent-jobs?limit=30`: running/queued jobs not already shown on a rail |
| `needsYou` | `GET /api/inbox` (first 10; `needsYouTotal` counts all) |
| `failures` | Inbox `failed`/`blocked` items plus jobs failed in the last 24 h (max 5). The reason comes from the failure diagnosis; `hasAnalysis` and a missing diagnosis are read from the job's own project database through the recovery adapter |
| `spendToday` | `GET /api/analytics?period=custom&from=<UTC day>&to=<UTC day>`: `kpi.totalCostUsd`, estimated part, `byCategory` |
| `resources` | `GET /api/resources` totals |

- A failing source sets `partial: true` and names itself in `sources`
  (`HTTP 500`, `timeout`, …); the rest is still returned.
- `mood`: `needs_you` when an inbox item other than a failure waits for the
  person, else `failing` when there are recent failures, else `working` when
  anything runs, else `idle`.
- `etag` hashes meaningful state only (mood, active ids, inbox ids/versions,
  failures, spend in cents). CPU/memory and `capturedAt` are excluded, so a
  poller passing `ifNoneMatch` gets `{ unchanged: true }` until something the
  person would notice changes.

## `specrails_inbox` and `specrails_missions`

The inbox reuses the desktop read-model (`GET /api/inbox`) and the companion's
action rules (`companionTargetsFor` in
[mobile-inbox.ts](../../server/mobile/mobile-inbox.ts)): `answer` (write),
`resume` and `retry` (AI-spawn) are forwarded to the same desktop routes the
phone uses. PR decisions, merge and discard stay in the app. `open` reads the
item's subject (review packet, pending question, loop run or budget).

Missions forward to `/api/agent/…`. `send` posts only `text` and `deliveryMode`
(never `tierLevel`, provider, model or pin); `ask` defaults the selection to the
latest assistant reply; `abort` is destructive. A mission cannot message,
question or stop its own conversation through MCP.

## Failures: `diagnose_failure` and `logs`

`specrails_jobs(diagnose_failure)` combines the job's deterministic
`failureDiagnosis` with the saved AI analysis (`GET …/failure-analysis`);
`generate:true` (AI-spawn) posts for a new one when none is current.
`specrails_jobs(logs)` splits the job's events into steps and returns the failed
step's lines first, then the end of the log (default 200 lines, max 1000, 40 000
characters), using the recovery module's `logLinesFromEvents`.

## Known gaps

- No route lets an MCP client focus the desktop UI on an item; `open` returns
  the detail instead.
- `spendToday` and `specrails_spend(period:"today")` ask the analytics route for
  the local day as exact UTC instants.
- The in-app mission prompts still name the legacy `specrails_jobs(runtime_*)`
  and `specrails_jobs(background_*)` actions; they run through the aliases.
- `specrails_runs` has no `fork`: the runtime exposes no fork route.
