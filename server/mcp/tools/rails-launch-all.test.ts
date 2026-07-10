import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { initDb, type DbInstance } from '../../db'
import { initDesktopDb } from '../../desktop-db'
import { createRailsRouter } from '../../rails-router'
import { setRailTickets, createRail } from '../../rails-store'
import { createPrDelivery, transitionDecision, type CreatePrDeliveryInput } from '../../rail-pr-store'
import { registerTieredTool, setActiveProject, type McpToolContext, type ToolHandlerExtra } from './types'
import { railsTools } from './rails'
import { AGENT_CAPABILITY_HEADER } from '../../agent-tier'
import { _resetAgentCapabilitiesForTest, mintAgentCapability } from '../agent-capability'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import type { ProjectRegistry } from '../../project-registry'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// ── specrails_rails: create_rail + launch_all (server-side fan-out) ───────────
//
// Drives the REAL chain: registerTieredTool → the rails tool handler → real
// HTTP loopback → the real rails-router over a real per-project DB. Loops are
// pinned OFF so launches take the legacy QueueManager path (a mocked enqueue) —
// the fan-out/skip logic under test is transport-level and identical either way.

describe('specrails_rails — create_rail + launch_all', () => {
  const savedLoops = process.env.SPECRAILS_LOOPS_SECTION
  let db: DbInstance
  let desktopDb: DbInstance
  let server: Server
  let ctx: McpToolContext
  let enqueue: ReturnType<typeof vi.fn>
  let railJobs: Map<string, { railIndex: number; mode: string; ticketIds: number[] }>
  let railLoopRuns: Map<string, { railIndex: number; ticketIds: number[] }>
  let captured: ((args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | undefined

  const fakeServer = {
    registerTool: (_name: string, _cfg: unknown, cb: typeof captured) => {
      captured = cb
    },
  } as unknown as McpServer

  const call = async (args: Record<string, unknown>) => {
    // In-app agent ladder at 'autonomous' so write/ai-spawn tiers pass the
    // guard (tier enforcement itself is covered by the mcp-tiers suites).
    const capability = mintAgentCapability({ conversationId: 'conv-launch-all', projectId: 'p1', tierLevel: 3 })
    const extra: ToolHandlerExtra = { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: capability } } }
    const res = await captured!(args, extra)
    return { res, data: res.isError ? null : JSON.parse(res.content[0].text) }
  }

  beforeEach(async () => {
    _resetAgentCapabilitiesForTest()
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    db = initDb(':memory:')
    desktopDb = initDesktopDb(':memory:')
    let n = 0
    enqueue = vi.fn().mockImplementation(() => ({ id: `job-${++n}`, queuePosition: 0 }))
    railJobs = new Map()
    railLoopRuns = new Map()

    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { projectCtx: unknown }).projectCtx = {
        db,
        desktopDb,
        railJobs,
        railLoopRuns,
        project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude'], path: '/repo' },
        queueManager: { enqueue },
        broadcast: () => { /* noop */ },
        jiraSyncManager: { onRailLaunch: () => {} },
        getTicketSpec: () => ({ title: 'T', description: 'D' }),
        onLoopRunFinished: () => { /* noop */ },
      }
      next()
    })
    app.use('/api/projects/p1/rails', createRailsRouter())
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port

    const project = { id: 'p1', slug: 's1', name: 'P1', path: '/repo', provider: 'claude', providers: ['claude'] }
    const pc = { project }
    const registry = {
      desktopDb,
      listContexts: () => [pc],
      getContext: (id: string) => (id === 'p1' ? pc : undefined),
    } as unknown as ProjectRegistry
    ctx = { registry, desktopDb, broadcast: () => {}, eventBus: new MobileEventBus(), desktopPort: port }
    captured = undefined
    setActiveProject('p1')
    registerTieredTool(fakeServer, ctx, railsTools()[0])
  })

  afterEach(async () => {
    setActiveProject(null)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    desktopDb.close()
    if (savedLoops === undefined) delete process.env.SPECRAILS_LOOPS_SECTION
    else process.env.SPECRAILS_LOOPS_SECTION = savedLoops
  })

  it('tier mapping: create_rail is write, launch_all is ai-spawn', () => {
    const spec = railsTools()[0]
    const tier = spec.tier as (a: Record<string, unknown>) => string
    expect(tier({ action: 'create_rail' })).toBe('write')
    expect(tier({ action: 'launch_all' })).toBe('ai-spawn')
    expect(tier({ action: 'launch' })).toBe('ai-spawn')
    expect(tier({ action: 'list' })).toBe('read')
  })

  it('create_rail returns the new railIndex (agents create slots when none are free)', async () => {
    const { res, data } = await call({ action: 'create_rail' })
    expect(res.isError).toBeUndefined()
    expect(data.rail).toMatchObject({ railIndex: 3, ticketIds: [] })
    // UI label is 1-based — the tool spells it out so the agent never quotes
    // the raw 0-based railIndex as the rail's name.
    expect(data.railLabel).toBe('Rail 4')
    expect(data.hint).toContain('Rail 4')
    expect(data.hint).toContain('set_tickets')
    // With a name, and visible on list.
    const second = await call({ action: 'create_rail', name: 'Overflow' })
    expect(second.data.rail).toMatchObject({ railIndex: 4, name: 'Overflow' })
    const list = await call({ action: 'list' })
    expect(list.data.rails.map((r: { railIndex: number }) => r.railIndex)).toEqual([0, 1, 2, 3, 4])
  })

  it('create_rail surfaces the rail_limit_reached error', async () => {
    for (let i = 0; i < 9; i++) createRail(db)
    const { res } = await call({ action: 'create_rail' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('rail_limit_reached')
  })

  it('launch_all launches every eligible rail IN PARALLEL and skips the rest with reasons', async () => {
    // rail 0: eligible (2 tickets); rail 1: empty → skipped; rail 2: eligible;
    // rail 3 (dynamic): active loop run → skipped already-running;
    // rail 4 (dynamic): undecided PR delivery → skipped pr-decision-pending.
    setRailTickets(db, 0, [1, 2])
    setRailTickets(db, 2, [3])
    createRail(db) // 3
    setRailTickets(db, 3, [4])
    railLoopRuns.set('run-1', { railIndex: 3, ticketIds: [4] })
    createRail(db) // 4
    setRailTickets(db, 4, [5])
    createPrDelivery(db, {
      railIndex: 4, loopId: 'factory:implement', railKey: '4-factory:implement',
      ticketIds: [5], baseBranch: 'main', loopName: 'Implement',
      originSurface: 'dashboard', originConversationId: null,
    } as CreatePrDeliveryInput)

    const { res, data } = await call({ action: 'launch_all' })
    expect(res.isError).toBeUndefined()
    expect(data.launched).toBe(2)
    expect(data.skipped).toBe(3)
    expect(data.failed).toBe(0)
    const byIndex = new Map((data.results as { railIndex: number }[]).map((r) => [r.railIndex, r]))
    expect(byIndex.get(0)).toMatchObject({ outcome: 'launched', ticketIds: [1, 2], railLabel: 'Rail 1' })
    expect(byIndex.get(4)).toMatchObject({ railLabel: 'Rail 5' })
    expect(byIndex.get(0)).toHaveProperty('jobId')
    expect(byIndex.get(1)).toMatchObject({ outcome: 'skipped', reason: 'empty' })
    expect(byIndex.get(2)).toMatchObject({ outcome: 'launched', ticketIds: [3] })
    expect(byIndex.get(3)).toMatchObject({ outcome: 'skipped', reason: 'already-running' })
    expect(byIndex.get(4)).toMatchObject({ outcome: 'skipped', reason: 'pr-decision-pending' })
    expect(enqueue).toHaveBeenCalledTimes(2) // one launch per eligible rail
    expect(data.hint).toContain('PARALLEL')
  })

  it('launch_all treats a published PR delivery covering the rail tickets as continuable', async () => {
    setRailTickets(db, 0, [5])
    const row = createPrDelivery(db, {
      railIndex: 0, loopId: 'factory:implement', railKey: '0-factory:implement',
      ticketIds: [5], baseBranch: 'main', loopName: 'Implement',
      originSurface: 'dashboard', originConversationId: null,
    } as CreatePrDeliveryInput)
    transitionDecision(db, row.id, 'building', 'on_review', {
      branches: [{ ticketId: 5, branch: 'feat/open-pr', succeeded: true }],
      worktreeIds: [],
    })
    transitionDecision(db, row.id, 'on_review', 'pr_draft', {
      branch: 'feat/open-pr',
      prUrl: 'https://github.com/o/r/pull/521',
      prNumber: 521,
      prState: 'pr-created',
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_ready')

    const { res, data } = await call({ action: 'launch_all' })

    expect(res.isError).toBeUndefined()
    expect(data.launched).toBe(1)
    expect(data.skipped).toBe(2)
    const byIndex = new Map((data.results as { railIndex: number }[]).map((r) => [r.railIndex, r]))
    expect(byIndex.get(0)).toMatchObject({ outcome: 'launched', ticketIds: [5] })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('launch_all uses each rail\'s STORED mode', async () => {
    setRailTickets(db, 0, [1], 'batch-implement')
    const { data } = await call({ action: 'launch_all' })
    expect(data.launched).toBe(1)
    expect((data.results as { railIndex: number; mode?: string }[]).find((r) => r.railIndex === 0)?.mode)
      .toBe('batch-implement')
    expect(enqueue.mock.calls[0][0]).toContain('batch-implement')
  })

  it('launch_all maps a raced tickets_in_flight 409 to a skip, not a failure', async () => {
    // Ticket 9 sits on rail 0 AND is worked by an active run registered on a
    // rail the GET snapshot does NOT flag for rail 0 — the per-rail launch 409s.
    setRailTickets(db, 0, [9])
    railLoopRuns.set('run-x', { railIndex: 5, ticketIds: [9] })
    const { data } = await call({ action: 'launch_all' })
    const r0 = (data.results as { railIndex: number; outcome: string; reason?: string }[]).find((r) => r.railIndex === 0)
    expect(r0).toMatchObject({ outcome: 'skipped', reason: 'tickets-in-flight' })
    expect(data.launched).toBe(0)
  })

  it('launch_all with nothing eligible returns zero launches and a retry hint', async () => {
    const { data } = await call({ action: 'launch_all' })
    expect(data.launched).toBe(0)
    expect(data.skipped).toBe(3) // the three empty base rails
    expect(data.hint).toContain('create_rail')
  })
})
