# MCP and mission operator reliability audit

Date: 2026-09-05. Branch: `feat/codex-gpt-6-astra`.

This audit covers the embedded MCP server, stdio bridge, tool contracts and
mission operator context. It builds on the implementation/worktree and startup
recovery fixes already present on this branch. No production AI runs were
launched, no project state was changed through the audited operational tools,
and no remote PRs were created. Source changes are retained on this branch.

## Findings and corrections

| Failure | Correction |
| --- | --- |
| A missing scoped spec/job could resolve to an entity in another project; references were deduplicated without their project scope. | Treat a project id as an exact address, retain scope in deduplication, report ambiguous/unavailable references, and never substitute another repository. |
| Missions received a project id but little current project context. A fresh provider session could lose conversation history. | Add bounded live project/provider/backlog/job orientation per turn and restore recent persisted history only on fresh invocations. Historical messages are labelled as data; current settings and live evidence take precedence. |
| An empty resumed reply could trigger a replay after tools had already executed. Missing MCP wiring silently launched a tool-less paid agent. | Retry only explicit stale-session errors without tool activity. Fail before provider launch if MCP preparation fails. |
| Project selection was process-global across external MCP clients. Mission selection could claim success despite its immutable capability pin. | Isolate defaults per MCP session. Preserve the mission pin, including Home; explicit project ids address intentional operations elsewhere. |
| Invalid/revoked mission capabilities could fall through to external-client permissions. Sessions were not bound to their originating capability. | Reject invalid capabilities, bind session ownership to the capability, close revoked/expired/idle sessions, and fail explicitly when the bridge cannot read its capability file. |
| Token rotation and session loss left clients disconnected or hanging. | Refresh bridge authentication on each request, retry a rejected 401 only after a token change, reinitialize after a protocol session 404, and terminate remote sessions on close. Network failures never replay a possibly-started mutation. |
| MCP admin tier edits could partially apply before returning 400; token rotation left old streams alive. | Validate all tier fields before writes; rotating the token closes existing sessions. Failed token persistence cannot silently publish an unusable token. |
| Mixed read/write facades advertised read-only MCP annotations. Some draft commits that can spawn Contract Refine were classified as Write. | Publish conservative facade annotations, expose precise action/argument tier previews, and enforce AI-spawn for potentially cost-incurring commits. |
| The project catalog and diagnostics hid registered projects whose databases were unavailable. | Use durable registry rows for tools/resources, preserve identity and show availability explicitly. Context sections fail independently rather than implying empty state. |
| Tool discovery ignored action names and nested argument structure. | Search names/actions/schema descriptions, support common Spanish intents, expose full SDK-generated JSON schemas, and validate prospective arguments without execution. |
| Watch only observed future events and could wait for completed jobs/loops; whole-payload substring matching could settle on the wrong entity. | Read durable job/loop state before waiting, match typed identity fields, retain bounded events, distinguish failure, and support cancellation. |
| Raw file reads and job histories could consume excessive model context; Code Explorer only searched filenames. | Add literal content search, bounded source pages with line/column continuations and revision hashes, compact spec/job lists and paginated event history. Partial results explicitly report their limits. |
| Operational tools omitted useful review evidence and conversational launch defaults. | Add PR candidates/review packets, Git/worktree information, PR lookup and phase breakdowns. Preserve conversation provider/model/effort when launching compatible jobs/loops, and report when isolation is unavailable. |
| Binary attachments were forwarded through a text response path. | Return attachment metadata and a download reference instead of decoding arbitrary bytes as text. |

## New investigation workflow

1. Identify the intended project from the conversation pin or durable catalog.
2. Read `specrails_context` sections relevant to the question: `overview`,
   `backlog`, `runs`, `git`, `blueprint`. Each result names its source and reports
   unavailable data; these independent reads are not an atomic snapshot.
3. Locate behavior/tests with `specrails_code(search)` and read exact source
   ranges. Use the returned hash when continuing to detect intervening edits.
4. Discover exact tool arguments and permissions with `specrails_describe`.
   Schema validation does not execute the tool or replace backend checks.
5. Inspect execution evidence and the verified review packet before describing
   completion. Refresh affected context after operations.

The catalog now has 22 tools. Existing domain tools gain focused read actions;
implementation and delivery still use the app's existing validated routes.

## Validation

Focused regression suites cover real HTTP/SDK session isolation and recovery,
capability revocation, tier boundaries, temporary project databases, source
search/read bounds, historical context and no-replay behavior.

- Server/CLI/MCP: 281 test files, 7,394 passing tests. Coverage: statements
  85.97%, branches 78.38%, functions 90.02%, lines 88.31%; all thresholds pass.
- Client: 348 test files, 4,335 passing tests. Coverage: statements/lines 89.13%,
  branches 82.86%, functions 74.35%; all thresholds pass.
- TypeScript, app/server/CLI build and the bundled MCP bridge build pass.
- Core compatibility passes: core 4.11.1 with desktop 2.40.0.
- `git diff --check` passes. The app build retains the existing Vite large-chunk
  advisory; it is not a build failure.

Total for this audit's complete run: 11,729 passing tests, including 120 more
server/CLI/MCP tests than the preceding startup-recovery audit. Test fixtures
use temporary databases/repositories and local HTTP servers.

## Practical limits

- This establishes deterministic platform behavior under the tested failures;
  it cannot guarantee the quality or success of every future model-generated
  implementation or third-party provider/GitHub operation.
- Durable watch recovery covers jobs and loop runs. Other async operations use
  future bus events and their domain reads; there is no generic durable replay.
- Context is deliberately bounded, and blueprint milestones are plans rather
  than proof that work is done. Truncated or unavailable results require a
  narrower source read, never a fabricated conclusion.
- The application sources and bundles are updated on this branch. Updating the
  installed native application remains a separate release/install operation.
