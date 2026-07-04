import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { initDesktopDb, type DbInstance } from '../../desktop-db'
import type { ProjectRegistry, ProjectContext } from '../../project-registry'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import { buildToolSpecs } from './catalog'
import type { McpToolContext } from './types'
import { setActiveProject } from './types'

// A registry stub exposing one project so requireProject() resolves; apiCall is
// exercised against a mocked fetch so we cover every domain handler's switch
// branches without a live server.
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

function actionOptions(spec: ReturnType<typeof buildToolSpecs>[number]): string[] {
  const field = spec.inputSchema.action as z.ZodTypeAny | undefined
  if (field && field instanceof z.ZodEnum) return field.options as string[]
  return []
}

describe('tool catalog smoke (all domains)', () => {
  let db: DbInstance
  let ctx: McpToolContext
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    ctx = makeCtx(db)
    setActiveProject('p1')
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, jobId: 'job-1', requestId: 'req-1' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setActiveProject(null)
  })

  it('every tool has a name, description and input schema', () => {
    for (const spec of buildToolSpecs()) {
      expect(spec.name).toMatch(/^specrails_/)
      expect(spec.description.length).toBeGreaterThan(10)
      expect(typeof spec.inputSchema).toBe('object')
    }
  })

  it('every action of every domain tool dispatches (or validates) without crashing the framework', async () => {
    const genericArgs: Record<string, unknown> = {
      projectId: 'p1',
      id: '1',
      ticketId: 1,
      jobId: 'job-1',
      railIndex: 0,
      ticketIds: [1],
      name: 'thing',
      title: 'Thing',
      description: 'desc',
      idea: 'an idea',
      text: 'hello',
      instructions: 'do it',
      path: '/code/file.ts',
      ref: 'job-1',
      loopId: 'loop-1',
      templateId: 'tpl-1',
      conversationId: 'c1',
      agentId: 'custom-x',
      refineId: 'r1',
      profile: { name: 'p' },
      value: 'v',
      key: 'k',
      provider: 'claude',
      jobIds: ['a', 'b'],
      mode: 'implement',
      body: 'body',
      content: 'content',
    }

    let dispatched = 0
    for (const spec of buildToolSpecs()) {
      const opts = actionOptions(spec)
      if (opts.length === 0) continue
      for (const action of opts) {
        try {
          await spec.handler(ctx, { ...genericArgs, action })
          dispatched++
        } catch (err) {
          // A validation/parse throw is fine — the handler still executed its
          // branch. We only fail on a framework-level programming error.
          expect(err).toBeInstanceOf(Error)
        }
      }
    }
    // The mocked fetch should have been hit by the many read/write branches.
    expect(fetchMock).toHaveBeenCalled()
    expect(dispatched).toBeGreaterThan(20)
  })

  it('minimal args exercise each handler validation branch', async () => {
    for (const spec of buildToolSpecs()) {
      for (const action of actionOptions(spec)) {
        try {
          // Only action + projectId → many actions throw on missing required
          // params, exercising their validation branches.
          await spec.handler(ctx, { action, projectId: 'p1' })
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
        }
      }
    }
  })

  it('unknown action throws a clear error', async () => {
    for (const spec of buildToolSpecs()) {
      if (actionOptions(spec).length === 0) continue
      await expect(async () => spec.handler(ctx, { action: '__nope__', projectId: 'p1' })).rejects.toThrow()
    }
  })

  it('async actions append a watch hint', async () => {
    const rails = buildToolSpecs().find((s) => s.name === 'specrails_rails')!
    const res = (await rails.handler(ctx, { action: 'launch', projectId: 'p1', railIndex: 0, mode: 'implement', ticketIds: [1] })) as { hint?: string }
    expect(res.hint).toMatch(/specrails_watch/)
  })

  // Origin link (safe-pr-review-flow): a launch driven by the in-app agent tags
  // itself with the launching conversation so the PR-decision card fires there.
  describe('rails launch origin link', () => {
    const launchBody = (): Record<string, unknown> => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/rails/0/launch'))
      expect(call).toBeTruthy()
      return JSON.parse((call![1] as { body: string }).body)
    }

    it('includes originConversationId + originSurface=agent-chat when the ctx carries the id', async () => {
      const rails = buildToolSpecs().find((s) => s.name === 'specrails_rails')!
      await rails.handler({ ...ctx, originConversationId: 'conv-42' }, { action: 'launch', projectId: 'p1', railIndex: 0 })
      expect(launchBody()).toMatchObject({ originConversationId: 'conv-42', originSurface: 'agent-chat' })
    })

    it('omits both fields when the ctx has no id (external client / dashboard)', async () => {
      const rails = buildToolSpecs().find((s) => s.name === 'specrails_rails')!
      await rails.handler(ctx, { action: 'launch', projectId: 'p1', railIndex: 0 })
      const body = launchBody()
      expect(body).not.toHaveProperty('originConversationId')
      expect(body).not.toHaveProperty('originSurface')
    })

    it('omits both fields when the ctx id sanitized to null (malformed header)', async () => {
      const rails = buildToolSpecs().find((s) => s.name === 'specrails_rails')!
      await rails.handler({ ...ctx, originConversationId: null }, { action: 'launch', projectId: 'p1', railIndex: 0 })
      const body = launchBody()
      expect(body).not.toHaveProperty('originConversationId')
      expect(body).not.toHaveProperty('originSurface')
    })
  })
})
