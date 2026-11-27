import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import express from 'express'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { call, createHarness, type Harness } from '../__fixtures__/harness'
import { registerV2Tool, type V2ToolDef } from './registry'
import { result, V2ToolError } from './envelope'
import { WRITE_FIELDS } from './views'
import { v2Catalog } from '../index'
import { missionsTool } from '../tools/missions'
import { createAgentChatRouter } from '../../../modules/missions/runtime/agent-chat-router'
import type { AgentChatManager } from '../../../modules/missions/runtime/agent-chat-manager'
import { setAgentChatManager } from '../../../modules/missions/runtime/agent-chat-registry'
import { createAgentConversation, getAgentConversation, listAgentConversations } from '../../../modules/agents/runtime/agent-store'

/**
 * mission-journal: an external MCP client's changes are logged in a mission
 * Desktop shows (the mission it works with, else its session's log mission).
 */

const testHome = path.join(os.tmpdir(), `sr-journal-${process.pid}`)
type Row = Record<string, unknown>

let h: Harness
let client: Client
let server: Server
let rows: Array<{ conversationId: string; row: Row }>
let created: string[]

function fakeManager(): AgentChatManager {
  return {
    notifyConversationCreated: (id: string) => { created.push(id) },
    notifyTitle: () => {},
    postSystemRow: (conversationId: string, row: Row) => { rows.push({ conversationId, row }); return 'm1' },
  } as unknown as AgentChatManager
}

const fakeTool: V2ToolDef = {
  name: 'specrails_fake', title: 'Fake', description: 'Test tool.', owner: 'test', fields: WRITE_FIELDS,
  actions: {
    poke: { tier: 'write', handler: async () => result({ ok: 1 }, { summary: 'Poked run 7', refs: { run: 'run:shop-api/7' } }) },
    boom: { tier: 'write', handler: async () => { throw new V2ToolError('conflict', 'The rail is busy') } },
    look: { tier: 'read', handler: async () => result({ seen: true }) },
  },
}

async function setup(external: boolean) {
  const app = express()
  app.use(express.json())
  app.use('/api/agent', createAgentChatRouter({ manager: fakeManager(), desktopDb: h.db }))
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  h.ctx.desktopPort = (server.address() as AddressInfo).port
  h.ctx.sessionState = { activeProjectId: 'p1', sessionKey: 'session-a', ...(external ? { external: true, journalMissions: {}, clientName: () => 'claude-code' } : {}) } as never
  registerV2Tool(h.server, h.ctx, missionsTool, { catalog: v2Catalog() })
  registerV2Tool(h.server, h.ctx, fakeTool, { catalog: v2Catalog() })
  client = await h.connect()
}

beforeEach(() => {
  fs.mkdirSync(testHome, { recursive: true })
  rows = []; created = []
  h = createHarness()
  setAgentChatManager(fakeManager())
})

afterEach(async () => {
  setAgentChatManager(null)
  await client.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(testHome, { recursive: true, force: true })
})

const fake = (args: Row) => call(client, 'specrails_fake', args)
const missions = (args: Row) => call(client, 'specrails_missions', args)

describe('mission journal (external MCP session)', () => {
  it('logs a change in the session log mission of its project, created once and reused', async () => {
    await setup(true)
    expect((await fake({ action: 'poke' })).isError).toBe(false)
    expect((await fake({ action: 'poke' })).isError).toBe(false)
    const log = listAgentConversations(h.db).filter((c) => c.origin === 'mcp')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ title: 'MCP · claude-code', pinned_project_id: 'p1', origin: 'mcp', origin_client: 'claude-code' })
    expect(created).toEqual([log[0].id])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ conversationId: log[0].id, row: expect.objectContaining({ kind: 'mcp-action', client: 'claude-code', tool: 'specrails_fake', action: 'poke', ok: true, summary: 'Poked run 7', refs: { run: 'run:shop-api/7' } }) })
  })

  it('records a failed change with its reason, and leaves reads out', async () => {
    await setup(true)
    expect((await fake({ action: 'boom' })).isError).toBe(true)
    await fake({ action: 'look' })
    expect(rows).toHaveLength(1)
    expect(rows[0].row).toMatchObject({ action: 'boom', ok: false, error: { code: 'conflict', message: 'The rail is busy' } })
  })

  it('uses the mission the session created, marks it as MCP, and logs later changes there', async () => {
    await setup(true)
    const made = await missions({ action: 'create', project: 'shop-api', provider: 'claude', title: 'Fix login' })
    const id = String(made.envelope.data.ref).slice('mission:'.length)
    expect(getAgentConversation(h.db, id)).toMatchObject({ title: 'Fix login', origin: 'mcp', origin_client: 'claude-code' })
    await fake({ action: 'poke' })
    expect(rows.map((r) => r.conversationId)).toEqual([id, id])
    expect(rows.map((r) => `${r.row.tool}.${r.row.action}`)).toEqual(['specrails_missions.create', 'specrails_fake.poke'])
    expect(rows[0].row.summary).toBeUndefined()
    expect(listAgentConversations(h.db).filter((c) => c.origin === 'mcp')).toHaveLength(1)
  })

  it('follows the mission named with options.mission', async () => {
    await setup(true)
    const chosen = createAgentConversation(h.db, { provider: 'claude', pinnedProjectId: 'p1' }).id
    await fake({ action: 'poke', options: { mission: `mission:${chosen}` } })
    await fake({ action: 'poke' })
    expect(rows.map((r) => r.conversationId)).toEqual([chosen, chosen])
    expect(created).toEqual([])
  })

  it('does nothing for a session that is not an external client', async () => {
    await setup(false)
    await fake({ action: 'poke' })
    const made = await missions({ action: 'create', project: 'shop-api', provider: 'claude' })
    expect(rows).toEqual([])
    expect(getAgentConversation(h.db, String(made.envelope.data.ref).slice('mission:'.length))?.origin).toBeUndefined()
  })
})
