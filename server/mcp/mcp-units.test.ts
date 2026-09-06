import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import type { Request, Response } from 'express'
vi.mock('../transient-children', () => ({
  startBackgroundProcess: vi.fn(),
  killBackgroundProcess: vi.fn(),
  killOwnedBackgroundProcess: vi.fn(),
  getBackgroundProcessLogs: vi.fn(),
  getBackgroundProcess: vi.fn(),
  listBackgroundProcesses: vi.fn(),
}))
import { initDesktopDb, getDesktopSetting, setDesktopSetting, type DbInstance } from '../desktop-db'
import type { ProjectRegistry, ProjectContext } from '../project-registry'
import { MobileEventBus } from '../mobile/mobile-event-bus'
import type { WsMessage } from '../types'
import {
  loadOrGenerateMcpToken,
  regenerateMcpToken,
  requireMcpAuth,
  _resetMcpTokenForTest,
} from './mcp-token'
import { isMcpEnabled, isTierEnabled, tierLabel, tierRefusalMessage, TIER_SETTING_KEY } from './mcp-tiers'
import { buildToolSpecs } from './tools/catalog'
import type { McpToolContext, McpToolSpec } from './tools/types'
import { startBackgroundProcess, killOwnedBackgroundProcess, getBackgroundProcessLogs, getBackgroundProcess, listBackgroundProcesses } from '../transient-children'

function makeRegistry(db: DbInstance, contexts: Partial<ProjectContext>[] = []): ProjectRegistry {
  const ctxs = contexts as ProjectContext[]
  return {
    desktopDb: db,
    listContexts: () => ctxs,
    listProjects: () => ctxs.map((ctx) => ctx.project),
    getProjectRow: (id: string) => ctxs.find((ctx) => ctx.project?.id === id)?.project,
    getContext: (id: string) => ctxs.find((c) => c.project?.id === id),
    getContextByPath: (p: string) => ctxs.find((c) => c.project?.path === p),
    removeProject: () => undefined,
  } as unknown as ProjectRegistry
}

function makeCtx(db: DbInstance, contexts: Partial<ProjectContext>[] = []): McpToolContext {
  return { registry: makeRegistry(db, contexts), desktopDb: db, broadcast: () => {}, eventBus: new MobileEventBus(), desktopPort: 4200 }
}

function tool(name: string): McpToolSpec {
  const spec = buildToolSpecs().find((s) => s.name === name)
  if (!spec) throw new Error(`tool ${name} not found`)
  return spec
}

describe('mcp-token', () => {
  beforeEach(() => _resetMcpTokenForTest())

  it('generates a >=32 char token and caches it', () => {
    const t1 = loadOrGenerateMcpToken()
    expect(t1.length).toBeGreaterThanOrEqual(32)
    expect(loadOrGenerateMcpToken()).toBe(t1)
  })

  it('regenerate produces a different token', () => {
    const t1 = loadOrGenerateMcpToken()
    const t2 = regenerateMcpToken()
    expect(t2).not.toBe(t1)
    expect(loadOrGenerateMcpToken()).toBe(t2)
  })

  it('keeps the previous live credential if regeneration cannot persist the new token', () => {
    const previous = loadOrGenerateMcpToken()
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk unavailable') })
    try {
      expect(() => regenerateMcpToken()).toThrow('disk unavailable')
      expect(loadOrGenerateMcpToken()).toBe(previous)
    } finally { rename.mockRestore() }
  })

  it('requireMcpAuth accepts the valid Bearer token', () => {
    const token = loadOrGenerateMcpToken()
    const next = vi.fn()
    const res = mockRes()
    requireMcpAuth({ headers: { authorization: `Bearer ${token}` } } as unknown as Request, res.res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('requireMcpAuth accepts the X-Desktop-Token header', () => {
    const token = loadOrGenerateMcpToken()
    const next = vi.fn()
    requireMcpAuth({ headers: { 'x-desktop-token': token } } as unknown as Request, mockRes().res, next)
    expect(next).toHaveBeenCalled()
  })

  it('requireMcpAuth 401s on a missing/invalid token', () => {
    const next = vi.fn()
    const res = mockRes()
    requireMcpAuth({ headers: {} } as unknown as Request, res.res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })
})

describe('mcp-tiers', () => {
  let db: DbInstance
  beforeEach(() => {
    db = initDesktopDb(':memory:')
    vi.mocked(startBackgroundProcess).mockReset()
    vi.mocked(killOwnedBackgroundProcess).mockReset()
  })

  it('mcp enabled by default; only an explicit false disables it', () => {
    expect(isMcpEnabled(db)).toBe(true)
    setDesktopSetting(db, 'mcp_enabled', 'false')
    expect(isMcpEnabled(db)).toBe(false)
    setDesktopSetting(db, 'mcp_enabled', 'true')
    expect(isMcpEnabled(db)).toBe(true)
  })

  it('every tier is on by default; read is fixed, the rest opt out via an explicit false', () => {
    expect(isTierEnabled(db, 'read')).toBe(true)
    expect(isTierEnabled(db, 'write')).toBe(true)
    expect(isTierEnabled(db, 'ai-spawn')).toBe(true)
    expect(isTierEnabled(db, 'destructive')).toBe(true)
    setDesktopSetting(db, TIER_SETTING_KEY.write, 'false')
    expect(isTierEnabled(db, 'write')).toBe(false)
    setDesktopSetting(db, TIER_SETTING_KEY.write, 'true')
    expect(isTierEnabled(db, 'write')).toBe(true)
    // A garbage value never disables — only the literal 'false' does.
    setDesktopSetting(db, TIER_SETTING_KEY.destructive, 'off')
    expect(isTierEnabled(db, 'destructive')).toBe(true)
  })

  it('labels + refusal messages name the tier', () => {
    expect(tierLabel('destructive')).toBe('Destructive')
    expect(tierRefusalMessage('ai-spawn')).toContain('AI-spawn')
    expect(tierRefusalMessage('write')).toContain('Settings ▸ MCP')
  })
})

describe('tool handlers', () => {
  let db: DbInstance
  beforeEach(() => {
    db = initDesktopDb(':memory:')
  })

  it('specrails_projects list returns [] and get/resolve/unregister validate input', async () => {
    const ctx = makeCtx(db)
    const t = tool('specrails_projects')
    expect(await t.handler(ctx, { action: 'list' })).toEqual([])
    await expect(async () => t.handler(ctx, { action: 'get', projectId: 'nope' })).rejects.toThrow(/Unknown projectId/)
    await expect(async () => t.handler(ctx, { action: 'resolve' })).rejects.toThrow(/requires a "path"/)
    await expect(async () => t.handler(ctx, { action: 'unregister' })).rejects.toThrow(/requires a "projectId"/)
  })

  it('specrails_projects tier is dynamic: unregister is destructive, list is read', () => {
    const t = tool('specrails_projects')
    const tierFn = t.tier as (a: Record<string, unknown>) => string
    expect(tierFn({ action: 'list' })).toBe('read')
    expect(tierFn({ action: 'unregister' })).toBe('destructive')
  })

  it('specrails_guide returns the guide text', async () => {
    const ctx = makeCtx(db)
    const text = await tool('specrails_guide').handler(ctx, {})
    expect(String(text)).toContain('Permissions — two regimes')
    expect(String(text)).toContain('pass the canonical mode value `freestyle`')
    expect(String(text)).toContain('call\n    the feature "Freestyle"')
    expect(String(text)).toContain('Explicit named profiles are validated against the selected provider')
    expect(String(text)).toContain('Kimi prompt mode cannot enforce')
    expect(String(text)).toContain('specrails_support')
    expect(String(text)).toContain('APP-GLOBAL specrails-core framework')
    expect(String(text)).toContain('pending checkpoints or 0 agents/commands do not prove')
    expect(String(text)).toContain('npx specrails-core@latest update')
    expect(String(text)).toContain("`decision:'pr_ready'`")
    expect(String(text)).toContain('Do not tell the user to Publish/Discard/Merge first')
  })

  it('specrails_search ranks tools by query terms', async () => {
    const ctx = makeCtx(db)
    const res = (await tool('specrails_search').handler(ctx, { query: 'project list' })) as Array<{ name: string }>
    expect(Array.isArray(res)).toBe(true)
    expect(res.some((r) => r.name === 'specrails_projects')).toBe(true)
  })

  it('specrails_describe returns per-field metadata or throws on unknown', async () => {
    const ctx = makeCtx(db)
    const d = (await tool('specrails_describe').handler(ctx, { name: 'specrails_watch' })) as {
      inputFields: Array<{ name: string; description?: string; type: string; enumValues?: string[]; optional: boolean }>
    }
    const names = d.inputFields.map((f) => f.name)
    expect(names).toContain('ref')
    const ref = d.inputFields.find((f) => f.name === 'ref')!
    expect(ref.type).toBe('string')
    expect(ref.optional).toBe(false)
    expect(ref.description).toMatch(/jobId/)
    // Wrappers unwrap: an optional+default number keeps its describe + base type.
    const untilMs = d.inputFields.find((f) => f.name === 'untilMs')!
    expect(untilMs.type).toBe('number')
    expect(untilMs.optional).toBe(true)
    // Enums surface their values.
    const kind = d.inputFields.find((f) => f.name === 'kind')!
    expect(kind.enumValues).toEqual(['job', 'loop_run'])
    await expect(async () => tool('specrails_describe').handler(ctx, { name: 'nope' })).rejects.toThrow(/Unknown tool/)
  })

  it('specrails_settings get reflects defaults, set validates', async () => {
    const ctx = makeCtx(db)
    const t = tool('specrails_settings')
    const got = (await t.handler(ctx, { action: 'get' })) as { theme: string; mcp: { enabled: boolean } }
    expect(got.theme).toBe('specrails')
    expect(got.mcp.enabled).toBe(true)
    const themeOptions = ((t.inputSchema.theme as any)._def.innerType.options as string[])
    expect(themeOptions).toEqual(['specrails', 'dracula', 'aurora-light', 'obsidian-dark', 'code-rain', 'galaxy'])
    expect(themeOptions).not.toContain('matrix')
    expect(themeOptions).not.toContain('star-wars')
    await t.handler(ctx, { action: 'set', theme: 'galaxy' })
    const got2 = (await t.handler(ctx, { action: 'get' })) as { theme: string }
    expect(got2.theme).toBe('galaxy')
    await expect(async () => t.handler(ctx, { action: 'set' })).rejects.toThrow(/at least one field/)
  })

  it.each([
    ['star-wars', 'galaxy'],
    ['matrix', 'code-rain'],
  ])('specrails_settings get migrates legacy theme %s to %s', async (legacy, current) => {
    const ctx = makeCtx(db)
    const t = tool('specrails_settings')
    setDesktopSetting(db, 'ui_theme', legacy)

    const got = (await t.handler(ctx, { action: 'get' })) as { theme: string }

    expect(got.theme).toBe(current)
    expect(getDesktopSetting(db, 'ui_theme')).toBe(current)
  })

  it('specrails_settings surfaces the code-explorer settings (get defaults, set validates + persists)', async () => {
    const ctx = makeCtx(db)
    const t = tool('specrails_settings')
    const got = (await t.handler(ctx, { action: 'get' })) as { summaryLanguage: string; summaryMonthlyBudgetUsd: number }
    expect(got.summaryLanguage).toBe('en')
    expect(got.summaryMonthlyBudgetUsd).toBe(5.0)
    const set = (await t.handler(ctx, { action: 'set', summaryLanguage: 'es', summaryMonthlyBudgetUsd: 12.5 })) as { changed: string[] }
    expect(set.changed).toEqual(['summaryLanguage', 'summaryMonthlyBudgetUsd'])
    const got2 = (await t.handler(ctx, { action: 'get' })) as { summaryLanguage: string; summaryMonthlyBudgetUsd: number }
    expect(got2.summaryLanguage).toBe('es')
    expect(got2.summaryMonthlyBudgetUsd).toBe(12.5)
    await expect(async () => t.handler(ctx, { action: 'set', summaryLanguage: 'fr' })).rejects.toThrow(/summaryLanguage/)
    await expect(async () => t.handler(ctx, { action: 'set', summaryMonthlyBudgetUsd: -1 })).rejects.toThrow(/non-negative/)
  })

  it('specrails_select_project sets and clears the active project', async () => {
    const ctx = makeCtx(db, [{ project: { id: 'p1', name: 'One', path: '/tmp/one' } as ProjectContext['project'] }])
    const t = tool('specrails_select_project')
    expect((await t.handler(ctx, { projectId: 'p1' })) as { active: string }).toMatchObject({ active: 'p1' })
    expect((await t.handler(ctx, { projectId: null })) as { active: null }).toMatchObject({ active: null })
    await expect(async () => t.handler(ctx, { path: '/nope' })).rejects.toThrow(/No project registered/)
  })

  it('paginates durable background history with live apps first and refuses recovered PID stops', async () => {
    const t = tool('specrails_jobs')
    const ctx = { ...makeCtx(db, [{ project: { id: 'p1', name: 'One', path: '/tmp/one' } as ProjectContext['project'] }]),
      firstPartyAgent: true, originConversationId: 'c-origin' }
    const base = { pid: 123, command: 'npm run dev', cwd: '/tmp/one', chatId: 'c-origin', projectId: 'p1' }
    const recovered = { ...base, processId: 'disconnected', startedAt: 20, status: 'interrupted' as const, recoveredAt: 40 }
    vi.mocked(listBackgroundProcesses).mockReturnValue([
      { ...base, processId: 'recent-failure', startedAt: 30, status: 'failed' },
      recovered,
      { ...base, pid: 124, processId: 'still-running', startedAt: 10, status: 'running' },
    ])
    const first = await t.handler(ctx, { action: 'background_list', projectId: 'p1', limit: 2 }) as { processes: Array<{ processId: string }> }
    expect(first).toMatchObject({ total: 3, offset: 0, limit: 2, hasMore: true, specrailsApi: { host: '127.0.0.1', port: 4200 } })
    expect(first.processes.map(p => p.processId)).toEqual(['still-running', 'recent-failure'])
    const next = await t.handler(ctx, { action: 'background_list', projectId: 'p1', limit: 2, offset: 2 }) as { processes: Array<{ processId: string }> }
    expect(next.processes.map(p => p.processId)).toEqual(['disconnected'])
    expect(next).toMatchObject({ hasMore: false })
    vi.mocked(getBackgroundProcess).mockReturnValue(recovered)
    const signalsBefore = vi.mocked(killOwnedBackgroundProcess).mock.calls.length
    await expect(t.handler(ctx, { action: 'background_kill', projectId: 'p1', pid: 123, processId: 'disconnected' })).rejects.toThrow(/current OS state is unknown/)
    expect(killOwnedBackgroundProcess).toHaveBeenCalledTimes(signalsBefore)
  })

  it('specrails_jobs background actions validate ownership, cwd, tier, and broadcasts', async () => {
    const t = tool('specrails_jobs')
    const tierFn = t.tier as (a: Record<string, unknown>) => string
    expect(tierFn({ action: 'background_start' })).toBe('destructive')
    expect(tierFn({ action: 'background_kill' })).toBe('destructive')

    const broadcast = vi.fn()
    const ctx = {
      ...makeCtx(db, [{ project: { id: 'p1', name: 'One', path: '/tmp/one' } as ProjectContext['project'] }]),
      broadcast,
    }
    const originCtx = { ...ctx, originConversationId: 'c-origin', firstPartyAgent: true }
    vi.mocked(startBackgroundProcess).mockImplementation((command: string, cwd: string, chatId: string, projectId: string, hooks: any) => {
      const proc = {
        pid: 123,
        processId: 'exec-123',
        command,
        cwd,
        startedAt: 10,
        status: 'running',
        chatId,
        projectId,
      }
      hooks.onStarted(proc)
      return proc
    })
    vi.mocked(killOwnedBackgroundProcess).mockReturnValue(true)
    vi.mocked(getBackgroundProcess).mockReturnValue({ pid: 123, processId: 'exec-123', command: 'npm run dev', cwd: '/tmp/one', startedAt: 10, status: 'running', chatId: 'c-origin', projectId: 'p1' })
    vi.mocked(getBackgroundProcessLogs).mockReturnValue({
      process: {
        pid: 123,
        processId: 'exec-123',
        command: 'npm run dev',
        cwd: '/tmp/one',
        startedAt: 10,
        status: 'failed',
        chatId: 'c-origin',
        projectId: 'p1',
        exitCode: 1,
      },
      lines: [
        { sequence: 1, at: 11, source: 'stdout', line: 'starting' },
        { sequence: 2, at: 12, source: 'stderr', line: 'error: missing script dev' },
      ],
      truncated: false,
      droppedLines: 0,
      maxLines: 500,
      maxLineChars: 1000,
      retentionMs: 600000,
      nextSequence: 2,
    })

    await expect(async () => t.handler(ctx, { action: 'background_start', projectId: 'p1', command: 'npm run dev', chatId: 'c1' })).rejects.toThrow(/confirmed/)
    await expect(async () => t.handler(ctx, { action: 'background_start', projectId: 'p1', command: 'npm run dev', chatId: 'spoofed', confirmed: true })).rejects.toThrow(/authenticated/)
    await expect(async () => t.handler(ctx, {
      action: 'background_start',
      projectId: 'p1',
      command: 'npm run dev',
      chatId: 'c1',
      cwd: '../outside',
      confirmed: true,
    })).rejects.toThrow(/authenticated/)
    await expect(async () => t.handler(originCtx, {
      action: 'background_start',
      projectId: 'p1',
      command: 'npm run dev',
      cwd: '../outside',
      confirmed: true,
    })).rejects.toThrow(/cwd/)

    const busyCtx = {
      ...makeCtx(db, [{
        project: { id: 'p1', name: 'One', path: '/tmp/one' } as ProjectContext['project'],
        queueManager: { getActiveJobId: () => 'job-1' } as unknown as ProjectContext['queueManager'],
      }]),
      broadcast,
      originConversationId: 'c-origin',
      firstPartyAgent: true,
    }
    await expect(async () => t.handler(busyCtx, {
      action: 'background_start',
      projectId: 'p1',
      command: 'npm run dev',
      chatId: 'c1',
      cwd: '.',
      confirmed: true,
    })).rejects.toThrow(/job job-1/)
    const forcedWhileBusy = await t.handler(busyCtx, {
      action: 'background_start',
      projectId: 'p1',
      command: 'npm run dev',
      chatId: 'c1',
      cwd: '.',
      confirmed: true,
      allowWhileBusy: true,
    }) as { process: { pid: number } }
    expect(forcedWhileBusy.process.pid).toBe(123)

    const startedFromOrigin = await t.handler(originCtx, {
      action: 'background_start',
      projectId: 'p1',
      command: 'npm run dev',
      cwd: '.',
      confirmed: true,
    }) as { process: { chatId: string } }
    expect(startedFromOrigin.process.chatId).toBe('c-origin')

    const started = await t.handler(originCtx, {
      action: 'background_start',
      projectId: 'p1',
      command: 'npm run dev',
      chatId: 'caller-cannot-override',
      cwd: '.',
      confirmed: true,
    }) as { process: { pid: number; cwd: string } }

    expect(started.process).toMatchObject({ pid: 123, cwd: '/tmp/one' })
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'background_process.started',
      projectId: 'p1',
      process: expect.objectContaining({ pid: 123, chatId: 'c-origin' }),
    }))

    await expect(async () => t.handler(ctx, { action: 'background_kill', projectId: 'p1', pid: 123, chatId: 'spoofed' })).rejects.toThrow(/authenticated/)
    await expect(async () => t.handler(originCtx, { action: 'background_kill', projectId: 'p1' })).rejects.toThrow(/pid/)
    const killed = await t.handler(originCtx, { action: 'background_kill', projectId: 'p1', pid: 123 }) as { ok: boolean }
    expect(killed.ok).toBe(true)
    expect(killOwnedBackgroundProcess).toHaveBeenCalledWith(123, { projectId: 'p1', chatId: 'c-origin' })

    // Read-only discovery still uses the authenticated mission, not a supplied chat.
    vi.mocked(listBackgroundProcesses).mockReturnValue([])
    const discovered = await t.handler(originCtx, { action: 'background_list', projectId: 'p1', chatId: 'foreign' })
    expect(discovered).toMatchObject({ processes: [], total: 0, limit: 50, offset: 0, hasMore: false })
    expect(listBackgroundProcesses).toHaveBeenCalledWith({ projectId: 'p1', chatId: 'c-origin', includeFinished: true })
    expect(tierFn({ action: 'background_list' })).toBe('read')
    const calls = vi.mocked(killOwnedBackgroundProcess).mock.calls.length
    await expect(t.handler(originCtx, { action: 'background_kill', projectId: 'p1', pid: 123, processId: 'stale' })).rejects.toThrow(/registered execution/)
    expect(killOwnedBackgroundProcess).toHaveBeenCalledTimes(calls)

    expect(tierFn({ action: 'background_logs' })).toBe('read')
    const logs = await t.handler(originCtx, {
      action: 'background_logs', projectId: 'p1', pid: 123, chatId: 'caller-cannot-override', limit: 20,
    }) as {
      ok: boolean
      lines: Array<{ source: string; line: string }>
    }
    expect(logs.ok).toBe(true)
    expect(logs.lines).toEqual([
      expect.objectContaining({ source: 'stdout', line: 'starting' }),
      expect.objectContaining({ source: 'stderr', line: 'error: missing script dev' }),
    ])
    expect(getBackgroundProcessLogs).toHaveBeenCalledWith(123, {
      projectId: 'p1',
      chatId: 'c-origin',
      limit: 20,
    })
    vi.mocked(getBackgroundProcessLogs).mockReturnValueOnce(null)
    await expect(async () => t.handler(originCtx, { action: 'background_logs', projectId: 'p1', pid: 404 })).rejects.toThrow(/expired/)
  })

  it('specrails_jobs cancel uses the dedicated POST cancel endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const ctx = makeCtx(db, [{
        project: { id: 'p1', name: 'One', path: '/tmp/one' } as ProjectContext['project'],
      }])
      await tool('specrails_jobs').handler(ctx, {
        action: 'cancel',
        projectId: 'p1',
        jobId: 'job/1',
      })

      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/projects/p1/jobs/job%2F1/cancel')
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('specrails_watch', () => {
  let db: DbInstance
  beforeEach(() => {
    db = initDesktopDb(':memory:')
  })

  it('settles when a terminal event for the ref arrives', async () => {
    const ctx = makeCtx(db)
    const p = tool('specrails_watch').handler(ctx, { projectId: 'p1', ref: 'job-9', untilMs: 5000 }) as Promise<{ settled: boolean; reason: string }>
    ctx.eventBus.publish({ type: 'log', projectId: 'p1', processId: 'job-9' } as unknown as WsMessage)
    ctx.eventBus.publish({ type: 'rail.job_completed', projectId: 'p1', jobId: 'job-9' } as unknown as WsMessage)
    const r = await p
    expect(r.settled).toBe(true)
    expect(r.reason).toContain('rail.job_completed')
  })

  it('times out (settled:false) with a recovery suggestion when nothing settles', async () => {
    vi.useFakeTimers()
    try {
      const ctx = makeCtx(db)
      const p = tool('specrails_watch').handler(ctx, { projectId: 'p1', ref: 'job-x', untilMs: 1000 }) as Promise<{ settled: boolean; reason: string; suggestion?: string }>
      await vi.advanceTimersByTimeAsync(1000)
      const r = await p
      expect(r.settled).toBe(false)
      expect(r.reason).toBe('timeout')
      expect(r.suggestion).toMatch(/timeout ≠ failure/)
      expect(r.suggestion).toMatch(/specrails_jobs\(get\)/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('projectId is optional: without one (and no active project) the project filter is skipped', async () => {
    const ctx = makeCtx(db)
    const p = tool('specrails_watch').handler(ctx, { ref: 'req-7', untilMs: 5000 }) as Promise<{ settled: boolean; reason: string; projectId: string | null }>
    // An app-level event (no projectId) settles the watch on ref match alone.
    ctx.eventBus.publish({ type: 'agent_refine_ready', requestId: 'req-7' } as unknown as WsMessage)
    const r = await p
    expect(r.settled).toBe(true)
    expect(r.reason).toContain('agent_refine_ready')
    expect(r.projectId).toBeNull()
  })

  it('settles on the new terminal patterns (plugin.installed)', async () => {
    const ctx = makeCtx(db)
    const p = tool('specrails_watch').handler(ctx, { projectId: 'p1', ref: 'serena', untilMs: 5000 }) as Promise<{ settled: boolean; reason: string }>
    ctx.eventBus.publish({ type: 'plugin.installed', projectId: 'p1', name: 'serena' } as unknown as WsMessage)
    const r = await p
    expect(r.settled).toBe(true)
    expect(r.reason).toContain('plugin.installed')
  })

  it('polls the job read every 5s for a UUID ref and settles on a terminal status', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ job: { status: 'completed' } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const ctx = makeCtx(db)
      const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const p = tool('specrails_watch').handler(ctx, { projectId: 'p1', ref: uuid, untilMs: 60000 }) as Promise<{
        settled: boolean
        reason: string
        terminalEvent: { type?: string } | null
      }>
      await vi.advanceTimersByTimeAsync(5000)
      const r = await p
      expect(r.settled).toBe(true)
      expect(r.reason).toBe('poll:job:completed')
      expect(r.terminalEvent?.type).toBe('job.poll_settled')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/projects/p1/jobs/${uuid}`)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('poll errors are ignored and the watch keeps waiting (kind:"job" forces polling)', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'not found' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const ctx = makeCtx(db)
      const p = tool('specrails_watch').handler(ctx, { projectId: 'p1', ref: 'job-77', kind: 'job', untilMs: 12000 }) as Promise<{ settled: boolean; reason: string }>
      await vi.advanceTimersByTimeAsync(12000)
      const r = await p
      expect(r.settled).toBe(false)
      expect(r.reason).toBe('timeout')
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

// ── registerTieredTool per-request active project (B1) ───────────────────────
import { registerTieredTool, getActiveProject, setActiveProject, type ToolHandlerExtra } from './tools/types'
import { AGENT_CAPABILITY_HEADER, AGENT_PROJECT_HEADER, AGENT_TIER_HEADER, AGENT_CONVERSATION_HEADER } from '../agent-tier'
import { _resetAgentCapabilitiesForTest, mintAgentCapability, revokeAgentCapability } from './agent-capability'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

describe('registerTieredTool per-request active project', () => {
  type ToolCb = (args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  let db: DbInstance
  let captured: ToolCb | undefined
  const fakeServer = {
    registerTool: (_name: string, _cfg: unknown, cb: ToolCb) => {
      captured = cb
    },
  } as unknown as McpServer

  beforeEach(() => {
    _resetAgentCapabilitiesForTest()
    db = initDesktopDb(':memory:')
    captured = undefined
    setActiveProject(null)
  })

  const capabilityExtra = (tierLevel: 0 | 1 | 2 | 3, projectId: string | null, conversationId = 'conv-test'): ToolHandlerExtra => {
    const token = mintAgentCapability({ conversationId, projectId, tierLevel })
    return { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: token } } }
  }

  it('the capability pins the project for that call only', async () => {
    const ctx = makeCtx(db)
    registerTieredTool(fakeServer, ctx, {
      name: 'echo',
      title: 'Echo',
      description: 'echo active project',
      tier: 'read',
      inputSchema: {},
      handler: (c) => ({ active: getActiveProject(c) }),
    })
    const extra = capabilityExtra(0, 'proj-42')
    const r1 = await captured!({}, extra)
    expect(JSON.parse(r1.content[0].text).active).toBe('proj-42')
    // A subsequent external call must not inherit the capability context.
    const r2 = await captured!({})
    expect(JSON.parse(r2.content[0].text).active).toBeNull()
    expect(getActiveProject(ctx)).toBeNull()
  })

  it('a capability Home binding overrides sticky selection with explicit null', async () => {
    const ctx = makeCtx(db)
    registerTieredTool(fakeServer, ctx, {
      name: 'echo2',
      title: 'Echo2',
      description: 'echo active project',
      tier: 'read',
      inputSchema: {},
      handler: (c) => ({ active: getActiveProject(c) }),
    })
    setActiveProject('sticky-1')
    try {
      const r1 = await captured!({})
      expect(JSON.parse(r1.content[0].text).active).toBe('sticky-1')
      const extra = capabilityExtra(0, null)
      const r2 = await captured!({}, extra)
      expect(JSON.parse(r2.content[0].text).active).toBeNull()
      // The override was per-request: sticky selection survives.
      const r3 = await captured!({})
      expect(JSON.parse(r3.content[0].text).active).toBe('sticky-1')
    } finally {
      setActiveProject(null)
    }
  })

  it('mcp.activity carries the per-request project as affectedProjectId', async () => {
    const seen: Array<Record<string, unknown>> = []
    const ctx: McpToolContext = { ...makeCtx(db), broadcast: (msg) => seen.push(msg as unknown as Record<string, unknown>) }
    registerTieredTool(fakeServer, ctx, {
      name: 'mutate',
      title: 'Mutate',
      description: 'a write tool',
      tier: 'write',
      inputSchema: {},
      handler: () => ({ ok: true }),
    })
    const extra = capabilityExtra(1, 'proj-77')
    const r = await captured!({}, extra)
    expect(r.isError).toBeFalsy()
    const activity = seen.find((m) => m.type === 'mcp.activity')
    expect(activity?.affectedProjectId).toBe('proj-77')
  })

  it('ignores spoofed project/tier headers without a capability', async () => {
    const ctx = makeCtx(db)
    registerTieredTool(fakeServer, ctx, {
      name: 'echo-spoof', title: 'EchoSpoof', description: '', tier: 'read', inputSchema: {},
      handler: (c) => ({ active: getActiveProject(c), firstParty: c.firstPartyAgent }),
    })
    const r = await captured!({}, { requestInfo: { headers: {
      [AGENT_PROJECT_HEADER]: 'proj-spoofed',
      [AGENT_TIER_HEADER]: 'autonomous',
    } } })
    expect(JSON.parse(r.content[0].text)).toEqual({ active: null })
  })
})

// ── registerTieredTool per-request origin conversation (safe-pr-review-flow) ──
describe('registerTieredTool per-request origin conversation', () => {
  type ToolCb = (args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  let db: DbInstance
  let captured: ToolCb | undefined
  const fakeServer = {
    registerTool: (_name: string, _cfg: unknown, cb: ToolCb) => {
      captured = cb
    },
  } as unknown as McpServer

  beforeEach(() => {
    _resetAgentCapabilitiesForTest()
    db = initDesktopDb(':memory:')
    captured = undefined
    setActiveProject(null)
    registerTieredTool(fakeServer, makeCtx(db), {
      name: 'echo-origin',
      title: 'EchoOrigin',
      description: 'echo per-call origin conversation + project pin',
      tier: 'read',
      inputSchema: {},
      handler: (c) => ({ origin: c.originConversationId, project: getActiveProject(c) }),
    })
  })

  const extraWithCapability = (conversationId: string, projectId: string | null = null): { extra: ToolHandlerExtra; token: string } => {
    const token = mintAgentCapability({ conversationId, projectId, tierLevel: 0 })
    return { extra: { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: token } } }, token }
  }

  it('a capability lands its origin on the per-call context only', async () => {
    const { extra } = extraWithCapability('conv-abc-1')
    const r1 = await captured!({}, extra)
    expect(JSON.parse(r1.content[0].text).origin).toBe('conv-abc-1')
    // A subsequent external call must not inherit it.
    const r2 = await captured!({})
    expect(JSON.parse(r2.content[0].text).origin).toBeUndefined()
  })

  it('ignores legacy conversation/project/tier headers without capability proof', async () => {
    const r = await captured!({}, { requestInfo: { headers: {
      [AGENT_CONVERSATION_HEADER]: 'conv-spoofed',
      [AGENT_PROJECT_HEADER]: 'proj-spoofed',
      [AGENT_TIER_HEADER]: 'autonomous',
    } } })
    expect(JSON.parse(r.content[0].text)).toEqual({ project: null })
  })

  it('derives conversation and project from the same capability binding', async () => {
    const { extra } = extraWithCapability('conv-42', 'proj-42')
    const r = await captured!({}, extra)
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed.origin).toBe('conv-42')
    expect(parsed.project).toBe('proj-42')
  })

  it('a revoked capability is rejected instead of gaining external-client permissions', async () => {
    const { extra, token } = extraWithCapability('conv-revoked', 'proj-revoked')
    revokeAgentCapability(token)
    const r = await captured!({}, extra)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('revoked')
  })
})

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn> } {
  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  return { res: { status } as unknown as Response, status }
}
