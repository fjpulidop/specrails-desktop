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
    expect(String(text)).toContain('Permission tiers')
  })

  it('specrails_search ranks tools by query terms', async () => {
    const ctx = makeCtx(db)
    const res = (await tool('specrails_search').handler(ctx, { query: 'project list' })) as Array<{ name: string }>
    expect(Array.isArray(res)).toBe(true)
    expect(res.some((r) => r.name === 'specrails_projects')).toBe(true)
  })

  it('specrails_describe returns fields or throws on unknown', async () => {
    const ctx = makeCtx(db)
    const d = (await tool('specrails_describe').handler(ctx, { name: 'specrails_watch' })) as { inputFields: string[] }
    expect(d.inputFields).toContain('ref')
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

  it('times out (settled:false) when nothing settles', async () => {
    vi.useFakeTimers()
    try {
      const ctx = makeCtx(db)
      const p = tool('specrails_watch').handler(ctx, { projectId: 'p1', ref: 'job-x', untilMs: 1000 }) as Promise<{ settled: boolean; reason: string }>
      await vi.advanceTimersByTimeAsync(1000)
      const r = await p
      expect(r.settled).toBe(false)
      expect(r.reason).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn> } {
  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  return { res: { status } as unknown as Response, status }
}
