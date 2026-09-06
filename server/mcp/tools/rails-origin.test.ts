import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('../../auth', () => ({ loadOrGenerateToken: () => 'rails-origin-test-token-no-filesystem-access' }))
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { initDb, type DbInstance } from '../../db'
import { initDesktopDb, setDesktopSetting } from '../../desktop-db'
import { createAgentConversation } from '../../agent-store'
import { createRailsRouter } from '../../rails-router'
import { setRailTickets } from '../../rails-store'
import { getActivePrDeliveryByRail, getPrDelivery } from '../../rail-pr-store'
import { setAgentChatManager } from '../../agent-chat-registry'
import type { AgentChatManager } from '../../agent-chat-manager'
import { registerTieredTool, setActiveProject, type McpToolContext, type ToolHandlerExtra } from './types'
import { railsTools } from './rails'
import { AGENT_CAPABILITY_HEADER, AGENT_CONVERSATION_HEADER } from '../../agent-tier'
import { _resetAgentCapabilitiesForTest, mintAgentCapability } from '../agent-capability'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import type { ProjectRegistry } from '../../project-registry'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// ── End-to-end origin link (design §8, safe-pr-review-flow) ───────────────────
//
// Drives the REAL chain with no hop mocked between the MCP tool guard and the
// per-project DB: registerTieredTool resolves the server-minted capability into
// the per-call ctx → the specrails_rails launch handler puts it in the POST body
// → a real HTTP round-trip hits the real rails-router → the real
// launchIsolatedRail INSERTs the rail_pr_deliveries row carrying the origin —
// and at settle the agent-chat card driver fires for that conversation.
// Only the git/worktree IO is faked (module mock), so no real repo is needed.

// Mutable isolation status so a test can drive the no-git fallback path.
const isoStatus = vi.hoisted(() => ({ value: 'ok' as 'ok' | 'no-git' | 'no-commits' }))
const testRefs = vi.hoisted(() => ({ headSha: 'a'.repeat(40) }))

vi.mock('../../worktree-manager', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  defaultGitRunner: {
    run: async (args: string[]) => args.join(' ') === 'rev-parse --verify HEAD'
      ? { code: 0, stdout: `${testRefs.headSha}\n`, stderr: '' }
      : { code: 1, stdout: '', stderr: '' },
  }, // integration branch still falls back to HEAD; settlement can prove exact HEAD
  repoIsolationStatus: async () => isoStatus.value,
  createWorktree: async (_git: unknown, input: { slug: string; ticketId: number; branch?: string }) => ({
    // The launch threads the conventional preferred name (pr-naming); echo it
    // back like the real createWorktree, with the legacy fallback when absent.
    branch: input.branch ?? `sr/${input.slug}/ticket-${input.ticketId}`,
    worktreePath: `/tmp/fake-wt-${input.ticketId}`,
  }),
  commitWorktree: async () => {},
  commitWorktreeAndVerify: async () => ({ staged: true, committed: true, clean: true, dirty: [] }),
  removeWorktree: async () => {},
}))

describe('MCP → rails launch → rail_pr_deliveries origin link (end-to-end)', () => {
  const ORIG_PR = process.env.SPECRAILS_RAIL_DELIVER_PR
  let db: DbInstance
  let desktopDb: DbInstance
  let server: Server
  let ctx: McpToolContext
  let captured: ((args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | undefined
  let postPrDecisionCard: ReturnType<typeof vi.fn>
  let updatePrDecisionCard: ReturnType<typeof vi.fn>
  let loopRun: ReturnType<typeof vi.fn>

  const fakeServer = {
    registerTool: (_name: string, _cfg: unknown, cb: typeof captured) => {
      captured = cb
    },
  } as unknown as McpServer

  beforeEach(async () => {
    delete process.env.SPECRAILS_RAIL_DELIVER_PR // PR delivery default-on
    isoStatus.value = 'ok'
    db = initDb(':memory:')
    desktopDb = initDesktopDb(':memory:')
    _resetAgentCapabilitiesForTest()
    setDesktopSetting(desktopDb, 'mcp_tier_ai_spawn', 'true')
    setRailTickets(db, 0, [1, 2], 'loop')

    // The real rails-router behind a real HTTP listener (apiCall does real fetch).
    // Multi-provider project (claude primary + codex) so the conversation-engine
    // default has a second installed engine to resolve to.
    loopRun = vi.fn().mockResolvedValue({ runId: 'r', outcome: 'success', iterations: 1, totalCostUsd: 0 })
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { projectCtx: unknown }).projectCtx = {
        db,
        desktopDb,
        railJobs: new Map(),
        railLoopRuns: new Map(),
        project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude', 'codex'], path: '/repo' },
        broadcast: () => { /* noop */ },
        loopRunManager: {
          run: loopRun,
          cancel: vi.fn(),
        },
        getTicketSpec: () => ({ title: 'T', description: 'D' }),
        onLoopRunFinished: () => { /* noop */ },
      }
      next()
    })
    app.use('/api/projects/p1/rails', createRailsRouter())
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port

    // The MCP side: real registerTieredTool over the real rails tool spec.
    const project = { id: 'p1', slug: 's1', name: 'P1', path: '/repo', provider: 'claude', providers: ['claude', 'codex'] }
    const pc = { project }
    const registry = {
      desktopDb,
      listContexts: () => [pc],
      getContext: (id: string) => (id === 'p1' ? pc : undefined),
    } as unknown as ProjectRegistry
    ctx = { registry, desktopDb, broadcast: () => {}, eventBus: new MobileEventBus(), desktopPort: port }
    captured = undefined
    setActiveProject(null)
    registerTieredTool(fakeServer, ctx, railsTools()[0])

    // Option B driver observer: the settle path posts the card via the registry.
    postPrDecisionCard = vi.fn()
    updatePrDecisionCard = vi.fn()
    setAgentChatManager({ postPrDecisionCard, updatePrDecisionCard } as unknown as AgentChatManager)
  })

  afterEach(async () => {
    setAgentChatManager(null)
    setActiveProject(null)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    desktopDb.close()
    if (ORIG_PR === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
    else process.env.SPECRAILS_RAIL_DELIVER_PR = ORIG_PR
  })

  const launchExtra = (conversationId?: string): ToolHandlerExtra => {
    if (!conversationId) return { requestInfo: { headers: {} } }
    const capability = mintAgentCapability({ conversationId, projectId: 'p1', tierLevel: 2 })
    return { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: capability } } }
  }

  it('a capability-authenticated launch persists origin_conversation_id and fires the chat card at settle', async () => {
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement' },
      launchExtra('conv-int-42'),
    )
    expect(r.isError).toBeFalsy()
    const payload = JSON.parse(r.content[0].text)
    expect(payload.isolated).toBe(true)
    expect(payload.loopRunIds).toHaveLength(1) // scope='all' → one unit

    // The 202 already implies the up-front INSERT ran: origin persisted.
    const row = getActivePrDeliveryByRail(db, 0)
    expect(row).toBeTruthy()
    expect(row!.origin_surface).toBe('agent-chat')
    expect(row!.origin_conversation_id).toBe('conv-int-42')

    // The building card lands in the LAUNCHING conversation immediately.
    expect(postPrDecisionCard).toHaveBeenCalledTimes(1)
    expect(postPrDecisionCard.mock.calls[0][0]).toBe('conv-int-42')
    expect(postPrDecisionCard.mock.calls[0][1]).toMatchObject({ kind: 'pr_decision', decision: 'building' })

    // Two in-place refreshes: the run-allocation runIds patch (still building —
    // the card gains its "View log" chips live), then the settle transition.
    await vi.waitFor(() => {
      expect(getPrDelivery(db, row!.id)!.decision).toBe('on_review')
      expect(updatePrDecisionCard).toHaveBeenCalledTimes(2)
    })
    expect(updatePrDecisionCard.mock.calls[0][0]).toBe('conv-int-42')
    expect(updatePrDecisionCard.mock.calls[0][1]).toMatchObject({
      kind: 'pr_decision',
      decision: 'building',
      runIds: payload.loopRunIds,
    })
    const [convId, envelope] = updatePrDecisionCard.mock.calls[1] as [string, Record<string, unknown>]
    expect(convId).toBe('conv-int-42')
    expect(envelope).toMatchObject({
      kind: 'pr_decision',
      prDeliveryId: row!.id,
      railIndex: 0,
      projectId: 'p1',
      decision: 'on_review',
      ticketIds: [1, 2],
      runIds: payload.loopRunIds,
    })
  })

  it('SDD Quick OpenSpec factory launch also persists origin and posts the PR decision card', async () => {
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, mode: 'loop', loopId: 'factory:sdd-quick-openspec' },
      launchExtra('conv-sdd-quick'),
    )

    expect(r.isError).toBeFalsy()
    const payload = JSON.parse(r.content[0].text)
    expect(payload.isolated).toBe(true)
    expect(payload.loopRunIds).toHaveLength(2)
    expect(loopRun.mock.calls[0][0].loopId).toBe('factory:sdd-quick-openspec')

    const row = getActivePrDeliveryByRail(db, 0)
    expect(row).toBeTruthy()
    expect(row!.origin_surface).toBe('agent-chat')
    expect(row!.origin_conversation_id).toBe('conv-sdd-quick')
    expect(postPrDecisionCard).toHaveBeenCalledWith(
      'conv-sdd-quick',
      expect.objectContaining({ kind: 'pr_decision', decision: 'building' }),
    )
    await settle()
  })

  it('a no-git repo falls back to shared cwd: NO card, and the hint tells the agent to be honest (not promise a card)', async () => {
    isoStatus.value = 'no-git'
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement' },
      launchExtra('conv-nogit'),
    )
    expect(r.isError).toBeFalsy()
    const payload = JSON.parse(r.content[0].text)
    // Shared-cwd fallback surfaced verbatim + isolated flag absent.
    expect(payload.isolationUnavailable).toBe('no-git')
    expect(payload.isolated).toBeUndefined()
    // No delivery row → no card ever posted, despite the authenticated origin.
    expect(getActivePrDeliveryByRail(db, 0)).toBeFalsy()
    expect(postPrDecisionCard).not.toHaveBeenCalled()
    // The hint forbids promising a card and explains the shared-cwd reality.
    expect(payload.hint).toMatch(/ISOLATION IS UNAVAILABLE/i)
    expect(payload.hint).toMatch(/NO PR-decision/i)
    expect(payload.hint).toMatch(/git init/i)
    expect(payload.hint).toMatch(/directly into the user's files/i)
  })

  it('without an agent capability the launch lands as dashboard/NULL and no card fires', async () => {
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement' },
      launchExtra(),
    )
    expect(r.isError).toBeFalsy()

    const row = getActivePrDeliveryByRail(db, 0)
    expect(row).toBeTruthy()
    expect(row!.origin_surface).toBe('dashboard')
    expect(row!.origin_conversation_id).toBeNull()

    // No origin conversation → no engine default: primary provider (claude).
    expect(loopRun).toHaveBeenCalledTimes(1)
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'claude' })

    await vi.waitFor(() => {
      expect(getPrDelivery(db, row!.id)!.decision).toBe('on_review')
    })
    expect(postPrDecisionCard).not.toHaveBeenCalled()
    expect(updatePrDecisionCard).not.toHaveBeenCalled()
  })

  it('a BARE-mode MCP launch (no loopId) derives factory:implement and gets the same isolated PR delivery as the dashboard', async () => {
    // The scenario that motivated the derivation fix: an agent/MCP-launched
    // implement without a loopId. Pre-fix it fell into the bare QueueManager
    // branch (shared cwd, no rail_pr_deliveries row — stranded uncommitted
    // work); this ctx has no queueManager at all, so reaching that branch
    // would 500. The derivation must route it through the loop engine.
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, mode: 'implement' },
      launchExtra('conv-bare-7'),
    )
    expect(r.isError).toBeFalsy()
    const payload = JSON.parse(r.content[0].text)
    expect(payload.isolated).toBe(true)
    expect(payload.loopRunIds).toHaveLength(1) // derived implement is all-scope → one unit

    const row = getActivePrDeliveryByRail(db, 0)
    expect(row).toBeTruthy()
    expect(row!.loop_id).toBe('factory:implement') // derived server-side, never sent
    expect(row!.origin_surface).toBe('agent-chat')
    expect(row!.origin_conversation_id).toBe('conv-bare-7')

    await vi.waitFor(() => {
      expect(getPrDelivery(db, row!.id)!.decision).toBe('on_review')
    })
  })

  it('a malformed legacy conversation header is ignored and the launch remains untagged', async () => {
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement' },
      { requestInfo: { headers: { [AGENT_CONVERSATION_HEADER]: 'not valid!!' } } },
    )
    expect(r.isError).toBeFalsy() // sanitized to null → fields omitted from the body

    const row = getActivePrDeliveryByRail(db, 0)
    expect(row!.origin_conversation_id).toBeNull()
    await vi.waitFor(() => {
      expect(getPrDelivery(db, row!.id)!.decision).toBe('on_review')
    })
    expect(postPrDecisionCard).not.toHaveBeenCalled()
    expect(updatePrDecisionCard).not.toHaveBeenCalled()
  })

  // ── Conversation-provider engine default (structural fix) ─────────────────
  // The live bug: a codex agent-chat conversation asked to implement and the
  // rail launched with claude, because the tool sent no aiEngine and the
  // router's precedence (body > rail > primary) fell through to the primary.

  const settle = async (): Promise<void> => {
    const row = getActivePrDeliveryByRail(db, 0)
    await vi.waitFor(() => {
      expect(getPrDelivery(db, row!.id)!.decision).toBe('on_review')
    })
  }

  it('a launch from a CODEX conversation defaults the engine to codex through the real router', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex' })
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement' },
      launchExtra(conv.id),
    )
    expect(r.isError).toBeFalsy()

    expect(loopRun).toHaveBeenCalledTimes(1)
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'codex' })
    // No conversation effort stored → none defaulted.
    expect(loopRun.mock.calls[0][0].effort).toBeUndefined()

    // The origin link still rides along untouched.
    const row = getActivePrDeliveryByRail(db, 0)
    expect(row!.origin_conversation_id).toBe(conv.id)
    await settle()
  })

  it('an explicit aiEngine always wins over the conversation default', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex' })
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement', aiEngine: 'claude' },
      launchExtra(conv.id),
    )
    expect(r.isError).toBeFalsy()
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'claude' })
    await settle()
  })

  it('inherits Astra together with its ultra effort instead of rejecting it against the default model', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' })
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement' },
      launchExtra(conv.id),
    )
    expect(r.isError).toBeFalsy()
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' })
    await settle()
  })

  it('an explicit model does not inherit an incompatible effort from the mission model', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' })
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement', model: 'gpt-5.5' },
      launchExtra(conv.id),
    )
    expect(r.isError).toBeFalsy()
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'codex', model: 'gpt-5.5' })
    expect(loopRun.mock.calls[0][0].effort).toBeUndefined()
    await settle()
  })

  it('never carries the conversation model or effort into a different engine', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' })
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement', aiEngine: 'claude' },
      launchExtra(conv.id),
    )
    expect(r.isError).toBeFalsy()
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'claude' })
    expect(loopRun.mock.calls[0][0].model).not.toBe('gpt-6-astra')
    expect(loopRun.mock.calls[0][0].effort).toBeUndefined()
    await settle()
  })

  it('an explicit aiEngine null forces the project primary despite the conversation provider', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex' })
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement', aiEngine: null },
      launchExtra(conv.id),
    )
    expect(r.isError).toBeFalsy()
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'claude' })
    await settle()
  })

  it('an unknown conversation id is tolerated: no engine default, launch proceeds on primary', async () => {
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement' },
      launchExtra('conv-that-does-not-exist'),
    )
    expect(r.isError).toBeFalsy()
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'claude' })
    // The router doesn't require the conversation to exist for the origin tag.
    expect(getActivePrDeliveryByRail(db, 0)!.origin_conversation_id).toBe('conv-that-does-not-exist')
    await settle()
  })

  it("a conversation provider NOT installed on the project surfaces the router's clear 400 as a tool error", async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'gemini' })
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement' },
      launchExtra(conv.id),
    )
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("provider 'gemini' is not installed")
    expect(loopRun).not.toHaveBeenCalled()
  })

  it("the conversation's reasoning effort defaults onto loop launches when it fits the low/medium/high contract", async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex', reasoningEffort: 'high' })
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement' },
      launchExtra(conv.id),
    )
    expect(r.isError).toBeFalsy()
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'codex', effort: 'high' })
    await settle()
  })

  it('a model-valid conversation effort is defaulted under the model-aware launch contract', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex', reasoningEffort: 'low' })
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement' },
      launchExtra(conv.id),
    )
    expect(r.isError).toBeFalsy()
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'codex', effort: 'low' })
    await settle()
  })

  it('an explicit reasoning_effort wins over the conversation effort', async () => {
    const conv = createAgentConversation(desktopDb, { provider: 'codex', reasoningEffort: 'high' })
    const r = await captured!(
      { action: 'launch', projectId: 'p1', railIndex: 0, loopId: 'factory:implement', reasoning_effort: 'low' },
      launchExtra(conv.id),
    )
    expect(r.isError).toBeFalsy()
    expect(loopRun.mock.calls[0][0]).toMatchObject({ provider: 'codex', effort: 'low' })
    await settle()
  })
})
