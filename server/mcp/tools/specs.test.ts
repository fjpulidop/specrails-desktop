import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { initDesktopDb, type DbInstance } from '../../desktop-db'
import type { ProjectRegistry, ProjectContext } from '../../project-registry'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import { specsTools } from './specs'
import type { McpToolContext } from './types'

// Focused tests for the specs facade behavior fixes (plan B4/B5):
//  - `create` forwards the full generate-spec option set via the shared body
//    builder (and no longer sends the dead `provider` key)
//  - `create` throws a self-correcting error when labels/priority/status/
//    assignee are passed (generate-spec accepts none of them)
//  - `commit_draft` forwards assignee/prerequisites/metadata (one-shot insert)
//  - `contract_refine` returns the honest asymmetric-settle hint
//  - `priority` is a nullable enum (null clears — drafts only, via update)

function makeCtx(db: DbInstance): McpToolContext {
  const project = { id: 'p1', slug: 'p1', name: 'P1', path: '/tmp/p1', provider: 'claude', providers: ['claude'] } as unknown as ProjectContext['project']
  const pc = { project } as ProjectContext
  const registry = {
    desktopDb: db,
    listContexts: () => [pc],
    getContext: (id: string) => (id === 'p1' ? pc : undefined),
    getContextByPath: (p: string) => (p === '/tmp/p1' ? pc : undefined),
    removeProject: () => undefined,
  } as unknown as ProjectRegistry
  return { registry, desktopDb: db, broadcast: () => {}, eventBus: new MobileEventBus(), desktopPort: 4299 }
}

describe('specrails_specs facade', () => {
  let db: DbInstance
  let ctx: McpToolContext
  let fetchMock: ReturnType<typeof vi.fn>
  const spec = specsTools()[0]

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    ctx = makeCtx(db)
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, requestId: 'req-1' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function lastBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.at(-1) as [string, { body?: string }]
    return JSON.parse(call[1].body ?? '{}') as Record<string, unknown>
  }

  it('create forwards contextScope/attachmentIds/pendingSpecId/createLocal and drops the dead provider key', async () => {
    await spec.handler(ctx, {
      action: 'create',
      projectId: 'p1',
      title: 'T',
      description: 'D',
      contextScope: { full: true },
      attachmentIds: ['a1'],
      pendingSpecId: 'pend-1',
      createLocal: true,
      model: 'sonnet',
      aiEngine: 'claude',
      contractRefine: true,
    })
    const body = lastBody()
    expect(body.idea).toBe('T\n\nD')
    expect(body.contextScope).toEqual({ full: true })
    expect(body.attachmentIds).toEqual(['a1'])
    expect(body.pendingSpecId).toBe('pend-1')
    expect(body.createLocal).toBe(true)
    expect(body.model).toBe('sonnet')
    expect(body.aiEngine).toBe('claude')
    expect(body.contractRefine).toBe(true)
    expect('provider' in body).toBe(false)
  })

  it('generate forwards the same option set as create (shared body builder)', async () => {
    await spec.handler(ctx, {
      action: 'generate',
      projectId: 'p1',
      idea: 'the idea',
      contextScope: { specrails: true },
      attachmentIds: ['a2'],
      pendingSpecId: 'pend-2',
      createLocal: false,
    })
    const body = lastBody()
    expect(body.idea).toBe('the idea')
    expect(body.contextScope).toEqual({ specrails: true })
    expect(body.attachmentIds).toEqual(['a2'])
    expect(body.pendingSpecId).toBe('pend-2')
    expect(body.createLocal).toBe(false)
  })

  it.each(['labels', 'priority', 'status', 'assignee'] as const)(
    'create throws a self-correcting error when %s is passed',
    async (field) => {
      const values: Record<string, unknown> = {
        labels: ['x'],
        priority: 'high',
        status: 'todo',
        assignee: 'me',
      }
      await expect(
        spec.handler(ctx, { action: 'create', projectId: 'p1', title: 'T', [field]: values[field] }),
      ).rejects.toThrow(
        'create generates the spec with AI and cannot set labels/priority directly — use commit_draft (you control everything) or update after generation.',
      )
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('commit_draft forwards assignee/prerequisites/metadata (one-shot insert)', async () => {
    await spec.handler(ctx, {
      action: 'commit_draft',
      projectId: 'p1',
      title: 'Full spec',
      description: 'Body',
      acceptanceCriteria: ['ac1'],
      priority: 'high',
      labels: ['l1'],
      shortSummary: 'One line',
      assignee: 'sr-developer',
      prerequisites: [1, 2],
      metadata: { area: 'server' },
    })
    const body = lastBody()
    expect(body.assignee).toBe('sr-developer')
    expect(body.prerequisites).toEqual([1, 2])
    expect(body.metadata).toEqual({ area: 'server' })
    expect(body.shortSummary).toBe('One line')
  })

  it('contract_refine returns the asymmetric-settle hint (not the generic watch hint)', async () => {
    const r = (await spec.handler(ctx, { action: 'contract_refine', projectId: 'p1', id: 3 })) as { hint: string }
    expect(r.hint).toContain('explore.contract_refine_failed')
    expect(r.hint).toContain('ticket_updated')
  })

  it('the generic watch hint no longer promises contract-refine settles via watch', async () => {
    const r = (await spec.handler(ctx, { action: 'generate', projectId: 'p1', idea: 'x' })) as { hint: string }
    expect(r.hint).not.toContain('contract_refine')
  })

  it('priority schema is a nullable enum (null clears — drafts only)', () => {
    const priority = spec.inputSchema.priority as z.ZodTypeAny
    expect(priority.safeParse(null).success).toBe(true)
    expect(priority.safeParse('high').success).toBe(true)
    expect(priority.safeParse('urgent').success).toBe(false)
  })

  it('update forwards a null priority to the PATCH route', async () => {
    await spec.handler(ctx, { action: 'update', projectId: 'p1', id: 5, priority: null })
    const body = lastBody()
    expect(body.priority).toBeNull()
  })
})
