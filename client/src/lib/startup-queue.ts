/**
 * The startup queue: one owner for the surfaces that can appear when the app
 * launches, so they arrive one at a time instead of piling up.
 *
 *   1. Crash banner — not modal; shows at once and never blocks.
 *   2. "Pick up where you left off" — the ONLY modal allowed at launch.
 *   3. Product tour — first install only, and only on a clean launch: after a
 *      crash or with resume offers it is deferred to the next clean launch.
 *   4. Update card — discreet (status bar), after the app sat idle ~30 s with
 *      no modal open.
 *   5. Attention toasts — held while a startup modal is open, then shown as
 *      one grouped toast ("3 things need you").
 *
 * Each surface reports what it found (`report`) and holds the queue while its
 * modal is open (`hold`). The tour decision waits for the crash and resume
 * reports, bounded by {@link DECIDE_TIMEOUT_MS} so an unreachable server never
 * keeps it waiting forever. Main window only; module state is app-wide (no
 * project data), and `resetStartupQueueForTests` clears it.
 */

export type StartupSignal = 'crash' | 'resume'
export type TourDecision = 'pending' | 'show' | 'defer'

/** How long the tour waits for the crash and resume reports before deciding without them. */
export const DECIDE_TIMEOUT_MS = 6_000
/** Quiet time (no input, no modal) before the update card may appear. */
export const UPDATE_IDLE_MS = 30_000

interface State {
  reports: Partial<Record<StartupSignal, boolean>>
  timedOut: boolean
  holds: ReadonlySet<string>
}

interface HeldToast { show: () => void }

let state: State = { reports: {}, timedOut: false, holds: new Set() }
let held: HeldToast[] = []
let groupToast: ((count: number, singles: HeldToast[]) => void) | null = null
let timeout: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function publish(next: State): void {
  state = next
  listeners.forEach((listener) => listener())
}

function armTimeout(): void {
  if (timeout || state.timedOut) return
  timeout = setTimeout(() => { timeout = null; publish({ ...state, timedOut: true }) }, DECIDE_TIMEOUT_MS)
}

function flushHeld(): void {
  if (state.holds.size > 0 || held.length === 0) return
  const batch = held
  held = []
  if (batch.length === 1 || !groupToast) batch.forEach((entry) => entry.show())
  else groupToast(batch.length, batch)
}

export const startupQueue = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    armTimeout()
    return () => { listeners.delete(listener) }
  },
  getSnapshot(): State { return state },

  /** A launch surface says whether it has something (a crash to explain, offers to resume). */
  report(signal: StartupSignal, present: boolean): void {
    if (state.reports[signal] === present) return
    armTimeout()
    publish({ ...state, reports: { ...state.reports, [signal]: present } })
  },

  /** A startup modal is open: no other modal, update card or attention toast meanwhile. */
  hold(id: string): () => void {
    if (!state.holds.has(id)) publish({ ...state, holds: new Set([...state.holds, id]) })
    let released = false
    return () => {
      if (released) return
      released = true
      const holds = new Set(state.holds)
      holds.delete(id)
      publish({ ...state, holds })
      flushHeld()
    }
  },

  held(): boolean { return state.holds.size > 0 },

  /**
   * Show an in-app attention toast now, or after the startup modal closes.
   * Several held toasts become one grouped toast (see {@link setGroupToast}).
   */
  deliver(show: () => void): void {
    if (state.holds.size === 0) { show(); return }
    held.push({ show })
  },
}

/** How several held attention toasts are shown as one ("N things need you"). */
export function setGroupToast(render: ((count: number, singles: HeldToast[]) => void) | null): void {
  groupToast = render
}

/**
 * The tour on a first install: shown only when the crash and resume reports
 * say the launch is clean; deferred (not marked seen) when either has
 * something. Without a report by the timeout, a missing report counts as clean.
 */
export function decideTour(snapshot: State): TourDecision {
  const { crash, resume } = snapshot.reports
  if (crash === true || resume === true) return 'defer'
  if (crash === false && resume === false) return snapshot.holds.size > 0 ? 'pending' : 'show'
  if (!snapshot.timedOut) return 'pending'
  return snapshot.holds.size > 0 ? 'pending' : 'show'
}

/** Test-only: forget every report, hold and held toast. */
export function resetStartupQueueForTests(): void {
  if (timeout) clearTimeout(timeout)
  timeout = null
  held = []
  groupToast = null
  state = { reports: {}, timedOut: false, holds: new Set() }
  listeners.forEach((listener) => listener())
}

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const

function modalOpen(): boolean {
  return state.holds.size > 0 || (typeof document !== 'undefined' && !!document.querySelector('[role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden])'))
}

/**
 * Resolves once the app has been quiet for `quietMs`: no pointer or key input
 * and no dialog open (a startup hold counts as a dialog). Rejects on abort.
 */
export function whenIdle(signal: AbortSignal, quietMs: number = UPDATE_IDLE_MS, tickMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    let quietSince = Date.now()
    const onInput = (): void => { quietSince = Date.now() }
    const cleanup = (): void => {
      clearInterval(timer)
      INPUT_EVENTS.forEach((type) => window.removeEventListener(type, onInput, true))
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => { cleanup(); reject(signal.reason) }
    const timer = setInterval(() => {
      if (modalOpen()) { quietSince = Date.now(); return }
      if (Date.now() - quietSince >= quietMs) { cleanup(); resolve() }
    }, tickMs)
    INPUT_EVENTS.forEach((type) => window.addEventListener(type, onInput, { capture: true, passive: true }))
    signal.addEventListener('abort', onAbort)
  })
}
