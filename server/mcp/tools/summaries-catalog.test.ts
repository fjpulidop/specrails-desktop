import { describe, expect, it } from 'vitest'
import { READ_SUMMARIZERS } from './summaries-catalog'

type Case = [key: string, args: Record<string, unknown>, data: unknown, expected: string[]]

const P = { projectId: 'p1' }

const CASES: Case[] = [
  ['specrails_projects:resolve', { path: '/r/app' }, { id: 'p1', name: 'App', repositoryId: 'primary-p1', available: true }, ['App (p1)', 'primary-p1']],
  ['specrails_projects:repositories', P, { repositories: [{ id: 'a', name: 'api', isPrimary: true }, { id: 'b', name: 'web' }] }, ['2 repositories', 'api (primary)', 'explicit repositoryId']],
  ['specrails_settings:get', {}, { theme: 'dark', language: 'es', dailyBudgetUsd: 5, weeklyBudgetUsd: null, mcp: { enabled: true } }, ['Theme dark', 'daily $5.00', 'MCP enabled']],
  ['specrails_settings:runtime_providers.list', {}, { providers: [{ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434' }] }, ['1 provider connection', 'Ollama']],
  ['specrails_settings:runtime_providers.test', { baseUrl: 'http://x' }, { ok: false, error: 'ECONNREFUSED' }, ['not reachable', 'ECONNREFUSED']],
  ['specrails_mission:subagent_wait', {}, { subagents: [{ subagentId: 's1', description: 'tests', phase: 'done' }, { subagentId: 's2', description: 'lint', phase: 'running' }] }, ['2 sub-agents', '1 still running']],
  ['specrails_mission:subagent_list', {}, { subagents: [{ subagentId: 's1', description: 'tests', phase: 'done' }] }, ['1 sub-agent', 'tests (done)']],
  ['specrails_specs:spending_summary', { id: 7 }, { totalCostUsd: 3.5, estimatedCostUsd: 1, totalRuns: 4, unpricedRuns: 0, ticketTitle: 'Login', bySurface: { job: { count: 3, costUsd: 3 }, 'quick-spec': { count: 1, costUsd: 0.5 } } }, ['Spec #7', '$3.50', '4 runs', 'mostly job', '$1.00 is estimated']],
  ['specrails_specs:files_touched', { id: 7, ...P }, { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }, ['2 files', 'src/a.ts']],
  ['specrails_specs:list_attachments', { ticketId: '7' }, { attachments: [{ id: 'att1', filename: 'mock.png' }] }, ['1 attachment', 'mock.png']],
  ['specrails_specs:get_attachment', {}, { attachment: { id: 'att1', filename: 'mock.png', mimeType: 'image/png', size: 2048 }, path: '/projects/p1/tickets/7/attachments/att1' }, ['mock.png', 'image/png', '2 KB', 'not inlined']],
  ['specrails_specs:list_addenda', { id: 7 }, { addenda: [{ status: 'open' }, { status: 'applied' }] }, ['2 addenda', 'open 1', 'next launch']],
  ['specrails_rails:pr_candidates', {}, { candidates: [{ number: 12, title: 'Fix login' }] }, ['1 PR candidate', 'Fix login']],
  ['specrails_rails:review_packet', P, { packet: { checks: [{ status: 'passed' }, { status: 'failed' }] }, snapshot: { id: 'd1', decision: 'on_review', prUrl: 'https://gh/pr/1' }, acceptCapability: false }, ['delivery d1', 'on_review', '2 checks (1 failing)', 'person decides']],
  ['specrails_jobs:list', P, { jobs: [{ id: 'j1', status: 'failed' }, { id: 'j2', status: 'completed' }], total: 10, nextOffset: 2 }, ['2 of 10 jobs', 'failed 1']],
  ['specrails_jobs:queue', P, { jobs: [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'queued' }], paused: false, activeJobId: 'j1' }, ['is running', 'job j1 active', '1 job waiting']],
  ['specrails_jobs:compare', {}, { jobs: [{ id: 'a', status: 'completed', total_cost_usd: 1 }, { id: 'b', status: 'failed', duration_ms: 90_000 }] }, ['2 jobs', 'a completed $1.00', 'b failed 2m']],
  ['specrails_jobs:export', {}, { note: 'x', data: { jobs: [{}, {}, {}] } }, ['3 jobs', 'JSON']],
  ['specrails_jobs:diagnostic', {}, { note: 'Binary', jobId: 'j1', path: '/projects/p1/jobs/j1/diagnostic' }, ['ZIP', 'j1']],
  ['specrails_jobs:run_state', P, { projectName: 'App', busy: true, currentJobId: 'j9' }, ['App is busy with job j9']],
  ['specrails_jobs:pipeline', {}, { pipelineId: 'pl1', status: 'running', jobs: [{ status: 'completed' }, { status: 'running' }] }, ['Pipeline pl1 is running', '2 jobs']],
  ['specrails_jobs:activity', {}, [{ summary: 'Job done', timestamp: '2026-01-01T00:00:00Z', type: 'job_completed' }], ['1 activity entry', 'Job done', 'before=2026-01-01']],
  ['specrails_jobs:stats', {}, { totalJobs: 20, failedJobs: 2, jobsToday: 3, totalCostUsd: 12, costToday: 1.5, estimatedCostUsd: 0 }, ['20 jobs', '2 failed', '3 today', '$1.50 today']],
  ['specrails_jobs:metrics', {}, { healthScore: 81.6, coverage: { pct: 74.2 }, pipeline: { lastJobStatus: 'completed', lastJobCommand: '/implement' }, failurePatterns: [{}] }, ['Health score 82', 'coverage 74%', 'last job completed', '1 recurring failure pattern']],
  ['specrails_jobs:phase_breakdown', {}, { jobId: 'j1', breakdown: [{ phase: 'plan', durationMs: 5_000 }, { phase: 'implement', durationMs: 600_000 }] }, ['2 phases', 'implement (10m)']],
  ['specrails_jobs:default_spec_model', {}, { model: 'sonnet', provider: 'claude', allowed: ['a', 'b'], providers: ['claude', 'codex'] }, ['claude default to sonnet', '2 allowed models', 'claude, codex']],
  ['specrails_jobs:audit', {}, { format: 'jsonl', jobId: 'j1', rows: 12, data: '' }, ['12 agent actions', 'job j1']],
  ['specrails_runs:state', P, { runs: [{ runId: 'r1', status: 'failed', nextStep: 'verify', canResume: true, recoverableSteps: [], active: false }] }, ['Run r1 is failed at verify', 'can be resumed']],
  ['specrails_runs:diagnose', { jobId: 'r1', ...P }, { runId: 'r1', recommendation: 'repair_before_retry', reason: 'The same check failed twice.', recentFailures: [{}, {}], reviewer: { approved: false } }, ['repair before retry', 'failed twice', '2 recent failures', 'Reviewer rejected']],
  ['specrails_runs:evidence', { jobId: 'r1' }, { items: [{}, {}], nextCursor: 'c2' }, ['run r1', '2 entries', 'cursor']],
  ['specrails_background:list', { chatId: 'c1' }, { processes: [{ pid: 10, processId: 'u1', command: 'npm run dev', status: 'running' }], total: 1, offset: 0, limit: 50, hasMore: false }, ['1 background processes', '1 live', 'npm run dev (running)']],
  ['specrails_background:logs', {}, { lines: ['a', 'b'], process: { pid: 10, status: 'running' }, appUrls: { local: ['http://localhost:5173'], network: [] } }, ['Process 10 is running', '2 log lines', 'http://localhost:5173']],
  ['specrails_recovery:inspect', { jobId: 'r1' }, { repositories: [{ repositoryId: 'primary' }], checks: [{ id: 'c' }], recentRepairs: [] }, ['Run r1', '1 repository', '1 registered check', '0 recent repairs']],
  ['specrails_recovery:list_files', {}, { entries: [{ path: 'src' }, { path: 'README.md' }] }, ['2 entries', 'README.md']],
  ['specrails_recovery:read_file', { path: 'a.ts' }, { path: 'a.ts', lines: ['x', 'y'], hash: 'f'.repeat(64) }, ['a.ts: 2 lines', 'expectedHash ffffffffffff']],
  ['specrails_recovery:diff', { path: 'a.ts' }, { diff: '--- a\n+++ b\n-old\n+new\n' }, ['a.ts differs', '2 changed lines']],
  ['specrails_recovery:history', {}, { attempts: [{ action: 'check', status: 'failed' }] }, ['1 recovery attempt', 'check failed']],
  ['specrails_chat:list_conversations', P, { conversations: [{ id: 'c1', title: 'Explore login' }] }, ['1 conversation', 'Explore login']],
  ['specrails_chat:get', P, { conversation: { id: 'c1', title: 'Explore login', kind: 'explore' } }, ['Explore login', 'explore']],
  ['specrails_chat:spec_draft', {}, { draft: { title: 'Login v2' }, ready: true, chips: [] }, ['Login v2', 'ready to commit']],
  ['specrails_chat:messages', {}, { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello there' }] }, ['2 messages', 'assistant', 'Hello there']],
  ['specrails_agents:list', {}, { profiles: [{ name: 'default', isDefault: true }, { name: 'fast' }] }, ['2 profiles', 'default (default)']],
  ['specrails_agents:get', { profileName: 'fast' }, { profile: { name: 'fast', provider: 'claude', agents: [{ id: 'architect' }] } }, ['Profile fast', 'claude', '1 agent']],
  ['specrails_agents:resolve', {}, { resolved: { name: 'fast', profile: {} } }, ['profile fast']],
  ['specrails_agents:analytics', {}, { provider: 'claude', windowDays: 30, rows: [{ profileName: 'fast', jobs: 4, successRate: 0.75 }] }, ['1 profile', 'fast 4 jobs 75%', '30 days']],
  ['specrails_agents:core_version', {}, { version: '4.2.0', required: '>=4', profileAware: true }, ['specrails-core 4.2.0', 'requires >=4', 'supported']],
  ['specrails_agents:catalog_list', {}, { agents: [{ id: 'architect' }, { id: 'reviewer' }] }, ['2 catalog agents', 'architect']],
  ['specrails_agents:catalog_get', {}, { id: 'architect', body: 'a\nb\nc', version: 3 }, ['Agent architect', '3 lines', 'version 3']],
  ['specrails_agents:versions', {}, { versions: [{ version: 1 }, { version: 2 }] }, ['2 versions', 'v1']],
  ['specrails_agents:refine_list', {}, { sessions: [{ refineId: 'r1', status: 'ready' }] }, ['1 refine session', 'r1 (ready)']],
  ['specrails_agents:refine_get', {}, { refineId: 'r1', status: 'ready', draft: 'body' }, ['r1 is ready', 'draft is ready']],
  ['specrails_plugins:list', {}, { plugins: [{ name: 'figma', installed: true }, { name: 'sentry' }] }, ['2 plugins', 'figma (installed)', '1 installed']],
  ['specrails_plugins:preview', { name: 'figma' }, { changes: [{}, {}], prerequisites: [{ name: 'node', ok: false }] }, ['figma', '2 changes', '1 prerequisite missing']],
  ['specrails_plugins:health', { name: 'figma' }, { ok: false, issues: [{ ok: false, message: 'token missing' }] }, ['figma is unhealthy', 'token missing']],
  ['specrails_jira:connection', {}, { connected: true, connection: { baseUrl: 'https://x.atlassian.net', projectKey: 'APP' }, outbox: { failed: 2 } }, ['https://x.atlassian.net', 'project APP', '2 outbox operations failed']],
  ['specrails_jira:test', {}, { ok: true, user: 'Ana' }, ['credentials work', 'Ana']],
  ['specrails_jira:discover_projects', {}, { projects: [{ key: 'APP' }] }, ['1 Jira project', 'APP']],
  ['specrails_jira:discover_statuses', {}, { statuses: [{ name: 'To Do' }, { name: 'Done' }] }, ['2 Jira statuses', 'To Do']],
  ['specrails_jira:statuses', {}, { statuses: [{ name: 'Done' }] }, ['1 Jira status', 'Done']],
  ['specrails_jira:outbox', P, { ops: [{ id: 3, status: 'failed' }, { id: 4, status: 'done' }], counts: {} }, ['2 outbox operations', 'failed 1']],
  ['specrails_jira:spec_details', {}, { key: 'APP-1', status: 'In Progress', summary: 'Login' }, ['APP-1 is In Progress', 'Login']],
  ['specrails_jira:links', {}, { links: [{ localId: 7, issueKey: 'APP-1' }] }, ['1 Jira link', '#7→APP-1']],
  ['specrails_loops:list', {}, { loops: [{ id: 'l1', name: 'Implement', published: true }, { id: 'l2', name: 'Draft', published: false }] }, ['2 loops', 'Implement', 'Draft (draft)']],
  ['specrails_loops:get', {}, { loop: { id: 'l1', name: 'Implement', status: 'published', graph: { nodes: [{}, {}, {}] } } }, ['Loop Implement (published)', '3 steps']],
  ['specrails_loops:templates', {}, { templates: [{ id: 't1', name: 'Review' }] }, ['1 loop template', 'Review']],
  ['specrails_loops:factory', {}, { factoryLoops: [{ id: 'f1', name: 'Implement' }] }, ['1 factory loop', 'Implement']],
  ['specrails_loops:commands', {}, { commands: [{ name: '/implement' }] }, ['1 command', '/implement']],
  ['specrails_loops:constants_list', {}, { constants: [{ name: 'MAX_ROUNDS' }] }, ['1 loop constant', 'MAX_ROUNDS']],
  ['specrails_loops:preview', {}, { valid: false, errors: [{ message: 'cycle' }], steps: [{}] }, ['invalid', '1 step', 'cycle']],
  ['specrails_loops:run_get', P, { loopRun: { id: 'lr1', loop_name: 'Implement', status: 'failed', iteration_count: 2, total_cost_usd: 0.42, failureDiagnosis: { detail: 'tests failed' } } }, ['Loop run lr1', 'is failed', '2 iterations', 'tests failed', '$0.42']],
  ['specrails_code:tree', { action: 'tree' }, { entries: [{ path: 'src', kind: 'dir' }, { path: 'src/a.ts', kind: 'file' }], nextCursor: 'n1' }, ['2 tree entries', '1 file', 'nextCursor']],
  ['specrails_code:find', { query: 'Lesson' }, { matches: [{ path: 'src/LessonView.tsx' }] }, ['1 file', 'src/LessonView.tsx']],
  ['specrails_code:search', { query: 'useAuth' }, { results: [{ path: 'a.ts' }, { path: 'a.ts' }, { path: 'b.ts' }] }, ['3 hits', 'useAuth', '2 files']],
  ['specrails_code:read_file', { path: 'a.ts' }, { path: 'a.ts', content: 'x\ny\nz', language: 'typescript' }, ['a.ts: 3 lines', 'typescript']],
  ['specrails_code:summary', { path: 'a.ts' }, { path: 'a.ts', summary: 'Handles   login.' }, ['a.ts: Handles login.']],
  ['specrails_code:provenance', { path: 'a.ts' }, { rows: [{ jobId: 'j1' }] }, ['1 provenance record', 'j1']],
  ['specrails_code:diff', { path: 'a.ts' }, { diff: '+a\n+b\n-c\n' }, ['a.ts has 3 changed lines']],
  ['specrails_setup:prerequisites', {}, { prerequisites: [{ name: 'git', ok: true }, { name: 'gh', ok: false }] }, ['1 prerequisite missing', 'gh']],
  ['specrails_setup:available_providers', {}, { providers: [{ id: 'claude' }, { id: 'codex', installed: false }] }, ['2 providers', 'codex (missing)']],
  ['specrails_setup:checkpoints', {}, { checkpoints: [{ name: 'install', status: 'done' }, { name: 'agents', status: 'pending' }] }, ['2 setup checkpoints', '1 done']],
  ['specrails_setup:integration_contract', {}, { version: '2', ok: false, missing: [{}] }, ['v2', 'not satisfied', '1 gap']],
  ['specrails_analytics:invocations', { offset: 0 }, { rows: [{ surface: 'job', total_cost_usd: 1 }, { surface: 'job', total_cost_usd: 0.5 }], total: 2, truncated: true, totalAvailable: 9 }, ['2 of 9 invocations', 'job 2', '$1.50']],
  ['specrails_analytics:ticket_summary', { id: 3 }, { totalCostUsd: 2, totalRuns: 1, bySurface: {} }, ['Spec #3', '$2.00', '1 run']],
  ['specrails_analytics:export', {}, { note: 'x', format: 'csv', mode: 'raw', data: 'a,b' }, ['raw', 'csv']],
  ['specrails_analytics:budget_get', P, { dailyBudgetUsd: 10, weeklyBudgetUsd: null, costToday: 4, budgetUtilizationPct: 40, unpricedRuns: 0 }, ['$4.00 today', '40% of the daily cap', 'daily $10']],
  ['specrails_analytics:decision_times', {}, { period: '30d', project: { deliveries: 5, toDecision: { medianMs: 3_600_000, p90Ms: 7_200_000, pending: 1 }, toMerge: { medianMs: 7_200_000 } }, byLoop: [] }, ['5 deliveries', '1.0h', 'p90 2.0h', '1 awaiting']],
  ['specrails_analytics:loop_economics', {}, { period: '30d', project: { hasData: true, delivered: 4, merged: 3, discarded: 1, discardRate: 0.25 }, byLoop: [{}] }, ['4 delivered', '3 merged', '25% discard rate', '1 loop']],
  ['specrails_git:info', {}, { git: true, branch: 'main', dirty: true, worktrees: [{}, {}] }, ['branch main', 'uncommitted changes', '2 worktrees']],
  ['specrails_git:pull_request', {}, { number: 42, title: 'Add login', state: 'open' }, ['PR #42', 'Add login', 'open']],
  ['specrails_git:remote', {}, { ok: true, command: 'git remote -v', stdout: 'origin git@x (fetch)\norigin git@x (push)' }, ['git remote', '2 lines', 'origin']],
  ['specrails_git:status', {}, { ok: true, stdout: '' }, ['git status: no output']],
  ['specrails_git:log', {}, { ok: true, stdout: 'abc first' }, ['git log', 'abc first']],
  ['specrails_git:diff', {}, { ok: true, stdout: 'diff --git a b' }, ['git diff']],
  ['specrails_git:branch', {}, { ok: true, stdout: '* main' }, ['git branch', '* main']],
  ['specrails_git:gh_repo', {}, { ok: false, command: 'gh repo view', exitCode: 1, stderr: 'no git remotes found' }, ['exited 1', 'no git remotes found', 'not a tool failure']],
  ['specrails_git:gh_auth', {}, { ok: true, stdout: 'Logged in' }, ['gh auth status', 'Logged in']],
  ['specrails_git:gh_pr_list', {}, { ok: true, stdout: '1\tFix\n2\tAdd' }, ['gh pr list', '2 lines']],
  ['specrails_git:gh_pr_view', {}, { ok: true, stdout: 'title: Fix' }, ['gh pr view']],
  ['specrails_env:get', {}, { names: ['AWS_PROFILE'], agentEnvMode: 'minimal', statuses: [{ name: 'AWS_PROFILE', status: 'missing' }] }, ['1 variable name', 'AWS_PROFILE', 'minimal', '1 not found']],
  ['specrails_env:status', {}, { checking: false, statuses: [{ name: 'A', status: 'present' }] }, ['1 variable', 'present 1']],
  ['specrails_env:recheck', {}, { checking: true, statuses: [] }, ['Still checking']],
  ['specrails_env:scan', {}, { discovered: ['DATABASE_URL', 'STRIPE_KEY'] }, ['2 variable names', 'DATABASE_URL', 'write action']],
  ['specrails_support:triage', {}, { mode: 'support-triage', topic: 'mcp_connection', recommendedNextSteps: ['a', 'b'], localDiagnostics: { coreUpdate: { ok: false } } }, ['mcp_connection', '2 recommended steps', 'coreUpdate']],
  ['specrails_support:core_update_status', {}, { currentVersion: '4.1.0', latestVersion: '4.2.0', updateAvailable: true }, ['4.1.0', '4.2.0 is available', 'ai-spawn']],
  ['specrails_support:core_update_check', {}, { currentVersion: '4.2.0', latestVersion: '4.2.0', updateAvailable: false }, ['4.2.0', 'latest 4.2.0']],
  ['specrails_support:api_meta', {}, { version: '2.3.0', apiVersion: '7' }, ['Specrails API 7', 'app 2.3.0']],
  ['specrails_context:', {}, { projectId: 'p1', sections: { overview: { status: 'ok', data: { name: 'App' } }, backlog: { status: 'ok', data: { statusCounts: { todo: 3 } } }, git: { status: 'unavailable' } } }, ['App', 'backlog todo 3', 'Unavailable: git']],
  ['specrails_watch:', { ref: 'j1' }, { settled: true, ref: 'j1', eventCount: 3, terminalEvent: { status: 'failed' } }, ['j1 settled with failed', '3 events', 'not necessarily success']],
  ['specrails_describe:', {}, { name: 'specrails_jobs', actions: [{}, {}], inputFields: [{}], validation: { valid: true, tier: 'read' } }, ['specrails_jobs', '2 actions', '1 input field', 'valid (tier read)']],
  ['specrails_search:', {}, [{ name: 'specrails_jobs' }, { name: 'specrails_runs' }], ['specrails_jobs, specrails_runs']],
  ['specrails_select_project:', {}, { active: 'p1', name: 'App', available: true }, ['Active project is App']],
]

describe('READ_SUMMARIZERS', () => {
  it('covers exactly the expected read actions', () => {
    expect(Object.keys(READ_SUMMARIZERS).sort()).toEqual([...new Set(CASES.map(([key]) => key))].sort())
  })

  it.each(CASES)('%s summarizes its own payload', (key, args, data, expected) => {
    const meta = READ_SUMMARIZERS[key](args, data)
    expect(meta?.summary).toBeTypeOf('string')
    for (const fact of expected) expect(meta!.summary).toContain(fact)
    expect(meta!.summary.length).toBeLessThanOrEqual(260)
    for (const call of meta!.next ?? []) {
      expect(call.tool).toMatch(/^specrails_/)
      expect(call.why.length).toBeGreaterThan(5)
    }
  })

  it.each(Object.keys(READ_SUMMARIZERS))('%s falls back (undefined) on an unexpected payload', (key) => {
    expect(READ_SUMMARIZERS[key]({}, 42)).toBeUndefined()
    expect(READ_SUMMARIZERS[key]({}, null)).toBeUndefined()
  })

  it('never mutates the payload', () => {
    for (const [key, args, data] of CASES) {
      const before = JSON.stringify(data)
      READ_SUMMARIZERS[key](args, data)
      expect(JSON.stringify(data)).toBe(before)
    }
  })

  it('carries paging and follow-ups with canonical tool names', () => {
    const jobs = READ_SUMMARIZERS['specrails_jobs:list']({ action: 'list', projectId: 'p1' }, { jobs: [{ id: 'j1', status: 'failed' }], total: 5, nextOffset: 1 })!
    expect(jobs).toMatchObject({ truncated: true, cursor: 1 })
    expect(jobs.next).toEqual([
      expect.objectContaining({ tool: 'specrails_jobs', args: { action: 'diagnose_failure', jobId: 'j1', projectId: 'p1' } }),
      expect.objectContaining({ tool: 'specrails_jobs', args: { action: 'list', projectId: 'p1', offset: 1 } }),
    ])
    const runs = READ_SUMMARIZERS['specrails_runs:state']({ projectId: 'p1' }, { runs: [{ runId: 'r1', status: 'failed', canResume: false }] })!
    expect(runs.next?.[0]).toMatchObject({ tool: 'specrails_runs', args: { action: 'diagnose', jobId: 'r1', projectId: 'p1' } })
    const background = READ_SUMMARIZERS['specrails_background:list']({ chatId: 'c1' }, { processes: [{ pid: 5, processId: 'u', status: 'running' }], hasMore: true, offset: 0 })!
    expect(background).toMatchObject({ truncated: true, cursor: 1 })
    expect(background.next?.[0]).toMatchObject({ tool: 'specrails_background', args: { action: 'logs', pid: 5, processId: 'u', chatId: 'c1' } })
  })

  it('reports ambiguous and unresolved project paths', () => {
    expect(READ_SUMMARIZERS['specrails_projects:resolve']({ path: '/x' }, { resolved: false })).toMatchObject({ status: 'not_found' })
    expect(READ_SUMMARIZERS['specrails_projects:resolve']({}, { resolved: false, ambiguous: true, matches: [{ projectId: 'a', repositoryId: 'r' }, { projectId: 'b', repositoryId: 'r' }] })).toMatchObject({ status: 'ambiguous' })
  })

  it('treats a watch timeout as pending, not failure', () => {
    const meta = READ_SUMMARIZERS['specrails_watch:']({ ref: 'j1', untilMs: 1000 }, { settled: false, reason: 'timeout', ref: 'j1' })!
    expect(meta.status).toBe('timeout')
    expect(meta.summary).toContain('may still be running')
    expect(meta.next?.[0]).toMatchObject({ tool: 'specrails_watch', args: { ref: 'j1', untilMs: 1000 } })
  })
})
