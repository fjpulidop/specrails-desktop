import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../auth', () => ({ loadOrGenerateToken: () => 'aliases-test-token-no-filesystem-access' }))
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { initDesktopDb } from '../../desktop-db'
import type { ProjectContext, ProjectRegistry } from '../../project-registry'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import { buildToolSpecs } from './catalog'
import { registerTieredTool, type McpToolContext } from './types'
import { advertisedActions } from './actions'

// Every action that moved to another tool keeps working on its old tool as a
// hidden alias: accepted at runtime, routed to exactly the same REST call and
// result as the canonical call, and never advertised in tools/list.

const specs = buildToolSpecs()
const aliases = specs.flatMap((spec) => Object.entries(spec.aliases ?? {}).map(([action, target]) => ({ tool: spec.name, action, target })))

const ARGS: Record<string, unknown> = {
  projectId: 'p1', jobId: 'j1', id: 3, title: 'T', description: 'D', idea: 'An idea', steeringText: 'Keep the tests',
  requestId: 'req-1', stepId: 'step-1', body: 'Add a note', addendumId: 'a1', instructions: 'Shorter', smashedAt: '2026-01-01T00:00:00Z',
  conversationId: 'c1', chatId: 'c1', pid: 4242, processId: 'proc-1', command: 'npm run dev', confirmed: true, confirm: true,
}

let client: Client
let calls: Array<{ url: string; method: string; body: string | null }>
const outcomes: Array<{ alias: string; ok: boolean; calls: number }> = []

beforeAll(async () => {
  const db = initDesktopDb(':memory:')
  const project = { id: 'p1', slug: 'p1', name: 'P1', path: '/tmp/aliases-p1', provider: 'claude', providers: ['claude'] } as unknown as ProjectContext['project']
  const pc = { project } as ProjectContext
  const registry = {
    desktopDb: db, listContexts: () => [pc], listProjects: () => [project],
    getProjectRow: (id: string) => (id === 'p1' ? project : undefined),
    getContext: (id: string) => (id === 'p1' ? pc : undefined),
  } as unknown as ProjectRegistry
  const ctx: McpToolContext = { registry, desktopDb: db, broadcast: () => {}, eventBus: new MobileEventBus(), desktopPort: 4299, sessionState: { activeProjectId: 'p1' } }
  const server = new McpServer({ name: 'aliases', version: '1' }, { capabilities: { tools: {} } })
  for (const spec of specs) registerTieredTool(server, ctx, spec)
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  client = new Client({ name: 'aliases-client', version: '1' })
  await client.connect(clientSide)
})

afterAll(async () => { await client.close() })

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null })
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, accepted: true, runs: [{ recoverableSteps: ['step-1'] }], tickets: [] }) }
  }))
})

async function run(tool: string, args: Record<string, unknown>) {
  calls = []
  const result = await client.callTool({ name: tool, arguments: args }) as { structuredContent?: Record<string, unknown>; isError?: boolean }
  const envelope = result.structuredContent ?? {}
  return { ok: envelope.ok, code: (envelope.error as { code?: string } | undefined)?.code, message: (envelope.error as { message?: string } | undefined)?.message, data: envelope.data, calls: [...calls] }
}

describe('hidden legacy aliases', () => {
  it('cover every action that moved', () => {
    expect(aliases.map((alias) => `${alias.tool}(${alias.action})`).sort()).toMatchSnapshot()
    expect(aliases.length).toBe(33)
  })

  it.each(aliases)('$tool($action) behaves exactly like $target.tool($target.action)', async ({ tool, action, target }) => {
    const legacy = await run(tool, { ...ARGS, action })
    const canonical = await run(target.tool, { ...ARGS, ...(target.args ?? {}), action: target.action })
    expect(legacy.ok).toBe(canonical.ok)
    expect(legacy.code).toBe(canonical.code)
    expect(legacy.calls).toEqual(canonical.calls)
    expect(legacy.data).toEqual(canonical.data)
    if (canonical.ok === false) expect(legacy.message).toBe(canonical.message)
    outcomes.push({ alias: `${tool}(${action})`, ok: legacy.ok === true, calls: legacy.calls.length })
  })

  it('reach the backend for every alias that an external client may run', () => {
    // background start/kill/logs need an in-app agent turn or a live process: they fail the same way on both names.
    const inAppOnly = new Set(['specrails_jobs(background_start)', 'specrails_jobs(background_kill)', 'specrails_jobs(background_logs)'])
    for (const outcome of outcomes) {
      if (inAppOnly.has(outcome.alias)) expect(outcome.ok).toBe(false)
      else if (outcome.alias !== 'specrails_jobs(background_list)') expect(outcome, outcome.alias).toMatchObject({ ok: true, calls: expect.any(Number) })
    }
    expect(outcomes.filter((outcome) => outcome.calls > 0).length).toBeGreaterThanOrEqual(29)
  })

  it('are not advertised in tools/list schemas or descriptions', async () => {
    const { tools } = await client.listTools()
    for (const alias of aliases) {
      const tool = tools.find((candidate) => candidate.name === alias.tool)!
      const actionSchema = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).action
      expect(actionSchema.enum).not.toContain(alias.action)
      expect(tool.description).not.toMatch(new RegExp(`\\b${alias.action}\\b`))
      expect(advertisedActions(specs.find((spec) => spec.name === alias.tool)!)).not.toContain(alias.action)
    }
  })

  it('per-action validation answers invalid_input naming the fields, before any REST call', async () => {
    const result = await run('specrails_runs', { action: 'diagnose', projectId: 'p1' })
    expect(result).toMatchObject({ ok: false, code: 'invalid_input', message: 'specrails_runs(diagnose) missing "jobId". It takes: jobId (required).', calls: [] })
    const legacy = await run('specrails_jobs', { action: 'runtime_diagnose', projectId: 'p1' })
    expect(legacy).toMatchObject({ ok: false, code: 'invalid_input', message: result.message })
  })

  it('validate the moved arguments against the target schema', async () => {
    const result = await run('specrails_jobs', { action: 'background_logs', projectId: 'p1', pid: -1, chatId: 'c1' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_input')
    expect(result.message).toMatch(/now specrails_background\(logs\).*pid/)
  })
})
