import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { setDesktopSetting } from '../../../desktop-db'
import { call, createHarness, type Harness } from '../__fixtures__/harness'
import { V2_TOOLS } from '../tools'
import { ConfirmationLedger } from './confirm'
import { choiceForm, compactChoices, freeTextOf, hasDecision, orderChoices, withField, type Choice, type ChoicePoint } from './choices'
import { result } from './envelope'
import { translator } from './lang'
import { createCatalog, defineTool, registerV2Tool } from './registry'
import { WRITE_FIELDS } from './views'

// A decision point (`choose`) reaches the person as choices: the client's own form when it can show one,
// otherwise a menu for the agent. The chosen option runs as its own call (its tier and confirmation apply).

const done: Array<Record<string, unknown>> = []
let point: ChoicePoint | null = null
const T = 'specrails_pick'
const ref = 'run:shop-api/1'
const choice = (id: string, extra: Partial<Choice> = {}): Choice => ({ id, label: `Pick ${id}`, effect: `Does ${id}.`, call: { tool: T, args: { action: 'decide', ref, decision: id } }, ...extra })

const pick = defineTool({
  name: T,
  title: 'Pick',
  description: 'Choice test tool.',
  owner: 'test',
  fields: { ...WRITE_FIELDS, decision: z.string(), note: z.string() },
  actions: {
    decide: {
      tier: 'write', required: ['ref', 'decision'],
      // `merge` is irreversible: picking it still needs the person's yes.
      confirm: (args) => args.decision === 'merge' ? 'irreversible' : null,
      preview: (_ctx, args) => ({ version: 'v1', effect: `Merges ${String(args.ref)}.` }),
      choose: { fields: ['decision'], point: () => point },
      handler: (_ctx, args) => { done.push(args); return result({ decided: args.decision, note: args.note ?? null }, { summary: `Decided ${String(args.decision)}.` }) },
    },
  },
})

let h: Harness
let asking: Client
const asked: Array<Record<string, any>> = []
let answer: (params: Record<string, any>) => { action: string; content?: Record<string, unknown> } = () => ({ action: 'cancel' })
const eliciting = (on: boolean) => { h.ctx.sessionState = { activeProjectId: null, sessionKey: 'session-c', elicitation: () => on } as never }

beforeAll(async () => {
  h = createHarness()
  registerV2Tool(h.server, h.ctx, pick, { catalog: createCatalog([...V2_TOOLS, pick]), ledger: new ConfirmationLedger() })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await h.server.connect(serverSide)
  asking = new Client({ name: 'eliciting-client', version: '1' }, { capabilities: { elicitation: { form: {} } } })
  asking.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request.params as Record<string, any>); return answer(request.params as Record<string, any>) as never })
  await asking.connect(clientSide)
})
afterAll(async () => { await asking.close() })
beforeEach(() => {
  asked.length = 0
  done.length = 0
  eliciting(true)
  point = { question: 'What now?', choices: [choice('keep'), choice('merge', { recommended: true, costHint: [0.1, 0.4] })], other: { call: { tool: T, args: { action: 'decide', ref, decision: 'changes' } }, field: 'note' } }
})

describe('a decision point in the client\'s own form', () => {
  it('shows the choices (recommended first, label — effect, cost) plus a free-text field, and runs the one picked', async () => {
    answer = () => ({ action: 'accept', content: { choice: 'keep' } })
    const { envelope } = await call(asking, T, { action: 'decide', ref })
    expect(envelope).toMatchObject({ ok: true, chosen: 'keep', data: { decided: 'keep' } })
    expect(asked).toHaveLength(1)
    const form = asked[0]
    expect(form.message).toBe('What now? Pick one (the first is recommended) or write your own.')
    expect(form.requestedSchema.properties.choice).toMatchObject({ type: 'string', enum: ['merge', 'keep'], default: 'merge' })
    expect(form.requestedSchema.properties.choice.enumNames).toEqual(['Pick merge — Does merge. (about 0.10–0.40 USD) · recommended', 'Pick keep — Does keep.'])
    expect(form.requestedSchema.properties.other).toMatchObject({ type: 'string', title: 'Something else — write it' })
    expect(form.requestedSchema.required).toBeUndefined()
    expect(done).toEqual([{ action: 'decide', ref, decision: 'keep' }])
  })

  it('still asks for the yes when the picked option needs a confirmation (a second dialog, same call)', async () => {
    answer = (params) => params.requestedSchema.properties.choice ? { action: 'accept', content: { choice: 'merge' } } : { action: 'accept', content: { confirm: true } }
    const { envelope } = await call(asking, T, { action: 'decide', ref })
    expect(envelope).toMatchObject({ ok: true, chosen: 'merge', confirmed: 'in_client', data: { decided: 'merge' } })
    expect(asked.map((form) => Object.keys(form.requestedSchema.properties))).toEqual([['choice', 'other'], ['confirm']])
    expect(asked[1].message).toMatch(/^Merges run:shop-api\/1\. It cannot be undone\. Go ahead\?$/)
  })

  it('never executes an irreversible pick without the yes: a closed confirmation falls back to the token flow', async () => {
    answer = (params) => params.requestedSchema.properties.choice ? { action: 'accept', content: { choice: 'merge' } } : { action: 'cancel' }
    const { envelope } = await call(asking, T, { action: 'decide', ref })
    expect(envelope).toMatchObject({ ok: false, chosen: 'merge', error: { code: 'confirmation_required', resend: { tool: T, args: { decision: 'merge' } } } })
    expect(done).toEqual([])
  })

  it('sends free text as the point\'s free-text call (it wins over the select)', async () => {
    answer = () => ({ action: 'accept', content: { choice: 'keep', other: '  Make the badge blue  ' } })
    const { envelope } = await call(asking, T, { action: 'decide', ref, lang: 'en' })
    expect(envelope).toMatchObject({ ok: true, chosen: 'other', data: { decided: 'changes', note: 'Make the badge blue' } })
    expect(done).toEqual([{ action: 'decide', ref, decision: 'changes', note: 'Make the badge blue', lang: 'en' }])
  })

  it('hands free text back to the agent when the point has nowhere to send it', async () => {
    point = { question: 'What now?', choices: [choice('keep')] }
    answer = () => ({ action: 'accept', content: { other: 'Ask me tomorrow' } })
    const { envelope } = await call(asking, T, { action: 'decide', ref })
    expect(envelope).toMatchObject({ ok: true, chosen: 'other', data: { other: 'Ask me tomorrow' }, summary: expect.stringContaining('"Ask me tomorrow"') })
    expect(envelope.untrusted).toEqual(expect.arrayContaining(['/data/other']))
    expect(done).toEqual([])
  })

  it('returns the menu to the agent on a decline, a cancel, an unknown id or an empty accept', async () => {
    for (const [reply, declined] of [[{ action: 'decline' }, true], [{ action: 'cancel' }, false], [{ action: 'accept', content: { choice: 'nope' } }, false], [{ action: 'accept', content: {} }, false]] as const) {
      answer = () => reply as never
      const { envelope } = await call(asking, T, { action: 'decide', ref })
      expect(envelope.ok).toBe(true)
      expect(envelope.summary).toMatch(declined ? /closed the form/ : /numbered menu/)
      expect(envelope.data.choices.map((c: { id: string }) => c.id)).toEqual(['merge', 'keep'])
    }
    expect(done).toEqual([])
  })

  it('asks nothing for a client without forms, with mcp_choices_in_client off, or when the call carries the choice', async () => {
    answer = () => ({ action: 'accept', content: { choice: 'keep' } })
    eliciting(false)
    const menu = (await call(asking, T, { action: 'decide', ref })).envelope
    expect(menu).toMatchObject({ ok: true, data: { question: 'What now?', other: { field: 'note', call: { tool: T } } } })
    expect(menu.data.choices[0]).toEqual({ id: 'merge', label: 'Pick merge', effect: 'Does merge.', recommended: true, call: { tool: T, args: { action: 'decide', ref, decision: 'merge' } } })
    expect(menu.untrusted).toEqual(['/data/question', '/data/choices/*/label', '/data/choices/*/effect'])
    eliciting(true)
    setDesktopSetting(h.db, 'mcp_choices_in_client', 'off')
    try { expect((await call(asking, T, { action: 'decide', ref })).envelope.data.choices).toHaveLength(2) } finally { setDesktopSetting(h.db, 'mcp_choices_in_client', 'on') }
    expect((await call(asking, T, { action: 'decide', ref, decision: 'keep' })).envelope.data.decided).toBe('keep')
    expect(asked).toHaveLength(0)
  })

  it('keeps the plain missing-field error when there is nothing to choose, or another required field is missing', async () => {
    point = { question: 'What now?', choices: [] }
    expect((await call(asking, T, { action: 'decide', ref })).envelope.error.code).toBe('invalid_input')
    point = { question: 'Free text only', choices: [], other: { call: { tool: T, args: { action: 'decide', ref, decision: 'text' } }, field: 'note' } }
    answer = () => ({ action: 'accept', content: { other: 'hi' } })
    expect((await call(asking, T, { action: 'decide', ref })).envelope.data).toEqual({ decided: 'text', note: 'hi' })
    expect(asked[0].requestedSchema.properties.choice).toBeUndefined()
    expect((await call(asking, T, { action: 'decide' })).envelope.error.code).toBe('invalid_input')
  })
})

describe('choice helpers', () => {
  const t = translator('es')
  it('order, compact and localize the menu', () => {
    const choices = [choice('a'), choice('b', { recommended: true })]
    expect(orderChoices(choices).map((c) => c.id)).toEqual(['b', 'a'])
    expect(compactChoices(choices)).toEqual([{ id: 'b', label: 'Pick b', effect: 'Does b.', recommended: true }, { id: 'a', label: 'Pick a', effect: 'Does a.' }])
    const form = choiceForm({ question: '¿Y ahora?', choices }, t) as { message: string; requestedSchema: { properties: Record<string, { title: string; enumNames?: string[] }> } }
    expect(form.message).toBe('¿Y ahora? Elige una (la primera es la recomendada) o escribe la tuya.')
    expect(form.requestedSchema.properties.other.title).toBe('Otra cosa — escríbela')
    expect(form.requestedSchema.properties.choice.enumNames?.[0]).toBe('Pick b — Does b. · recomendada')
  })

  it('find where free text goes and set dotted fields', () => {
    const offer = (id: string, args: Record<string, unknown>, needs?: string[]) => ({ id, label: id, tier: 'write' as const, call: { tool: T, args }, ...(needs ? { needs } : {}) })
    expect(freeTextOf({ offers: [offer('answer', { action: 'answer' }, ['answer|optionId'])] }, t)).toMatchObject({ field: 'answer' })
    expect(freeTextOf({ offers: [offer('rc', { action: 'decide', decision: 'request_changes' })] }, t)).toMatchObject({ field: 'note', title: 'Otra cosa — describe los cambios' })
    expect(freeTextOf({ offers: [offer('reject', { action: 'reject' })] }, t)).toMatchObject({ field: 'answer', title: 'Otra cosa — escribe por qué rechazar' })
    expect(freeTextOf({ offers: [offer('resume', { action: 'resume' })] }, t)).toBeUndefined()
    expect(withField({ a: 1, options: { x: 1 } }, 'options.note', 'n')).toEqual({ a: 1, options: { x: 1, note: 'n' } })
    expect(hasDecision(null)).toBe(false)
    expect(hasDecision({ question: '', choices: [], other: { field: 'answer' } })).toBe(false)
  })
})
