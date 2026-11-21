import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { call, createHarness, type Harness } from '../__fixtures__/harness'
import { V2_TOOLS } from '../tools'
import { bindingArgs, ConfirmationLedger } from './confirm'
import { decodeCursor, pageOf } from './cursor'
import { result } from './envelope'
import { createCatalog, defineTool, normalizeV1Args, registerV2Tool, type LegacyDelegate, type RegisterOptions, type V2Callback } from './registry'
import { F, WRITE_FIELDS } from './views'

// Registry follow-ups of the WP1–WP5 integration: v1 argument names, control
// options outside the binding, absolute guard cursors, dispatch and progress.

const seen: Array<Record<string, unknown>> = []
const counter = { executed: 0 }

const target = defineTool({
  name: 'specrails_target',
  title: 'Target',
  description: 'Dispatch target.',
  owner: 'test',
  fields: { ...WRITE_FIELDS, query: z.string() },
  actions: {
    echo: { tier: 'read', required: ['ref'], handler: (_ctx, args) => { seen.push(args); return { ref: args.ref, project: args.project ?? null, query: args.query ?? null } } },
    risky: {
      tier: 'destructive', confirm: 'irreversible', required: ['ref'],
      preview: () => ({ version: 'v1aaaa', refs: ['run:shop-api/1'] }),
      handler: () => { counter.executed++; return { done: true } },
    },
    paged: {
      tier: 'read',
      handler: () => result({ items: Array.from({ length: 400 }, (_, i) => ({ id: 50 + i, text: `item number ${50 + i} with some words` })) }, { pageBase: { offset: 50, key: 'k1' } }),
    },
    slow: {
      tier: 'read',
      handler: async (ctx) => { ctx.v2.progress(1, 3, 'waiting'); ctx.v2.progress(2, 3); return 'ok' },
    },
  },
})

const relay = defineTool({
  name: 'specrails_relay',
  title: 'Relay',
  description: 'Dispatches an offer.',
  owner: 'test',
  fields: { ...WRITE_FIELDS, call: F.object() },
  actions: {
    run: { tier: 'read', handler: async (ctx, args) => ctx.v2.dispatch(args.call as { tool: string; args: Record<string, unknown> }) },
  },
})

const legacyCalls: Array<Record<string, unknown>> = []
const legacy: LegacyDelegate = {
  actions: new Set(['old']),
  hint: () => 'specrails_target(echo)',
  call: async (args) => { legacyCalls.push(args); return { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true, summary: 'v1 answer', data: { v1: true } } } },
}

let harness: Harness
let client: Client

beforeAll(async () => {
  harness = createHarness()
  const catalog = createCatalog([...V2_TOOLS, target, relay])
  const callbacks = new Map<string, V2Callback>()
  const dispatch: RegisterOptions['dispatch'] = (c, extra) => callbacks.get(c.tool)!(c.args, extra)
  const ledger = new ConfirmationLedger()
  callbacks.set(target.name, registerV2Tool(harness.server, harness.ctx, target, { catalog, ledger, legacy, dispatch }))
  callbacks.set(relay.name, registerV2Tool(harness.server, harness.ctx, relay, { catalog, ledger, dispatch }))
  client = await harness.connect()
})
afterAll(async () => { await client.close() })
beforeEach(() => {
  harness.ctx.sessionState = { activeProjectId: null, sessionKey: 'session-a' } as never
  seen.length = 0
  legacyCalls.length = 0
  counter.executed = 0
})

describe('v1 argument names on v2 actions', () => {
  it('maps id/jobId/itemId/runId to ref, q to query and projectId to project before the required check', async () => {
    const res = await call(client, 'specrails_target', { action: 'echo', jobId: 'abc', q: 'flaky', projectId: 'p1' })
    expect(res.isError).toBe(false)
    expect(res.envelope.data).toEqual({ ref: 'abc', project: 'p1', query: 'flaky' })
    expect(seen[0]).not.toHaveProperty('jobId')
    expect((await call(client, 'specrails_target', { action: 'echo', id: 42 })).envelope.data).toMatchObject({ ref: '42' })
  })

  it('keeps an explicit v2 field, skips aliases the tool declares itself and leaves v1-only actions to the v1 handler', async () => {
    expect(normalizeV1Args(target, { ref: 'run:x/1', jobId: 'other' })).toEqual({ ref: 'run:x/1' })
    expect(normalizeV1Args({ fields: { id: z.string(), ref: z.string() } }, { id: '7' })).toEqual({ id: '7' })
    expect(normalizeV1Args({ fields: { project: z.string() } }, { jobId: '7' })).toEqual({ jobId: '7' })
    await call(client, 'specrails_target', { action: 'old', jobId: 'abc' })
    expect(legacyCalls[0]).toMatchObject({ jobId: 'abc' })
  })

  it('binds a confirmation to the normalized shape, so a v1-shaped call confirms a v2-shaped token', async () => {
    const first = await call(client, 'specrails_target', { action: 'risky', jobId: 'r1' })
    expect(first.envelope.error).toMatchObject({ code: 'confirmation_required' })
    const ok = await call(client, 'specrails_target', { action: 'risky', ref: 'r1', confirm: first.envelope.error.confirmToken })
    expect(ok.envelope.ok).toBe(true)
    expect(counter.executed).toBe(1)
  })
})

describe('control options', () => {
  it('leaves options.waitMs out of the binding', async () => {
    expect(bindingArgs({ action: 'x', options: { waitMs: 5000 } })).toEqual({ action: 'x' })
    expect(bindingArgs({ action: 'x', options: { waitMs: 5000, mode: 'full' } })).toEqual({ action: 'x', options: { mode: 'full' } })
    const first = await call(client, 'specrails_target', { action: 'risky', ref: 'r1', options: { waitMs: 1000 } })
    const ok = await call(client, 'specrails_target', { action: 'risky', ref: 'r1', options: { waitMs: 20000 }, confirm: first.envelope.error.confirmToken })
    expect(ok.envelope.ok).toBe(true)
  })
})

describe('size guard on paged lists', () => {
  it('resumes at an absolute offset with the query key', async () => {
    const res = await call(client, 'specrails_target', { action: 'paged' })
    const kept = res.envelope.data.items.length
    expect(res.envelope.page.truncated).toBe(true)
    expect(decodeCursor(res.envelope.page.cursor, 'k1')).toMatchObject({ offset: 50 + kept, path: '/items', key: 'k1' })
    expect(() => decodeCursor(res.envelope.page.cursor, 'other')).toThrow(/another query/)
  })

  it('pageOf hands its offset and key over as the page base', () => {
    const page = pageOf(Array.from({ length: 60 }, (_, i) => i), { cursor: pageOf(Array.from({ length: 60 }, (_, i) => i), { key: 'q' }).page.cursor, key: 'q' })
    expect(page.base).toEqual({ offset: 25, key: 'q' })
  })
})

describe('ctx.v2.dispatch', () => {
  it('runs the target through its own callback, confirmation protocol included', async () => {
    const echoed = await call(client, 'specrails_relay', { action: 'run', call: { tool: 'specrails_target', args: { action: 'echo', ref: 'r9' } } })
    expect(echoed.envelope.data).toMatchObject({ v: 2, ok: true, data: { ref: 'r9' } })
    const held = await call(client, 'specrails_relay', { action: 'run', call: { tool: 'specrails_target', args: { action: 'risky', ref: 'r9' } } })
    expect(held.envelope.data).toMatchObject({ ok: false, error: { code: 'confirmation_required' } })
    expect(counter.executed).toBe(0)
  })

  it('reaches a legacy delegate and reads its v1 envelope as v2', async () => {
    const res = await call(client, 'specrails_relay', { action: 'run', call: { tool: 'specrails_target', args: { action: 'old', jobId: 'j' } } })
    expect(res.envelope.data).toMatchObject({ v: 2, ok: true, data: { v1: true }, warnings: [expect.stringContaining('specrails_target(echo)')] })
  })
})

describe('ctx.v2.progress', () => {
  it('sends notifications/progress for the request progressToken', async () => {
    const updates: Array<{ progress: number; total?: number; message?: string }> = []
    await client.callTool({ name: 'specrails_target', arguments: { action: 'slow' } }, CallToolResultSchema, { onprogress: (p) => { updates.push(p) } })
    expect(updates).toEqual([{ progress: 1, total: 3, message: 'waiting' }, { progress: 2, total: 3 }])
  })

  it('is a no-op without a token', async () => {
    expect((await call(client, 'specrails_target', { action: 'slow' })).envelope.ok).toBe(true)
  })
})
