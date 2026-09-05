import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { initDesktopDb, setDesktopSetting, type DbInstance } from '../../desktop-db'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import { buildToolSpecs } from './catalog'
import { metaTools } from './meta'
import { getActiveProject, type McpToolContext, type McpToolSpec } from './types'

const projects = [
  { id: 'p1', name: 'One', path: '/tmp/one', provider: 'codex', providers: ['codex'] },
  { id: 'p2', name: 'Recovering', path: '/tmp/two', provider: 'claude', providers: ['claude'] },
]
let db: DbInstance
let ctx: McpToolContext
const catalog = buildToolSpecs()
const tool = (name: string) => catalog.find(tool => tool.name === `specrails_${name}`)!
beforeEach(() => {
  db = initDesktopDb(':memory:')
  ctx = { desktopDb: db, desktopPort: 4299, broadcast: () => {}, eventBus: new MobileEventBus(), sessionState: { activeProjectId: null },
    registry: { listProjects: () => projects, getProjectRow: (id: string) => projects.find(p => p.id === id),
      getContext: (id: string) => id === 'p1' ? { project: projects[0] } : undefined, removeProject: vi.fn() },
  } as unknown as McpToolContext
})
afterEach(() => db.close())

describe('project discovery and session defaults', () => {
  it('preserves temporarily unavailable projects in list/get/resolve', async () => {
    expect(await tool('projects').handler(ctx, { action: 'list' })).toMatchObject([{ id: 'p1', available: true }, { id: 'p2', available: false }])
    expect(await tool('projects').handler(ctx, { action: 'get', projectId: 'p2' })).toMatchObject({ id: 'p2', available: false })
    expect(await tool('projects').handler(ctx, { action: 'resolve', path: '/tmp/two/' })).toMatchObject({ id: 'p2', available: false })
    await tool('projects').handler(ctx, { action: 'unregister', projectId: 'p2' })
    expect(ctx.registry.removeProject).toHaveBeenCalledWith('p2')
  })

  it('selects a registered unavailable project without affecting another session', async () => {
    const other = { ...ctx, sessionState: { activeProjectId: null } }
    expect(await tool('select_project').handler(ctx, { path: '/tmp/two/' })).toMatchObject({ active: 'p2', available: false })
    expect(getActiveProject(ctx)).toBe('p2')
    expect(getActiveProject(other)).toBe(null)
    expect(await tool('projects').handler(ctx, { action: 'get' })).toMatchObject({ id: 'p2' })
    expect(await tool('select_project').handler(ctx, { projectId: null })).toEqual({ active: null })
  })

  it('cannot claim to change or clear the authenticated mission pin', async () => {
    const mission = { ...ctx, firstPartyAgent: true, requestProjectId: 'p1' }
    expect(await tool('select_project').handler(mission, { projectId: 'p1' })).toMatchObject({ active: 'p1' })
    await expect(async () => tool('select_project').handler(mission, { projectId: 'p2' })).rejects.toThrow('conversation project pin')
    await expect(async () => tool('select_project').handler(mission, { projectId: null })).rejects.toThrow('conversation project pin')
    expect(getActiveProject(mission)).toBe('p1')
    expect(await tool('projects').handler(mission, { action: 'get', projectId: 'p2' })).toMatchObject({ id: 'p2' })
    await expect(async () => tool('select_project').handler({ ...mission, requestProjectId: null }, { projectId: 'p1' })).rejects.toThrow('conversation project pin')
  })

  it('validates unknown ids, ambiguous selectors, and absent defaults', async () => {
    for (const args of [{}, { projectId: 'missing' }, { path: '/missing' }, { projectId: null, path: '/tmp/one' }]) {
      await expect(async () => tool('select_project').handler(ctx, args)).rejects.toThrow()
    }
    await expect(async () => tool('projects').handler(ctx, { action: 'get' })).rejects.toThrow('No project selected')
    await expect(async () => tool('projects').handler(ctx, { action: 'get', projectId: 'missing' })).rejects.toThrow('Unknown projectId')
  })
})

describe('tool discovery with full contracts', () => {
  it('exposes nested JSON schema, constraints, and prospective validation without executing', async () => {
    const handler = vi.fn()
    const sample: McpToolSpec = { name: 'specrails_sample', title: 'Sample', description: 'Nested contract', tier: 'write', handler,
      inputSchema: { payload: z.object({ steps: z.array(z.object({ name: z.string().min(3), count: z.number().int().min(1).max(5) })).min(1), mode: z.enum(['a', 'b']) }) } }
    const describeTool = metaTools(() => [sample]).find(t => t.name === 'specrails_describe')!
    const result = await describeTool.handler(ctx, { name: sample.name }) as any
    expect(result.inputSchema.required).toEqual(['payload'])
    const fields = result.inputSchema.properties.payload.properties
    expect(fields.steps.items.properties.name.minLength).toBe(3)
    expect(fields.steps.items.properties.count).toMatchObject({ type: 'integer', minimum: 1, maximum: 5 })
    expect(fields.mode.enum).toEqual(['a', 'b'])
    const invalid = await describeTool.handler(ctx, { name: sample.name, arguments: { payload: { steps: [], mode: 'x' } } }) as any
    expect(invalid.validation.valid).toBe(false)
    const valid = await describeTool.handler(ctx, { name: sample.name, arguments: { payload: { steps: [{ name: 'run', count: 2 }], mode: 'a' } } }) as any
    expect(valid.validation).toEqual({ valid: true, tier: 'write', allowed: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('reports permissions for the current caller and distinguishes cost-incurring draft commits', async () => {
    setDesktopSetting(db, 'mcp_tier_ai_spawn', 'false')
    const result = await tool('describe').handler(ctx, { name: 'specrails_specs' }) as any
    expect(result.actions).toContainEqual({ action: 'commit_draft', tier: 'ai-spawn', allowed: false })
    const preview = await tool('describe').handler(ctx, { name: 'specrails_specs', arguments: { action: 'commit_draft', title: 'Ready', contractRefine: false } }) as any
    expect(preview.validation).toEqual({ valid: true, tier: 'write', allowed: true })
    const mission = { ...ctx, firstPartyAgent: true, agentTierLevel: 0 as const }
    const missionResult = await tool('describe').handler(mission, { name: 'specrails_rails' }) as any
    expect(missionResult.actions).toContainEqual({ action: 'set_tickets', tier: 'write', allowed: false })
    expect(missionResult.actions).toContainEqual({ action: 'list', tier: 'read', allowed: true })
  })

  it.each([
    ['buscar código del proyecto', 'specrails_code'],
    ['estado y contexto del proyecto', 'specrails_context'],
    ['review_packet', 'specrails_rails'],
    ['phase_breakdown', 'specrails_jobs'],
    ['esperar ejecución', 'specrails_watch'],
  ])('finds useful tools for %s', async (query, name) => {
    const result = await tool('search').handler(ctx, { query }) as any[]
    expect(result.slice(0, 3).map(row => row.name)).toContain(name)
  })

  it('does not match empty filler queries to every tool', async () => {
    expect(await tool('search').handler(ctx, { query: 'the and la el para' })).toHaveProperty('hint')
  })
})
