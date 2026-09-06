import type { WsMessage } from '../types'
import { getMobileEventBus } from './mobile-event-bus'
import { redact } from './mobile-redact'

// The gateway's WS fan-out. Subscribes ONCE to the in-process event bus and
// pushes a mobile-shaped, redacted, per-subscription-filtered stream to each
// attached socket. The raw /ws firehose (stream-json payloads, 256 KB
// scrollbacks) is never forwarded verbatim.

const OPEN = 1
const INBOUND_MAX_BYTES = 4096
const INBOUND_MAX_PER_MIN = 30
const HEARTBEAT_MS = 30_000
const LOG_FLUSH_MS = 250
const LOG_LINE_MAX = 2048
const LOG_BATCH_MAX = 60

/** Minimal structural view of a ws.WebSocket (so tests can pass a stub). */
export interface SocketLike {
  readyState: number
  send(data: string): void
  on(event: string, cb: (...args: unknown[]) => void): void
  ping(): void
  terminate(): void
  close(code?: number, reason?: string): void
}

interface SockState {
  ws: SocketLike
  deviceId: string
  projects: Set<string>
  topics: Set<string>
  watchedJob: { projectId: string; jobId: string } | null
  inbound: number[]
  alive: boolean
  logBuf: Map<string, string[]>
  logDropped: Map<string, number>
}

// The topic NAME 'hub' is part of the mobile wire contract (the phone
// subscribes to it) — mobile-app v1 wire compat, do not rename the topic.
type TopicName = 'queue' | 'phase' | 'tickets' | 'rails' | 'spending' | 'activity' | 'alerts' | 'chat' | 'missions'

function topicFor(type: string): TopicName | 'jobtail' | 'hub' | null {
  switch (type) {
    case 'agent_stream': case 'agent_done': case 'agent_partial': case 'agent_error': case 'agent_title':
    case 'agent_tool': case 'agent_tool_result': case 'agent_queued': case 'agent_dequeued': case 'agent_steered':
    case 'agent_queue_edited': case 'agent_queue_removed': case 'agent_queue_cleared': case 'agent_input_receipt':
    case 'agent_pr_decision': case 'background_process.started': case 'background_process.updated': case 'background_process.exited': return 'missions'
    case 'queue': return 'queue'
    case 'phase': return 'phase'
    case 'ticket_created':
    case 'ticket_updated':
    case 'ticket_deleted':
    case 'spec_gen_stream':
    case 'spec_gen_done':
    case 'spec_gen_error': return 'tickets'
    case 'rail.job_started':
    case 'rail.job_stopped':
    case 'rail.job_completed':
    case 'rail.updated':
    // Dynamic rails: a deleted rail slot. Same frozen-safe reasoning as the
    // loop.run_* family below — an old v1 client ignores the unknown type,
    // a new client drops the slot from its mirror.
    case 'rail.removed':
    // rails-as-loops: loop runs (no queue job) report their lifecycle via the
    // loop.run_* family. Map them onto the EXISTING 'rails' topic (frozen-safe —
    // the companion's subscribe set is unchanged; an old v1 client ignores the
    // unknown `loop.run_*` types harmlessly, a new client mirrors the run).
    case 'loop.run_started':
    case 'loop.run_progress':
    case 'loop.run_stopped':
    case 'loop.run_completed': return 'rails'
    case 'spending.invalidated': return 'spending'
    case 'chat_stream':
    case 'chat_done':
    case 'chat_error':
    case 'chat_title_update':
    case 'chat_command_proposal':
    case 'spec_draft.update': return 'chat'
    case 'cost_alert':
    case 'daily_budget_exceeded':
    case 'desktop_daily_budget_exceeded': return 'alerts'
    case 'log':
    case 'event': return 'jobtail'
    case 'desktop.projects':
    case 'desktop.project_added':
    case 'desktop.project_removed': return 'hub' // mobile-app v1 wire compat — topic name frozen
    default: return null
  }
}

// ─── Mobile wire compat ───────────────────────────────────────────────────────
// mobile-app v1 wire compat — do not rename: the phone app (v1.0.0, in App
// Review) matches these exact legacy `type` strings (and the legacy budget
// payload field names). The internal broadcast types were renamed `desktop.*`
// in the Specrails Desktop rebrand; this outbound boundary translates them
// back before anything reaches a mobile socket.
const LEGACY_WIRE_TYPES: Record<string, string> = {
  'desktop.projects': 'hub.projects',
  'desktop.project_added': 'hub.project_added',
  'desktop.project_removed': 'hub.project_removed',
  desktop_daily_budget_exceeded: 'hub_daily_budget_exceeded',
}

function toMobileWire(msg: WsMessage): unknown {
  // SECURITY: loop.run_progress carries `reasoning` — free-text LLM output that
  // the path-only `redact()` does NOT scrub for repo content. Drop it at the
  // mobile boundary (forward only iteration/activeNode); it's the one field that
  // would leak more than any existing rail.* frame. Forward everything else.
  if (msg.type === 'loop.run_progress') {
    const { reasoning: _drop, ...rest } = msg as unknown as Record<string, unknown>
    return rest
  }
  const legacyType = LEGACY_WIRE_TYPES[msg.type]
  if (!legacyType) return msg
  const out: Record<string, unknown> = { ...(msg as unknown as Record<string, unknown>), type: legacyType }
  if (msg.type === 'desktop_daily_budget_exceeded') {
    // mobile-app v1 wire compat — restore the legacy payload field names.
    if ('desktopDailySpend' in out) { out.hubDailySpend = out.desktopDailySpend; delete out.desktopDailySpend }
    if ('desktopBudget' in out) { out.hubBudget = out.desktopBudget; delete out.desktopBudget }
  }
  return out
}

export class MobileWsBridge {
  private _socks = new Set<SockState>()
  private _unsub: (() => void) | null = null
  private _flush: ReturnType<typeof setInterval> | null = null
  private _hb: ReturnType<typeof setInterval> | null = null
  private _clock: () => number
  // BUG-MOBILE-02: resolve a device's per-project ACL. `null` ⇒ unrestricted
  // (all projects, legacy). When provided, a `subscribe` is intersected against
  // it so a companion can only subscribe to projects it was granted. Default
  // resolver (undefined) keeps every device unrestricted — byte-identical legacy.
  private _allowedProjectsFor: (deviceId: string) => Set<string> | null
  private _missionProjectFor: (conversationId: string) => string | null

  constructor(opts: { clock?: () => number; allowedProjectsFor?: (deviceId: string) => Set<string> | null; missionProjectFor?: (conversationId: string) => string | null } = {}) {
    this._clock = opts.clock ?? (() => Date.now())
    this._allowedProjectsFor = opts.allowedProjectsFor ?? (() => null)
    this._missionProjectFor = opts.missionProjectFor ?? (() => null)
  }

  start(): void {
    if (this._unsub) return
    this._unsub = getMobileEventBus().onMessage((msg) => this.dispatch(msg))
    this._flush = setInterval(() => this.flushLogs(), LOG_FLUSH_MS)
    this._hb = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    // Don't keep the event loop alive purely for these timers.
    this._flush.unref?.()
    this._hb.unref?.()
  }

  stop(): void {
    if (this._unsub) { this._unsub(); this._unsub = null }
    if (this._flush) { clearInterval(this._flush); this._flush = null }
    if (this._hb) { clearInterval(this._hb); this._hb = null }
    for (const s of this._socks) {
      try { s.ws.close(1001, 'gateway stopping') } catch { /* ignore */ }
    }
    this._socks.clear()
  }

  get socketCount(): number {
    return this._socks.size
  }

  /** Register a freshly-upgraded socket for an authenticated device. */
  attach(ws: SocketLike, deviceId: string): void {
    const state: SockState = {
      ws, deviceId,
      projects: new Set(), topics: new Set(), watchedJob: null,
      inbound: [], alive: true,
      logBuf: new Map(), logDropped: new Map(),
    }
    this._socks.add(state)
    ws.on('message', (...args: unknown[]) => this.onInbound(state, args[0]))
    ws.on('pong', () => { state.alive = true })
    ws.on('close', () => { this._socks.delete(state) })
    ws.on('error', () => { this._socks.delete(state) })
  }

  /** Close every socket belonging to a (just-revoked) device. */
  closeForDevice(deviceId: string): void {
    for (const s of this._socks) {
      if (s.deviceId === deviceId) {
        try { s.ws.close(4401, 'revoked') } catch { /* ignore */ }
        this._socks.delete(s)
      }
    }
  }

  private onInbound(state: SockState, raw: unknown): void {
    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : ''
    if (Buffer.byteLength(text) > INBOUND_MAX_BYTES) {
      try { state.ws.close(1009, 'message too large') } catch { /* ignore */ }
      return
    }
    const now = this._clock()
    state.inbound = state.inbound.filter((t) => now - t < 60_000)
    state.inbound.push(now)
    if (state.inbound.length > INBOUND_MAX_PER_MIN) {
      try { state.ws.close(1008, 'rate limit') } catch { /* ignore */ }
      return
    }
    let msg: Record<string, unknown>
    try { msg = JSON.parse(text) as Record<string, unknown> } catch { return }
    switch (msg.type) {
      case 'subscribe': {
        const projects = Array.isArray(msg.projects) ? msg.projects.filter((x) => typeof x === 'string') as string[] : []
        const topics = Array.isArray(msg.topics) ? msg.topics.filter((x) => typeof x === 'string') as string[] : []
        // BUG-MOBILE-02: intersect the device-supplied project list against the
        // device's granted set — a companion can never subscribe to a project it
        // wasn't granted (unrestricted devices keep the full list verbatim).
        const allowed = this._allowedProjectsFor(state.deviceId)
        const scoped = allowed === null ? projects : projects.filter((p) => allowed.has(p))
        state.projects = new Set(scoped)
        state.topics = new Set(topics)
        break
      }
      case 'watch_job': {
        if (typeof msg.projectId === 'string' && typeof msg.jobId === 'string') {
          state.watchedJob = { projectId: msg.projectId, jobId: msg.jobId }
        }
        break
      }
      case 'unwatch_job':
        state.watchedJob = null
        break
    }
  }

  /** Fan a single bus message out to matching sockets. */
  dispatch(msg: WsMessage): void {
    const topic = topicFor(msg.type)
    if (!topic) return
    for (const s of this._socks) {
      const allowed = this._allowedProjectsFor(s.deviceId)
      if (topic === 'missions') {
        if (allowed !== null || !s.topics.has('missions')) continue
        const value = msg as unknown as Record<string, unknown>
        const process = value.process as { chatId?: string } | undefined
        const cid = typeof value.conversationId === 'string' ? value.conversationId : process?.chatId
        const projectId = cid ? this._missionProjectFor(cid) : null
        if (!projectId || !s.projects.has(projectId)) continue
        // The snapshot is authoritative. Events are bounded invalidation hints;
        // never stream tool inputs/results or arbitrary provider payloads.
        this.send(s, redact({ type: 'mission.updated', projectId, conversationId: cid, event: msg.type, timestamp: value.timestamp,
          ...(msg.type === 'agent_stream' ? { delta: String(value.delta ?? '').slice(0, 16_000) } : {}),
          ...(msg.type === 'agent_tool' ? { tool: String(value.tool ?? '').slice(0, 100) } : {}) }))
        continue
      }
      if (topic === 'hub') {
        // App-level (project registry): always forward, but translate to the
        // legacy mobile wire types and redact (the projects payload carries `path`).
        if (msg.type === 'desktop.projects') this.send(s, redact(toMobileWire({ ...msg, projects: allowed === null ? msg.projects : msg.projects.filter(project => allowed.has(project.id)) })))
        else if (msg.type === 'desktop.project_added') { if (allowed === null || allowed.has(msg.project.id)) this.send(s, redact(toMobileWire(msg))) }
        else if (msg.type === 'desktop.project_removed' && (allowed === null || allowed.has(msg.projectId))) this.send(s, redact(toMobileWire(msg)))
        continue
      }
      // App-level desktop budget alert: deliver to subscribers holding the
      // `alerts` topic regardless of which project tripped it (boundBroadcast
      // stamps it with one project id, but it's an app-wide alert). Honour the
      // topic gate like every other delivery — a device that never subscribed to
      // `alerts` (topics init empty) must NOT receive these frames (BUG-MOBILE-05).
      if (topic === 'alerts' && msg.type === 'desktop_daily_budget_exceeded') {
        if (allowed === null && s.topics.has('alerts')) this.send(s, redact(toMobileWire(msg)))
        continue
      }

      const projectId = (msg as { projectId?: string }).projectId
      if (!projectId || !s.projects.has(projectId) || (allowed !== null && !allowed.has(projectId))) continue

      if (topic === 'jobtail') {
        if (!s.watchedJob || s.watchedJob.projectId !== projectId) continue
        const jobId = (msg as { jobId?: string; processId?: string }).jobId
          ?? (msg as { processId?: string }).processId
        if (jobId !== s.watchedJob.jobId) continue
        if (msg.type === 'log') {
          this.bufferLog(s, s.watchedJob.jobId, (msg as { line: string }).line)
        } else if (msg.type === 'event') {
          this.send(s, { type: 'job_event', projectId, jobId, eventType: (msg as { event_type: string }).event_type })
        }
        continue
      }

      if (s.topics.has(topic)) {
        this.send(s, redact(toMobileWire(msg)))
      }
    }
  }

  private bufferLog(s: SockState, jobId: string, line: string): void {
    const buf = s.logBuf.get(jobId) ?? []
    if (buf.length >= LOG_BATCH_MAX) {
      s.logDropped.set(jobId, (s.logDropped.get(jobId) ?? 0) + 1)
      return
    }
    buf.push(line.length > LOG_LINE_MAX ? line.slice(0, LOG_LINE_MAX) + '…' : line)
    s.logBuf.set(jobId, buf)
  }

  private flushLogs(): void {
    for (const s of this._socks) {
      for (const [jobId, lines] of s.logBuf) {
        const allowed = this._allowedProjectsFor(s.deviceId)
        if (lines.length === 0 || !s.watchedJob || s.watchedJob.jobId !== jobId || (allowed !== null && !allowed.has(s.watchedJob.projectId))) continue
        const dropped = s.logDropped.get(jobId) ?? 0
        this.send(s, { type: 'log_batch', jobId, lines, dropped })
      }
      s.logBuf.clear()
      s.logDropped.clear()
    }
  }

  private heartbeat(): void {
    for (const s of this._socks) {
      if (!s.alive) {
        try { s.ws.terminate() } catch { /* ignore */ }
        this._socks.delete(s)
        continue
      }
      s.alive = false
      try { s.ws.ping() } catch { /* ignore */ }
    }
  }

  private send(s: SockState, obj: unknown): void {
    if (s.ws.readyState !== OPEN) return
    try { s.ws.send(JSON.stringify(obj)) } catch { /* ignore */ }
  }
}
