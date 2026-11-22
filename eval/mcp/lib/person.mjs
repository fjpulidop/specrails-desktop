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
    // A dry run that came back with a confirmToken is a preview waiting for the person's yes too.
    const dryPreview = c.ok && c.args?.dryRun === true && typeof c.envelope?.data?.confirmToken === 'string'
    if (c.code === 'confirmation_required' || c.code === 'stale' || dryPreview) pending = { tool: c.tool, action: c.args?.action, decision: c.args?.decision ?? null }
    else if (pending && c.ok && c.tool === pending.tool && c.args?.action === pending.action && c.args?.confirm) pending = null
  }
  return pending
}

/** Does the agent's last message ask the person something? */
export function asksPerson(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  const tail = t.slice(-400)
  return /\?\s*$/.test(t) || /\b(confirm|shall I|should I|do you want|would you like|go[- ]ahead|proceed|let me know|tell me (if|whether|to)|say (yes|so|the word)|¿|confirma|quieres|procedo|dime si|avísame)\b|¿/i.test(tail)
    // "I need your go-ahead first" may open the message rather than close it.
    || /\b(need|want|wait for|waiting for|with) (your|an?) (explicit )?(go[- ]ahead|approval|confirmation|ok|okay|yes|answer|decision)\b/i.test(t)
    || /\b(necesito|espero) (tu|su) (confirmación|aprobación|visto bueno|respuesta)\b/i.test(tail)
}

/**
 * The person's next reply, or null to end the conversation.
 * @param {object} person scenario.person
 * @param {{ turn: number, calls: object[], lastText: string, used: number }} state
 */
export function nextReply(person = {}, { calls = [], lastText = '', used = 0 }) {
  if (Array.isArray(person.replies)) return person.replies[used] ?? null
  const pending = pendingConfirmation(calls)
  if (pending || (asksPerson(lastText) && /confirm|preview|irreversible|cost|proceed|go[- ]ahead|approv|merge|integrat|launch|switch|discard|resume|fusion|confirma|aprob/i.test(lastText))) {
    const reply = person.decline ?? person.confirm
    return used < (person.maxReplies ?? 3) ? reply ?? null : null
  }
  if (asksPerson(lastText) && person.question) return used < (person.maxReplies ?? 3) ? person.question : null
  return null
}
