// Opt-in live smoke: the real mission manager runs turns on a real Core host
// (local ../specrails-core build) with real providers. Paid; never runs in CI.
//   SPECRAILS_LIVE_PROVIDER_SMOKE=1 npx vitest run server/modules/missions/runtime/mission-core-sessions.live.test.ts
// SPECRAILS_LIVE_PROVIDERS=claude,codex selects providers (default: claude).
// SPECRAILS_LIVE_CLAUDE_MODEL / SPECRAILS_LIVE_CODEX_MODEL override the models.
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ cwd: '' }))
vi.mock('./agent-cwd-manager', () => ({
  ensureAgentCwd: () => dirs.cwd,
  ensureAgentConversationCwd: () => dirs.cwd,
}))
// The Specrails bridge needs a running Desktop server; the smoke is about sessions and sub-agents.
vi.mock('../../../agent-mcp-config', async (original) => ({
  ...await original<typeof import('../../../agent-mcp-config')>(),
  prepareAgentMcpSpec: () => [],
}))

import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import '../../../providers'
import { getAdapter } from '../../../providers/registry'
import { revokeAgentCapability } from '../../../mcp/agent-capability'
import { CoreHostLauncher } from '../../agent-sessions/adapters/host-process'
import { SessionHostRegistry } from '../../agent-sessions/runtime/session-host-registry'
import { createAgentConversation, listAgentMessages } from '../../agents/runtime/agent-store'
import { AgentChatManager } from './agent-chat-manager'
import { getSessionCursor, listSubagents } from './agent-session-store'
import { MissionCoreSessions } from './mission-core-sessions'

const coreCli = path.resolve(__dirname, '../../../../../specrails-core/dist/agent-runtime/cli.js')
const enabled = process.env.SPECRAILS_LIVE_PROVIDER_SMOKE === '1' && existsSync(path.resolve(coreCli, '../session/index.js'))
const providers = (process.env.SPECRAILS_LIVE_PROVIDERS ?? 'claude').split(',').map((id) => id.trim()).filter(Boolean)
// Provider defaults unless SPECRAILS_LIVE_<PROVIDER>_MODEL overrides them (model access is account-dependent).
const models: Record<string, string | undefined> = { claude: process.env.SPECRAILS_LIVE_CLAUDE_MODEL ?? 'haiku', codex: process.env.SPECRAILS_LIVE_CODEX_MODEL }

async function until(condition: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

describe.skipIf(!enabled)('missions on a live Core host', () => {
  let db: DbInstance
  let home: string
  let manager: AgentChatManager
  let registry: SessionHostRegistry
  const broadcasts: Array<Record<string, unknown>> = []

  const allow = { value: true }

  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), 'desktop live sessions '))
    dirs.cwd = mkdtempSync(path.join(tmpdir(), 'desktop live cwd '))
    db = initDesktopDb(':memory:')
    registry = new SessionHostRegistry({
      launcher: new CoreHostLauncher({ cli: () => coreCli, node: () => process.execPath, env: { ...process.env, SPECRAILS_REGISTRY_HOME: home }, host: { name: 'desktop-live-smoke', version: '0' }, onStderr: (_scope, text) => process.stderr.write(text) }),
      clock: { now: () => Date.now(), after: (ms, callback) => { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) } } },
    })
    manager = new AgentChatManager((message) => broadcasts.push(message as unknown as Record<string, unknown>), db, 4200, null)
    manager.setCoreSessions(new MissionCoreSessions({
      db, registry, port: 4200, broadcast: (message) => broadcasts.push(message), adapterFor: getAdapter,
      availability: async () => ({ enabled: true, flag: 'on', reason: 'live smoke' }), projectKey: () => null, revokeCapability: revokeAgentCapability,
      subagentPolicy: () => (allow.value ? 'enabled' : 'disabled'),
    }))
  })

  afterAll(async () => {
    await manager?.shutdown()
    await registry?.stopAll()
    for (const dir of [home, dirs.cwd]) if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function dumpJournal(sessionId: string, provider: string) {
    const client = await registry.acquire('global')
    const page = await client.request<{ events: Array<{ seq: number; event: Record<string, unknown> }> }>('session.events', { sessionId, afterSeq: 0, limit: 500 })
    for (const { seq, event } of page.events) console.log(`[live:${provider}] #${seq}`, JSON.stringify(event).slice(0, 400))
    console.log(`[live:${provider}] broadcasts`, broadcasts.map((message) => message.type).join(' '))
  }

  for (const provider of providers) {
    it(`${provider}: a background sub-agent outlives the turn and its result reaches the mission`, async () => {
      const conversation = createAgentConversation(db, { provider, model: models[provider] ?? null })
      const done = () => {
        const failure = broadcasts.find((message) => message.type === 'agent_error' && message.conversationId === conversation.id)
        if (failure) throw new Error(`The user turn failed: ${String(failure.error ?? failure.message ?? '')}`)
        return broadcasts.filter((message) => message.type === 'agent_done' && message.conversationId === conversation.id).length
      }
      manager.sendMessage(conversation.id, [
        'This is an infrastructure smoke test: Specrails tools are intentionally unavailable, do not use or wait for them.',
        'Launch exactly one sub-agent IN THE BACKGROUND (do not wait for it).',
        'The sub-agent must run the shell command `sleep 40 && echo SUBDONE` and report its output.',
        'Right after launching it, reply with the single word LAUNCHED and end your turn.',
      ].join(' '))
      await until(() => done() === 1, 120_000, 'the user turn').catch(async (error) => { await dumpJournal(conversation.id, provider); throw error })
      const first = listAgentMessages(db, conversation.id).filter((message) => message.role === 'assistant')[0]
      expect(first).toMatchObject({ turn_origin: 'user' })
      expect(first?.core_turn_id).toBeTruthy()

      await until(() => listSubagents(db, conversation.id).length > 0, 60_000, 'a projected sub-agent').catch(async (error) => { await dumpJournal(conversation.id, provider); throw error })
      const [subagent] = listSubagents(db, conversation.id)
      expect(subagent?.launchedInTurnId).toBe(first?.core_turn_id)

      // The sub-agent is still working after the user turn settled.
      expect(getSessionCursor(db, conversation.id)?.liveSubagents).toBeGreaterThan(0)
      const continued = () => listAgentMessages(db, conversation.id).some((message) => message.role === 'assistant' && message.turn_origin !== 'user')
      await until(() => listSubagents(db, conversation.id).every((node) => node.phase !== 'running'), 240_000, 'the sub-agent to finish')
      await until(() => continued() && getSessionCursor(db, conversation.id)?.residentPhase === 'idle', 180_000, 'the continuation turn').catch(async (error) => { await dumpJournal(conversation.id, provider); throw error })
      const assistant = listAgentMessages(db, conversation.id).filter((message) => message.role === 'assistant')
      console.log(`[live:${provider}]`, JSON.stringify({
        subagents: listSubagents(db, conversation.id).map((node) => ({ id: node.subagentId, parent: node.parentId, phase: node.phase, kind: node.kind, type: node.agentType, description: node.description, result: node.resultSummary?.slice(0, 80), usage: node.usage })),
        messages: assistant.map((message) => ({ origin: message.turn_origin, text: message.content.slice(0, 120) })),
        invocations: db.prepare('SELECT origin, status, total_cost_usd, total_cost_usd_estimated, tokens_in, tokens_out FROM agent_invocations WHERE conversation_id = ?').all(conversation.id),
      }, null, 2))
      expect(listSubagents(db, conversation.id)[0]?.phase).toBe('idle')
      // The agent reported back on its own after the sub-agent finished.
      expect(continued()).toBe(true)
    }, 600_000)
  }

  for (const provider of providers) {
    it(`${provider}: with "Allow sub-agents" off, no sub-agent keeps running`, async () => {
      allow.value = false
      try {
        const conversation = createAgentConversation(db, { provider, model: models[provider] ?? null })
        const settled = () => broadcasts.some((message) => (message.type === 'agent_done' || message.type === 'agent_error') && message.conversationId === conversation.id)
        manager.sendMessage(conversation.id, [
          'This is an infrastructure smoke test: Specrails tools are intentionally unavailable, do not use or wait for them.',
          'If you can, launch one sub-agent in the background to run `sleep 30 && echo SUBDONE`.',
          'If you cannot launch sub-agents, run `echo DIRECT` yourself instead. Then reply with one word: LAUNCHED or DIRECT.',
        ].join(' '))
        await until(settled, 180_000, 'the user turn').catch(async (error) => { await dumpJournal(conversation.id, provider); throw error })
        await until(() => listSubagents(db, conversation.id).every((node) => node.phase !== 'running'), 60_000, 'no running sub-agents').catch(async (error) => { await dumpJournal(conversation.id, provider); throw error })
        const nodes = listSubagents(db, conversation.id)
        console.log(`[live:${provider}:disabled]`, JSON.stringify(nodes.map((node) => ({ phase: node.phase, reason: node.reason, type: node.agentType }))))
        // Either the provider never offered sub-agents, or Core stopped the ones it started.
        expect(nodes.every((node) => node.phase === 'stopped' && node.reason === 'policy')).toBe(true)
      } finally {
        allow.value = true
      }
    }, 600_000)
  }
})

