// The simulated person: scripted replies to the agent between turns, and answers to the server's forms (pure).
//
// The person answers from the keyboard: when the agent shows a menu they reply with its number; in a form they
// pick an option id. Free text only where the scenario needs it (`freeText`), at most once.
//
// A scenario's `person` is `{ confirm?, decline?, question?, pick?, freeText?, replies? }`:
//   confirm   what the person says to a preview that needs a yes when the agent shows no menu
//   decline   said instead of `confirm` (the person refuses); in a menu they pick its "no" item
//   question  what the person says when the agent asks something else without a menu (free text)
//   pick      RegExp of the option they want (matched against a menu item, or a form choice id and title)
//   freeText  their own words where no option fits (a request for changes, an answer to a Builder question)
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
    || menuOf(t).length >= 2
}

/**
 * The numbered menu at the end of a message: `1. …` / `1) …` / `**1.** …` / `1 — …` lines (pure). Returns the
 * last block of consecutive numbers starting at 1, as `[{ n, text }]`; fewer than two items is no menu. A numbered
 * list followed by more than two lines of prose is a summary, not the choices the message ends with.
 */
export function menuOf(text) {
  const items = []
  let after = 0
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(?:[-*]\s*)?(?:\*\*|__)?\(?(\d{1,2})(?:[.)]|\s*[—–-])(?:\*\*|__)?\s+(.+)$/.exec(line)
    if (!m) { if (line.trim() && items.length) after++; continue }
    const n = Number(m[1])
    if (n === 1) items.length = 0
    if (n === items.length + 1) { items.push({ n, text: m[2].replace(/[*_`]/g, '').trim() }); after = 0 }
  }
  return items.length >= 2 && after <= 2 ? items : []
}

const YES = /\b(yes|s[ií]|go ahead|adelante|confirm\w*|proceed|procede|do it|hazlo|apply|integr\w*|merge|fusion\w*|launch|lanza\w*|switch|cambia\w*|resume|reanud\w*|continu\w*|send|env[ií]a\w*|start|empez\w*|discard|descart\w*|hand.?off|pasa\w*)\b/i
const NO = /^(no\b|not now|ahora no|cancel|leave|déjalo|nothing|nada)|\b(don'?t|do not|no hagas)\b/i
const OTHER = /something else|otra cosa|write (it|your)|escr[ií]bel[ao]|your own words|tus palabras/i

/** The menu item the person wants (pure): their pick, else yes/no for a preview, else the recommended (first) one. */
export function pickFromMenu(menu, person = {}, { confirming = false } = {}) {
  const real = menu.filter(item => !OTHER.test(item.text))
  if (!real.length) return null
  if (person.decline && confirming) return (real.find(item => NO.test(item.text)) ?? null)?.n ?? null
  if (person.pick) {
    const hit = real.find(item => person.pick.test(item.text))
    if (hit) return hit.n
  }
  if (confirming) return (real.find(item => YES.test(item.text) && !NO.test(item.text)) ?? real[0]).n
  return real[0].n
}

/**
 * The person's next reply, or null to end the conversation. `used` is how many replies they gave, `wrote` how many
 * of those were free text (the keyboard-only bar allows one).
 * @param {object} person scenario.person
 * @param {{ calls: object[], lastText: string, used: number, wrote?: number }} state
 */
export function nextReply(person = {}, { calls = [], lastText = '', used = 0, wrote = 0 }) {
  if (Array.isArray(person.replies)) return person.replies[used] ?? null
  if (used >= (person.maxReplies ?? 3)) return null
  const pending = pendingConfirmation(calls)
  const confirming = Boolean(pending) || (asksPerson(lastText) && /confirm|preview|irreversible|cost|proceed|go[- ]ahead|approv|merge|integrat|launch|switch|discard|resume|fusion|confirma|aprob/i.test(lastText))
  const menu = menuOf(lastText)
  // Their own words where the scenario needs them (once), when no option of the menu is what they want.
  const own = person.freeText && !wrote && !(person.pick && menu.some(item => person.pick.test(item.text))) && !confirming ? person.freeText : null
  if (menu.length) {
    if (own) return own
    const n = pickFromMenu(menu, person, { confirming })
    if (n !== null) return String(n)
    return person.decline ?? null
  }
  if (confirming) return person.decline ?? person.confirm ?? null
  if (asksPerson(lastText)) return own ?? person.question ?? null
  return null
}

/** Keyboard input (pure): a menu number, an option id or a yes/no button, not free text. */
export const isKeyboardReply = reply => /^\s*\d{1,2}\s*\.?\s*$/.test(String(reply ?? ''))

/**
 * The person's answer to one of the server's forms (MCP elicitation params; pure). A choice form: the option
 * matching `pick` (id or title), else their free text when they have some and no option fits, else the
 * recommended (default) one. A confirmation: `confirm` (accept | decline | cancel; default cancel, so the
 * chat-token flow runs).
 */
export function formAnswer(person = {}, params = {}, { confirm = 'cancel' } = {}) {
  const props = params.requestedSchema?.properties ?? {}
  if (props.choice || props.other) {
    const ids = props.choice?.enum ?? []
    const titles = props.choice?.enumNames ?? ids
    const hit = person.pick ? ids.findIndex((id, i) => person.pick.test(id) || person.pick.test(String(titles[i] ?? ''))) : -1
    if (hit >= 0) return { action: 'accept', content: { choice: ids[hit] } }
    if (person.freeText && props.other) return { action: 'accept', content: { other: person.freeText } }
    if (ids.length) return { action: 'accept', content: { choice: props.choice.default ?? ids[0] } }
    return { action: 'cancel' }
  }
  if (confirm === 'accept') return { action: 'accept', content: { confirm: true } }
  return { action: confirm === 'decline' ? 'decline' : 'cancel' }
}
