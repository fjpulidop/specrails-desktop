import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Request, Response } from 'express'
import { initDesktopDb, setDesktopSetting, type DbInstance } from '../desktop-db'
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

function makeRegistry(db: DbInstance, contexts: Partial<ProjectContext>[] = []): ProjectRegistry {
  const ctxs = contexts as ProjectContext[]
  return {
    desktopDb: db,
    listContexts: () => ctxs,
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
  })

  it('mcp disabled by default, enabled when set', () => {
    expect(isMcpEnabled(db)).toBe(false)
    setDesktopSetting(db, 'mcp_enabled', 'true')
    expect(isMcpEnabled(db)).toBe(true)
  })

  it('read tier always enabled; others require their flag', () => {
    expect(isTierEnabled(db, 'read')).toBe(true)
    expect(isTierEnabled(db, 'write')).toBe(false)
    setDesktopSetting(db, TIER_SETTING_KEY.write, 'true')
    expect(isTierEnabled(db, 'write')).toBe(true)
    expect(isTierEnabled(db, 'ai-spawn')).toBe(false)
    expect(isTierEnabled(db, 'destructive')).toBe(false)
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
    expect(kind.enumValues).toEqual(['job'])
    await expect(async () => tool('specrails_describe').handler(ctx, { name: 'nope' })).rejects.toThrow(/Unknown tool/)
  })

  it('specrails_settings get reflects defaults, set validates', async () => {
    const ctx = makeCtx(db)
    const t = tool('specrails_settings')
    const got = (await t.handler(ctx, { action: 'get' })) as { theme: string; mcp: { enabled: boolean } }
    expect(got.theme).toBe('specrails')
    expect(got.mcp.enabled).toBe(false)
    await t.handler(ctx, { action: 'set', theme: 'dracula' })
    const got2 = (await t.handler(ctx, { action: 'get' })) as { theme: string }
    expect(got2.theme).toBe('dracula')
    await expect(async () => t.handler(ctx, { action: 'set' })).rejects.toThrow(/at least one field/)
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
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

// ── registerTieredTool per-request active project (B1) ───────────────────────
import { registerTieredTool, getActiveProject, setActiveProject, type ToolHandlerExtra } from './tools/types'
import { AGENT_PROJECT_HEADER, AGENT_TIER_HEADER, AGENT_CONVERSATION_HEADER } from '../agent-tier'
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
    db = initDesktopDb(':memory:')
    captured = undefined
    setActiveProject(null)
  })

  it('the project header pins the project for THAT call only — the process-wide global is untouched', async () => {
    const ctx = makeCtx(db)
    registerTieredTool(fakeServer, ctx, {
      name: 'echo',
      title: 'Echo',
      description: 'echo active project',
      tier: 'read',
      inputSchema: {},
      handler: (c) => ({ active: getActiveProject(c) }),
    })
    const extra: ToolHandlerExtra = { requestInfo: { headers: { [AGENT_PROJECT_HEADER]: 'proj-42', [AGENT_TIER_HEADER]: 'observe' } } }
    const r1 = await captured!({}, extra)
    expect(JSON.parse(r1.content[0].text).active).toBe('proj-42')
    // A concurrent/subsequent call WITHOUT the header must not see the pin.
    const r2 = await captured!({})
    expect(JSON.parse(r2.content[0].text).active).toBeNull()
    expect(getActiveProject(ctx)).toBeNull()
  })

  it('explicit sticky selection still applies and a header overrides it per call', async () => {
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
      const extra: ToolHandlerExtra = { requestInfo: { headers: { [AGENT_PROJECT_HEADER]: 'proj-9', [AGENT_TIER_HEADER]: 'observe' } } }
      const r2 = await captured!({}, extra)
      expect(JSON.parse(r2.content[0].text).active).toBe('proj-9')
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
    const extra: ToolHandlerExtra = { requestInfo: { headers: { [AGENT_PROJECT_HEADER]: 'proj-77', [AGENT_TIER_HEADER]: 'edit' } } }
    const r = await captured!({}, extra)
    expect(r.isError).toBeFalsy()
    const activity = seen.find((m) => m.type === 'mcp.activity')
    expect(activity?.affectedProjectId).toBe('proj-77')
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

  const extraWith = (headers: Record<string, string | string[]>): ToolHandlerExtra => ({
    requestInfo: { headers: { [AGENT_TIER_HEADER]: 'observe', ...headers } },
  })

  it('a valid conversation header lands on ctx.originConversationId for THAT call only', async () => {
    const r1 = await captured!({}, extraWith({ [AGENT_CONVERSATION_HEADER]: 'conv-abc-1' }))
    expect(JSON.parse(r1.content[0].text).origin).toBe('conv-abc-1')
    // A subsequent call WITHOUT the header must not see it (per-call ctx copy).
    const r2 = await captured!({})
    expect(JSON.parse(r2.content[0].text).origin).toBeUndefined()
  })

  it('a malformed header sanitizes to null — never a throw, never the raw value', async () => {
    for (const bad of ['under_score', 'x'.repeat(65), '   ', 'nope!']) {
      const r = await captured!({}, extraWith({ [AGENT_CONVERSATION_HEADER]: bad }))
      expect(r.isError).toBeFalsy()
      expect(JSON.parse(r.content[0].text).origin).toBeNull()
    }
  })

  it('an absent header leaves ctx.originConversationId undefined', async () => {
    const r = await captured!({}, extraWith({}))
    expect(JSON.parse(r.content[0].text).origin).toBeUndefined()
  })

  it('array header form uses the first value; trims whitespace', async () => {
    const r = await captured!({}, extraWith({ [AGENT_CONVERSATION_HEADER]: [' conv-first ', 'conv-second'] }))
    expect(JSON.parse(r.content[0].text).origin).toBe('conv-first')
  })

  it('composes with the project header — both land on the same per-call ctx (the normal agent case)', async () => {
    const r = await captured!({}, extraWith({
      [AGENT_PROJECT_HEADER]: 'proj-42',
      [AGENT_CONVERSATION_HEADER]: 'conv-42',
    }))
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed.origin).toBe('conv-42')
    expect(parsed.project).toBe('proj-42') // the conversation copy must not drop the project pin
  })
})

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn> } {
  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  return { res: { status } as unknown as Response, status }
}
