// The platform guide returned by the `specrails_guide` meta tool and the
// `specrails://guide` resource. This is what lets an external LLM "understand
// the platform" without prior knowledge. It is intentionally English (the LLM
// consumes it); human-facing onboarding docs are localized separately.
//
// Keep this BYTE-STABLE where possible (no timestamps / live data) so MCP
// clients that cache resources stay valid.

export const SPECRAILS_GUIDE = `# Specrails Desktop — Agent Guide

You are operating Specrails Desktop through its MCP server — either as an
EXTERNAL MCP client (Claude Desktop, Cursor, a custom agent) or as the app's own
embedded agent chat. Everything here applies to both, except Permissions, which
differs by client kind (see below).

Specrails is a local dashboard + pipeline runner that manages multiple software
projects (registered repositories) and drives AI coding agents (Claude Code,
Codex, Gemini) to implement specs.

## The object model

- **Project**: a registered repository. Almost every tool is project-scoped and
  takes a \`projectId\`. \`specrails_select_project\` sets a sticky active project
  so later calls can omit it; an explicit \`projectId\` overrides.
  \`specrails_projects(get)\` includes the repo's absolute path.
- **Spec / ticket**: a unit of work in a project's backlog. Statuses \`draft\`,
  \`todo\`, \`in_progress\`, \`done\`, \`cancelled\`, plus a \`needs_review\` boolean FLAG
  set on \`done\` specs when the pipeline ships with partial confidence (it is
  not a status). Priorities \`critical|high|medium|low\`. INVARIANT: priority may
  be null ONLY when status is \`draft\`. Specs can be epics with children (see
  SMASH) and can be Jira-backed (\`source: 'jira'\`).
- **Rail**: a persistent numbered launch slot that runs the AI pipeline over its
  assigned tickets. A rail REMEMBERS its config across launches: ticket ids,
  mode, profile, engine, name. Launching spawns AI CLI processes that write
  code, run tests and commit — it costs money and runs for minutes.
- **Job**: one spawned pipeline run. Jobs stream events over the app's bus and
  settle (completed/failed/canceled). Job outcome mutates spec status
  AUTOMATICALLY: launch → \`in_progress\`; success → \`done\`; revert → \`todo\`;
  partial confidence → \`done\` + \`needs_review\`. Do not patch statuses the
  pipeline manages.
- **Loop**: an APP-LEVEL saved workflow graph (not project-scoped). Author with
  \`specrails_loops\`; RUN it with \`specrails_rails(launch, mode:'loop', loopId)\`.
- **Profile**: per-project agent configuration (which agents, which models,
  routing). CLAUDE-ONLY; forced to null for codex/gemini rails.
- **Provider / engine**: claude, codex or gemini. A project installs one or
  more; a requested engine must be one of the installed set.
- **Plugin**: an MCP-based integration installed per project (e.g. serena).

## Creating specs — three paths, one decision rule

1. **Quick (AI-generated)** — \`specrails_specs(action:'generate', idea, …)\`, or
   the simpler \`create\` with title/description: routes through the app's Quick
   Add Spec — an AI pass structures the request into a complete spec, so
   MCP-created specs are indistinguishable from UI-created ones. \`generate\`
   additionally accepts \`contextScope\`, \`attachmentIds\`, \`createLocal\`. Async
   (202): watch the returned ref. Use for clear, well-scoped requests.
2. **Explore (multi-turn refinement)** — when requirements are fuzzy:
   - \`specrails_chat(create, kind:'explore', contextScope)\` → keep the
     conversation id.
   - First \`send\`: text \`/specrails:explore-spec\` + blank line + the idea, with
     \`lightweight: true\`, \`maxTurns: 20\`. Watch each turn by conversationId
     (\`chat_done\` / \`chat_error\` are terminal).
   - \`specrails_chat(spec_draft)\` reads the live structured draft the Explore
     assistant maintains (title, description, labels, priority,
     acceptanceCriteria, ready).
   - When converged: \`specrails_specs(save_draft, conversationId)\` parks a
     resumable draft ticket; \`specrails_specs(commit_draft, conversationId,
     title, …)\` creates the real spec. Passing the conversationId preserves the
     origin link ("Continue Explore", Contract Refine eligibility).
   - \`contextScope\` flags: \`specrails\` (pipeline context), \`openspec\` (spec
     history), \`full\` (whole-repo access), \`mcp\` (project .mcp.json servers),
     \`userMcp\` (the user's own approved MCP servers), \`contractRefine\` (append
     a Contract Layer after commit).
   An EMBEDDED agent may instead run the refinement conversation ITSELF (no
   nested AI spawn, no extra cost) and persist via path 3 — use the app's
   Explore when the user wants the draft visible and resumable in the UI.
3. **Direct insert (no AI)** — for a COMPLETE spec you already hold:
   - \`specrails_specs(commit_draft)\` with NO \`conversationId\`/\`draftTicketId\`
     is the canonical rich insert: \`title\` (required), \`description\`,
     \`acceptanceCriteria\` (folded into an \`## Acceptance Criteria\` section),
     \`priority\`, \`labels\`, \`shortSummary\` (max 240 chars). One write call.
   - \`specrails_specs(from_prompt)\` stores a description verbatim but CANNOT
     set acceptanceCriteria or shortSummary — prefer \`commit_draft\` for
     structured specs.
   - Follow with \`update\` for assignee/prerequisites/metadata when needed.
   - Never route an already-refined spec through \`create\`/\`generate\` — they
     REGENERATE the content with AI.

A complete spec matches the app-generated shape: short imperative English
\`title\`; one-sentence \`shortSummary\`; a \`description\` with the sections
\`## Problem Statement\`, \`## Proposed Solution\`, \`## Out of Scope\`,
\`## Technical Considerations\`, \`## Estimated Complexity\`; a separate
\`acceptanceCriteria\` array (never duplicated inside the description; no title
heading inside the description); \`labels\`; \`priority\`. Spec content is English.

## Running the pipeline (rails)

- Configure: \`set_tickets\` (replaces the assigned set), \`set_profile\` (null =
  legacy), \`set_engine\` (null = project primary), \`set_name\`.
- Launch modes:
  - \`implement\`: one pipeline job (Architect → Developer → Reviewer → Ship)
    over the rail's tickets.
  - \`batch-implement\`: dependency-aware waves across many tickets.
  - Freestyle (wire value \`ultracode\`): hands the spec straight to the model —
    one job per ticket; Claude-only; \`model\` picker; optional
    \`interactive\` in-job chat (settle with \`specrails_jobs(finalize)\`).
  - \`loop\`: runs a published loop graph per ticket (\`loopId\`,
    \`reasoning_effort\`).
- Profiles are Claude-only: a profile set on a rail that is then pointed at
  codex/gemini is force-nulled.
- \`stop\` kills the rail's process tree AND cancels its queued jobs
  (destructive).
- \`specrails_jobs(spawn, command)\` bypasses rails and enqueues an arbitrary
  slash-command job (e.g. \`/specrails:implement #5 --yes\`); \`queue\`, \`pause\`,
  \`resume\`, \`reorder\`, \`priority\` manage the queue.

## Async results (IMPORTANT)

Cost-incurring / streaming actions (launch a rail, generate a spec, send a chat
turn, refine an agent, SMASH, install a plugin) return 202 immediately with a
reference (jobId / conversationId / requestId) and emit the REAL result over
the app's event bus. \`specrails_watch(projectId, ref, untilMs)\` waits for the
operation to settle. Rules:

- \`projectId\` is REQUIRED on watch — it does not default to the active project.
- Default \`untilMs\` is 120000 (max 600000); rails routinely run longer.
- \`settled:false\` means TIMEOUT, not failure: the operation may still be
  running, or may have finished without a watch-terminal event. Re-watch with a
  larger window or poll the domain read to confirm: \`specrails_jobs(get)\`,
  \`specrails_specs(get)\`, \`specrails_plugins(health)\`.
- Chat turns are watched by conversationId (\`chat_done\` / \`chat_error\`).

Never assume success from the 202 acceptance alone.

## Permissions — two regimes

- **External MCP clients** (Claude Desktop, Cursor, …): four INDEPENDENT opt-in
  tiers configured by the user in the app's Settings ▸ MCP — Read (always on),
  Write, AI-spawn (costs money), Destructive. On refusal, tell the user to
  enable the named tier in Settings ▸ MCP.
- **The in-app agent chat**: a CUMULATIVE ladder the user steers live with
  Shift+Tab — observe (read) ▸ edit (+write) ▸ operate (+ai-spawn) ▸ autonomous
  (+destructive). It overrides the Settings checkboxes for that chat. On
  refusal, tell the user to raise the level with Shift+Tab.

Tools cannot raise their own permissions in either regime. Common tiers:
list/get/spending/watch = read; commit_draft, from_prompt, update, set_tickets,
plugin install, Jira connect = write; spec create/generate, rail launch, chat
send, job spawn = ai-spawn; spec delete, rail stop, job purge, plugin
uninstall, Jira disconnect, project unregister = destructive. Note the
embedded spec-refinement happy path (investigate + commit_draft) needs only
read + write — ai-spawn is required only to launch work or spawn a nested AI.

## Providers & Claude-only surface

- Installed providers are per-project; AI-spawning calls may pick any installed
  one (\`aiEngine\`); rails carry a per-rail engine.
- CLAUDE-ONLY: agent profiles, Contract Refine, SMASH, Freestyle mode
  (\`ultracode\`), interactive jobs. They are rejected or inert when the
  effective engine is codex or gemini.
- Cost figures are authoritative for claude and estimated for codex/gemini
  (flagged as estimated in analytics).

## Domain cheat-sheet

- **Epics / SMASH** (\`specrails_specs\`): \`smash\` splits a large spec into child
  specs (Claude-only); \`smash_undo\` restores (needs the \`smashedAt\` stamp);
  \`delete_epic_children\` removes a whole family.
- **Attachments**: \`list_attachments\` / \`get_attachment\` read files the user
  attached in the app UI; \`generate\` / \`ai_edit\` accept \`attachmentIds\`.
  Uploading new attachments is not available over MCP.
- **Jira** (\`specrails_jira\`): per-project connection (the token stays
  on-device). Jira-backed specs carry a LOCAL numeric id — never a \`PROJ-123\`
  key; map via \`links\`. Status write-back flows through a durable outbox
  (\`outbox\`, \`retry_outbox\`).
- **Code explorer** (\`specrails_code\`): read-only repo browsing — \`tree\`
  (provenance: which specs/jobs touched each file), \`read_file\`, \`summary\`,
  \`provenance\`, \`diff\`. There is no MCP write path to files.
- **Analytics** (\`specrails_analytics\`): \`spending\` aggregates by surface
  (\`job\`, \`quick-spec\`, \`explore-spec\`, \`ai-edit\`, \`file-summary\`), model,
  ticket, day. Prefer \`spending\` over raw \`invocations\`/\`export\` for token
  economy. TWO budget knobs exist: \`specrails_analytics(budget_set,
  dailyBudgetUsd)\` is PER-PROJECT and pauses that project's queue when
  exceeded; \`specrails_settings(set, dailyBudgetUsd)\` is the APP-WIDE budget.
- **Plugins** (\`specrails_plugins\`): per-project MCP integrations; \`preview\`
  the diff before \`install\`; a degraded plugin never blocks rail launches.
- **Profiles** (\`specrails_agents\`): per-project agent chains; the baseline
  trio \`sr-architect\`/\`sr-developer\`/\`sr-reviewer\` is required; routing rules
  end in a single terminal \`default: true\` rule; requires specrails-core
  4.1.0 or newer.
- **Setup** (\`specrails_setup\`): \`prerequisites\` → \`add_project\` →
  \`install_config\` per provider → ONE \`install\` (provisions all chosen
  providers; quick-only, offline) → poll \`checkpoints\` until
  \`isInstalling === false\`.
- **Loops lifecycle** (\`specrails_loops\`): Draft → \`publish\` (graph-validated)
  → runnable; \`update\` reverts to Draft and returns 409 while running;
  \`preview\` dry-runs token resolution without spawning; constants are shared
  values graphs reference.

## Operating discipline

- Do not mutate statuses the pipeline manages (\`in_progress\`/\`done\` transitions
  ride job outcomes).
- Confirm cost-incurring (ai-spawn) and destructive actions with the user
  first, with cost/risk framing.
- Report ids and results verbatim; never fabricate outcomes.
- Use \`specrails_search\` / \`specrails_describe\` to discover the exact action
  and arguments instead of guessing.

## Resources

Read-only state is also exposed as MCP resources: \`specrails://guide\` (this
document), \`specrails://projects\` (all registered projects), and
\`specrails://projects/{projectId}\` (one project by id).
`
