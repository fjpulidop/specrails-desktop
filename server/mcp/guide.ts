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
Codex, Gemini, Kimi Code) to implement specs.

## The object model

- **Project**: a registered repository. Almost every tool is project-scoped and
  takes a \`projectId\`. \`specrails_select_project\` sets a sticky active project
  so later calls can omit it; an explicit \`projectId\` overrides.
  \`specrails_projects(get)\` includes the repo's absolute path.
- **Spec / ticket**: a unit of work in a project's backlog. Statuses \`draft\`,
  \`todo\`, \`in_progress\`, \`on_review\` (implemented, awaiting human PR review),
  \`done\`, \`cancelled\`, plus a \`needs_review\` boolean FLAG
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
  AUTOMATICALLY: launch → \`in_progress\`; success → \`done\` (or \`on_review\` when
  the rail delivers a draft PR — the spec waits there for the human PR
  decision: merge → \`done\`, discard → \`todo\`); revert → \`todo\`;
  partial confidence → \`done\` + \`needs_review\`. Do not patch statuses the
  pipeline manages.
- **Loop**: an APP-LEVEL saved workflow graph (not project-scoped). Author with
  \`specrails_loops\`; RUN it with \`specrails_rails(launch, mode:'loop', loopId)\`.
- **Profile**: per-project agent configuration (which agents, which models,
  routing). Supported by Claude and Kimi; forced to null for Codex/Gemini rails.
- **Provider / engine**: claude, codex, gemini or kimi. A project installs one or
  more; a requested engine must be one of the installed set.
- **Plugin**: an MCP-based integration installed per project (e.g. serena).

## Creating specs — three paths, one decision rule

Before creating a spec, classify the user's intent. If they are asking for
help using Specrails, installation/setup, a failed job, missing agents/skills,
MCP connection, provider auth, GitHub/PR delivery, costs, or "how do I...?"
support, DO NOT create a spec. Call \`specrails_support(action:'triage')\`
and solve it conversationally first. Only move to spec creation when the user
explicitly asks for product/backlog work.

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

- Rails are DYNAMIC: \`create_rail\` (write) adds a new slot — up to 12 per
  project — and returns its \`railIndex\`. When every rail is busy or holds
  other work, create one and proceed; never wait for a slot.
- Parallel launches are safe and normal: each launch isolates its work in
  per-ticket git worktrees, so several rails can run at once. \`launch_all\`
  (ai-spawn) launches EVERY rail that has tickets and no active run /
  uncontinuable pending PR decision in one call, each with its stored
  mode/engine/profile, returning per-rail outcomes (launched / skipped with
  reason / failed).
- Relaunching an \`on_review\` ticket with a matching OPEN GitHub PR continues
  that PR's head branch automatically. Jira-linked \`in_progress\` tickets can
  also continue an open PR when the match is explicit, covering Jira projects
  whose Review status has not been mapped to Specrails \`on_review\`. New
  tickets, or tickets without a confident open-PR match, keep the normal
  branch-from-integration flow.
- A published PR delivery (\`decision:'pr_ready'\`) is still an open PR
  continuation target when it has a PR URL/head branch covering the rail's
  tickets. Do not tell the user to Publish/Discard/Merge first when they ask for
  more changes on that same PR; assign the spec(s) to a rail and launch again.
- Projects without Git cannot use isolated worktrees or PR continuation. A
  launch degrades to shared-cwd execution and returns \`isolationUnavailable\`;
  explain that it writes directly to files and no PR card/branch will appear.
- Configure: \`set_tickets\` (replaces the assigned set), \`set_profile\` (null =
  legacy), \`set_engine\` (null = project primary), \`set_name\`.
- Launch modes:
  - \`implement\`: one pipeline job (Architect → Developer → Reviewer → Ship)
    over the rail's tickets.
  - \`batch-implement\`: dependency-aware waves across many tickets.
  - Freestyle: sends a free-form autonomous prompt to a capable provider — one
    job per ticket; Claude and Kimi; \`model\` picker. Claude additionally
    supports optional \`interactive\` in-job chat (settle with
    \`specrails_jobs(finalize)\`). To launch it through the API, pass the canonical mode value \`freestyle\`. In user-facing language, call
    the feature "Freestyle".
  - \`loop\`: runs a published loop graph per ticket (\`loopId\`,
    \`reasoning_effort\`).
- Profiles are supported by Claude and Kimi: a profile set on a rail that is
  then pointed at Codex/Gemini is force-nulled.
- \`stop\` kills the rail's process tree AND cancels its queued jobs
  (destructive).
- \`specrails_jobs(spawn, command)\` bypasses rails and enqueues an arbitrary
  slash-command job (e.g. \`/specrails:implement #5 --yes\`); \`queue\`, \`pause\`,
  \`resume\`, \`reorder\`, \`priority\` manage the queue.
- Long-running shell commands launched with \`specrails_jobs(background_start)\`
  create chat chips. Start/kill are destructive and available only to an
  authenticated in-app Agent turn at Autonomous level after explicit user
  confirmation; third-party MCP clients cannot invoke them. Use
  \`specrails_jobs(background_logs, pid)\` to read bounded stdout/stderr tail
  when a chip exits or fails.

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
create_rail, plugin install, Jira connect = write; spec create/generate, rail
launch/launch_all, chat send, job spawn = ai-spawn; spec delete, rail stop, job
purge, plugin uninstall, Jira disconnect, project unregister = destructive.
\`specrails_support(triage/core_update_status/core_update_check)\` is read;
\`specrails_support(core_update_apply)\` is ai-spawn because it runs longer
global update work. Note the
embedded spec-refinement happy path (investigate + commit_draft) needs only
read + write — ai-spawn is required only to launch work or spawn a nested AI.

## Providers & capability-gated surfaces

- Installed providers are per-project; AI-spawning calls may pick any installed
  one (\`aiEngine\`); rails carry a per-rail engine.
- Claude and Kimi support agent profiles and Freestyle mode (pass the canonical
  API value \`freestyle\`; call the feature "Freestyle" to users). Persistent
  interactive jobs remain Claude-only.
- Kimi prompt mode cannot enforce a no-tools or read-only boundary. Consequently
  pure-output and safety-bounded surfaces fail closed before spawn: Quick Spec,
  AI Edit, Contract Refine, SMASH, Builder chat/commit, milestone generation,
  Loop Decider, Code Explorer AI summaries, and Agent Studio automation. Use
  Explore/direct authoring or another installed provider for those surfaces.
- Cost figures are authoritative for Claude and estimated for Codex/Gemini
  (flagged as estimated in analytics). Kimi cost is unavailable when its stream
  omits usage and billing data.

## Domain cheat-sheet

- **Epics / SMASH** (\`specrails_specs\`): \`smash\` splits a large spec into child
  specs with a structured-action provider (currently Claude); \`smash_undo\`
  restores (needs the \`smashedAt\` stamp);
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
- **Support** (\`specrails_support\`): use FIRST for installation/usage help,
  provider CLI/auth, MCP/Agent Chat issues, missing agents/skills/commands,
  failed jobs, PR delivery confusion, costs, and plugin questions. It returns a
  support playbook plus local diagnostics and never creates specs. When a job
  says agents, skills, or slash commands are missing, explain that upstream
  definitions live in the APP-GLOBAL specrails-core framework, not inside the
  project. For specrails-core installation questions, project setup checkpoints
  are NOT a health signal: pending checkpoints or 0 agents/commands do not prove
  a core problem and must not trigger \`specrails_setup(install)\`. If global
  core is stale, offer \`core_update_check\` + \`core_update_apply\`. If global
  core is current but a real job still reports missing core definitions, ask for
  the job error/diagnostic and give the manual fallback for standalone/legacy
  core installs: from the project root, run \`npx specrails-core@latest update\`,
  then retry the job.
- **Loops lifecycle** (\`specrails_loops\`): Draft → \`publish\` (graph-validated)
  → runnable; \`update\` reverts to Draft and returns 409 while running;
  \`preview\` dry-runs token resolution without spawning; constants are shared
  values graphs reference.

## Operating discipline

- Do not mutate statuses the pipeline manages (\`in_progress\`/\`on_review\`/\`done\`
  transitions ride job outcomes and the PR-review decision).
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
