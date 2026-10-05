import { stripVTControlCharacters } from 'node:util'

type Event = Record<string, unknown>
interface Stream {
  scope: string
  attemptId?: string
  prefix: string
  tap: boolean
  failed: boolean
  yaml: boolean
  inputLines: number | null
  inputShortened: boolean
  headLines: number
  headChars: number
  shown: Set<string>
  diagnostics: string[][]
  summaries: Map<string, string>
  tail: string[]
  previous: string[]
  context: number
  omitted: number
  announced: boolean
}
const object = (value: unknown): value is Event => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const display = (value: string, limit = 512): string => stripVTControlCharacters(value).replace(/[\r\n]/g, ' ').slice(0, limit)
const attemptId = (event: Event): string | undefined => typeof event.attemptId === 'string' && event.attemptId.length <= 256 && event.attemptId.trim() ? event.attemptId : undefined
export interface VerificationLogLine { text: string; attemptId?: string }
const output = (value: string, id?: string): VerificationLogLine => ({ text: value, ...(id ? { attemptId: id } : {}) })
const scope = (event: Event): string => JSON.stringify([event.runId, event.scopeId, event.nodePath, event.attemptId, event.attempt, event.visit]
  .map(value => typeof value === 'string' && value.length <= 512 || typeof value === 'number' && Number.isSafeInteger(value) ? value : null))
const reference = 'Details → Verification evidence (stdout/stderr; retained evidence may be truncated)'
const shortPrefix = (value: string): string => value.length > 96 ? value.slice(0, 92) + '…] ' : value

/** This is presentation only. Neither its heuristics nor check progress can
 * certify a candidate; original runtime events and command evidence are untouched. */
export function createVerificationLogProjection() {
  const streams = new Map<string, Stream>()
  const active = new Map<string, string>()
  let overflow = false
  const binding = (event: Event, repository: string): string => JSON.stringify([scope(event), repository])
  function get(key: string, event: Event, prefix: string): Stream | undefined {
    let state = streams.get(key)
    if (!state && streams.size < 64) {
      state = { scope: scope(event), attemptId: attemptId(event), prefix: shortPrefix(prefix), tap: false, failed: false, yaml: false, inputLines: null, inputShortened: false,
        headLines: 0, headChars: 0, shown: new Set(), diagnostics: [[], [], [], []], summaries: new Map(), tail: [], previous: [], context: 0, omitted: 0, announced: false }
      streams.set(key, state)
    }
    return state
  }
  function omitted(state: Stream): string {
    state.omitted++
    if (state.announced) return ''
    state.announced = true
    return state.prefix + '[Verbose output omitted; ' + reference + ']\n'
  }
  function diagnostic(state: Stream, line: string, priority: number): void {
    const bounded = line.slice(0, priority === 3 ? 256 : 512), bucket = state.diagnostics[priority]
    if (state.shown.has(line) || bucket.includes(bounded)) return
    // First fact plus three recent facts in each class; warnings cannot consume
    // the compiler/assertion budget, and later failures remain represented.
    if (bucket.length === (priority === 3 ? 2 : 4)) bucket.splice(1, 1)
    bucket.push(bounded)
  }
  function priority(body: string): number | undefined {
    if (/^(?!['"`]|(?:actual|expected|source):).+(?:\(\d+,\d+\)|:\d+(?::\d+)?)(?::|\s+-)?\s+(?:fatal\s+)?error\b/i.test(body)
      || /^(?:fatal\s+)?error\s+[A-Z]+\d+\s*:/.test(body)
      || /^(?:AssertionError|TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(body)) return 0
    if (/^(?:FAIL\s|not ok \d+\b|[✖✗]\s|(?:fatal\s+)?error(?:\s*\[[^\]]+\])?\s*:)/i.test(body)
      && !/\b0 errors?\b/i.test(body)) return 1
    if (/^(?:expected|actual|operator|test at|location)\s*[: ]/i.test(body)) return 2
    return undefined
  }
  function summary(body: string): string | undefined {
    if (/^Ran all test suites[.\s]*$/.test(body)) return 'ran'
    const match = body.match(/^(Test Suites|Test Files|Tests|Snapshots|Time|Duration|Ran all test suites)\s*:?\s/i)
      ?? body.match(/^(?:#|ℹ)\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms|duration)\b/i)
    return match?.[1].toLowerCase()
  }
  function line(state: Stream, original: string, body: string): string {
    let value = original
    if (/AssertionError\b.*\bInput:\s*$/.test(body)) state.inputLines = 0
    else if (state.inputLines !== null) {
      if (/^["'`]/.test(body)) {
        state.inputLines++
        if (state.inputLines > 2) {
          if (state.inputShortened) return ''
          state.inputShortened = true
          return state.prefix + '[Assertion input shortened; inspect raw evidence]\n'
        }
      } else if (!body) return ''
      else state.inputLines = null
    }
    if (/^[✔✓]\s/.test(body)) return ''
    if (/^PASS\s/.test(body)) return omitted(state)
    if (/^[✖✗]\s/.test(body)) state.failed = true
    if (/^TAP version |^# Subtest:/.test(body)) { state.tap = true; return '' }
    if (/^(?:not )?ok \d+\b/.test(body)) { state.tap = true; state.failed = body.startsWith('not ok'); state.yaml = false; if (!state.failed) return '' }
    if (state.tap) {
      if (body === '---') { state.yaml = true; if (!state.failed) return '' }
      if (body === '...') { state.yaml = false; if (!state.failed) return '' }
      if (state.yaml && !state.failed) return ''
      if (/^1\.\.\d+$/.test(body)) return ''
    }
    if (!body) return ''
    if (value.length > 2_000) value = value.slice(0, 1_900) + '\n[Long diagnostic line shortened; inspect raw evidence]'
    const total = summary(body)
    if (total) {
      // Known totals have a fixed key set, so repeated progress updates do not
      // become another unbounded stream or evict diagnostics.
      state.summaries.set(total, state.prefix + body.slice(0, 128))
      return ''
    }
    const rank = priority(body.slice(0, 2_000))
    if (state.headLines < 24 && state.headChars + value.length <= 3_500) {
      state.headLines++; state.headChars += value.length; state.shown.add(value)
      state.previous.push(value); if (state.previous.length > 2) state.previous.shift()
      return value + '\n'
    }
    if (rank !== undefined) {
      if (rank < 2) {
        for (const preceding of state.previous) diagnostic(state, preceding, 3)
        state.context = 3
      }
      diagnostic(state, value, rank)
    } else if (state.context > 0) { diagnostic(state, value, 3); state.context-- }
    state.previous.push(value); if (state.previous.length > 2) state.previous.shift()
    state.tail.push(value.slice(0, 256)); if (state.tail.length > 6) state.tail.shift()
    return omitted(state)
  }
  function flush(key?: string): VerificationLogLine[] {
    const result: VerificationLogLine[] = []
    for (const [id, state] of streams) {
      if (key !== undefined && id !== key) continue
      let content = ''
      const pending = [...state.diagnostics.flat(), ...state.tail, ...state.summaries.values()]
      const seen = new Set(state.shown)
      for (const value of pending) if (!seen.has(value)) { seen.add(value); content += value + '\n' }
      if (state.omitted) content += state.prefix + `[${state.omitted} output lines compacted; ${reference}]\n`
      if (content) result.push(output(content, state.attemptId))
      streams.delete(id)
      for (const [name, activeId] of active) if (activeId === id) active.delete(name)
    }
    return result
  }
  function project(event: Event): VerificationLogLine[] {
    if (event.type === 'verification-output' && typeof event.text === 'string') {
      const result: VerificationLogLine[] = []
      for (const value of stripVTControlCharacters(event.text).split('\n')) {
        if (!value) continue
        const match = value.match(/^(\[verification ([^/\]]+)\/[^\]]+\] )?(.*)$/)
        const prefix = match?.[1] ?? '', repository = match?.[2] ?? '', body = (match?.[3] ?? value).trim()
        const key = active.get(binding(event, repository)) ?? JSON.stringify([scope(event), prefix.slice(0, 1024)])
        const state = get(key, event, prefix)
        if (state) {
          const content = line(state, shortPrefix(prefix) + (match?.[3] ?? value), body)
          if (content) result.push(output(content, state.attemptId))
        } else if (!overflow) { overflow = true; result.push(output(`[Additional verification output omitted; ${reference}]\n`, attemptId(event))) }
      }
      return result
    }
    if (event.type === 'runtime-efficiency-event') {
      const data = object(event.payload) ? { ...event, ...event.payload } : event
      const kind = text(data.kind), id = text(data.executionId), repository = text(data.repositoryId), label = text(data.label)
      if (!['check-started', 'check-finished', 'check-reused', 'check-invalidated'].includes(kind) || !id || id.length > 256 || !repository || repository.length > 256 || !label || label.length > 4096) return []
      const prefix = `[verification ${display(repository)}/${display(label)}] `
      const key = JSON.stringify([scope(data), id]), name = binding(data, repository)
      if (kind === 'check-started') {
        if (active.get(name) === key) return []
        const result = active.has(name) ? flush(active.get(name)) : []
        if (get(key, data, prefix)) active.set(name, key)
        result.push(output(prefix + 'started\n', attemptId(data)))
        return result
      }
      if (kind === 'check-invalidated') return [output(prefix + 'evidence invalidated' + (typeof data.reason === 'string' ? ': ' + display(data.reason) : '') + '\n', attemptId(data))]
      if (!Number.isSafeInteger(data.exitCode) || typeof data.durationMs !== 'number' || !Number.isFinite(data.durationMs) || data.durationMs < 0) return []
      const result = flush(key)
      return [...result, output(prefix + `${kind === 'check-reused' ? 'reused' : data.exitCode === 0 ? 'command passed' : 'command failed'} (exit ${data.exitCode}, ${(data.durationMs / 1000).toFixed(1)} s)\n`, attemptId(data))]
    }
    if (event.type === 'runtime-result') return flush()
    if (event.type === 'workflow-event' && object(event.event)) {
      const data = event.event, kind = text(data.type)
      if (/^workflow_(?:succeeded|failed|cancelled|paused)$/.test(kind)) return flush()
      if (!/^step_(?:started|succeeded|failed|cancelled|interrupted)$/.test(kind)) return []
      const result: VerificationLogLine[] = []
      for (const [key, state] of streams) {
        const identity = JSON.parse(state.scope) as Array<string | number | null>
        // Older transports lack attempt identity. Flush them before a phase
        // boundary; v2 flushes only the ending attempt, leaving siblings intact.
        const legacy = identity[2] === null && identity[3] === null
        const sameAttempt = typeof data.attemptId === 'string' && identity[3] === data.attemptId
        const sameNode = !data.attemptId && (data.nodePath ?? data.stepId) === identity[2] && (!data.scopeId || data.scopeId === identity[1])
        if (legacy || (kind !== 'step_started' && (sameAttempt || sameNode))) result.push(...flush(key))
      }
      return result
    }
    return []
  }
  return { project, flush }
}
