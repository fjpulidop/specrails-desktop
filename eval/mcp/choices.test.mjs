// The simulated person answers from the keyboard, and the two choice bars (pure).
import test from 'node:test'
import assert from 'node:assert/strict'
import { formAnswer, isKeyboardReply, menuOf, nextReply, pickFromMenu } from './lib/person.mjs'
import { decisionMetrics, effectiveArgs, formKind, pairCalls } from './lib/metrics.mjs'
import { passBars } from './lib/report.mjs'

const MENU_ES = [
  'La entrega «Añadir la insignia» está lista. ¿Qué hago?',
  '',
  '1. **Integrar en local** (recomendada) — fusiona en tu rama; no se puede deshacer.',
  '2. Crear el pull request — abre una PR para revisión.',
  '3. Descartar — desecha la entrega.',
  '4. Otra cosa — escríbela',
].join('\n')

test('reads the numbered menu at the end of a message (markdown, parentheses, dashes)', () => {
  assert.deepEqual(menuOf(MENU_ES).map(item => item.n), [1, 2, 3, 4])
  assert.equal(menuOf(MENU_ES)[0].text, 'Integrar en local (recomendada) — fusiona en tu rama; no se puede deshacer.')
  assert.deepEqual(menuOf('Pick one:\n1) Resume\n2) Stop').map(item => item.text), ['Resume', 'Stop'])
  assert.deepEqual(menuOf('1 — Yes, go ahead\n2 — No'), [{ n: 1, text: 'Yes, go ahead' }, { n: 2, text: 'No' }])
  // A single numbered line, or a numbered list that restarts, keeps only the last complete block.
  assert.deepEqual(menuOf('1. Only one'), [])
  assert.deepEqual(menuOf('1. a\n2. b\n\nThen:\n1. Yes\n2. No').map(item => item.text), ['Yes', 'No'])
})

test('picks by number: the option they want, yes/no for a preview, else the recommended first; never "Something else"', () => {
  assert.equal(pickFromMenu(menuOf(MENU_ES), { pick: /descart/i }), 3)
  assert.equal(pickFromMenu(menuOf(MENU_ES), {}), 1)
  const preview = menuOf('Merge it into main?\n1. No, leave it\n2. Yes, go ahead\n3. Something else — write it')
  assert.equal(pickFromMenu(preview, {}, { confirming: true }), 2)
  assert.equal(pickFromMenu(preview, { decline: 'No.' }, { confirming: true }), 1)
  assert.equal(pickFromMenu(menuOf('1. Something else — write it\n2. Otra cosa — escríbela'), {}), null)
})

test('replies with a number when the agent shows a menu, with words only where the scenario needs them', () => {
  const preview = { tool: 'specrails_deliveries', args: { action: 'decide', decision: 'merge_local' }, code: 'confirmation_required', ok: false }
  assert.equal(nextReply({ confirm: 'Sí, adelante.' }, { calls: [preview], lastText: '¿Confirmas?\n1. Sí, integrar\n2. No\n3. Otra cosa — escríbela', used: 0 }), '1')
  assert.equal(nextReply({ confirm: 'Yes.', pick: /codex/i }, { calls: [], lastText: 'Pick one:\n1. Try again now\n2. Continue on codex\n3. Something else — write it', used: 0 }), '2')
  // Their own words once, when no option is what they want; then numbers again.
  const ask = 'What should the app be?\n1. A web app\n2. A mobile app\n3. Something else — write it'
  assert.equal(nextReply({ freeText: 'A CLI todo list.' }, { lastText: ask, used: 0, wrote: 0 }), 'A CLI todo list.')
  assert.equal(nextReply({ freeText: 'A CLI todo list.' }, { lastText: ask, used: 1, wrote: 1 }), '1')
  // No menu: the old chat words (the keyboard bar then counts it as free text).
  assert.equal(nextReply({ confirm: 'Yes.' }, { calls: [preview], lastText: 'Shall I merge it?', used: 0 }), 'Yes.')
  assert.equal(isKeyboardReply('2'), true)
  assert.equal(isKeyboardReply(' 3. '), true)
  assert.equal(isKeyboardReply('Yes, go ahead'), false)
})

test('answers a server form by option id, its one free text, or the recommended default; confirmations stay in the chat', () => {
  const form = { requestedSchema: { properties: { choice: { type: 'string', enum: ['decide.merge_local', 'decide.discard'], enumNames: ['Integrate locally — Merges…', 'Discard — Throws…'], default: 'decide.merge_local' }, other: { type: 'string' } } } }
  assert.deepEqual(formAnswer({ pick: /discard/i }, form), { action: 'accept', content: { choice: 'decide.discard' } })
  assert.deepEqual(formAnswer({ pick: /request changes/i, freeText: 'Make it blue.' }, form), { action: 'accept', content: { other: 'Make it blue.' } })
  assert.deepEqual(formAnswer({}, form), { action: 'accept', content: { choice: 'decide.merge_local' } })
  assert.deepEqual(formAnswer({}, { requestedSchema: { properties: { confirm: { type: 'boolean' } } } }), { action: 'cancel' })
  assert.deepEqual(formAnswer({}, { requestedSchema: { properties: { confirm: { type: 'boolean' } } } }, { confirm: 'accept' }), { action: 'accept', content: { confirm: true } })
  assert.equal(formKind(form), 'choice')
  assert.equal(formKind({ requestedSchema: { properties: { confirm: {} } } }), 'confirm')
})

const record = (calls) => {
  const out = []
  let t = 0
  calls.forEach(({ name, args, envelope, forms = [] }, i) => {
    const id = `c${i}`
    out.push({ t: t++, d: 'in', m: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } })
    forms.forEach(([params, result], j) => {
      out.push({ t: t++, d: 'out', m: { jsonrpc: '2.0', id: `e${i}${j}`, method: 'elicitation/create', params } })
      out.push({ t: t++, d: 'in', m: { jsonrpc: '2.0', id: `e${i}${j}`, result } })
    })
    out.push({ t: t++, d: 'out', m: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: !envelope.ok } } })
  })
  return out
}
const CHOICE = { mode: 'form', message: 'Pick', requestedSchema: { properties: { choice: { type: 'string', enum: ['decide.merge_local'] }, other: { type: 'string' } } } }
const CONFIRM = { mode: 'form', message: 'Go ahead?', requestedSchema: { properties: { confirm: { type: 'boolean' } } } }

test('counts decision points and keyboard inputs from the forms and the chat', () => {
  const { calls } = pairCalls(record([
    { name: 'specrails_deliveries', args: { action: 'decide', ref: 'delivery:p/1' }, envelope: { v: 2, ok: false, chosen: 'decide.merge_local', summary: '', error: { code: 'confirmation_required' } }, forms: [[CHOICE, { action: 'accept', content: { choice: 'decide.merge_local' } }], [CONFIRM, { action: 'cancel' }]] },
    { name: 'specrails_runs', args: { action: 'answer', ref: 'run:p/1' }, envelope: { v: 2, ok: true, summary: '', data: { question: 'Which?', choices: [{ id: 'a' }] } } },
  ]))
  assert.deepEqual(effectiveArgs(calls[0]), { action: 'decide', ref: 'delivery:p/1', decision: 'merge_local' })
  const live = decisionMetrics(calls, { asked: [{ menu: true }, { menu: false }], replies: ['1', 'Yes please'] })
  assert.deepEqual({ ...live, inputs: live.inputs }, { points: 4, asChoices: 3, forms: { choice: 1, confirm: 1 }, menusReturned: 1, inputs: ['number', 'text', 'option'], freeText: 1, keyboardOnly: true })
  const typed = decisionMetrics(calls, { replies: ['Yes', 'Do it'] })
  assert.equal(typed.keyboardOnly, false)
  assert.equal(decisionMetrics([], {}).keyboardOnly, false)
})

test('reports the two choice bars', () => {
  const row = (id, status, decisions) => ({ id, status, mode: 'v2', clientName: 'claude', metrics: { calls: 1, invalidArgs: 0, tokens: {}, latency: {}, polling: {}, confirmations: { unconfirmed: [] }, decisions } })
  const bars = passBars([
    row('S5', 'pass', { points: 2, asChoices: 2, inputs: ['number', 'number'], keyboardOnly: true }),
    row('S6', 'pass', { points: 1, asChoices: 0, inputs: ['text', 'text'], keyboardOnly: false }),
    row('S8', 'pass', { points: 0, asChoices: 0, inputs: [], keyboardOnly: false }),
  ], { client: 'claude' })
  const byId = Object.fromEntries(bars.map(b => [b.id, b]))
  assert.deepEqual([byId.choices.value, byId.choices.pass], ['2/3', false])
  assert.deepEqual([byId.keyboard.value, byId.keyboard.pass], ['1/2', false])
})
