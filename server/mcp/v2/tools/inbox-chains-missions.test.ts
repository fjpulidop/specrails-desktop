import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'v2-inbox-chains-missions-test-token' }))
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createHarness, call, type Harness } from '../__fixtures__/harness'
import { registerV2Surface, v2Catalog } from '../index'
import { buildToolSpecs } from '../../tools/catalog'
import { buildDecisionState } from '../core/decision-state'
import { translator } from '../core/lang'
import { createChain, updateChain } from '../../../modules/builder/runtime/milestone-chain-store'
import type { InboxItem } from '../../../modules/inbox'
import { inboxStateInput } from './inbox'
import { startDesktop, type FakeDesktop } from './__fixtures__/wp2-desktop'

// specrails_inbox lists paused milestone chains and waiting mission cards from
// the app's own inbox projection, with the offers their owning tools take.

let h: Harness
let desktop: FakeDesktop
let client: Client
const sqlAgo = (ms: number) => new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19)

beforeEach(async () => {
  h = createHarness({ projects: [{ id: 'p1', slug: 'shop-api', name: 'Shop API', path: '/tmp/v2-shop-api' }] })
  desktop = await startDesktop(h)
  registerV2Surface(h.server, h.ctx, buildToolSpecs(), { inApp: false })
  client = await h.connect()
})
afterEach(async () => { await client.close(); await desktop.close() })

const inbox = (args: Record<string, unknown>) => call(client, 'specrails_inbox', args)

function seed() {
  const db = desktop.dbs.get('p1')!
  createChain(db, { id: 'c1', milestoneN: 2, milestoneId: 'm2', mode: 'sequential', chunks: [[11], [12]], integrationBranch: null, nowMs: Date.now() - 60_000 })
  expect(updateChain(db, 'c1', 'running', { status: 'paused', pauseReason: 'head_missing', nextChunk: 1 })).toBe(true)
  h.db.prepare("INSERT INTO agent_conversations (id, title, pinned_project_id) VALUES ('conv-1', 'Checkout', 'p1')").run()
  h.db.prepare("INSERT INTO agent_messages (id, conversation_id, role, content, created_at) VALUES ('msg-1', 'conv-1', 'assistant', ?, ?)").run('Ready\n```rail-launch\n{"ticketIds":[12],"railIndex":0}\n```', sqlAgo(120_000))
}

describe('specrails_inbox: chains and mission cards', () => {
  it('lists both kinds with their offers; filter.kind selects them', async () => {
    seed()
    const { envelope, isError } = await inbox({ action: 'list' })
    expect(isError).toBe(false)
    const items = envelope.data.items as Array<Record<string, any>>
    expect(items.map((item) => item.kind)).toEqual(['mission', 'chain'])
    const [mission, chain] = items
    expect(mission).toMatchObject({ status: 'needs_you', subject: 'mission:conv-1', title: 'Checkout', detail: '#12' })
    expect(mission.choices.map((choice: { id: string }) => choice.id)).toEqual(['launch', 'dismiss'])
    expect(mission.choices[0]).toMatchObject({ id: 'launch', recommended: true })
    expect(chain).toMatchObject({ status: 'paused', subject: 'chain:shop-api/c1' })
    expect(chain.choices[0]).toMatchObject({ id: 'chain.resume', label: 'Resume the chain', effect: 'The milestone chain continues.', recommended: true })
    expect(chain.choices.map((choice: { id: string }) => choice.id)).toEqual(expect.arrayContaining(['chain.resume', 'chain.cancel']))
    const filtered = await inbox({ action: 'list', filter: { kind: 'chain' } })
    expect((filtered.envelope.data.items as unknown[]).length).toBe(1)
    expect(envelope.summary).toMatch(/mission card/)
  })

  it('opens a chain item by its chain ref, with the chain facts and its hold', async () => {
    seed()
    const { envelope } = await inbox({ action: 'open', ref: 'chain:shop-api/c1' })
    expect(envelope.data).toMatchObject({ kind: 'chain', chain: { milestoneN: 2, status: 'paused', pauseReason: 'head_missing', totalChunks: 2 } })
    expect(envelope.state.hold).toMatchObject({ kind: 'chain', code: 'head_missing' })
    expect(envelope.state.offers.find((offer: { id: string }) => offer.id === 'chain.resume').call).toEqual({ tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: 'chain:shop-api/c1' } })
  })

  it('act runs a mission card decision through specrails_missions(card_decide)', async () => {
    seed()
    desktop.on('GET', '/agent/conversations/conv-1', {
      conversation: { id: 'conv-1', title: 'Checkout', pinned_project_id: 'p1' },
      messages: [{ id: 'msg-1', role: 'assistant', content: 'Ready\n```rail-launch\n{"ticketIds":[12],"railIndex":0}\n```', intents: [], created_at: new Date().toISOString() }],
      pendingMessages: [], live: {},
    })
    desktop.on('PATCH', '/agent/conversations/conv-1/messages/msg-1/intent', { ok: true })
    const list = await inbox({ action: 'list' })
    const ref = (list.envelope.data.items as Array<Record<string, any>>)[0].ref
    const { envelope, isError } = await inbox({ action: 'act', ref, offerId: 'dismiss' })
    expect(isError).toBe(false)
    expect(envelope.data).toMatchObject({ mission: 'mission:conv-1', card: 'msg-1:rail-launch:0', decision: 'dismiss' })
    expect(desktop.calls.find((entry) => entry.method === 'PATCH')?.body).toMatchObject({ kind: 'rail-launch', proposalIndex: 0, status: 'dismissed' })
  })

  it('every card and chain shape projects to offers the catalog knows', () => {
    const t = translator('en')
    const env = { translate: t, policyFor: v2Catalog().policyFor, confirmAboveUsd: 0.5 }
    const base: InboxItem = { id: 'p1:mission:m:rail-launch:0', projectId: 'p1', projectName: 'Shop', kind: 'mission', title: 'M', detail: null, at: '2026-11-21T12:00:00.000Z', version: 'v', action: 'open-mission', subjectId: 'm:rail-launch:0', conversationId: 'conv-1', diagnosis: null }
    const shapes: InboxItem[] = [
      { ...base, card: { id: 'm:rail-launch:0', kind: 'rail-launch', ticketIds: [1, 2] } },
      { ...base, card: { id: 'm:flow-offer:0', kind: 'flow-offer' } },
      { ...base, card: { id: 'm:pr-ci-offer:0', kind: 'pr-ci-offer', prNumber: 4 } },
      { ...base, kind: 'chain', action: 'resume-chain', subjectId: 'c1', conversationId: null, chain: { milestoneN: 2, status: 'awaiting_approval', pauseReason: null, autoAdvance: false, nextChunk: 1, totalChunks: 3, retryChunk: null } },
      { ...base, kind: 'chain', action: 'resume-chain', subjectId: 'c2', conversationId: null, chain: { milestoneN: 2, status: 'paused', pauseReason: 'integration_failed:conflict', autoAdvance: true, nextChunk: 1, totalChunks: 3, retryChunk: 0 } },
    ]
    const states = shapes.map((entry) => buildDecisionState(inboxStateInput(entry, 'shop', {}, t), env))
    expect(states[0].offers.find((offer) => offer.id === 'launch')?.label).toBe('Launch #1, #2 on a rail')
    expect(states[1].offers.map((offer) => offer.id)).toEqual(['intent', 'implement', 'dismiss', 'open'])
    expect(states[2].offers.map((offer) => offer.call.args.decision ?? null)).toEqual(['start', 'dismiss', null])
    expect(states[3]).toMatchObject({ status: 'needs_you', recommended: 'chain.resume', hold: { code: 'checkpoint' } })
    expect(states[3].offers[0].label).toBe('Continue with the next rail')
    expect(states[4]).toMatchObject({ status: 'paused', hold: { code: 'integration_failed' } })
  })
})
