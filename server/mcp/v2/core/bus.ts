/**
 * Bounded waits on the app's event bus (the WebSocket frames the GUI gets).
 * Subscribe BEFORE triggering the work, so a fast frame is never missed.
 */
import type { MobileEventBus } from '../../../mobile/mobile-event-bus'
import type { WsMessage } from '../../../types'
import type { McpToolContext } from '../../tools/types'
import { asRecord, type Row } from './text'

export type Waited = { kind: 'done' | 'error' | 'timeout'; msg?: Row }
export type FrameMatch = (msg: Row) => 'done' | 'error' | null

/** Resolves on the first frame `match` settles, on the timeout, or when the call is aborted. */
export function listen(ctx: Pick<McpToolContext, 'eventBus'> & { signal?: AbortSignal }, match: FrameMatch, timeoutMs: number): { promise: Promise<Waited>; stop: () => void } {
  const bus = ctx.eventBus as MobileEventBus | undefined
  let stop = () => {}
  const promise = new Promise<Waited>((resolve) => {
    if (!bus || timeoutMs <= 0) { resolve({ kind: 'timeout' }); return }
    let off: (() => void) | null = null
    const finish = (value: Waited) => { clearTimeout(timer); off?.(); ctx.signal?.removeEventListener('abort', onAbort); resolve(value) }
    const onAbort = () => finish({ kind: 'timeout' })
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
    off = bus.onMessage((raw: WsMessage) => {
      const msg = asRecord(raw)
      const verdict = match(msg)
      if (verdict) finish({ kind: verdict, msg })
    })
    ctx.signal?.addEventListener('abort', onAbort)
    stop = () => finish({ kind: 'timeout' })
  })
  return { promise, stop: () => stop() }
}

/** `options.waitMs` clamped to [0, max]; the default when absent or not a number. */
export function waitMsOf(options: Row, fallback: number, max: number): number {
  const raw = options.waitMs
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return Math.min(fallback, max)
  return Math.max(0, Math.min(Math.floor(raw), max))
}
