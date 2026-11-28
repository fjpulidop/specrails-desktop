/**
 * The compact text a client's model sees in `tools/list` (the "wire" catalog).
 *
 * Every tool and field keeps its complete description in its own tool file:
 * `specrails_describe(name)` / `specrails_describe(name, action)` return it, and
 * `specrails_search` and the destructive-effect text read it. `tools/list`
 * carries the brief instead, because the whole list is resent on every mission
 * turn. A brief keeps: purpose, the actions with a few words each, their tier
 * when not read, and the pointer to describe/guide. Field briefs stay under
 * {@link FIELD_BRIEF_MAX} characters and never repeat what the name, type or
 * enum already says. A field without a brief keeps its description when short
 * enough (enforced by wire-schema.test.ts). An empty brief drops the text.
 *
 * Pure data: no imports.
 */

export const FIELD_BRIEF_MAX = 80

export interface ToolBrief {
  /** Wire description of the tool. */
  description?: string
  /** Wire descriptions per input field. */
  fields?: Record<string, string>
}

/** Fields shared by many tools. */
export const COMMON_FIELD_BRIEFS: Record<string, string> = {
  projectId: 'Defaults to the active project',
  confirm: 'true once the person agreed (external clients, destructive actions)',
  dryRun: 'true: describe the call and its tier without executing',
}

const DETAIL = 'Arguments per action: specrails_describe(name, action).'

export const TOOL_BRIEFS: Record<string, ToolBrief> = {
  specrails_status: {
    description: 'App-wide glance: mood, running missions/rails/jobs, what needs the person, recent failures, today\'s spend, CPU/memory. Start here. Poll with ifNoneMatch:<etag>. Read-only.',
    fields: { ifNoneMatch: 'Previous etag; answers {unchanged:true} when nothing changed' },
  },
  specrails_board: {
    description: 'One project\'s board: backlog columns with counts and newest specs, every rail (availability, specs, run, delivery) and the queue. Read-only.',
  },
  specrails_spend: {
    description: 'Spend today or over a period, app-wide or for projectId: total, byCategory, caps with utilization, month-end projection, costliest items. Read-only.',
    fields: { period: 'Default today (local day)', from: 'period custom: ISO start', to: 'period custom: ISO end' },
  },
  specrails_resources: {
    description: 'CPU/memory of everything Specrails launched, by category; with conversationId, one mission\'s processes, history and worktree disk. Read-only.',
    fields: { conversationId: 'Mission id; omit for app-wide', top: 'Heaviest items per category (default 5)' },
  },
  specrails_projects: {
    description: 'Registered projects. Actions: list, get, resolve (by path), repositories, repository_add / repository_update (write), repository_remove (destructive), unregister (destructive — removes the project).',
    fields: {
      path: 'resolve / repository_add / repository_update: filesystem path',
      repositoryId: 'repository_update / repository_remove (from get/repositories)',
      workspacePaths: 'repository_add/update: code dirs in the repo; null = repo root',
    },
  },
  specrails_context: {
    description: 'Compact project briefing: identity, providers, backlog, rails/runs, Git/worktrees, blueprint; each section names its source. Use before planning unfamiliar work. Read-only.',
    fields: {
      repositoryId: 'Git section: one repository (default: overview of all)',
      sections: 'Sections to return (default all); ask only for what you need',
      limit: 'Max items per list (default 10)',
      cursor: 'backlog: nextCursor of the previous answer',
    },
  },
  specrails_inbox: {
    description: 'What needs the person across projects. Actions: list (items name their next calls), open (detail of itemId), question (of runId), answer (write), resume / retry (ai-spawn). PR decisions stay in the app.',
    fields: { runId: 'question/answer/resume: the item\'s subjectId', sourceId: 'retry: delivery id or run:<id> from the item' },
  },
  specrails_missions: {
    description: 'Agent missions. Actions: list, active, get (messages, context usage), send / ask (ai-spawn; ask never writes to the mission), abort (destructive — stop the running turn). Never changes permissions, provider or pin.',
    fields: {
      limit: 'list: missions (default 20); get: recent messages (default 10)',
      deliveryMode: 'send while a turn runs: queue (default) or steer',
      selection: 'ask: passage asked about (default latest reply)',
      throughMessageId: 'ask: read history up to this message',
    },
  },
  specrails_mission: {
    description: 'First-party mission only. acknowledge_updates(revision): after reading mission_user_updates, in a separate call before other tools. acknowledge_inputs(inputIds): read receipt for native messages with queueId. subagent_start (ai-spawn) / subagent_wait / subagent_list / subagent_stop: only when Specrails launches this mission\'s sub-agents. Never changes permissions, provider or pin.',
    fields: {
      contextTurns: 'subagent_start: recent turns to hand over',
      subagentIds: 'subagent_wait/stop: these sub-agents (default all)',
      timeoutSeconds: 'subagent_wait: default 60, max 300',
      revision: 'acknowledge_updates: exact latest delivered revision; never guess',
      inputIds: 'acknowledge_inputs: queueId values you have read',
    },
  },
  specrails_settings: {
    description: 'App-level settings. Actions: get, set (write), runtime_providers.list, runtime_providers.test (probe a baseUrl), runtime_providers.save (write — replace connections). Budgets here are APP-WIDE; per-project caps: specrails_analytics(budget_set). MCP tiers and sub-agent settings are read-only.',
    fields: {
      baseUrl: 'runtime_providers.test: OpenAI-compatible base URL',
      apiKeyEnv: 'runtime_providers.test: env var NAME of the key, never the key',
      providers: 'runtime_providers.save: the FULL connections list',
      dailyBudgetUsd: 'App-wide daily cap; null clears',
      weeklyBudgetUsd: 'App-wide weekly cap (week starts Monday); null clears',
      monthlyBudgetUsd: 'App-wide monthly cap; null clears',
      runCapUsd: 'App-wide default per-run soft cap; null clears',
      summaryMonthlyBudgetUsd: 'Code Explorer monthly summary budget (default 5)',
    },
  },
  specrails_watch: {
    description: 'Await an async action (launch, generate, chat turn, refine, SMASH, loop run, install) and return its events. settled means terminal, not successful; a timeout is not a failure — re-watch or read state.',
    fields: {
      ref: 'jobId / requestId / conversationId / loopRunId the action returned',
      untilMs: 'Max wait (default 120000, max 600000)',
      kind: 'job or loop_run: read stored state first; omit to auto-detect',
    },
  },
  specrails_specs: {
    description: `Read the spec backlog. Actions: list (paged), search (q), board, get (with criteria and addenda), list_addenda, spending_summary, files_touched, list_attachments, get_attachment. Changes: specrails_specs_write. ${DETAIL}`,
    fields: {
      status: 'list/search: CSV of statuses',
      q: 'Free text over title + description',
      repositoryId: 'files_touched: required in multi-repository projects',
      ticketId: 'Spec id or pending-spec UUID',
    },
  },
  specrails_specs_write: {
    description: 'Create and change specs. Actions: create (ai-spawn, async — THE way to add a spec from a request), commit_draft (persist a spec you authored or an Explore draft; Contract Layer by default, never ask), from_prompt (verbatim), generate (ai-spawn, from idea), update, delete (destructive, soft: 30 days), restore, save_draft, ai_edit / contract_refine / smash (ai-spawn), cancel_ai_edit, smash_undo / delete_epic_children (destructive), add_addendum (THE way to iterate on a spec: rides into the next launch), update_addendum / dismiss_addendum / reopen_addendum, delete_addendum (destructive). Others are write. Await AI actions with specrails_watch. Recipes: specrails_guide.',
    fields: {
      repositoryIds: 'Repository memberships of the spec (omit to keep)',
      status: 'update: job outcomes set statuses automatically; do not fight them',
      description: 'Spec description; ai_edit: the current baseline',
      priority: 'update: null only for drafts',
      metadata: 'update merges keys; regressionOf = delivery that caused this bug',
      acceptanceCriteria: 'Bullets folded into the description',
      intent: 'Problem/outcome/signals/affects/constraints, never the solution; null clears',
      short_summary: 'update (snake_case); null clears',
      shortSummary: 'commit_draft (camelCase)',
      createLocal: 'Keep the spec local (skip Jira promote)',
      conversationId: 'Explore conversation id (never a mission id)',
      draftTicketId: 'commit_draft: draft to flip in place',
      editTicketId: 'save_draft: ticket to demote to a draft',
      pendingSpecId: 'Pending-spec UUID owning pre-creation attachments',
      model: 'Model override (validated)',
      aiEngine: 'Installed provider override',
      contextScope: 'Flags {specrails,openspec,full,mcp,userMcp,contractRefine}',
      contractRefine: 'Default true, never ask; false only if the person asked for none',
      attachmentIds: 'create/generate need pendingSpecId',
      instructions: 'ai_edit: what to change',
      requestId: 'cancel_ai_edit: the in-flight ai_edit requestId',
      smashedAt: 'smash_undo: timestamp of the SMASH to reverse',
      addendumId: 'From specrails_specs(list_addenda)',
      body: 'Addendum note in the person\'s own words (markdown)',
    },
  },
  specrails_rails: {
    description: 'Rail slots (up to 12; create_rail when every rail is busy — never wait) and the pipeline on them. Actions: list (availability, runs, deliveries), pr_candidates, review_packet (evidence of prDeliveryId), create_rail / set_tickets / set_profile / set_engine / set_name (write), launch / launch_all (ai-spawn — runs the provider CLI in isolated worktrees; 202 with jobId/loopRunIds), ci_fix (write — prepares the Fix PR CI card), stop (destructive — kills the rail\'s runs). railIndex is 0-based: say "Rail <railIndex + 1>". Launch rules, budget refusals and PR continuation: specrails_guide.',
    fields: {
      repositoryIds: 'launch: memberships, incl. every one the specs need',
      workspaceSelection: 'launch: repository id → workspace paths (default all)',
      repositoryId: 'review_packet: one member of a grouped delivery',
      railIndex: '0-based; needed except for list/create_rail/launch_all/review_packet/ci_fix',
      prDeliveryId: 'review_packet: id from list.prDeliveries',
      profileName: 'Agent profile; null = legacy',
      aiEngine: 'Installed provider, "roles" or null (project primary)',
      mode: 'launch: implement (default) or loop (with loopId)',
      model: 'launch: default is the conversation model on the same engine',
      interactive: '',
      loopId: 'launch mode loop: published loop id',
      targetPrNumber: 'launch: deliver INTO this PR (pass it when the person names a PR)',
      revisionOfDeliveryId: 'launch: revise this undecided delivery (with revisionNote)',
      revisionNote: 'launch: what to change, in the person\'s words',
      followUp: 'launch: PR review follow-up (comments + scope), with targetPrNumber',
      baseBranch: 'launch: local branch to stack the worktree on',
    },
  },
  specrails_jobs: {
    description: `AI job queue and jobs. Actions: list, get, logs (failed step first), diagnose_failure (why it stopped; generate:true is ai-spawn), queue, cancel (destructive), stats, spawn (ai-spawn — slash-command job; prefer specrails_rails(launch) for specs), interactive_turn (ai-spawn), finalize, pause / resume, reorder / priority (write), purge (destructive), compare, export, diagnostic, run_state, pipeline, activity, metrics, phase_breakdown, default_spec_model, audit. Runtime runs: specrails_runs; background processes: specrails_background. ${DETAIL}`,
    fields: {
      limit: 'list: page size; activity: rows; logs: lines (default 200, max 1000)',
      eventLimit: 'get: max events (default 50, latest)',
      eventOffset: 'get: chronological event offset',
      from: 'ISO lower bound', to: 'ISO upper bound',
      before: 'activity: rows before this timestamp',
      command: 'spawn: slash-command',
      dependsOnJobId: 'spawn: depend on this job',
      pipelineId: 'spawn: group into / pipeline: read this pipeline',
      profileName: 'spawn: agent profile; null forces legacy',
      aiEngine: 'spawn: provider (default: the conversation provider)',
      jobIds: 'reorder: queued ids in order; compare: exactly 2',
      repositoryId: 'spawn: required in multi-repository projects',
      format: 'export json|csv; audit jsonl|csv',
      provider: 'default_spec_model: provider',
      generate: 'diagnose_failure: true asks for a fresh AI analysis (ai-spawn)',
      language: 'diagnose_failure: analysis language (default en)',
    },
  },
  specrails_runs: {
    description: `Runtime state and recovery of a job/rail run (jobId). Actions: state, diagnose (read before recommending a retry), evidence, steer (write), resume (ai-spawn; mode recover replays steps, mode approve is write; only after the person confirmed), settle / dismiss (write), cancel (destructive). ${DETAIL}`,
    fields: {
      railIndex: 'state: latest run of this rail',
      requestId: 'steer: idempotency key; reuse only with identical text',
      mode: 'resume (default), recover (all recoverable steps) or approve (write)',
      invalidate: 'Step ids whose results are discarded',
      stepId: 'One step id instead of the arrays',
      section: 'Summary index, command output or recorded source',
    },
  },
  specrails_background: {
    description: `Long-running processes (dev servers, watchers) of an in-app agent conversation, and running a mobile app on a device. Actions: start (destructive, in-app agent only; confirmed:true after the person approved this exact command), list, logs, kill (destructive, in-app agent only), mobile_test (build the iOS/Android app and open it on a simulator in Specrails; target mission = your Intent), mobile_status. ${DETAIL}`,
    fields: {
      confirmed: 'start: true after the person approved this exact command',
      allowWhileBusy: 'start: override the active-run guard after confirmation',
      repositoryId: 'start: required in multi-repository projects',
      cwd: 'start: directory in the repository (see specrails_projects(get))',
      processId: 'logs/kill: execution UUID; pass with pid',
      chatId: 'External clients only: the owning conversation id',
      limit: 'list: page size (default 50); logs: last N lines (default 100)',
      target: 'mobile_test: mission (your Intent worktree, default), checkout, branch',
      platforms: 'mobile_test: ["ios"], ["android"] or both',
      devices: 'mobile_test: Tapflow device id per platform (else Tapflow picks)',
      runId: 'mobile_status: the runId mobile_test returned',
    },
  },
  specrails_recovery: {
    description: 'Inspect and repair the ORIGINAL saved run worktree without relaunching. Actions: inspect, list_files, read_file (with hash), diff, history, patch (write; one exact replacement, expectedHash + operationId), check (destructive tier; runs project code). Never blindly repeat a failed check. Then specrails_runs(resume).',
    fields: {
      offset: 'history: nextOffset of the previous page',
      operationId: 'New UUID per patch/check; reuse only for the identical retry',
      changedPrecondition: 'What changed since the failed check (before repeating one)',
      acknowledgeInterrupted: 'Only after accepting an interrupted run\'s partial writes',
    },
  },
  specrails_chat: {
    description: 'Chat and Explore-Spec conversations. Actions: list_conversations, get, create (kind sidebar|explore), update, send (ai-spawn, async), abort, delete (destructive), minimize, restore, spec_draft (in-memory Explore draft), messages. Explore recipe (persist via specrails_specs_write(commit_draft, conversationId)): specrails_guide.',
    fields: {
      conversationId: 'Every action except list_conversations and create',
      provider: 'create: installed engine (default the primary)',
      model: 'create/update: valid for the provider',
      contextScope: 'create (explore): {full,specrails,openspec,mcp,userMcp,contractRefine}',
    },
  },
  specrails_agents: {
    description: 'Provider-aware agent profiles and catalog (provider = a non-primary installed provider). Profiles: list, get, resolve, create, update, delete (destructive), duplicate, rename, migrate, analytics, core_version. Catalog: catalog_list, catalog_get, versions, create_custom, update_custom, delete_custom (destructive), generate / test / refine_start / refine_turn (ai-spawn), refine_list, refine_get, refine_patch, refine_cancel, refine_apply.',
    fields: {
      provider: 'Installed provider (default the primary)',
      name: 'Profile name; the new one goes in newName',
      profileName: 'resolve: profile to preview (default the project default)',
      profile: 'create/update: full Profile body',
      agentId: 'Catalog and refine actions (custom-* for mutations)',
      agentName: 'create_custom: new id, ^custom-[a-z0-9][a-z0-9-]*$',
      description: 'generate: what the custom agent should do',
      autoTest: 'refine_start (default true) / refine_patch',
      refineId: 'refine_get/turn/patch/cancel/apply',
      force: 'refine_apply: bypass the disk-hash guard',
    },
  },
  specrails_plugins: {
    description: 'A project\'s MCP integration plugins. Actions: list, preview (dry run), install (write, long-running), uninstall (destructive), activate, deactivate, update, health.',
    fields: { provider: 'Provider to manage (default the conversation\'s, then primary)', name: 'Bundled plugin name (every action except list)' },
  },
  specrails_jira: {
    description: 'A project\'s Jira-backed specs. Actions: connection, test, discover_projects, discover_statuses, connect / update_connection (write), disconnect (destructive), statuses, sync / resume / retry_outbox (write), outbox, create_spec (write — a real Jira issue), discard_spec (write), spec_details, links. token is a SECRET, only for test/discover_*/connect.',
    fields: {
      baseUrl: 'e.g. https://acme.atlassian.net (test/discover_*/connect)',
      accountEmail: 'Cloud Basic auth (test/discover_*/connect)',
      token: 'SECRET API token / PAT (test/discover_*/connect); never returned',
      statusMap: 'connect/update_connection: logical state → Jira status name',
      discardStatus: 'Status discard moves an issue to; empty clears',
      enabled: 'update_connection: true re-arms write-back, false restores local writes',
      localId: 'discard_spec/spec_details: LOCAL spec id, not a Jira key',
      title: 'create_spec: issue summary',
      description: 'create_spec: issue description',
      labels: 'create_spec: issue labels',
      priority: 'create_spec: Jira priority name',
      issueType: 'create_spec: default Task',
    },
  },
  specrails_loops: {
    description: 'App-wide loop library (no projectId except run/run_get). Actions: list, get, templates, factory, commands, constants_list, constant_create / constant_update (write), constant_delete (destructive), preview, import, create, from_template, fork, duplicate, update, publish, unpublish, restore_builtin, delete (destructive), run (ai-spawn — a Published loop; 202 with loopRunId), run_get. To run on specs: specrails_rails(launch, mode:"loop", loopId). Lifecycle: specrails_guide.',
    fields: {
      loopId: 'Loop id (built-ins: factory:implement); run needs Published',
      repositoryIds: 'run: memberships to include (default primary only)',
      workspaceSelection: 'run: workspace paths per repository (default all)',
      name: 'Required for create/constant_create; optional override elsewhere',
      graph: '{ nodes, edges, ... } for create/update; required for preview',
      provider: 'preview: token provider (default claude); run: installed engine',
      model: 'run: model (validated; default the provider default)',
      reasoning_effort: 'run: provider-supported reasoning effort',
    },
  },
  specrails_code: {
    description: 'Read-only source browsing. Actions: tree, find (file by name/path suffix; use when read_file 404s), search (literal text), read_file (bounded pages with hash), summary, regenerate_summary (ai-spawn), provenance, diff (what a job applied).',
    fields: {
      repositoryId: 'Required for file actions in multi-repository projects',
      path: 'Project-relative path; required for read_file/summary/regenerate_summary/diff',
      file: 'Alias of path',
      query: 'search: literal text (not regex); find: name, path suffix or fragment',
      filter: 'tree: AI-touched files (default) or the whole repo',
      endLine: 'read_file: inclusive (default startLine + 199, max 500 lines)',
      startColumn: 'read_file: resume at nextColumn of a split long line',
      expectedHash: 'read_file: hash from the previous page; rejects a changed file',
      withProvenance: 'tree: include created-by / modified-by rollup',
      cursor: 'tree: nextCursor',
      limit: 'tree default 200 (max 500); find 20 (50); search 30 (100)',
      jobId: 'tree/provenance/diff; required for diff',
      overrideBudget: 'regenerate_summary: bypass the monthly budget (privileged)',
    },
  },
  specrails_setup: {
    description: 'Add and provision projects. App-level: prerequisites, available_providers, add_project (write). Per project: install_config (write), install (write, async), checkpoints (poll until isInstalling is false), abort (destructive), integration_contract. Order: prerequisites → add_project → install_config per provider → one install → checkpoints.',
    fields: {
      diagnostic: 'prerequisites: include PATH sources and which results',
      path: 'add_project: repository path',
      name: 'add_project: display name (default the directory name)',
      provider: 'add_project: legacy primary; install: which install-config',
      providers: 'add_project: providers to install (first = primary)',
      workspacePaths: 'add_project: code dirs inside the project root',
      repositories: 'add_project: extra repository memberships',
      config: 'install_config: the install-config object (required)',
    },
  },
  specrails_analytics: {
    description: 'Per-project cost analytics (quick totals: specrails_spend). Actions: spending (dashboard), invocations (rows), ticket_summary, export, budget_get, budget_set (write — per-project caps), decision_times, loop_economics. Read-only except budget_set.',
    fields: {
      period: 'Default 30d; custom needs from + to',
      modelProvider: 'Providers index-aligned to model[]',
      provider: 'CSV of providers',
      tzOffsetMinutes: 'Local UTC offset for daily buckets (default 0)',
      limit: 'invocations: max rows',
      id: 'ticket_summary: spec id',
      mode: 'export: summary (default) or raw rows',
      dailyBudgetUsd: 'budget_set: per-project daily cap; null clears',
      jobCostThresholdUsd: 'budget_set: per-job alert threshold; null clears',
      weeklyBudgetUsd: 'budget_set: per-project weekly cap; null clears',
      monthlyBudgetUsd: 'budget_set: per-project monthly cap; null clears',
      runCapUsd: 'budget_set: per-run soft cap (pauses the loop run); null clears',
    },
  },
  specrails_git: {
    description: 'READ-ONLY git/GitHub diagnostics with the app\'s bundled git/gh (use instead of a shell). Actions: info, pull_request (prNumber → verified URL), remote, status, log, diff, branch, gh_repo, gh_auth, gh_pr_list, gh_pr_view. Pushing, commits and PRs go through the app\'s delivery flow, never here.',
    fields: { repositoryId: 'Required in multi-repository projects (see specrails_projects(get))', prNumber: 'pull_request: exact PR number' },
  },
  specrails_env: {
    description: 'Per-project allowlist of environment variable NAMES for rail jobs (values never read). Actions: get, status, recheck, scan, set (write), auto_configure (write).',
    fields: { merge: 'set: merge with existing names (default true)' },
  },
  specrails_support: {
    description: 'Support for Specrails installation and usage problems (setup, missing agents/skills, providers, MCP, rails, PRs, cost, plugins). Actions: triage (playbook + diagnostics), core_update_status / core_update_check, core_update_apply (write), api_meta. Never creates specs.',
    fields: {
      question: 'The problem, in the user\'s words',
      version: 'core_update_apply: target version (default the latest found)',
      includeDiagnostics: 'Include read-only local diagnostics (default true)',
    },
  },
  specrails_guide: {
    description: 'The platform guide by topic. Without topic: the topic index (read it first); with topic: that section.',
    fields: { topic: 'Topic id from the index; omit for the index' },
  },
  specrails_search: {
    description: 'Find the tool/action for an English or Spanish intent, with current permissions.',
    fields: { query: 'The intent, e.g. "launch the pipeline for a spec"' },
  },
  specrails_describe: {
    description: 'Full input schema, per-action fields (with action: that action\'s fields and their complete docs) and tiers; with arguments, validates a call without executing it.',
    fields: { name: 'Tool name', action: 'Only this action\'s fields, with full docs', arguments: 'Prospective arguments to validate; never executes' },
  },
  specrails_select_project: {
    description: 'Set this session\'s active project (id, path, or null to clear) so tools may omit projectId. Cannot override a mission\'s pin.',
    fields: { projectId: 'Project id, or null to clear', path: 'Select by filesystem path instead' },
  },
}
