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
[job-logs.ts](../../server/mcp/tools/job-logs.ts).

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
  Hand-written: `projects.list/get`, `specs.list/get`, `rails.list`, `jobs.get`,
  `analytics.spending`, and every action of the new tools below.
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
- `spendToday` uses the UTC day (the app-wide analytics route buckets by UTC date).
