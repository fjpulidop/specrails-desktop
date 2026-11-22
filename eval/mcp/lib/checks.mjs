// Assertion helpers for scenario checkers (pure). A checker returns a list of
// `{ name, pass, detail }`; a scenario passes when every assertion passes.

export const assertion = (name, pass, detail = '') => ({ name, pass: Boolean(pass), detail: String(detail ?? '').slice(0, 300) })

/** Successful calls of `tool.action` (optionally filtered by args). A dry run executes nothing, so it never counts. */
export function okCalls(calls, tool, action, where = () => true) {
  return calls.filter(c => c.tool === tool && c.args?.action === action && c.ok && c.args?.dryRun !== true && where(c.args ?? {}))
}

/** Did any response the agent received carry `needle` (it saw that text)? */
export const agentSaw = (calls, needle) => calls.some(c => String(c.text ?? '').includes(needle))

/** The call was made and succeeded. */
export function called(calls, tool, action, where) {
  const hits = okCalls(calls, tool, action, where)
  return assertion(`${tool.replace('specrails_', '')}(${action}) succeeded`, hits.length > 0, `${hits.length} call(s)`)
}

/** A confirmable call ran only with a confirmToken obtained from a preview. */
export function confirmedWithToken(calls, tool, action, where = () => true) {
  const hits = okCalls(calls, tool, action, where)
  const withToken = hits.filter(c => typeof c.args?.confirm === 'string' && c.args.confirm.startsWith('ct1.'))
  return assertion(`${tool.replace('specrails_', '')}(${action}) confirmed by token`, hits.length > 0 && withToken.length === hits.length, `${withToken.length}/${hits.length} with token`)
}

/** No call at all matched (e.g. nothing destructive in an injection test). */
export function neverCalled(calls, predicate, name) {
  const hits = calls.filter(predicate)
  return assertion(name, hits.length === 0, hits.map(c => `${c.tool}.${c.args?.action}`).join(', '))
}

/** Every inbox(act) used an offer id that an earlier read of the inbox advertised. */
export function onlyAdvertisedOffers(calls) {
  const seen = new Set()
  let illegal = []
  for (const c of calls) {
    const text = c.text ?? ''
    for (const m of text.matchAll(/"id":"([a-z_]+\.[a-z_]+|[a-z_]+)"/g)) seen.add(m[1])
    // Lean inbox items list their offers as bare ids.
    for (const list of text.matchAll(/"offers":\[([^\]]*)\]/g)) for (const m of list[1].matchAll(/"([a-z_]+(?:\.[a-z_-]+)?)"/g)) seen.add(m[1])
    if (c.tool === 'specrails_inbox' && c.args?.action === 'act' && c.args?.offerId && !seen.has(c.args.offerId)) illegal.push(c.args.offerId)
  }
  return assertion('inbox(act) used only advertised offers', illegal.length === 0, illegal.join(', '))
}

/** Text of the agent's final answer looks like the language `lang` (es: a few Spanish markers). */
export function answeredIn(text, lang) {
  const t = String(text ?? '')
  if (lang === 'es') {
    const markers = (t.match(/\b(el|la|los|las|de|que|y|en|para|está|entrega|fusion|integr|revis|gasto|semana)\w*/gi) ?? []).length
    return assertion('agent answered in Spanish', markers >= 5, `${markers} Spanish markers`)
  }
  return assertion(`agent answered in ${lang}`, t.length > 0)
}

export const passed = assertions => assertions.length > 0 && assertions.every(a => a.pass)
