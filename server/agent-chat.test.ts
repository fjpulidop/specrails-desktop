import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import { initDesktopDb, setDesktopSetting, type DbInstance } from './desktop-db'
import {
  normalizeLevel,
  nextLevel,
  levelForTierName,
  tierNameForLevel,
  levelAllowsTier,
  levelFromHeader,
  tierNeedsApproval,
  AGENT_TIER_HEADER,
  AGENT_TIER_ENV,
} from './agent-tier'
import {
  createAgentConversation,
  getAgentConversation,
  listAgentConversations,
  updateAgentConversation,
  deleteAgentConversation,
  addAgentMessage,
  listAgentMessages,
} from './agent-store'
import { buildSpecrailsMcpEntry, buildAgentMcpArgs, resolveBridgeScript, resolveNodeCommand, mergeSpecrailsIntoWorkspaceMcp, prepareAgentMcp } from './agent-mcp-config'
import { ensureAgentCwd, agentCwdPath, removeAgentCwd } from './agent-cwd-manager'
import { registerTieredTool, setActiveProject, getActiveProject, type McpToolContext, type McpToolSpec, type ToolHandlerExtra } from './mcp/tools/types'
import { AGENT_PROJECT_HEADER } from './agent-tier'
import { MobileEventBus } from './mobile/mobile-event-bus'
import type { ProjectRegistry } from './project-registry'
import fs from 'fs'
import os from 'os'

// ── agent-tier (pure ladder) ──────────────────────────────────────────────────
describe('agent-tier', () => {
  it('normalizeLevel clamps numbers, names and junk', () => {
    expect(normalizeLevel(2)).toBe(2)
    expect(normalizeLevel('3')).toBe(3)
    expect(normalizeLevel('operate')).toBe(2)
    expect(normalizeLevel(9)).toBe(0)
    expect(normalizeLevel('nonsense')).toBe(0)
    expect(normalizeLevel(undefined)).toBe(0)
  })

  it('nextLevel cycles 0→1→2→3→0', () => {
    expect([nextLevel(0), nextLevel(1), nextLevel(2), nextLevel(3)]).toEqual([1, 2, 3, 0])
  })

  it('name ↔ level round-trips', () => {
    expect(levelForTierName('autonomous')).toBe(3)
    expect(levelForTierName('bogus')).toBeNull()
    expect(tierNameForLevel(0)).toBe('observe')
  })

  it('levelAllowsTier is cumulative', () => {
    expect(levelAllowsTier(0, 'read')).toBe(true)
    expect(levelAllowsTier(0, 'write')).toBe(false)
    expect(levelAllowsTier(1, 'write')).toBe(true)
    expect(levelAllowsTier(1, 'ai-spawn')).toBe(false)
    expect(levelAllowsTier(2, 'ai-spawn')).toBe(true)
    expect(levelAllowsTier(2, 'destructive')).toBe(false)
    expect(levelAllowsTier(3, 'destructive')).toBe(true)
  })

  it('levelFromHeader parses names, numbers and rejects junk', () => {
    expect(levelFromHeader('operate')).toBe(2)
    expect(levelFromHeader('2')).toBe(2)
    expect(levelFromHeader(['edit'])).toBe(1)
    expect(levelFromHeader(undefined)).toBeNull()
    expect(levelFromHeader('')).toBeNull()
    expect(levelFromHeader('nope')).toBeNull()
    expect(levelFromHeader('7')).toBeNull()
  })

  it('tierNeedsApproval flags cost + destructive', () => {
    expect(tierNeedsApproval('read')).toBe(false)
    expect(tierNeedsApproval('write')).toBe(false)
    expect(tierNeedsApproval('ai-spawn')).toBe(true)
    expect(tierNeedsApproval('destructive')).toBe(true)
  })

  it('header/env constant names are stable', () => {
    expect(AGENT_TIER_HEADER).toBe('x-specrails-agent-tier')
    expect(AGENT_TIER_ENV).toBe('SPECRAILS_AGENT_TIER')
  })
})

// ── agent-store (app-global persistence) ──────────────────────────────────────
describe('agent-store', () => {
  let db: DbInstance
  beforeEach(() => {
    db = initDesktopDb(':memory:')
  })

  it('creates, lists, gets, patches and deletes conversations', () => {
    const c = createAgentConversation(db, { provider: 'claude', pinnedProjectId: 'p1', tierLevel: 2 })
    expect(c.provider).toBe('claude')
    expect(c.pinned_project_id).toBe('p1')
    expect(c.tier_level).toBe(2)
    expect(getAgentConversation(db, c.id)?.id).toBe(c.id)
    expect(listAgentConversations(db).map((x) => x.id)).toContain(c.id)

    const patched = updateAgentConversation(db, c.id, { title: 'Hi', session_id: 's1', tier_level: 3 })
    expect(patched?.title).toBe('Hi')
    expect(patched?.session_id).toBe('s1')
    expect(patched?.tier_level).toBe(3)

    deleteAgentConversation(db, c.id)
    expect(getAgentConversation(db, c.id)).toBeUndefined()
  })

  it('defaults a bare conversation to observe/claude', () => {
    const c = createAgentConversation(db)
    expect(c.provider).toBe('claude')
    expect(c.tier_level).toBe(0)
    expect(c.pinned_project_id).toBeNull()
  })

  it('adds + lists messages in order and cascade-deletes', () => {
    const c = createAgentConversation(db)
    addAgentMessage(db, { conversationId: c.id, role: 'user', content: 'hello' })
    addAgentMessage(db, { conversationId: c.id, role: 'assistant', content: 'world' })
    const msgs = listAgentMessages(db, c.id)
    expect(msgs.map((m) => m.content)).toEqual(['hello', 'world'])
    deleteAgentConversation(db, c.id)
    expect(listAgentMessages(db, c.id)).toEqual([])
  })
})

// ── agent-mcp-config (bridge wiring, no token inlined) ─────────────────────────
describe('agent-mcp-config', () => {
  it('resolves the bundled bridge script + a node command', () => {
    expect(resolveBridgeScript()).toContain('specrails-mcp.js')
    expect(typeof resolveNodeCommand()).toBe('string')
  })

  it('builds a specrails entry carrying port + tier, never a token', () => {
    const entry = buildSpecrailsMcpEntry({ port: 4321, tierLevel: 2 })
    expect(entry).not.toBeNull()
    expect(entry!.args[0]).toContain('specrails-mcp.js')
    expect(entry!.env.SPECRAILS_MCP_PORT).toBe('4321')
    expect(entry!.env.SPECRAILS_AGENT_TIER).toBe('operate')
    expect(JSON.stringify(entry)).not.toMatch(/token/i)
  })

  it('writes a --mcp-config file using the bundled bridge (tier in env, no token)', () => {
    const args = buildAgentMcpArgs({ conversationId: 'conv-1', port: 4200, tierLevel: 1 })
    expect(args[0]).toBe('--mcp-config')
    const file = args[1]
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(json.mcpServers.specrails.args[0]).toContain('specrails-mcp.js')
    expect(json.mcpServers.specrails.env.SPECRAILS_AGENT_TIER).toBe('edit')
    expect(JSON.stringify(json)).not.toMatch(/mcp\.token|Bearer/i)
  })

  it('rejects an unsafe conversation id', () => {
    expect(() => buildAgentMcpArgs({ conversationId: '../evil', port: 4200, tierLevel: 0 })).toThrow(/unsafe/)
  })

  it('prepareAgentMcp is provider-aware: claude → --mcp-config', () => {
    const w = prepareAgentMcp({ adapterId: 'claude', conversationId: 'c-claude', cwd: os.tmpdir(), port: 4200, tierLevel: 0 })
    expect(w.extraArgs[0]).toBe('--mcp-config')
    expect(w.env).toEqual({})
  })

  it('prepareAgentMcp: codex → inline -c overrides (no CODEX_HOME, auth intact)', () => {
    const w = prepareAgentMcp({ adapterId: 'codex', conversationId: 'c-codex', cwd: os.tmpdir(), port: 4242, tierLevel: 2, activeProjectId: 'p9' })
    expect(w.env).toEqual({}) // no CODEX_HOME override
    const joined = w.extraArgs.join(' ')
    expect(w.extraArgs.filter((a) => a === '-c').length).toBeGreaterThanOrEqual(3)
    expect(joined).toContain('mcp_servers.specrails.command=')
    expect(joined).toContain('mcp_servers.specrails.args=')
    expect(joined).toContain('specrails-mcp.js')
    expect(joined).toContain('mcp_servers.specrails.env.SPECRAILS_MCP_PORT="4242"')
    expect(joined).toContain('operate') // tier name in env override
    expect(joined).toContain('p9')      // active project in env override
  })

  it('prepareAgentMcp: gemini/other → writes .mcp.json in the cwd', () => {
    const cwd = fs.mkdtempSync(`${os.tmpdir()}/agent-gem-`)
    const w = prepareAgentMcp({ adapterId: 'gemini', conversationId: 'c-gem', cwd, port: 4200, tierLevel: 1 })
    expect(w.extraArgs).toEqual([])
    const json = JSON.parse(fs.readFileSync(`${cwd}/.mcp.json`, 'utf-8'))
    expect(json.mcpServers.specrails.args[0]).toContain('specrails-mcp.js')
  })

  it('Part A: merges specrails into a workspace .mcp.json, preserving others, no token', () => {
    const ws = fs.mkdtempSync(`${os.tmpdir()}/agent-ws-`)
    fs.writeFileSync(`${ws}/.mcp.json`, JSON.stringify({ mcpServers: { serena: { command: 'uvx' } }, other: 1 }))
    expect(mergeSpecrailsIntoWorkspaceMcp(ws, 4242)).toBe(true)
    const json = JSON.parse(fs.readFileSync(`${ws}/.mcp.json`, 'utf-8'))
    expect(json.mcpServers.serena).toEqual({ command: 'uvx' }) // preserved
    expect(json.mcpServers.specrails.env.SPECRAILS_MCP_PORT).toBe('4242')
    expect(json.other).toBe(1) // top-level preserved
    expect(JSON.stringify(json)).not.toMatch(/mcp\.token|Bearer/i)
    // idempotent + recovers from a corrupt file
    fs.writeFileSync(`${ws}/.mcp.json`, 'not json{')
    expect(mergeSpecrailsIntoWorkspaceMcp(ws, 4242)).toBe(true)
    expect(JSON.parse(fs.readFileSync(`${ws}/.mcp.json`, 'utf-8')).mcpServers.specrails).toBeTruthy()
  })
})

// ── agent-cwd-manager ─────────────────────────────────────────────────────────
describe('agent-cwd-manager', () => {
  it('materializes operator instruction files and cleans up', () => {
    const dir = ensureAgentCwd()
    expect(dir).toBe(agentCwdPath())
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      expect(fs.existsSync(`${dir}/${f}`)).toBe(true)
    }
    expect(fs.readFileSync(`${dir}/CLAUDE.md`, 'utf-8')).toMatch(/operator/i)
    removeAgentCwd()
    expect(fs.existsSync(dir)).toBe(false)
  })
})

// ── tier guard override at the central chokepoint ─────────────────────────────
describe('registerTieredTool agent-tier override', () => {
  let db: DbInstance
  let captured: ((args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<{ isError?: boolean; content: { text: string }[] }>) | null
  let ctx: McpToolContext

  const fakeServer = {
    registerTool: (_name: string, _def: unknown, handler: typeof captured) => {
      captured = handler
    },
  }

  function writeSpec(): McpToolSpec {
    return {
      name: 'demo',
      title: 'Demo',
      description: 'demo',
      tier: (args) => (args.action === 'delete' ? 'destructive' : args.action === 'run' ? 'ai-spawn' : 'write'),
      hintTier: 'write',
      inputSchema: {},
      handler: () => ({ ok: true }),
    }
  }

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    captured = null
    ctx = { registry: {} as ProjectRegistry, desktopDb: db, broadcast: () => {}, eventBus: new MobileEventBus(), desktopPort: 4200 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTieredTool(fakeServer as any, ctx, writeSpec())
  })

  function withTier(level: string): ToolHandlerExtra {
    return { requestInfo: { headers: { [AGENT_TIER_HEADER]: level } } }
  }

  it('uses the ladder header in place of Settings tiers', async () => {
    // observe: a write action is refused even though Settings could allow it
    const r1 = await captured!({ action: 'create' }, withTier('observe'))
    expect(r1.isError).toBe(true)
    // edit: write allowed, ai-spawn still refused
    expect((await captured!({ action: 'create' }, withTier('edit'))).isError).toBeFalsy()
    expect((await captured!({ action: 'run' }, withTier('edit'))).isError).toBe(true)
    // operate: ai-spawn allowed, destructive refused
    expect((await captured!({ action: 'run' }, withTier('operate'))).isError).toBeFalsy()
    expect((await captured!({ action: 'delete' }, withTier('operate'))).isError).toBe(true)
    // autonomous: destructive allowed
    expect((await captured!({ action: 'delete' }, withTier('autonomous'))).isError).toBeFalsy()
  })

  it('falls back to Settings tiers when no agent header is present', async () => {
    // write disabled by default → refused
    expect((await captured!({ action: 'create' })).isError).toBe(true)
    setDesktopSetting(db, 'mcp_tier_write', 'true')
    expect((await captured!({ action: 'create' })).isError).toBeFalsy()
  })

  it('pins the active project from the project header (per request)', async () => {
    setActiveProject(null)
    // A spec whose handler echoes the resolved active project.
    const echo: McpToolSpec = {
      name: 'echo', title: 'Echo', description: '', tier: 'read', inputSchema: {},
      handler: (c) => ({ active: getActiveProject(c) }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTieredTool(fakeServer as any, ctx, echo)
    const extra: ToolHandlerExtra = { requestInfo: { headers: { [AGENT_PROJECT_HEADER]: 'proj-42', [AGENT_TIER_HEADER]: 'observe' } } }
    const r = await captured!({}, extra)
    expect(JSON.parse(r.content[0].text).active).toBe('proj-42')
  })
})

// ── agent-chat-router (app-level REST) ────────────────────────────────────────
import { createAgentChatRouter } from './agent-chat-router'
import type { AgentChatManager } from './agent-chat-manager'

function makeApp(db: DbInstance, manager: Partial<AgentChatManager>) {
  const app = express()
  app.use(express.json())
  app.use('/api/agent', createAgentChatRouter({ manager: manager as AgentChatManager, desktopDb: db }))
  return app
}

async function req(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  // Minimal in-process HTTP via supertest-free fetch against an ephemeral listen.
  const server = app.listen(0)
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  } finally {
    server.close()
  }
}

describe('agent-chat-router', () => {
  let db: DbInstance
  let sent: { id: string; text: string }[]
  let app: express.Express
  beforeEach(() => {
    db = initDesktopDb(':memory:')
    sent = []
    const manager: Partial<AgentChatManager> = {
      sendMessage: async (id, text) => {
        sent.push({ id, text })
      },
      abort: () => true,
      isBusy: () => false,
    }
    app = makeApp(db, manager)
  })

  it('full lifecycle: create → list → get → patch → send → abort → delete', async () => {
    const created = await req(app, 'POST', '/api/agent/conversations', { provider: 'claude', tierLevel: 1 })
    expect(created.status).toBe(201)
    const id = created.body.conversation.id

    expect((await req(app, 'GET', '/api/agent/conversations')).body.conversations.length).toBe(1)

    const got = await req(app, 'GET', `/api/agent/conversations/${id}`)
    expect(got.body.conversation.id).toBe(id)
    expect(got.body.messages).toEqual([])

    const patched = await req(app, 'PATCH', `/api/agent/conversations/${id}`, { title: 'T', tierLevel: 2 })
    expect(patched.body.conversation.title).toBe('T')
    expect(patched.body.conversation.tier_level).toBe(2)

    const send = await req(app, 'POST', `/api/agent/conversations/${id}/send`, { text: 'do it', tierLevel: 3 })
    expect(send.status).toBe(202)
    expect(send.body.queued).toBe(false)
    expect(sent).toEqual([{ id, text: 'do it' }])
    // tier persisted before dispatch
    expect((await req(app, 'GET', `/api/agent/conversations/${id}`)).body.conversation.tier_level).toBe(3)

    expect((await req(app, 'POST', `/api/agent/conversations/${id}/abort`)).body.aborted).toBe(true)
    expect((await req(app, 'DELETE', `/api/agent/conversations/${id}`)).body.ok).toBe(true)
    expect((await req(app, 'GET', `/api/agent/conversations/${id}`)).status).toBe(404)
  })

  it('clears the session id AND model when the provider changes', async () => {
    const created = await req(app, 'POST', '/api/agent/conversations', { provider: 'claude', model: 'opus' })
    const id = created.body.conversation.id
    updateAgentConversation(db, id, { session_id: 'claude-session' })
    const patched = await req(app, 'PATCH', `/api/agent/conversations/${id}`, { provider: 'codex' })
    expect(patched.body.conversation.provider).toBe('codex')
    expect(patched.body.conversation.session_id).toBeNull()
    expect(patched.body.conversation.model).toBeNull() // sonnet/opus don't apply to codex
  })

  it('GET /models returns the provider catalog', async () => {
    const claude = await req(app, 'GET', '/api/agent/models?provider=claude')
    expect(claude.body.models.some((m: { value: string }) => m.value === 'sonnet')).toBe(true)
    const codex = await req(app, 'GET', '/api/agent/models?provider=codex')
    expect(codex.body.models.some((m: { value: string }) => m.value === 'gpt-5.5')).toBe(true)
  })

  it('validates an explicit model against the provider catalog', async () => {
    const c = await req(app, 'POST', '/api/agent/conversations', { provider: 'codex' })
    const id = c.body.conversation.id
    expect((await req(app, 'PATCH', `/api/agent/conversations/${id}`, { model: 'sonnet' })).status).toBe(400)
    const ok = await req(app, 'PATCH', `/api/agent/conversations/${id}`, { model: 'gpt-5.5' })
    expect(ok.body.conversation.model).toBe('gpt-5.5')
  })

  it('GET /models exposes per-provider reasoning-effort tiers (gemini: none)', async () => {
    const claude = await req(app, 'GET', '/api/agent/models?provider=claude')
    expect(claude.body.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    const codex = await req(app, 'GET', '/api/agent/models?provider=codex')
    expect(codex.body.efforts).toEqual(['minimal', 'low', 'medium', 'high'])
    const gemini = await req(app, 'GET', '/api/agent/models?provider=gemini')
    expect(gemini.body.efforts).toEqual([])
  })

  it('validates reasoningEffort against the provider catalog and clears it on provider switch', async () => {
    const c = await req(app, 'POST', '/api/agent/conversations', { provider: 'claude', reasoningEffort: 'xhigh' })
    const id = c.body.conversation.id
    expect(c.body.conversation.reasoning_effort).toBe('xhigh')
    // codex has no xhigh → invalid for the target provider on an explicit pick
    expect((await req(app, 'PATCH', `/api/agent/conversations/${id}`, { reasoningEffort: 'bogus' })).status).toBe(400)
    // provider switch clears the stale effort (xhigh is claude-only)
    const switched = await req(app, 'PATCH', `/api/agent/conversations/${id}`, { provider: 'codex' })
    expect(switched.body.conversation.reasoning_effort).toBeNull()
    // an in-catalog pick for the new provider sticks; null resets to default
    const set = await req(app, 'PATCH', `/api/agent/conversations/${id}`, { reasoningEffort: 'minimal' })
    expect(set.body.conversation.reasoning_effort).toBe('minimal')
    const reset = await req(app, 'PATCH', `/api/agent/conversations/${id}`, { reasoningEffort: null })
    expect(reset.body.conversation.reasoning_effort).toBeNull()
  })

  it('rejects unknown provider and empty send text', async () => {
    expect((await req(app, 'POST', '/api/agent/conversations', { provider: 'bogus' })).status).toBe(400)
    const c = await req(app, 'POST', '/api/agent/conversations', {})
    expect((await req(app, 'POST', `/api/agent/conversations/${c.body.conversation.id}/send`, { text: '  ' })).status).toBe(400)
    expect((await req(app, 'POST', '/api/agent/conversations/missing/send', { text: 'x' })).status).toBe(404)
  })

  it('reports queued=true when a turn is in flight and forwards the queueId', async () => {
    const captured: unknown[] = []
    const busyManager: Partial<AgentChatManager> = {
      sendMessage: async (_id, _text, options) => {
        captured.push(options)
      },
      abort: () => true,
      isBusy: () => true,
    }
    const busyApp = makeApp(db, busyManager)
    const c = await req(busyApp, 'POST', '/api/agent/conversations', {})
    const send = await req(busyApp, 'POST', `/api/agent/conversations/${c.body.conversation.id}/send`, {
      text: 'later please',
      queueId: 'q-front-1',
    })
    expect(send.status).toBe(202)
    expect(send.body.queued).toBe(true)
    expect((captured[0] as { queueId?: string }).queueId).toBe('q-front-1')
  })

  it('404s the whole surface when SPECRAILS_AGENT_CHAT=false', async () => {
    const prev = process.env.SPECRAILS_AGENT_CHAT
    process.env.SPECRAILS_AGENT_CHAT = 'false'
    try {
      expect((await req(app, 'GET', '/api/agent/conversations')).status).toBe(404)
    } finally {
      if (prev === undefined) delete process.env.SPECRAILS_AGENT_CHAT
      else process.env.SPECRAILS_AGENT_CHAT = prev
    }
  })
})

// ── AgentChatManager (mock the spawn core) ────────────────────────────────────
import type { InvocationResult } from './spawn-lifecycle'
import type { AdapterEvent } from './providers/types'

vi.mock('./spawn-lifecycle', () => ({
  runAiCliInvocation: vi.fn(),
}))
import { runAiCliInvocation } from './spawn-lifecycle'
import { AgentChatManager as RealManager } from './agent-chat-manager'

describe('AgentChatManager', () => {
  let db: DbInstance
  let events: { type: string; conversationId: string }[]
  let manager: RealManager
  beforeEach(() => {
    db = initDesktopDb(':memory:')
    events = []
    manager = new RealManager((m) => events.push(m as { type: string; conversationId: string }), db, 4200)
    vi.mocked(runAiCliInvocation).mockReset()
  })

  function fakeRun(streamEvents: AdapterEvent[], code = 0): void {
    vi.mocked(runAiCliInvocation).mockImplementation(async (hooks) => {
      hooks.onSpawn?.({ kill: () => true } as never)
      for (const ev of streamEvents) hooks.onEvent?.(ev)
      return { code, timedOut: false, spawnFailed: false, events: streamEvents, lastResultEvent: null, sessionId: null, stderrTail: '', child: null } as InvocationResult
    })
  }

  it('streams deltas, persists the assistant reply + session, emits agent_done', async () => {
    const c = createAgentConversation(db, { provider: 'claude' })
    fakeRun([
      { kind: 'text-delta', text: 'Hello ' },
      { kind: 'tool-use', name: 'specrails_specs', inputPreview: '' },
      { kind: 'text-delta', text: 'world' },
      { kind: 'session-started', sessionId: 'sess-9' },
    ])
    await manager.sendMessage(c.id, 'hi')
    const types = events.map((e) => e.type)
    expect(types).toContain('agent_stream')
    expect(types).toContain('agent_tool')
    expect(types).toContain('agent_done')
    const msgs = listAgentMessages(db, c.id)
    expect(msgs.map((m) => `${m.role}:${m.content}`)).toEqual(['user:hi', 'assistant:Hello world'])
    expect(getAgentConversation(db, c.id)?.session_id).toBe('sess-9')
  })

  it('emits agent_error when the spawn fails', async () => {
    const c = createAgentConversation(db, { provider: 'claude' })
    vi.mocked(runAiCliInvocation).mockResolvedValue({
      code: null, timedOut: false, spawnFailed: true, events: [], lastResultEvent: null, sessionId: null, stderrTail: '', child: null,
    } as InvocationResult)
    await manager.sendMessage(c.id, 'hi')
    expect(events.some((e) => e.type === 'agent_error')).toBe(true)
  })

  it('queues a second concurrent turn and drains it FIFO after the first settles', async () => {
    const c = createAgentConversation(db, { provider: 'claude' })
    let release: () => void = () => {}
    let calls = 0
    vi.mocked(runAiCliInvocation).mockImplementation((hooks) => {
      calls++
      hooks.onSpawn?.({ kill: () => true } as never)
      if (calls === 1) {
        hooks.onEvent?.({ kind: 'text-delta', text: 'first reply' })
        return new Promise<InvocationResult>((resolve) => {
          release = () =>
            resolve({ code: 0, timedOut: false, spawnFailed: false, events: [], lastResultEvent: null, sessionId: null, stderrTail: '', child: null } as InvocationResult)
        })
      }
      hooks.onEvent?.({ kind: 'text-delta', text: 'second reply' })
      return Promise.resolve({ code: 0, timedOut: false, spawnFailed: false, events: [], lastResultEvent: null, sessionId: null, stderrTail: '', child: null } as InvocationResult)
    })
    const first = manager.sendMessage(c.id, 'one')
    // Mid-flight send: never rejected, parked on the queue with its queueId.
    await manager.sendMessage(c.id, 'two', { queueId: 'q-77' })
    expect(events.some((e) => e.type === 'agent_error')).toBe(false)
    const queuedEv = events.find((e) => e.type === 'agent_queued') as { queueId?: string; position?: number } | undefined
    expect(queuedEv?.queueId).toBe('q-77')
    expect(queuedEv?.position).toBe(1)

    release()
    await first
    // Drained: dequeued event + BOTH turns persisted in FIFO order.
    const dequeuedEv = events.find((e) => e.type === 'agent_dequeued') as { queueId?: string } | undefined
    expect(dequeuedEv?.queueId).toBe('q-77')
    expect(calls).toBe(2)
    const msgs = listAgentMessages(db, c.id).map((m) => `${m.role}:${m.content}`)
    expect(msgs).toEqual(['user:one', 'assistant:first reply', 'user:two', 'assistant:second reply'])
  })

  it('abort discards the queue (agent_queue_cleared) and the queued turn never runs', async () => {
    const c = createAgentConversation(db, { provider: 'claude' })
    let release: () => void = () => {}
    let calls = 0
    vi.mocked(runAiCliInvocation).mockImplementation((hooks) => {
      calls++
      hooks.onSpawn?.({ kill: () => true } as never)
      return new Promise<InvocationResult>((resolve) => {
        release = () =>
          resolve({ code: 0, timedOut: false, spawnFailed: false, events: [], lastResultEvent: null, sessionId: null, stderrTail: '', child: null } as InvocationResult)
      })
    })
    const first = manager.sendMessage(c.id, 'one')
    await manager.sendMessage(c.id, 'two', { queueId: 'q-88' })
    expect(manager.isBusy(c.id)).toBe(true)
    manager.abort(c.id)
    expect(events.some((e) => e.type === 'agent_queue_cleared')).toBe(true)
    release()
    await first
    expect(calls).toBe(1) // the queued turn was discarded, never spawned
    expect(events.some((e) => e.type === 'agent_dequeued')).toBe(false)
    expect(listAgentMessages(db, c.id).some((m) => m.content === 'two')).toBe(false)
  })

  it('errors on unknown conversation', async () => {
    await manager.sendMessage('nope', 'hi')
    expect(events[0]?.type).toBe('agent_error')
  })

  it('abort never resurrects the stopped prompt via the stale-session auto-heal', async () => {
    const c = createAgentConversation(db, { provider: 'claude' })
    updateAgentConversation(db, c.id, { session_id: 'live-session' }) // → canResume
    let release: () => void = () => {}
    let calls = 0
    vi.mocked(runAiCliInvocation).mockImplementation((hooks) => {
      calls++
      hooks.onSpawn?.({ kill: () => true } as never)
      // Pre-first-delta window: the child is killed before emitting anything.
      return new Promise<InvocationResult>((resolve) => {
        release = () =>
          resolve({ code: null, timedOut: false, spawnFailed: false, events: [], lastResultEvent: null, sessionId: null, stderrTail: '', child: null } as InvocationResult)
      })
    })
    const turn = manager.sendMessage(c.id, 'stop me')
    manager.abort(c.id) // user presses Stop before any text streamed
    release()
    await turn
    expect(calls).toBe(1) // NO fresh respawn of the aborted prompt
    expect(events.some((e) => e.type === 'agent_error')).toBe(false) // a stop is not an error
    expect(events.some((e) => e.type === 'agent_done')).toBe(false) // nothing streamed → nothing persisted
    expect(listAgentMessages(db, c.id).some((m) => m.role === 'assistant')).toBe(false)
  })

  it('settle never clobbers a mid-turn provider switch (config is PATCH-owned)', async () => {
    const c = createAgentConversation(db, { provider: 'claude' })
    let release: () => void = () => {}
    vi.mocked(runAiCliInvocation).mockImplementation((hooks) => {
      hooks.onSpawn?.({ kill: () => true } as never)
      hooks.onEvent?.({ kind: 'text-delta', text: 'claude reply' })
      hooks.onEvent?.({ kind: 'session-started', sessionId: 'claude-sess' })
      return new Promise<InvocationResult>((resolve) => {
        release = () =>
          resolve({ code: 0, timedOut: false, spawnFailed: false, events: [], lastResultEvent: null, sessionId: null, stderrTail: '', child: null } as InvocationResult)
      })
    })
    const turn = manager.sendMessage(c.id, 'hola')
    // Mid-turn the user switches provider — PATCH semantics: session/model reset.
    updateAgentConversation(db, c.id, { provider: 'codex', session_id: null, model: null })
    release()
    await turn
    const row = getAgentConversation(db, c.id)
    expect(row?.provider).toBe('codex') // NOT reverted to claude
    expect(row?.session_id).toBeNull() // claude session never pollutes codex state
    expect(row?.model).toBeNull()
    expect(events.some((e) => e.type === 'agent_done')).toBe(true) // reply still lands
  })

  it('auto-heals a stale/foreign session: a resume with no text retries fresh', async () => {
    const c = createAgentConversation(db, { provider: 'claude' })
    updateAgentConversation(db, c.id, { session_id: 'stale-thread' }) // → canResume
    let calls = 0
    vi.mocked(runAiCliInvocation).mockImplementation(async (hooks) => {
      calls++
      hooks.onSpawn?.({ kill: () => true } as never)
      if (calls === 1) {
        hooks.onEvent?.({ kind: 'error', message: 'no rollout found for thread id …' })
        return { code: 1, timedOut: false, spawnFailed: false, events: [], lastResultEvent: null, sessionId: null, stderrTail: '', child: null } as InvocationResult
      }
      hooks.onEvent?.({ kind: 'text-delta', text: 'fresh reply' })
      return { code: 0, timedOut: false, spawnFailed: false, events: [], lastResultEvent: null, sessionId: null, stderrTail: '', child: null } as InvocationResult
    })
    await manager.sendMessage(c.id, 'hola')
    expect(calls).toBe(2) // resume failed → retried fresh
    expect(events.some((e) => e.type === 'agent_done')).toBe(true)
    expect(listAgentMessages(db, c.id).some((m) => m.content === 'fresh reply')).toBe(true)
  })
})
