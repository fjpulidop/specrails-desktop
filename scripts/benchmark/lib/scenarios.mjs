// Scenario definitions for the live Implement benchmark (JSON or YAML).
//
// {
//   "defaults": { "provider": "claude", "model": "haiku", "timeoutMinutes": 25 },
//   "scenarios": [{
//     "name": "react-filter",               // unique, [a-z0-9-]
//     "repo": "react-vite" | { "template": "node-lib", "name": "x", "files": { "path": "content" } },
//     "repos": ["mr-api", "mr-web"],        // multi-repo run (instead of repo)
//     "ticket": { "title": "...", "description": "..." },
//     "provider": "claude", "model": "haiku",
//     "approvalBeforeArchive": true,        // pause for Approve / Reject before archive
//     "env": { "PATH_PREPEND": "<dir>" },  // informational (the server's env is fixed at start)
//     "answers": [                           // how to answer questions, first match wins
//       { "match": "regex on question text", "asker": "developer", "optionId": "a" },
//       { "kind": "approval", "approve": true } | { "kind": "approval", "reject": "reason" },
//       { "text": "free-text answer" }
//     ],
//     "actions": [{ "when": "phase:build" | "question" | "seconds:60", "do": "restart" | "kill" | "cancel" }],
//     "expect": { "status": "delivered" | "failed" | "stopped" | "declined" | "any", "question": true }
//   }]
// }

export class ScenarioError extends Error {
  constructor(message) { super(message); this.name = 'ScenarioError' }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'kimi'])
const STATUSES = new Set(['delivered', 'failed', 'stopped', 'declined', 'paused', 'any'])
const ACTIONS = new Set(['restart', 'kill', 'cancel'])
const WHEN = /^(question|phase:[a-z0-9-]+|seconds:\d+)$/

/** Parse a scenario file's text. `format` is 'json' or 'yaml'; YAML needs a loader. */
export function parseScenarioText(text, { format = 'json', yamlLoad } = {}) {
  let raw
  try {
    raw = format === 'yaml' ? (yamlLoad ? yamlLoad(text) : missingYaml()) : JSON.parse(text)
  } catch (error) {
    if (error instanceof ScenarioError) throw error
    throw new ScenarioError(`Cannot parse scenarios: ${error.message}`)
  }
  return normalizeScenarios(raw)
}

function missingYaml() { throw new ScenarioError('YAML scenarios need js-yaml; use a .json file') }

/** Validate and fill defaults. Throws a ScenarioError naming the first problem. */
export function normalizeScenarios(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ScenarioError('The scenario file must be an object with a "scenarios" list')
  const defaults = { provider: 'claude', model: 'haiku', timeoutMinutes: 25, ...(raw.defaults ?? {}) }
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) throw new ScenarioError('"scenarios" must be a non-empty list')
  const seen = new Set()
  const scenarios = expandRepeats(raw.scenarios).map((s, i) => {
    const at = `scenarios[${i}]`
    if (!s || typeof s !== 'object') throw new ScenarioError(`${at} must be an object`)
    if (!NAME.test(String(s.name ?? ''))) throw new ScenarioError(`${at}.name must match ${NAME}`)
    if (seen.has(s.name)) throw new ScenarioError(`Duplicate scenario name "${s.name}"`)
    seen.add(s.name)
    const repos = s.repos ?? (s.repo !== undefined ? [s.repo] : [])
    if (!Array.isArray(repos) || repos.length === 0) throw new ScenarioError(`${s.name}: "repo" or "repos" is required`)
    const repoSpecs = repos.map((r, j) => normalizeRepo(r, `${s.name}.repos[${j}]`, s.name, repos.length > 1 ? j : null))
    const ticket = s.ticket
    if (!ticket || typeof ticket.title !== 'string' || !ticket.title.trim()) throw new ScenarioError(`${s.name}: ticket.title is required`)
    if (ticket.description !== undefined && typeof ticket.description !== 'string') throw new ScenarioError(`${s.name}: ticket.description must be text`)
    const provider = s.provider ?? defaults.provider
    if (!PROVIDERS.has(provider)) throw new ScenarioError(`${s.name}: unknown provider "${provider}"`)
    const expect = { status: 'delivered', ...(s.expect ?? {}) }
    if (!STATUSES.has(expect.status)) throw new ScenarioError(`${s.name}: expect.status must be one of ${[...STATUSES].join(', ')}`)
    const answers = (s.answers ?? []).map((a, j) => normalizeAnswer(a, `${s.name}.answers[${j}]`))
    const actions = (s.actions ?? []).map((a, j) => {
      if (!a || !WHEN.test(String(a.when ?? '')) || !ACTIONS.has(a.do)) throw new ScenarioError(`${s.name}.actions[${j}] needs when (question | phase:<id> | seconds:<n>) and do (${[...ACTIONS].join(' | ')})`)
      return { when: a.when, do: a.do, once: a.once !== false }
    })
    const timeoutMinutes = Number(s.timeoutMinutes ?? defaults.timeoutMinutes)
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new ScenarioError(`${s.name}: timeoutMinutes must be positive`)
    return {
      name: s.name, group: s.group ?? 'default', repos: repoSpecs,
      ticket: { title: ticket.title.trim(), description: ticket.description ?? '' },
      provider, model: s.model ?? (provider === defaults.provider ? defaults.model : undefined),
      approvalBeforeArchive: s.approvalBeforeArchive === true, answers, actions, expect, timeoutMinutes,
      runCapUsd: s.runCapUsd ?? defaults.runCapUsd, notes: s.notes ?? '', rail: railOf(s, at), startAtMin: startAtOf(s, at),
    }
  })
  return { defaults, scenarios }
}

/** Soak mode: minutes after the soak starts before this scenario may launch (default 0). */
function startAtOf(s, at) {
  const v = Number(s.startAtMin ?? 0)
  if (!Number.isFinite(v) || v < 0) throw new ScenarioError(`${at}.startAtMin must be a non-negative number`)
  return v
}

/**
 * Soak mode trickle: `repeat: { count, everyMin }` expands one scenario into `count`
 * copies named `<name>-<k>` (k from 1), each with its own repository and
 * `startAtMin` = base + (k - 1) × everyMin. Pure.
 */
export function expandRepeats(list) {
  const out = []
  for (const s of list) {
    if (!s || typeof s !== 'object' || s.repeat === undefined) { out.push(s); continue }
    const count = Number(s.repeat?.count), every = Number(s.repeat?.everyMin ?? 0)
    if (!Number.isInteger(count) || count < 1 || count > 200 || !Number.isFinite(every) || every < 0) throw new ScenarioError(`${s.name}: repeat needs { count: 1..200, everyMin >= 0 }`)
    const { repeat, ...rest } = s
    for (let k = 1; k <= count; k++) {
      const name = `${s.name}-${k}`
      const rename = r => (typeof r === 'string' ? { template: r, name: `${name}-${r}` } : { ...r, name: `${r.name ?? `${s.name}-${r.template}`}-${k}` })
      const repos = s.repos ? s.repos.map(rename) : undefined
      const repo = s.repo !== undefined ? (typeof s.repo === 'string' ? { template: s.repo, name } : { ...s.repo, name: `${s.repo.name ?? s.name}-${k}` }) : undefined
      out.push({ ...rest, name, ...(repos ? { repos } : {}), ...(repo ? { repo } : {}), startAtMin: Number(s.startAtMin ?? 0) + (k - 1) * every })
    }
  }
  return out
}

/** Rail slot of a scenario (0..11); scenarios sharing a repository each take their own. */
function railOf(s, at) {
  if (s.rail === undefined) return 0
  if (!Number.isInteger(s.rail) || s.rail < 0 || s.rail > 11) throw new ScenarioError(`${at}.rail must be an integer from 0 to 11`)
  return s.rail
}

function normalizeRepo(r, at, scenarioName, index) {
  if (typeof r === 'string') return { template: r, name: index === null ? scenarioName : `${scenarioName}-${r}`, files: {} }
  if (!r || typeof r !== 'object' || typeof r.template !== 'string') throw new ScenarioError(`${at} must be a template name or { template, name?, files? }`)
  const name = r.name ?? (index === null ? scenarioName : `${scenarioName}-${r.template}`)
  if (!NAME.test(name)) throw new ScenarioError(`${at}.name must match ${NAME}`)
  const files = r.files ?? {}
  for (const [p, c] of Object.entries(files)) {
    if (typeof c !== 'string' || p.startsWith('/') || p.split(/[\\/]/).includes('..')) throw new ScenarioError(`${at}.files["${p}"] must be a relative path with text content`)
  }
  return { template: r.template, name, files, branch: r.branch ?? 'main' }
}

function normalizeAnswer(a, at) {
  if (!a || typeof a !== 'object') throw new ScenarioError(`${at} must be an object`)
  const kind = a.kind ?? 'question'
  if (!['question', 'approval'].includes(kind)) throw new ScenarioError(`${at}.kind must be question or approval`)
  if (a.match !== undefined) {
    try { new RegExp(a.match, 'i') } catch { throw new ScenarioError(`${at}.match is not a valid regular expression`) }
  }
  const modes = ['optionId', 'text', 'approve', 'reject', 'recommended'].filter(k => a[k] !== undefined)
  if (modes.length !== 1 && !(modes.length === 2 && modes.includes('optionId') && modes.includes('text'))) throw new ScenarioError(`${at} needs exactly one of optionId, text, approve, reject, recommended`)
  if (a.optionId !== undefined && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(a.optionId)) throw new ScenarioError(`${at}.optionId is not a valid option id`)
  const delayMinutes = Number(a.delayMinutes ?? 0)
  if (!Number.isFinite(delayMinutes) || delayMinutes < 0) throw new ScenarioError(`${at}.delayMinutes must be a non-negative number`)
  return { kind, match: a.match, asker: a.asker, optionId: a.optionId, text: a.text, approve: a.approve === true, reject: a.reject, recommended: a.recommended === true, once: a.once !== false, delayMinutes }
}

/**
 * Pick the answer for a pending question card (server `RunQuestion`). Returns
 * the HTTP control body for `POST /jobs/:id/messages`, or null when no rule matches.
 * `used` is the set of answer indexes already consumed (once-only rules).
 */
export function chooseAnswer(question, answers, used = new Set()) {
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i]
    if (a.once && used.has(i)) continue
    if (a.kind !== (question.kind ?? 'question')) continue
    if (a.asker && a.asker !== question.asker) continue
    if (a.match && !new RegExp(a.match, 'i').test(`${question.text ?? ''}\n${question.why ?? ''}\n${question.detail ?? ''}`)) continue
    const interruptId = question.interruptId
    const optionIds = (question.options ?? []).map(o => o.id)
    const delayMs = (a.delayMinutes ?? 0) * 60_000
    if (a.approve) return { index: i, delayMs, body: { text: '', interruptId, approve: true } }
    if (a.reject !== undefined) return { index: i, delayMs, body: { text: String(a.reject), interruptId, reject: true } }
    if (a.recommended) {
      const id = question.recommended ?? optionIds[0]
      if (!id) continue
      return { index: i, delayMs, body: { text: labelOf(question, id), interruptId, optionId: id } }
    }
    if (a.optionId) {
      if (!optionIds.includes(a.optionId)) continue
      return { index: i, delayMs, body: { text: a.text ?? labelOf(question, a.optionId), interruptId, optionId: a.optionId } }
    }
    return { index: i, delayMs, body: { text: String(a.text), interruptId } }
  }
  return null
}

function labelOf(question, id) {
  const o = (question.options ?? []).find(x => x.id === id)
  return o ? [o.label, o.meaning].filter(Boolean).join(' — ') : id
}
