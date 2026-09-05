import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import type { Request } from 'express'
import { initDesktopDb, setDesktopSetting } from '../../desktop-db'
import type { DbInstance } from '../../db'
import { createAgentConversation } from '../../agent-store'
import { registerJobsRoutes } from '../../project-router-jobs'
import type { ProjectRoutesDeps } from '../../project-router-helpers'
import type { ProjectContext, ProjectRegistry } from '../../project-registry'
import { registerTieredTool, setActiveProject, originConversationDefaults, type McpToolContext, type ToolHandlerExtra } from './types'
import { jobsTools } from './jobs'
import { AGENT_CAPABILITY_HEADER } from '../../agent-tier'
import { _resetAgentCapabilitiesForTest, mintAgentCapability } from '../agent-capability'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// ── Conversation-provider engine default on specrails_jobs(spawn) ─────────────
//
// Same structural fix as the rails launch (see rails-origin.test.ts): a spawn
// driven by the in-app agent without an explicit aiEngine must run on the
// LAUNCHING CONVERSATION's provider, not silently on the project primary.
// Drives the REAL /spawn route (validateRequestedProvider included) behind a
// real HTTP listener — only the QueueManager is stubbed at the enqueue seam.

describe('MCP → jobs spawn → conversation-provider engine default', () => {
  let desktopDb: DbInstance
  let server: Server
  let ctx: McpToolContext
  let enqueue: ReturnType<typeof vi.fn>
  let captured: ((args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | undefined

  const fakeServer = {
    registerTool: (_name: string, _cfg: unknown, cb: typeof captured) => {
      captured = cb
    },
  } as unknown as McpServer

  beforeEach(async () => {
    desktopDb = initDesktopDb(':memory:')
    _resetAgentCapabilitiesForTest()
    setDesktopSetting(desktopDb, 'mcp_tier_ai_spawn', 'true')
    enqueue = vi.fn().mockReturnValue({ id: 'job-1', queuePosition: 0 })

    // The REAL spawn route (project-router-jobs) behind a real HTTP listener.
    const project = { id: 'p1', slug: 's1', name: 'P1', path: '/repo', provider: 'claude', providers: ['claude', 'codex'] }
    const projectCtx = { project, queueManager: { enqueue } } as unknown as ProjectContext
    const app = express()
    app.use(express.json())
    const jobsRouter = express.Router()
    registerJobsRoutes({
      router: jobsRouter,
      registry: {} as ProjectRegistry,
      ctx: (_req: Request) => projectCtx,
      ticketPath: () => '/unused',
    } as unknown as ProjectRoutesDeps)
    app.use('/api/projects', jobsRouter)
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port

    // The MCP side: real registerTieredTool over the real jobs tool spec.
    const registry = {
      desktopDb,
      listContexts: () => [projectCtx],
      getContext: (id: string) => (id === 'p1' ? projectCtx : undefined),
    } as unknown as ProjectRegistry
    ctx = { registry, desktopDb, broadcast: () => {}, eventBus: new MobileEventBus(), desktopPort: port }
    captured = undefined
    setActiveProject(null)
    registerTieredTool(fakeServer, ctx, jobsTools()[0])
  })

  afterEach(async () => {
    setActiveProject(null)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    desktopDb.close()
  })

  const spawnExtra = (conversationId?: string): ToolHandlerExtra => {
    if (!conversationId) return { requestInfo: { headers: {} } }
    const capability = mintAgentCapability({ conversationId, projectId: 'p1', tierLevel: 2 })
    return { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: capability } } }
  }

  const spawnArgs = { action: 'spawn', projectId: 'p1', command: '/specrails:implement #5 --yes' }

  it('a spawn from a CODEX conversation defaults the engine to codex through the real route', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex' })
    const r = await captured!(spawnArgs, spawnExtra(conv.id))
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(r.content[0].text)).toMatchObject({ jobId: 'job-1' })

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0][2]).toMatchObject({ provider: 'codex' })
  })

  it('an explicit aiEngine always wins over the conversation default', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex' })
    const r = await captured!({ ...spawnArgs, aiEngine: 'claude' }, spawnExtra(conv.id))
    expect(r.isError).toBeFalsy()
    expect(enqueue.mock.calls[0][2]).toMatchObject({ provider: 'claude' })
  })

  it('preserves the conversation model and explicit null profile through the real spawn route', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex', model: 'gpt-6-astra' })
    const r = await captured!({ ...spawnArgs, profileName: null }, spawnExtra(conv.id))
    expect(r.isError).toBeFalsy()
    expect(enqueue.mock.calls[0][2]).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', profileName: null })
  })

  it('explicit model override reaches provider validation instead of being silently discarded', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex', model: 'gpt-6-astra' })
    const r = await captured!({ ...spawnArgs, model: 'not-a-codex-model' }, spawnExtra(conv.id))
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('model')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('without an agent capability no engine is sent (legacy primary resolution)', async () => {
    const r = await captured!(spawnArgs, spawnExtra())
    expect(r.isError).toBeFalsy()
    expect(enqueue).toHaveBeenCalledTimes(1)
    // The route passes provider: undefined when no aiEngine was requested —
    // QueueManager keeps its legacy primary-provider path.
    expect(enqueue.mock.calls[0][2].provider).toBeUndefined()
  })

  it('an unknown conversation id is tolerated: no default, spawn proceeds', async () => {
    const r = await captured!(spawnArgs, spawnExtra('conv-that-does-not-exist'))
    expect(r.isError).toBeFalsy()
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0][2].provider).toBeUndefined()
  })

  it("a conversation provider NOT installed on the project surfaces the route's clear 400 as a tool error", async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'gemini' })
    const r = await captured!(spawnArgs, spawnExtra(conv.id))
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("provider 'gemini' is not installed")
    expect(enqueue).not.toHaveBeenCalled()
  })

  // ── originConversationDefaults unit edges ───────────────────────────────────

  it('originConversationDefaults: null and absent origin both yield {}', () => {
    expect(originConversationDefaults(ctx)).toEqual({})
    expect(originConversationDefaults({ ...ctx, originConversationId: null })).toEqual({})
  })

  it('originConversationDefaults: returns the conversation provider + stored effort', () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex', reasoningEffort: 'high' })
    expect(originConversationDefaults({ ...ctx, originConversationId: conv.id })).toEqual({
      provider: 'codex',
      reasoningEffort: 'high',
    })
  })

  it('originConversationDefaults: unknown id yields {}', () => {
    expect(originConversationDefaults({ ...ctx, originConversationId: 'nope' })).toEqual({})
  })
})
