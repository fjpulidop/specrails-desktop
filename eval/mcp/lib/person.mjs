// The simulated person: scripted replies to the agent between turns (pure).
//
// A scenario's `person` is `{ confirm?, decline?, question?, replies? }`:
//   confirm   what the person says when the agent shows a preview that needs a yes
//   decline   said instead of `confirm` (the person refuses)
//   question  what the person says when the agent asks something else
//   replies   fixed replies, used in order after the first prompt (overrides the rest)

/**
 * Has the server asked for a confirmation that no later call satisfied?
 * `calls` are the paired calls of the conversation so far (metrics.pairCalls).
 */
export function pendingConfirmation(calls) {
  let pending = null
  for (const c of calls) {
    if (c.code === 'confirmation_required' || c.code === 'stale') pending = { tool: c.tool, action: c.args?.action, decision: c.args?.decision ?? null }
    else if (pending && c.ok && c.tool === pending.tool && c.args?.action === pending.action && c.args?.confirm) pending = null
  }
  return pending
}

/** Does the agent's last message ask the person something? */
export function asksPerson(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  return /\?\s*$/.test(t) || /\b(confirm|shall I|should I|do you want|would you like|go ahead|proceed|¿|confirma|quieres|procedo)\b/i.test(t.slice(-400))
}

/**
 * The person's next reply, or null to end the conversation.
 * @param {object} person scenario.person
 * @param {{ turn: number, calls: object[], lastText: string, used: number }} state
 */
export function nextReply(person = {}, { calls = [], lastText = '', used = 0 }) {
  if (Array.isArray(person.replies)) return person.replies[used] ?? null
  const pending = pendingConfirmation(calls)
  if (pending || (asksPerson(lastText) && /confirm|preview|irreversible|cost|proceed|go ahead|merge|integrat|launch|fusion|confirma/i.test(lastText))) {
    const reply = person.decline ?? person.confirm
    return used < (person.maxReplies ?? 3) ? reply ?? null : null
  }
  if (asksPerson(lastText) && person.question) return used < (person.maxReplies ?? 3) ? person.question : null
  return null
}
