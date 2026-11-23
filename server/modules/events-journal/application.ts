import { JOURNAL_RETENTION, classifyMessage, refKey, signatureOf, type JournalDraft, type JournalEvent, type RetentionPolicy } from './domain'
import type { AppendRow, JournalFilter, JournalStore } from './ports'

/**
 * The event journal use cases: ingest broadcast messages (classify, drop
 * repeats, batch-append on the next tick), read pages after a cursor, and
 * block a reader until a matching row arrives. Waiters are matched in memory
 * against the rows just appended, so a wake-up costs no query per waiter and
 * lands within one tick plus the settle window.
 */

export interface BusLike {
  onMessage(listener: (msg: unknown) => void): () => void
}

export interface EventJournalDeps {
  store: JournalStore
  now?: () => number
  retention?: RetentionPolicy
  compactEveryAppends?: number
  /** 0 disables the timer (tests). */
  compactIntervalMs?: number
  /** How many refs keep their last signature in memory (older ones are re-read from the store). */
  signatureCapacity?: number
}

export interface WaitRequest {
  afterSeq: number
  filter: JournalFilter
  limit: number
  timeoutMs: number
  signal?: AbortSignal
  /** After the first matching row, collect what else lands in this window (one wake-up per burst). */
  settleMs?: number
  /** Called every `progressEveryMs` while blocked. */
  onProgress?: (elapsedMs: number) => void
  progressEveryMs?: number
  /** Ends the wait early (e.g. a new mission message); returns its disposer. */
  interrupt?: (wake: () => void) => () => void
}

export type WaitReason = 'event' | 'timeout' | 'aborted' | 'interrupted'

export interface WaitOutcome {
  events: JournalEvent[]
  reason: WaitReason
  /** Where the next read resumes (after the last row considered). */
  cursorSeq: number
  /** More matching rows exist after `cursorSeq` (the page was full). */
  more: boolean
  waitedMs: number
}

export interface EventJournal {
  /** One broadcast message; never throws. */
  ingest(message: unknown): void
  /** Drafts appended as-is (after de-duplication) on the next tick. */
  record(drafts: readonly JournalDraft[]): void
  /** Writes what is pending now; returns the appended rows. */
  flush(): JournalEvent[]
  read(afterSeq: number, filter: JournalFilter, limit: number): { events: JournalEvent[]; cursorSeq: number; more: boolean }
  tail(filter: JournalFilter, limit: number): JournalEvent[]
  latest(refs: ReadonlyArray<{ kind: string; id: string }>): Map<string, JournalEvent>
  bounds(): { head: number; oldest: number }
  epoch(): string
  waitFor(request: WaitRequest): Promise<WaitOutcome>
  /** Rows appended from now on (notifications); returns the disposer. */
  onAppend(listener: (events: readonly JournalEvent[]) => void): () => void
  compact(): number
  /** Feeds the journal from a bus; attaching the same bus twice is a no-op. */
  attach(bus: BusLike): () => void
  close(): void
}

/** In-memory twin of `filterSql` (adapters/sqlite.ts). */
export function matchesFilter(filter: JournalFilter, event: JournalEvent): boolean {
  if (filter.projectId && event.projectId !== filter.projectId) return false
  const refOk = !filter.refs?.length || filter.refs.some((ref) => ref.kind === event.refKind && ref.id === event.refId)
  const matchOk = filter.match === 'settled' ? event.settled || event.attention !== null
    : filter.match === 'attention' ? event.attention !== null
      : true
  return (refOk && matchOk) || (filter.alsoAttention === true && event.attention !== null)
}

interface Known { sig: string; status: string; settled: boolean; hold: string | null }

/** Holds a cleared question can end; any other hold (the person's pause, a limit, a cap) outlives it. */
const QUESTION_HOLDS = new Set(['question', 'approval'])

export function createEventJournal(deps: EventJournalDeps): EventJournal {
  const { store } = deps
  const now = deps.now ?? Date.now
  const retention = deps.retention ?? JOURNAL_RETENTION
  const compactEvery = deps.compactEveryAppends ?? JOURNAL_RETENTION.compactEveryAppends
  const capacity = deps.signatureCapacity ?? 20_000
  const known = new Map<string, Known>()
  const pending: AppendRow[] = []
  const listeners = new Set<(events: readonly JournalEvent[]) => void>()
  const buses = new Map<BusLike, () => void>()
  let flushScheduled = false
  let sinceCompact = 0
  let closed = false

  const remember = (key: string, value: Known) => {
    known.delete(key)
    known.set(key, value)
    if (known.size > capacity) known.delete(known.keys().next().value as string)
  }

  const lastOf = (draft: JournalDraft): Known | null => {
    const key = refKey(draft.refKind, draft.refId)
    const cached = known.get(key)
    if (cached) return cached
    const row = store.latest([{ kind: draft.refKind, id: draft.refId }]).get(key)
    if (!row) return null
    const value = { sig: signatureOf(row), status: row.status, settled: row.settled, hold: row.hold ?? null }
    remember(key, value)
    return value
  }

  const scheduleFlush = () => {
    if (flushScheduled || closed) return
    flushScheduled = true
    setImmediate(() => { flushScheduled = false; flush() })
  }

  function record(drafts: readonly JournalDraft[]): void {
    if (closed) return
    for (const draft of drafts) {
      const last = lastOf(draft)
      const sig = signatureOf(draft)
      if (last && last.sig === sig) continue
      // The queue snapshot only fills gaps: it never overrides a hold or a finished run.
      if (draft.source === 'queue' && last && (last.settled || last.status === draft.status)) continue
      // "No pending question" (job.interactive) clears a question, never the person's pause or a limit:
      // Core settles its step after a pause and reports an empty interrupt list, which is not a resume.
      if (draft.kind === 'run.hold' && draft.hold === null && last?.hold && !QUESTION_HOLDS.has(last.hold)) continue
      remember(refKey(draft.refKind, draft.refId), { sig, status: draft.status, settled: draft.settled, hold: draft.hold })
      // Same status, new content: the spec was edited (title, body, priority, labels).
      const kind = draft.kind === 'spec.status' && last && last.status === draft.status ? 'spec.updated' : draft.kind
      pending.push({ ...draft, kind, at: new Date(now()).toISOString(), prevStatus: last?.status ?? null })
    }
    if (pending.length) scheduleFlush()
  }

  function flush(): JournalEvent[] {
    if (!pending.length) return []
    const batch = pending.splice(0, pending.length)
    let appended: JournalEvent[]
    try {
      appended = store.append(batch)
    } catch {
      // The database went away (shutdown) or is busy: the journal is best effort, the app is not affected.
      known.clear()
      return []
    }
    sinceCompact += appended.length
    for (const listener of [...listeners]) {
      try { listener(appended) } catch { /* a listener never breaks the journal */ }
    }
    if (sinceCompact >= compactEvery) {
      sinceCompact = 0
      setImmediate(() => { try { compact() } catch { /* retried on the next trigger */ } })
    }
    return appended
  }

  function read(afterSeq: number, filter: JournalFilter, limit: number) {
    flush()
    const head = store.bounds().head
    const events = store.read(afterSeq, filter, limit)
    const more = events.length >= limit
    const cursorSeq = more ? events[events.length - 1].seq : Math.max(afterSeq, head, events.at(-1)?.seq ?? 0)
    return { events, cursorSeq, more }
  }

  function compact(): number {
    flush()
    return store.compact(retention, now())
  }

  const timer = deps.compactIntervalMs === 0 ? null : setInterval(() => {
    try { compact() } catch { /* retried on the next tick */ }
  }, deps.compactIntervalMs ?? JOURNAL_RETENTION.compactIntervalMs)
  timer?.unref?.()

  function waitFor(request: WaitRequest): Promise<WaitOutcome> {
    const started = now()
    const first = read(request.afterSeq, request.filter, request.limit)
    if (first.events.length || closed || request.signal?.aborted) {
      return Promise.resolve({ ...first, reason: first.events.length ? 'event' : 'aborted', waitedMs: 0 })
    }
    const settleMs = request.settleMs ?? 100
    return new Promise<WaitOutcome>((resolve) => {
      let done = false
      let settleTimer: NodeJS.Timeout | null = null
      const finish = (reason: WaitReason) => {
        if (done) return
        done = true
        clearTimeout(timeout)
        if (settleTimer) clearTimeout(settleTimer)
        if (progress) clearInterval(progress)
        stopAppend()
        stopInterrupt?.()
        request.signal?.removeEventListener('abort', onAbort)
        waiters.delete(cancel)
        let page = { ...first, events: [] as JournalEvent[] }
        if (reason !== 'aborted') {
          try { page = read(request.afterSeq, request.filter, request.limit) } catch { /* store closed: answer with what we know */ }
        }
        resolve({ ...page, reason: page.events.length ? 'event' : reason, waitedMs: now() - started })
      }
      const cancel = () => finish('aborted')
      const onAbort = () => finish('aborted')
      const stopAppend = onAppend((events) => {
        if (settleTimer || done) return
        if (!events.some((event) => event.seq > request.afterSeq && matchesFilter(request.filter, event))) return
        settleTimer = setTimeout(() => finish('event'), settleMs)
      })
      const timeout = setTimeout(() => finish('timeout'), request.timeoutMs)
      const progress = request.onProgress
        ? setInterval(() => { try { request.onProgress!(now() - started) } catch { /* notifications are optional */ } }, request.progressEveryMs ?? 5_000)
        : null
      const stopInterrupt = request.interrupt?.(() => finish('interrupted'))
      request.signal?.addEventListener('abort', onAbort, { once: true })
      waiters.add(cancel)
    })
  }

  const waiters = new Set<() => void>()

  function onAppend(listener: (events: readonly JournalEvent[]) => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  return {
    ingest(message) {
      try { record(classifyMessage(message)) } catch { /* never into the broadcast loop */ }
    },
    record,
    flush,
    read,
    tail: (filter, limit) => { flush(); return store.tail(filter, limit) },
    latest: (refs) => { flush(); return store.latest(refs) },
    bounds: () => { flush(); return store.bounds() },
    epoch: () => store.epoch(),
    waitFor,
    onAppend,
    compact,
    attach(bus) {
      const existing = buses.get(bus)
      if (existing) return existing
      const stop = bus.onMessage((msg: unknown) => this.ingest(msg))
      const dispose = () => { stop(); buses.delete(bus) }
      buses.set(bus, dispose)
      return dispose
    },
    close() {
      if (closed) return
      try { flush() } catch { /* closing */ }
      closed = true
      if (timer) clearInterval(timer)
      for (const dispose of [...buses.values()]) dispose()
      for (const cancel of [...waiters]) cancel()
      listeners.clear()
    },
  }
}
