import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useDesktop } from './useDesktop'
import { isMacKeyboard } from '../lib/keyboard-label'

/**
 * Undo instead of confirm (QW2). A reversible action applies immediately and
 * calls `pushUndo`: a toast offers "Undo" for {@link UNDO_WINDOW_MS}, and
 * ⌘Z / Ctrl+Z undoes the latest live entry while focus is not in a text field,
 * code editor or terminal.
 *
 * The stack is per project. An entry remembers the project it belongs to, ⌘Z
 * only considers entries of the ACTIVE project, and switching project dismisses
 * the previous project's toasts. The `undo` callback must therefore address its
 * project explicitly (never "whatever is active now").
 */

/** How long a toast offers Undo (and ⌘Z stays live). Keep in sync with UNDO_WINDOW_HOLD_MS on the server. */
export const UNDO_WINDOW_MS = 8000

/** How long a deleted spec or mission stays in Recently deleted. Keep in sync with TRASH_RETENTION_DAYS on the server. */
export const TRASH_RETENTION_DAYS = 30

export interface UndoRequest {
  /** Project the action happened in. Defaults to the active project. */
  projectId?: string | null
  /** What happened, past tense: "Spec #12 deleted". */
  label: string
  /** Reverse the action. Reject to report failure. */
  undo: () => void | Promise<void>
  /** Days the thing stays recoverable from Recently deleted after the toast is gone; the hint then says so. */
  recoverableDays?: number
}

interface UndoEntry {
  id: string
  projectId: string
  label: string
  undo: () => void | Promise<void>
  expiresAt: number
  done: boolean
}

export interface UndoApi {
  /** Apply-then-undoable: shows the toast and registers ⌘Z. Returns false when there is no undo surface (nothing was shown). */
  pushUndo: (request: UndoRequest) => boolean
  /** Undo the latest live entry of the active project. Returns whether one ran. */
  undoLast: () => Promise<boolean>
  /** Label of the entry `undoLast` would reverse right now (active project, window still open), or null. */
  peekUndo: () => string | null
}

const NOOP: UndoApi = { pushUndo: () => false, undoLast: async () => false, peekUndo: () => null }
const UndoContext = createContext<UndoApi>(NOOP)

/** Without a provider (isolated windows, unit tests) every call is a harmless no-op. */
export function useUndo(): UndoApi {
  return useContext(UndoContext)
}

function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  // Code editors and terminals own ⌘Z for their own history.
  return !!el.closest('.monaco-editor, .cm-editor, [data-code-editor], .specrails-xterm-container, .xterm, [contenteditable="true"]')
}

/** Throw from `undo` to refuse with a specific, human reason (shown instead of the generic failure). */
export class UndoBlockedError extends Error {}

let entrySeq = 0

export function UndoProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('undo')
  const { activeProjectId } = useDesktop()
  const activeRef = useRef(activeProjectId)
  activeRef.current = activeProjectId
  const tRef = useRef(t)
  tRef.current = t
  const stack = useRef<UndoEntry[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const drop = useCallback((id: string) => {
    stack.current = stack.current.filter((e) => e.id !== id)
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
  }, [])

  const run = useCallback(async (entry: UndoEntry): Promise<boolean> => {
    if (entry.done) return false
    entry.done = true
    drop(entry.id)
    try {
      await entry.undo()
      toast.success(tRef.current('undone', { label: entry.label }), { id: entry.id, duration: 2500 })
      return true
    } catch (err) {
      toast.error(err instanceof UndoBlockedError ? err.message : tRef.current('failed'), { id: entry.id })
      return false
    }
  }, [drop])

  const pushUndo = useCallback((request: UndoRequest): boolean => {
    const projectId = request.projectId ?? activeRef.current
    if (!projectId) return false
    const entry: UndoEntry = {
      id: `undo-${++entrySeq}`,
      projectId,
      label: request.label,
      undo: request.undo,
      expiresAt: Date.now() + UNDO_WINDOW_MS,
      done: false,
    }
    stack.current.push(entry)
    timers.current.set(entry.id, setTimeout(() => drop(entry.id), UNDO_WINDOW_MS))
    toast(request.label, {
      id: entry.id,
      duration: UNDO_WINDOW_MS,
      description: request.recoverableDays
        ? tRef.current('hintRecoverable', { keys: isMacKeyboard() ? '⌘Z' : 'Ctrl+Z', days: request.recoverableDays })
        : tRef.current('hint', { keys: isMacKeyboard() ? '⌘Z' : 'Ctrl+Z' }),
      action: { label: tRef.current('action'), onClick: () => { void run(entry) } },
      onDismiss: () => drop(entry.id),
      onAutoClose: () => drop(entry.id),
    })
    return true
  }, [drop, run])

  const undoLast = useCallback(async (): Promise<boolean> => {
    const now = Date.now()
    const live = stack.current.filter((e) => e.projectId === activeRef.current && e.expiresAt > now)
    const entry = live[live.length - 1]
    return entry ? run(entry) : false
  }, [run])

  const peekUndo = useCallback((): string | null => {
    const now = Date.now()
    const live = stack.current.filter((e) => e.projectId === activeRef.current && e.expiresAt > now)
    return live.length > 0 ? live[live.length - 1].label : null
  }, [])

  // A project switch ends the previous project's undo window.
  useEffect(() => {
    for (const entry of [...stack.current]) {
      if (entry.projectId !== activeProjectId) {
        toast.dismiss(entry.id)
        drop(entry.id)
      }
    }
  }, [activeProjectId, drop])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.code !== 'KeyZ') return
      if (isTextTarget(e.target)) return
      const now = Date.now()
      if (!stack.current.some((entry) => entry.projectId === activeRef.current && entry.expiresAt > now)) return
      e.preventDefault()
      void undoLast()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undoLast])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [])

  const api = useMemo<UndoApi>(() => ({ pushUndo, undoLast, peekUndo }), [pushUndo, undoLast, peekUndo])
  return <UndoContext.Provider value={api}>{children}</UndoContext.Provider>
}
