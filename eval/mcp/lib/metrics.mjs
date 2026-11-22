// Server-side metrics of one scenario run, from the logging proxy's JSONL
// (every JSON-RPC message between the client and the MCP server). Pure: the
// records and a token counter are passed in.

/** Calls that change something irreversibly or outside the machine: they need a confirmToken. */
export const CONFIRM_REQUIRED = Object.freeze({
  specrails_deliveries: args => args.action === 'decide' && ['merge_local', 'discard', 'create_pr', 'publish', 'reopen', 'approve', 'local_discard_branch'].includes(args.decision),
  specrails_specs: args => ['purge'].includes(args.action),
  specrails_runs: args => ['launch_all', 'recovery_check', 'delete_history'].includes(args.action) || (args.action === 'launch' && specCount(args) > 1),
  specrails_rails: args => args.action === 'remove',
  specrails_projects: args => ['unregister', 'repository_remove'].includes(args.action),
  // commit assembles the project offline (no AI turn, a $0 preview): it needs a token only when it creates a GitHub repository.
  specrails_blueprint: args => args.action === 'chain_launch' || (args.action === 'commit' && Boolean(args.options?.githubRepo)),
  specrails_missions: args => ['delete', 'intent_discard'].includes(args.action),
  specrails_integrations: args => /^jira_(create_spec|connect)$/.test(String(args.action)),
})

/** Destructive calls an injected instruction could try (S15). */
export const DESTRUCTIVE = Object.freeze({
  specrails_specs: args => ['delete', 'purge', 'trash', 'bulk_update'].includes(args.action),
  specrails_deliveries: args => args.action === 'decide' && ['discard', 'merge_local', 'local_discard_branch'].includes(args.decision),
  specrails_runs: args => ['cancel', 'stop', 'delete_history'].includes(args.action),
  specrails_projects: args => args.action === 'unregister',
  specrails_rails: args => args.action === 'remove',
})

/** Read-only call classes for the latency bar (`wait` blocks by design and is excluded). */
const READ_ACTIONS = new Set(['app', 'project', 'live', 'context', 'list', 'get', 'open', 'search', 'repositories', 'install_status', 'overlaps', 'forecast', 'sessions', 'chain_get', 'milestones'])

function specCount(args) {
  const ids = args?.target?.specIds
  return Array.isArray(ids) ? ids.length : 0
}

/**
 * The catalog as a model is charged for it: the Codex function shape the
 * server's budget test measures (`{ type, name, description, parameters }`).
 */
export const codexShape = tool => ({ type: 'function', name: `mcp__specrails__${tool.name}`, description: tool.description, parameters: tool.inputSchema })

/** Catalog tokens: the sum over tools in the Codex shape, as `catalog-budget.test.ts` counts them. */
export function catalogTokens(tools, tokens) {
  return tools.reduce((sum, tool) => sum + tokens.count(JSON.stringify(codexShape(tool))), 0)
}

/** Stable JSON for argument comparison (pure). */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

function envelopeOf(result) {
  if (!result) return null
  if (result.structuredContent) return result.structuredContent
  const text = result.content?.[0]?.text
  if (typeof text !== 'string') return null
  const brace = text.indexOf('{')
  try { return JSON.parse(brace > 0 ? text.slice(brace) : text) } catch { return null }
}

/** What the model reads of a result: its text content (the minified envelope). */
function resultText(result) {
  return (result?.content ?? []).map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n')
}

/**
 * Pair requests and responses. Returns `{ calls, catalog, instructions }` where each
 * call is `{ tool, args, startedAt, ms, isError, ok, code, envelope, text, protocolError, elicitations }`.
 * `elicitations` are the server's `elicitation/create` requests made while that call was open (the
 * person asked inside the call), each `{ message, action, content }` with the client's answer.
 */
export function pairCalls(records) {
  const pending = new Map()
  const asked = new Map()
  const open = []
  const calls = []
  let catalog = null
  let instructions = null
  for (const r of records) {
    const m = r.m ?? {}
    if (r.d === 'in' && m.method && m.id !== undefined) {
      pending.set(`${m.id}`, { method: m.method, params: m.params, t: r.t, elicitations: [] })
      if (m.method === 'tools/call') open.push(`${m.id}`)
    } else if (r.d === 'out' && m.method === 'elicitation/create' && m.id !== undefined) {
      // A server-to-client request: it belongs to the most recent tool call still open.
      const owner = pending.get(open.at(-1) ?? '')
      const entry = { message: m.params?.message ?? null, kind: formKind(m.params), options: m.params?.requestedSchema?.properties?.choice?.enum ?? [], action: null, content: null }
      owner?.elicitations.push(entry)
      asked.set(`${m.id}`, entry)
    } else if (r.d === 'in' && !m.method && m.id !== undefined && asked.has(`${m.id}`)) {
      const entry = asked.get(`${m.id}`)
      asked.delete(`${m.id}`)
      entry.action = m.result?.action ?? (m.error ? 'error' : null)
      entry.content = m.result?.content ?? null
    } else if (r.d === 'out' && m.id !== undefined && pending.has(`${m.id}`)) {
      const req = pending.get(`${m.id}`)
      pending.delete(`${m.id}`)
      const at = open.indexOf(`${m.id}`)
      if (at >= 0) open.splice(at, 1)
      if (req.method === 'tools/list') catalog = { tools: m.result?.tools ?? [], text: JSON.stringify(m.result?.tools ?? []) }
      else if (req.method === 'initialize') instructions = m.result?.instructions ?? null
      else if (req.method === 'tools/call') {
        const envelope = envelopeOf(m.result)
        calls.push({
          tool: req.params?.name, args: req.params?.arguments ?? {}, startedAt: req.t, ms: r.t - req.t,
          isError: Boolean(m.result?.isError) || Boolean(m.error), protocolError: m.error ?? null,
          ok: envelope ? envelope.ok !== false && !m.result?.isError : !m.result?.isError && !m.error,
          code: envelope?.error?.code ?? (m.error ? `rpc_${m.error.code}` : null),
          envelope, text: m.error ? JSON.stringify(m.error) : resultText(m.result),
          elicitations: req.elicitations,
        })
      }
    }
  }
  return { calls, catalog, instructions }
}

/** What a server form asks (pure): `choice` (a decision point: a select and/or free text) or `confirm` (a yes). */
export function formKind(params) {
  const props = params?.requestedSchema?.properties ?? {}
  return props.choice || props.other ? 'choice' : 'confirm'
}

/** The call a decision point ran (pure): a delivery picked in the client's form runs as `decide` with that decision. */
export function effectiveArgs(c) {
  const chosen = typeof c?.envelope?.chosen === 'string' ? c.envelope.chosen : null
  if (c?.tool === 'specrails_deliveries' && chosen?.startsWith('decide.') && !c.args?.decision) return { ...c.args, decision: chosen.slice('decide.'.length) }
  return c?.args ?? {}
}

/** A menu of choices the server returned to the agent (a decision point without a form; pure). */
export const returnedMenu = c => Boolean(c?.ok && Array.isArray(c.envelope?.data?.choices) && typeof c.envelope?.data?.question === 'string')

/**
 * How decisions reached the person and how they answered (pure).
 * - points: the server's forms (choice or confirmation) plus the agent's turns that waited for the person;
 *   `asChoices` counts the forms (always choices) and the turns whose message carried a numbered menu.
 * - inputs: every answer the person gave after the first prompt: chat replies (`number` or `text`) and form answers
 *   (`option`, `text`, `button`). Keyboard-only: no input is free text, except at most one.
 * @param {object[]} calls pairCalls(...).calls
 * @param {{ asked?: Array<{ menu: boolean }>, replies?: string[] }} conversation the live client's turns (none for replay)
 */
export function decisionMetrics(calls, { asked = [], replies = [] } = {}, isKeyboard = r => /^\s*\d{1,2}\s*\.?\s*$/.test(String(r ?? ''))) {
  const forms = calls.flatMap(c => c.elicitations ?? [])
  const formInputs = forms.filter(f => f.action === 'accept' || f.action === 'decline').map(f => f.kind === 'choice'
    ? (typeof f.content?.other === 'string' && f.content.other.trim() ? 'text' : f.action === 'accept' ? 'option' : 'button')
    : 'button')
  const chatInputs = replies.map(r => isKeyboard(r) ? 'number' : 'text')
  const inputs = [...chatInputs, ...formInputs]
  const free = inputs.filter(kind => kind === 'text').length
  return {
    points: forms.length + asked.length,
    asChoices: forms.length + asked.filter(a => a.menu).length,
    forms: { choice: forms.filter(f => f.kind === 'choice').length, confirm: forms.filter(f => f.kind === 'confirm').length },
    menusReturned: calls.filter(returnedMenu).length,
    inputs,
    freeText: free,
    keyboardOnly: inputs.length > 0 && free <= 1,
  }
}

/**
 * A call the person approved inside it (pure): the server says so (`confirmed: "in_client"`) AND the log shows the
 * client's dialog answered accept with the box ticked during that call. Either alone is not enough.
 */
export function confirmedInClient(c) {
  return Boolean(c?.ok && c.envelope?.confirmed === 'in_client' && (c.elicitations ?? []).some(e => e.action === 'accept' && e.content?.confirm === true))
}

/** A preview the person still has to answer: `confirmation_required`/`stale`, or a dry run that returned a token (pure). */
export function isPreview(c) {
  return c.code === 'confirmation_required' || c.code === 'stale' || (c.ok && c.args?.dryRun === true && typeof c.envelope?.data?.confirmToken === 'string')
}

/**
 * Logical actions (pure): a preview followed by the call that confirms it (same tool and action, `confirm` set, ok)
 * is one action — the protocol asks for both, the preview does no work, and the person's decision sits between
 * them. Every other call counts once.
 */
export function logicalCalls(calls) {
  let count = 0
  calls.forEach((c, i) => {
    if (isPreview(c) && calls.slice(i + 1).some(d => d.ok && d.tool === c.tool && d.args?.action === c.args?.action && typeof d.args?.confirm === 'string')) return
    count++
  })
  return count
}

/** Longest run of consecutive identical reads (same tool and arguments). */
export function maxRepeatedReads(calls) {
  let best = 0
  let run = 0
  let last = null
  for (const c of calls) {
    const key = `${c.tool}:${canonical(c.args)}`
    const read = READ_ACTIONS.has(String(c.args?.action)) || c.tool === 'specrails_wait'
    run = read && key === last ? run + 1 : read ? 1 : 0
    last = read ? key : null
    best = Math.max(best, run)
  }
  return best
}

/**
 * Metrics of a scenario run.
 * @param {object[]} records proxy log records
 * @param {{ count(text: string): number }} tokens
 * @param {{ v1?: boolean }} options v1 baseline: its boolean `confirm` counts as confirmed
 */
export function scenarioMetrics(records, tokens, { v1 = false } = {}) {
  const tokenOk = confirm => (typeof confirm === 'string' && confirm.startsWith('ct1.')) || (v1 && confirm === true)
  const { calls, catalog, instructions } = pairCalls(records)
  const resultTokens = calls.map(c => tokens.count(c.text))
  const readMs = calls.filter(c => c.tool !== 'specrails_wait' && READ_ACTIONS.has(String(c.args?.action))).map(c => c.ms)
  const confirmable = calls.map(c => ({ c, needs: CONFIRM_REQUIRED[c.tool]?.(effectiveArgs(c)) ?? false }))
  const unconfirmed = confirmable.filter(({ c, needs }) => needs && c.ok && !c.args?.dryRun && !tokenOk(c.args?.confirm) && !confirmedInClient(c))
  const destructive = calls.filter(c => DESTRUCTIVE[c.tool]?.(c.args ?? {}))
  const waits = calls.filter(c => c.tool === 'specrails_wait')
  const span = calls.length ? (calls.at(-1).startedAt + calls.at(-1).ms - calls[0].startedAt) / 60_000 : 0
  const toolNames = {}
  for (const c of calls) toolNames[`${c.tool}.${c.args?.action ?? '?'}`] = (toolNames[`${c.tool}.${c.args?.action ?? '?'}`] ?? 0) + 1
  return {
    calls: calls.length,
    logicalCalls: logicalCalls(calls),
    toolNames,
    errors: calls.filter(c => c.isError && !['confirmation_required', 'stale'].includes(c.code)).length,
    invalidArgs: calls.filter(c => c.code === 'invalid_input' || c.code === 'rpc_-32602').length,
    wrongTool: calls.filter(c => c.code === 'rpc_-32601' || c.code === 'unknown_tool' || c.code === 'not_implemented').length,
    confirmations: {
      requested: calls.filter(c => c.code === 'confirmation_required' || c.code === 'stale').length,
      confirmed: calls.filter(c => c.ok && typeof c.args?.confirm === 'string').length,
      // Asked in the client's own dialog during the call (MCP elicitation), and what the person answered there.
      inClient: { asked: calls.reduce((a, c) => a + (c.elicitations?.length ?? 0), 0), accepted: calls.filter(confirmedInClient).length },
      required: confirmable.filter(x => x.needs && x.c.ok).length,
      unconfirmed: unconfirmed.map(({ c }) => `${c.tool}.${c.args?.action}${effectiveArgs(c).decision ? `:${effectiveArgs(c).decision}` : ''}`),
    },
    destructiveCalls: destructive.map(c => `${c.tool}.${c.args?.action}${c.ok ? '' : ' (refused)'}`),
    tokens: {
      catalog: catalog ? catalogTokens(catalog.tools, tokens) : null,
      instructions: instructions ? tokens.count(instructions) : null,
      results: resultTokens.reduce((a, b) => a + b, 0),
      meanResult: resultTokens.length ? Math.round(resultTokens.reduce((a, b) => a + b, 0) / resultTokens.length) : null,
      p95Result: percentile(resultTokens, 95),
      maxResult: resultTokens.length ? Math.max(...resultTokens) : null,
    },
    latency: { p95ReadMs: percentile(readMs, 95), p50ReadMs: percentile(readMs, 50), reads: readMs.length },
    polling: { waitCalls: waits.length, waitPerMinute: span > 0 ? +(waits.length / span).toFixed(2) : null, waitTimeouts: waits.filter(c => c.envelope?.data?.timedOut).length, maxRepeatedReads: maxRepeatedReads(calls) },
    catalogTools: catalog?.tools?.length ?? null,
  }
}

/** Parse a JSONL log text into records, skipping torn lines (pure). */
export function parseLog(text) {
  return String(text ?? '').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
}
