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

  it('describes Freestyle as the user-facing name for the canonical freestyle mode', () => {
    const rails = buildToolSpecs().find((s) => s.name === 'specrails_rails')!
    expect(rails.description).toContain('call the free-form autonomous mode "Freestyle"')
    expect(rails.description).toContain('canonical API enum value')
    const mode = rails.inputSchema.mode as z.ZodTypeAny
    expect(mode.description).toContain('Use "freestyle" as the canonical API enum value for Freestyle')
    expect(mode.description).toContain('In prose, call it "Freestyle"')
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

describe('specrails_git tool', () => {
  let db: DbInstance
  let ctx: McpToolContext
  beforeEach(() => { db = initDesktopDb(':memory:'); ctx = makeCtx(db); setActiveProject('p1') })
  afterEach(() => { vi.unstubAllGlobals(); setActiveProject(null) })

  const gitSpec = () => buildToolSpecs().find((s) => s.name === 'specrails_git')!

  it('is registered as a READ-tier tool with a read-only action enum', () => {
    const spec = gitSpec()
    expect(spec).toBeTruthy()
    expect(spec.hintTier).toBe('read')
    expect(spec.tier).toBe('read') // constant, never ai-spawn/destructive
    const actions = actionOptions(spec)
    expect(actions).toEqual(expect.arrayContaining(['remote', 'gh_repo', 'gh_auth']))
    // No mutating action is exposed.
    for (const a of actions) expect(a).not.toMatch(/push|create|merge|commit|checkout|delete/)
  })

  it('handler GETs the diagnostic endpoint for the chosen action', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ action: 'remote', command: 'git remote -v', ok: true, exitCode: 0, stdout: 'origin ...', stderr: '' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await gitSpec().handler(ctx, { action: 'remote' }) as Record<string, unknown>
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/projects/p1/git/diagnostic?action=remote')
    expect(r).toMatchObject({ action: 'remote', ok: true })
  })

  it('adds a report-the-real-state hint when the command exited non-zero', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ action: 'gh_repo', ok: false, exitCode: 1, stdout: '', stderr: 'no git remotes found' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await gitSpec().handler(ctx, { action: 'gh_repo' }) as Record<string, unknown>
    expect(String(r.hint)).toContain('report the real state')
  })
})

describe('specrails_support tool', () => {
  let db: DbInstance
  let ctx: McpToolContext
  beforeEach(() => { db = initDesktopDb(':memory:'); ctx = makeCtx(db); setActiveProject('p1') })
  afterEach(() => { vi.unstubAllGlobals(); setActiveProject(null) })

  const supportSpec = () => buildToolSpecs().find((s) => s.name === 'specrails_support')!

  it('routes support triage away from spec creation and recognizes missing framework files', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => {
        if (String(url).includes('/core-update/status')) {
          return JSON.stringify({ available: true, currentVersion: '4.8.0', latestVersion: null, updateAvailable: false })
        }
        if (String(url).includes('/setup/checkpoints')) {
          return JSON.stringify({ isInstalling: false, logLines: ['missing baseline agents'] })
        }
        return JSON.stringify({ ok: true })
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await supportSpec().handler(ctx, {
      action: 'triage',
      projectId: 'p1',
      question: 'The job failed because no agents or skills were found',
    }) as Record<string, unknown>

    expect(res).toMatchObject({
      mode: 'support-triage',
      doNotCreateSpec: true,
      topic: 'framework_install',
    })
    const diagnostics = res.localDiagnostics as { setupCheckpoints?: { skipped?: boolean; reason?: string } }
    expect(diagnostics.setupCheckpoints?.skipped).toBe(true)
    expect(diagnostics.setupCheckpoints?.reason).toContain('not a specrails-core health check')
    expect(String(res.recommendedNextSteps)).toContain('specrails-core')
    expect(String(res.recommendedNextSteps)).toContain('npx specrails-core@latest update')
    expect(String(res.availableRepairActions)).toContain('core_update_apply')
    expect(String(res.availableRepairActions)).not.toContain('reassemble_project_workspace')
    expect(String(res.recommendedNextSteps)).toContain('Never recommend specrails_setup(install)')
    expect(String(res.supportPrompt)).toContain('Do not create or propose a spec')
  })

  it('exposes only global core update as ai-spawn for core support', () => {
    const spec = supportSpec()
    const tier = spec.tier as (a: Record<string, unknown>) => string
    expect(tier({ action: 'triage' })).toBe('read')
    expect(tier({ action: 'core_update_status' })).toBe('read')
    expect(tier({ action: 'core_update_apply' })).toBe('ai-spawn')
    expect(actionOptions(spec)).not.toContain('reassemble_project_workspace')
  })
})
