/**
 * Per-conversation live-turn store (stream text, tool chips, queued inputs).
 *
 * Why it exists: a token used to travel through React state of the chat
 * provider, so EVERY streamed token of ANY mission re-rendered every consumer
 * of the chat context (app shell, sidebar, the open conversation with all of its
 * markdown). Here the slices live outside React; components subscribe to exactly
 * the slice or derived value they render (see hooks/useAgentLive.ts).
 *
 * Contract:
 * - `patch` is synchronous and notifies immediately (state transitions: tool
 *   chips, queue, settle). It first folds in any buffered stream text so the
 *   order of events is never inverted.
 * - `appendStream` buffers the token and flushes once per animation frame for
 *   the open mission, and at a low cadence for missions out of view (only their
 *   activity state matters there). The first token of a turn flips `isStreaming`
 *   synchronously so dots/shimmer appear without waiting for the frame.
 * - Text-only changes notify the conversation's own subscribers; "structural"
 *   changes (streaming flag, tools, queue, slice added/removed) also notify the
 *   aggregate subscribers.
 * - Nothing is lost or duplicated: the buffer is concatenated in arrival order.
 */
import type { AgentPendingMessage } from './agent-api'

export interface AgentLiveTool {
  id: string
  tool: string
  /** Bounded JSON preview of the tool input (server `agent_tool.input`). */
  input?: string
  /** Bounded output preview merged in from `agent_tool_result` (claude-only). */
  output?: string
  isError?: boolean
  /** Provider tool-call id — correlates the result event to this entry. */
  toolId?: string
  /** ISO timestamp of the tool invocation (server clock). */
  at?: string
}

/** Input awaiting native delivery, a safe tool checkpoint or a resumed turn. */
export interface AgentQueuedItem extends AgentPendingMessage {}

/** Live turn state for ONE conversation. Kept per-conversation so background
 *  agents keep streaming while the user reads another thread. */
export interface AgentConvLive {
  streamingText: string
  isStreaming: boolean
  liveTools: AgentLiveTool[]
  /** The last SETTLED turn's tool activity — kept past agent_done so the
   *  activity-log modal still has content between turns. Session-only. */
  turnTools: AgentLiveTool[]
  queued: AgentQueuedItem[]
}

export const EMPTY_LIVE: AgentConvLive = { streamingText: '', isStreaming: false, liveTools: [], turnTools: [], queued: [] }

export type LiveMap = ReadonlyMap<string, AgentConvLive>

export interface LiveStore {
  get(id: string): AgentConvLive | undefined
  /** Immutable map; its identity changes whenever any slice changes. */
  snapshot(): LiveMap
  /** Apply `fn` to the slice; returning `null` (or an all-idle slice) drops it. */
  patch(id: string, fn: (previous: AgentConvLive) => AgentConvLive | null): void
  /** Replace the whole map (turn reconciliation after a reconnect). */
  replaceAll(fn: (current: LiveMap) => Map<string, AgentConvLive>): void
  /** Buffer a streamed token for `id` (flushed per frame). */
  appendStream(id: string, delta: string): void
  /** The mission the person is looking at: its tokens flush on the frame cadence. */
  setForeground(id: string | null): void
  /** Aggregate subscribers: fire on structural changes only (never for text-only ones). */
  subscribe(listener: () => void): () => void
  /** Per-conversation subscribers: fire on every change of that slice, text included. */
  subscribeId(id: string, listener: () => void): () => void
  /** Fold every buffered token in now (tests, teardown, focus gain). */
  flush(): void
  dispose(): void
}

const BACKGROUND_FLUSH_MS = 500
/** A hidden window gets no animation frames: fall back to a timer. */
const FRAME_FALLBACK_MS = 80

function isIdle(next: AgentConvLive): boolean {
  return !next.isStreaming && !next.streamingText && next.liveTools.length === 0
    && next.turnTools.length === 0 && next.queued.length === 0
}

export function createLiveStore(): LiveStore {
  let map: LiveMap = new Map()
  let foreground: string | null = null
  const pending = new Map<string, string>()
  const globalListeners = new Set<() => void>()
  const idListeners = new Map<string, Set<() => void>>()
  let frame = 0
  let frameTimer: ReturnType<typeof setTimeout> | null = null
  let backgroundTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const notifyId = (id: string): void => {
    const set = idListeners.get(id)
    if (set) for (const listener of [...set]) listener()
  }
  const notifyGlobal = (): void => {
    for (const listener of [...globalListeners]) listener()
  }

  /** Commit one slice. `structural` = anything beyond the stream text changed. */
  const commit = (id: string, next: AgentConvLive | null, structural: boolean): void => {
    const copy = new Map(map)
    if (next === null || isIdle(next)) copy.delete(id)
    else copy.set(id, next)
    map = copy
    notifyId(id)
    if (structural) notifyGlobal()
  }

  const withPending = (id: string): AgentConvLive | undefined => {
    const current = map.get(id)
    const buffered = pending.get(id)
    if (!buffered) return current
    return { ...(current ?? EMPTY_LIVE), streamingText: (current?.streamingText ?? '') + buffered }
  }

  const flushId = (id: string): void => {
    const buffered = pending.get(id)
    if (!buffered) return
    const current = map.get(id) ?? EMPTY_LIVE
    pending.delete(id)
    commit(id, { ...current, streamingText: current.streamingText + buffered }, false)
  }

  const clearFrame = (): void => {
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    if (frameTimer) clearTimeout(frameTimer)
    frame = 0
    frameTimer = null
  }
  const runForeground = (): void => {
    clearFrame()
    if (disposed) return
    if (foreground) flushId(foreground)
  }
  const scheduleForeground = (): void => {
    if (frame || frameTimer) return
    if (typeof requestAnimationFrame === 'function' && !(typeof document !== 'undefined' && document.hidden)) {
      frame = requestAnimationFrame(runForeground)
    }
    // Also a timer: a hidden window never fires animation frames.
    frameTimer = setTimeout(runForeground, FRAME_FALLBACK_MS * (frame ? 4 : 1))
  }
  const scheduleBackground = (): void => {
    if (backgroundTimer) return
    backgroundTimer = setTimeout(() => {
      backgroundTimer = null
      if (disposed) return
      for (const id of [...pending.keys()]) if (id !== foreground) flushId(id)
    }, BACKGROUND_FLUSH_MS)
  }

  return {
    get: (id) => withPending(id),
    snapshot: () => map,
    patch(id, fn) {
      const previous = withPending(id)
      pending.delete(id)
      const next = fn(previous ?? EMPTY_LIVE)
      commit(id, next, true)
    },
    replaceAll(fn) {
      for (const id of [...pending.keys()]) flushId(id)
      const next = fn(map)
      map = next
      for (const id of new Set([...next.keys(), ...idListeners.keys()])) notifyId(id)
      notifyGlobal()
    },
    appendStream(id, delta) {
      if (!delta) return
      const current = map.get(id)
      if (!current?.isStreaming) {
        // First token of a turn: the streaming flag (dots, shimmer, composer
        // state) flips now; the text follows with the frame.
        pending.set(id, (pending.get(id) ?? '') + delta)
        commit(id, { ...(current ?? EMPTY_LIVE), isStreaming: true }, true)
      } else {
        pending.set(id, (pending.get(id) ?? '') + delta)
      }
      if (id === foreground) scheduleForeground()
      else scheduleBackground()
    },
    setForeground(id) {
      if (foreground === id) return
      foreground = id
      if (id) flushId(id)
    },
    subscribe(listener) {
      globalListeners.add(listener)
      return () => { globalListeners.delete(listener) }
    },
    subscribeId(id, listener) {
      let set = idListeners.get(id)
      if (!set) { set = new Set(); idListeners.set(id, set) }
      set.add(listener)
      return () => {
        set!.delete(listener)
        if (set!.size === 0) idListeners.delete(id)
      }
    },
    flush() {
      clearFrame()
      for (const id of [...pending.keys()]) flushId(id)
    },
    dispose() {
      disposed = true
      clearFrame()
      if (backgroundTimer) clearTimeout(backgroundTimer)
      backgroundTimer = null
      pending.clear()
      globalListeners.clear()
      idListeners.clear()
    },
  }
}
