import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { setDesktopSetting } from '../../../desktop-db'
import { call, createHarness, type Harness } from '../__fixtures__/harness'
import { V2_TOOLS } from '../tools'
import { ConfirmationLedger, elicitsForms } from './confirm'
import { result } from './envelope'
import { createCatalog, defineTool, registerV2Tool, type LegacyDelegate } from './registry'
import { WRITE_FIELDS } from './views'

// The registry contract every v2 tool inherits: admission, required fields,
// language, refs, the confirmation protocol, the envelope and the size guard.

const control = { version: 'v1aaaa', cost: { forecastUsd: [0.1, 0.3] as [number, number] | null, runs: 1 }, merged: 0, spent: 0 }

const fake = defineTool({
  name: 'specrails_fake',
  title: 'Fake',
  description: 'Registry test tool.',
  owner: 'test',
  fields: { ...WRITE_FIELDS, note: z.string() },
  actions: {
    whoami: { tier: 'read', handler: (ctx, args) => result({ project: ctx.v2.project(args).slug, lang: ctx.v2.lang }, { summary: ctx.v2.t('core.status.running') }) },
    target: { tier: 'read', required: ['ref'], handler: (ctx, args) => ctx.v2.target(args, 'run') },
    needs: { tier: 'write', required: ['ref', 'note'], handler: () => 'ok' },
    stub: { tier: 'read' },
    later: { tier: 'read' },
    big: { tier: 'read', handler: () => ({ items: Array.from({ length: 400 }, (_, i) => ({ id: i, text: `item number ${i} with some words` })) }) },
    state: {
      tier: 'read',
      handler: (ctx) => result({}, { state: ctx.v2.state({ status: 'paused', hold: { kind: 'paused', since: null }, offers: [{ id: 'resume', labelKey: 'core.offer.run.resume', call: { tool: 'specrails_runs', args: { action: 'resume', ref: 'run:shop-api/1' } } }], recommended: 'resume' }) }),
    },
    merge: {
      tier: 'destructive', confirm: 'irreversible', required: ['ref'],
      preview: () => ({ version: control.version, refs: ['delivery:shop-api/1'], effect: 'Merges the delivery into main.' }),
      handler: () => { control.merged++; return { merged: true } },
    },
    spend: {
      tier: 'ai-spawn', confirm: 'costly',
      preview: () => ({ version: 'v1', cost: control.cost }),
      handler: () => { control.spent++; return 'spent' },
    },
  },
})

const legacyCalls: Array<Record<string, unknown>> = []
const legacy: LegacyDelegate = {
  actions: new Set(['old_action', 'stub']),
  shape: { confirm: z.boolean().optional(), projectId: z.string().optional() },
  hint: (action) => action === 'old_action' ? 'specrails_fake(whoami)' : null,
  call: async (args) => { legacyCalls.push(args); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true, summary: 'v1', data: 1 } } },
}

let harness: Harness
let client: Client

beforeAll(async () => {
  harness = createHarness()
  const catalog = createCatalog([...V2_TOOLS, fake])
  registerV2Tool(harness.server, harness.ctx, fake, { catalog, ledger: new ConfirmationLedger(), legacy, legacyEquivalent: (_tool, action) => action === 'stub' ? null : 'specrails_jobs(list)' })
  client = await harness.connect()
})
afterAll(async () => { await client.close() })
beforeEach(() => {
  Object.assign(control, { version: 'v1aaaa', cost: { forecastUsd: [0.1, 0.3], runs: 1 }, merged: 0, spent: 0 })
  harness.ctx.sessionState = { activeProjectId: null, sessionKey: 'session-a' } as never
  harness.broadcasts.length = 0
  legacyCalls.length = 0
})

describe('v2 registry', () => {
  it('answers with one minified envelope, localized, scoped by the session project', async () => {
    harness.ctx.sessionState!.activeProjectId = 'p1'
    const { envelope, text } = await call(client, 'specrails_fake', { action: 'whoami', lang: 'es' })
    expect(envelope).toEqual({ v: 2, ok: true, summary: 'En curso', data: { project: 'shop-api', lang: 'es' } })
    expect(text).toBe(JSON.stringify(envelope))
  })

  it('keeps the session language for later calls that omit lang', async () => {
    harness.ctx.sessionState!.activeProjectId = 'p1'
    await call(client, 'specrails_fake', { action: 'whoami', lang: 'es' })
    const { envelope } = await call(client, 'specrails_fake', { action: 'whoami' })
    expect(envelope).toMatchObject({ summary: 'En curso', data: { lang: 'es' } })
  })

  it('resolves refs and fails a call without project with choices', async () => {
    expect((await call(client, 'specrails_fake', { action: 'target', ref: 'run:shop-api/r7' })).envelope.data).toMatchObject({ kind: 'run', id: 'r7', ref: 'run:shop-api/r7' })
    const { envelope, isError } = await call(client, 'specrails_fake', { action: 'whoami' })
    expect(isError).toBe(true)
    expect(envelope.error).toMatchObject({ code: 'ambiguous', choices: [{ slug: 'shop-api' }] })
  })

  it('validates per-action required fields with the fields it takes', async () => {
    const { envelope } = await call(client, 'specrails_fake', { action: 'needs', ref: 'run:shop-api/1' })
    expect(envelope.error.code).toBe('invalid_input')
    expect(envelope.error.message).toBe('specrails_fake(needs) missing "note". It takes: ref, note.')
  })

  it('refuses a disabled tier', async () => {
    setDesktopSetting(harness.db, 'mcp_tier_destructive', 'false')
    try {
      const { envelope } = await call(client, 'specrails_fake', { action: 'merge', ref: 'delivery:shop-api/1' })
      expect(envelope.error.code).toBe('unauthorized')
    } finally { setDesktopSetting(harness.db, 'mcp_tier_destructive', 'true') }
  })

  it('answers not_implemented for a stub, naming the v1 call to use meanwhile', async () => {
    const { envelope } = await call(client, 'specrails_fake', { action: 'later' })
    expect(envelope.error).toMatchObject({ code: 'not_implemented', message: 'specrails_fake(later) is not available in this version yet; meanwhile use specrails_jobs(list).' })
    // `stub` is also a v1 action of the same tool name: the v1 handler serves it while the v2 action is a stub.
    expect((await call(client, 'specrails_fake', { action: 'stub' })).envelope).toEqual({ ok: true, summary: 'v1', data: 1 })
  })

  it('cuts oversized results with a cursor', async () => {
    const { envelope } = await call(client, 'specrails_fake', { action: 'big' })
    expect(envelope.page).toMatchObject({ truncated: true, cursor: expect.any(String) })
    expect(envelope.data.items.length).toBeLessThan(400)
  })

  it('returns decision state with localized labels and catalog facts', async () => {
    const { envelope } = await call(client, 'specrails_fake', { action: 'state', lang: 'es' })
    expect(envelope.state).toMatchObject({ status: 'paused', label: 'En pausa', recommended: 'resume', offers: [{ id: 'resume', tier: 'ai-spawn', call: { tool: 'specrails_runs' } }] })
  })

  it('broadcasts activity for mutating calls only', async () => {
    await call(client, 'specrails_fake', { action: 'needs', ref: 'run:shop-api/1', note: 'n' })
    await call(client, 'specrails_fake', { action: 'target', ref: 'run:shop-api/1' })
    expect(harness.broadcasts.map((msg) => (msg as unknown as { tool: string; action: string }).action)).toEqual(['needs'])
  })
})

describe('confirmation protocol', () => {
  const merge = { action: 'merge', ref: 'delivery:shop-api/1' }

  it('requires a confirmation with a preview and token, then executes once with it', async () => {
    const first = await call(client, 'specrails_fake', merge)
    expect(first.envelope.error).toMatchObject({
      code: 'confirmation_required', confirmToken: expect.stringMatching(/^ct1\./),
      preview: { label: 'specrails_fake(merge)', class: 'irreversible', reversible: false, external: false, refs: ['delivery:shop-api/1'], version: 'v1aaaa', effect: 'Merges the delivery into main. It cannot be undone.' },
    })
    // The exact confirming call comes back with the preview, so the agent makes it without rebuilding the arguments.
    expect(first.envelope.error.resend).toEqual({ tool: 'specrails_fake', args: { ...merge, confirm: first.envelope.error.confirmToken } })
    expect(first.envelope.summary).toBe('specrails_fake(merge): Merges the delivery into main. It cannot be undone.')
    expect(control.merged).toBe(0)
    const confirmed = await call(client, 'specrails_fake', { ...merge, confirm: first.envelope.error.confirmToken })
    expect(confirmed.envelope).toMatchObject({ ok: true, data: { merged: true } })
    expect(control.merged).toBe(1)
    const replay = await call(client, 'specrails_fake', { ...merge, confirm: first.envelope.error.confirmToken })
    expect(replay.envelope.error).toMatchObject({ code: 'stale', reason: 'replayed', confirmToken: expect.any(String) })
    expect(control.merged).toBe(1)
  })

  it('fails stale with a fresh preview when the state changed after the preview', async () => {
    const { envelope } = await call(client, 'specrails_fake', merge)
    control.version = 'v2bbbb'
    const stale = await call(client, 'specrails_fake', { ...merge, confirm: envelope.error.confirmToken })
    expect(stale.envelope.error).toMatchObject({ code: 'stale', reason: 'stale', preview: { version: 'v2bbbb' } })
    const fresh = await call(client, 'specrails_fake', { ...merge, confirm: stale.envelope.error.confirmToken })
    expect(fresh.envelope.ok).toBe(true)
  })

  it('binds the token to the arguments and the session', async () => {
    const { envelope } = await call(client, 'specrails_fake', merge)
    const other = await call(client, 'specrails_fake', { ...merge, ref: 'delivery:shop-api/2', confirm: envelope.error.confirmToken })
    expect(other.envelope.error).toMatchObject({ code: 'confirmation_required', reason: 'mismatch' })
    harness.ctx.sessionState = { activeProjectId: null, sessionKey: 'session-b' } as never
    const session = await call(client, 'specrails_fake', { ...merge, confirm: envelope.error.confirmToken })
    expect(session.envelope.error.reason).toBe('mismatch')
    expect(control.merged).toBe(0)
  })

  it('previews without executing on dryRun', async () => {
    const { envelope } = await call(client, 'specrails_fake', { ...merge, dryRun: true })
    expect(envelope).toMatchObject({ ok: true, data: { wouldExecute: false, preview: { class: 'irreversible' }, confirmToken: expect.any(String) } })
    expect(envelope.summary).toMatch(/^Dry run, nothing executed/)
    expect(envelope.data.resend).toEqual({ tool: 'specrails_fake', args: { ...merge, confirm: envelope.data.confirmToken } })
    expect(control.merged).toBe(0)
  })

  it('lets costly calls under the threshold through and confirms above it or for several runs', async () => {
    expect((await call(client, 'specrails_fake', { action: 'spend' })).envelope.ok).toBe(true)
    control.cost = { forecastUsd: [0.2, 0.9], runs: 1 }
    expect((await call(client, 'specrails_fake', { action: 'spend' })).envelope.error).toMatchObject({ code: 'confirmation_required', preview: { effect: expect.stringContaining('0.20–0.90 USD') } })
    control.cost = { forecastUsd: [0.01, 0.02], runs: 3 }
    expect((await call(client, 'specrails_fake', { action: 'spend' })).envelope.error.preview.effect).toContain('It starts 3 runs.')
    control.cost = { forecastUsd: null, runs: 1 }
    expect((await call(client, 'specrails_fake', { action: 'spend' })).envelope.error.code).toBe('confirmation_required')
    setDesktopSetting(harness.db, 'mcp_confirm_above_usd', '5')
    control.cost = { forecastUsd: [0.2, 0.9], runs: 1 }
    try { expect((await call(client, 'specrails_fake', { action: 'spend' })).envelope.ok).toBe(true) } finally { setDesktopSetting(harness.db, 'mcp_confirm_above_usd', '0.5') }
    expect(control.spent).toBe(2)
  })
})

describe('legacy delegate (a v1 tool of the same name)', () => {
  it('serves v1 actions with the v1 handler, adds a deprecation warning, and accepts v1 argument types', async () => {
    const { envelope, text } = await call(client, 'specrails_fake', { action: 'old_action', projectId: 'p1', confirm: true })
    expect(legacyCalls).toEqual([{ action: 'old_action', projectId: 'p1', confirm: true }])
    expect(envelope).toEqual({ ok: true, summary: 'v1', data: 1, warnings: ['deprecated: use specrails_fake(whoami)'] })
    expect(JSON.parse(text)).toEqual(envelope)
  })

  it('advertises only the v2 actions and the v2 field types', async () => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'specrails_fake')!
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[]; type?: string }>
    expect(properties.action.enum).not.toContain('old_action')
    expect(properties.confirm).toMatchObject({ type: 'string' })
    expect(tool.inputSchema.required).toEqual(['action'])
  })
})

describe('confirmation inside the call (MCP elicitation)', () => {
  const merge = { action: 'merge', ref: 'delivery:shop-api/1' }
  let own: Harness
  let asking: Client
  const asked: Array<Record<string, unknown>> = []
  let answer: () => { action: string; content?: Record<string, unknown> } = () => ({ action: 'cancel' })

  beforeAll(async () => {
    own = createHarness()
    registerV2Tool(own.server, own.ctx, fake, { catalog: createCatalog([...V2_TOOLS, fake]), ledger: new ConfirmationLedger() })
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await own.server.connect(serverSide)
    asking = new Client({ name: 'eliciting-client', version: '1' }, { capabilities: { elicitation: { form: {} } } })
    asking.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request.params as Record<string, unknown>); return answer() as never })
    await asking.connect(clientSide)
  })
  afterAll(async () => { await asking.close() })
  beforeEach(() => {
    asked.length = 0
    own.ctx.sessionState = { activeProjectId: null, sessionKey: 'session-e', elicitation: () => true } as never
  })

  it('asks the person in the client and executes on an explicit yes, with no token round trip', async () => {
    answer = () => ({ action: 'accept', content: { confirm: true } })
    const done = await call(asking, 'specrails_fake', merge)
    expect(done.envelope).toMatchObject({ ok: true, data: { merged: true }, confirmed: 'in_client' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ mode: 'form', message: 'Merges the delivery into main. It cannot be undone. Go ahead?', requestedSchema: { required: ['confirm'] } })
    expect(control.merged).toBe(1)
  })

  it('does not act on a yes given while the state changed under the dialog (stale, fresh preview)', async () => {
    answer = () => { control.version = 'v9zzzz'; return { action: 'accept', content: { confirm: true } } }
    const moved = await call(asking, 'specrails_fake', merge)
    expect(moved.envelope.error).toMatchObject({ code: 'stale', reason: 'stale', preview: { version: 'v9zzzz' } })
    expect(control.merged).toBe(0)
  })

  it('treats a decline (or an unticked box) as no, and a cancelled dialog as the token flow', async () => {
    answer = () => ({ action: 'decline' })
    const declined = await call(asking, 'specrails_fake', merge)
    expect(declined.envelope.error).toMatchObject({ code: 'confirmation_required', reason: 'declined', confirmToken: expect.stringMatching(/^ct1\./) })
    expect(declined.envelope.error.message).toMatch(/Not confirmed in the client's dialog/)
    answer = () => ({ action: 'accept', content: { confirm: false } })
    expect((await call(asking, 'specrails_fake', merge)).envelope.error.reason).toBe('declined')
    answer = () => ({ action: 'cancel' })
    const cancelled = await call(asking, 'specrails_fake', merge)
    expect(cancelled.envelope.error).toMatchObject({ code: 'confirmation_required', resend: { args: { confirm: cancelled.envelope.error.confirmToken } } })
    expect(cancelled.envelope.error.reason).toBeUndefined()
    expect(control.merged).toBe(0)
    // The token still confirms in the chat afterwards.
    expect((await call(asking, 'specrails_fake', { ...merge, confirm: cancelled.envelope.error.confirmToken })).envelope.ok).toBe(true)
  })

  it('never asks for a call that needs no confirmation, a dry run, a client without the capability, or with the setting off', async () => {
    answer = () => ({ action: 'accept', content: { confirm: true } })
    await call(asking, 'specrails_fake', { action: 'spend' })
    const dry = await call(asking, 'specrails_fake', { ...merge, dryRun: true })
    expect(dry.envelope.warnings).toEqual([expect.stringContaining('without dryRun')])
    own.ctx.sessionState = { activeProjectId: null, sessionKey: 'session-e', elicitation: () => false } as never
    expect((await call(asking, 'specrails_fake', merge)).envelope.error.code).toBe('confirmation_required')
    own.ctx.sessionState = { activeProjectId: null, sessionKey: 'session-e', elicitation: () => true } as never
    setDesktopSetting(own.db, 'mcp_confirm_in_client', 'off')
    try { expect((await call(asking, 'specrails_fake', merge)).envelope.error.code).toBe('confirmation_required') } finally { setDesktopSetting(own.db, 'mcp_confirm_in_client', 'on') }
    expect(asked).toHaveLength(0)
    expect(control.merged).toBe(0)
  })

  it('reads form support from the declared capabilities', () => {
    expect(elicitsForms({ elicitation: { form: {}, url: {} } })).toBe(true)
    expect(elicitsForms({ elicitation: {} })).toBe(true)
    expect(elicitsForms({ elicitation: { url: {} } })).toBe(false)
    expect(elicitsForms({})).toBe(false)
    expect(elicitsForms(undefined)).toBe(false)
  })
})
