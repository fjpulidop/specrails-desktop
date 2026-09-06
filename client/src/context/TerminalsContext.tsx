/**
 * TerminalsContext — holds per-project terminal state and xterm instances.
 *
 * Key invariants:
 *  - xterm.js Terminal instances are created once per session and NEVER disposed
 *    until the session is explicitly killed. They live in `xtermHandles` (ref Map).
 *  - Each xterm's container DOM node is attached to a hidden host div by default.
 *    When a session becomes active and the panel is visible, the viewport slot
 *    component appendChild's it into its own subtree, then moves it back on unmount.
 *  - Per-project panel state (visibility + userHeight) is persisted to localStorage.
 *  - PTYs live on the server; when we switch to a project, we GET /terminals and
 *    reconcile local refs against the server truth.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSettings } from '../lib/terminal-settings-types'
import { DEFAULT_TERMINAL_SETTINGS, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, clampFontSize } from '../lib/terminal-settings-types'
import { ingestMark, disposeSession as disposeMarksSession, getMarks } from '../lib/command-mark-store'
import { notifyCommandFinished, shouldNotify } from '../lib/terminal-notifications'
import { toast } from 'sonner'
import i18n from '../lib/i18n'
import { API_ORIGIN } from '../lib/origin'
import { WS_URL } from '../lib/ws-url'
import { getDesktopTokenProtocol } from '../lib/auth'
import { useThemeOptional } from './ThemeContext'
import { getActiveTheme } from '../lib/theme-palette'
import { readClipboardText, writeClipboardText } from '../lib/tauri-clipboard'

// ─── Types ────────────────────────────────────────────────────────────────────

export type PanelVisibility = 'hidden' | 'restored' | 'maximized'

export interface TerminalRef {
  id: string
  projectId: string
  name: string
  shell?: string
  cwd?: string
  cols: number
  rows: number
  createdAt: number
}

export interface ProjectPanelState {
  visibility: PanelVisibility
  userHeight: number
  sessions: TerminalRef[]
  activeId: string | null
}

export const DEFAULT_USER_HEIGHT = 320
export const PANEL_MIN_HEIGHT = 120
export const TERMINAL_MAX_PER_PROJECT = 10

interface TerminalsContextValue {
  /** All per-project state. Re-reads trigger re-renders. */
  states: Record<string, ProjectPanelState>
  getState: (projectId: string) => ProjectPanelState
  ensureProject: (projectId: string) => void
  setVisibility: (projectId: string, v: PanelVisibility) => void
  togglePanel: (projectId: string) => void
  setUserHeight: (projectId: string, h: number) => void
  setActive: (projectId: string, id: string) => void
  create: (projectId: string, opts?: { cols?: number; rows?: number; name?: string }) => Promise<TerminalRef | null>
  /** Create a new terminal and type the given text into it once the PTY is attached.
   *  Used by the "Open Claude" shortcut and similar quick-launchers. */
  createAndType: (projectId: string, text: string, opts?: { cols?: number; rows?: number; name?: string }) => Promise<TerminalRef | null>
  /** Write text to a session's PTY without creating a new one. Used by the
   *  Quick Script shortcut to paste-and-not-execute into the active terminal. */
  writeToSession: (sessionId: string, text: string) => boolean
  rename: (projectId: string, id: string, name: string) => Promise<boolean>
  kill: (projectId: string, id: string) => Promise<void>
  focusActive: (projectId: string) => void
  disposeProject: (projectId: string) => void
  /** For viewport slot components — returns the container DOM node to adopt. */
  getContainer: (sessionId: string) => HTMLDivElement | null
  /** Called when the viewport slot has appended the container to its DOM. Triggers fit. */
  notifyAdopted: (sessionId: string) => void
  /** Force an immediate fit + resize for the given session (used on transitionend). */
  refitActive: (sessionId: string) => void
  /** Subscribe to OSC mark events for a session; returns unsubscribe. */
  subscribeMarks: (sessionId: string, fn: (m: MarkFrame) => void) => () => void
  /** Last reported CWD for a session, when shell integration has emitted one. */
  getCwd: (sessionId: string) => string | null
  getShell: (sessionId: string) => string | null
  /** Returns the SearchAddon for a session, used by the search overlay. */
  getSearchAddon: (sessionId: string) => SearchAddon | null
  /** Returns the underlying Terminal instance for context-menu / scrollback save. */
  getTerminalInstance: (sessionId: string) => Terminal | null
  /** Subscribe to "open search overlay" requests for a session. Returns unsubscribe. */
  subscribeOpenSearch: (sessionId: string, fn: () => void) => () => void
}

const TerminalsContext = createContext<TerminalsContextValue | null>(null)

// ─── Internals ────────────────────────────────────────────────────────────────

interface XtermHandle {
  term: Terminal
  fit: FitAddon
  webLinks: WebLinksAddon
  search: SearchAddon
  /** WebGL renderer when active; null when running in canvas mode. */
  webgl: { dispose: () => void } | null
  /** Resolved settings snapshot at boot; may diverge from current UI state until next refresh. */
  settings: TerminalSettings
  container: HTMLDivElement
  ws: WebSocket | null
  attached: boolean
  disposers: Array<() => void>
  /** Wall-clock ms when the PTY socket opened (0 until open). */
  openedAt: number
  /** True once any PTY output byte has arrived (distinguishes a live shell from a stillborn one). */
  gotData: boolean
  /** True once the user has typed into this terminal (suppresses false "failed to start" alarms). */
  gotUserInput: boolean
  /** Set when the client is deliberately disposing the session (kill / project switch). */
  disposing: boolean
  /** Guards against showing the "process exited" notice twice (exit frame + close). */
  exitShown: boolean
  /** Latest CWD reported via OSC 1337 mark frame. */
  currentCwd: string | null
  /** Listeners attached to mark events (gutter, timing badge, notifications). */
  markListeners: Set<(ev: MarkFrame) => void>
  /** Listeners attached to "open search overlay" requests. */
  openSearchListeners: Set<() => void>
}

export interface MarkFrame {
  type: 'mark'
  kind: 'prompt-start' | 'prompt-end' | 'pre-exec' | 'post-exec' | 'cwd'
  payload?: { exitCode?: number; path?: string }
  ts: number
  sessionId: string
}

function storageKey(projectId: string): string {
  return `specrails-desktop:terminal-panel:${projectId}`
}

interface StoredPanel { visibility: PanelVisibility; userHeight: number }

function readStored(projectId: string): StoredPanel | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return null
    const obj = JSON.parse(raw) as Partial<StoredPanel>
    if (!obj) return null
    const vis = obj.visibility
    const h = obj.userHeight
    if (vis !== 'hidden' && vis !== 'restored' && vis !== 'maximized') return null
    if (typeof h !== 'number' || !Number.isFinite(h)) return null
    return { visibility: vis, userHeight: h }
  } catch { return null }
}

function writeStored(projectId: string, v: StoredPanel): void {
  try { localStorage.setItem(storageKey(projectId), JSON.stringify(v)) } catch { /* ignore */ }
}

function initialProjectState(stored: StoredPanel | null): ProjectPanelState {
  return {
    visibility: stored?.visibility ?? 'hidden',
    userHeight: stored?.userHeight ?? DEFAULT_USER_HEIGHT,
    sessions: [],
    activeId: null,
  }
}

// ─── Hidden host for detached xterm containers ────────────────────────────────

function ensureTerminalHost(): HTMLDivElement {
  let host = document.getElementById('specrails-terminal-host') as HTMLDivElement | null
  if (host) return host
  host = document.createElement('div')
  host.id = 'specrails-terminal-host'
  host.style.position = 'fixed'
  host.style.left = '0'
  host.style.top = '0'
  host.style.width = '0'
  host.style.height = '0'
  host.style.overflow = 'hidden'
  host.style.visibility = 'hidden'
  host.style.pointerEvents = 'none'
  host.setAttribute('aria-hidden', 'true')
  document.body.appendChild(host)
  return host
}

// ─── xterm theme — driven by the active app theme ─────────────────────────────
// `getActiveTheme()` reads `<html data-theme>` and returns the matching xterm
// palette from `themes.ts`. Existing terminal instances are reconfigured live
// by the TerminalsProvider effect that subscribes to ThemeContext.

// ─── Provider ─────────────────────────────────────────────────────────────────

interface ProviderProps {
  children: ReactNode
  /** Active project ID from DesktopProvider — used to focus panel on Cmd+J. */
  activeProjectId: string | null
}

export function TerminalsProvider({ children, activeProjectId }: ProviderProps) {
  const [states, setStates] = useState<Record<string, ProjectPanelState>>({})
  const statesRef = useRef(states)
  statesRef.current = states

  // Map of sessionId → xterm handle. Persists across project switches.
  const xtermHandles = useRef<Map<string, XtermHandle>>(new Map())
  // Map of sessionId → projectId. Needed to find owner on project-removal cleanup.
  const sessionOwners = useRef<Map<string, string>>(new Map())

  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    hostRef.current = ensureTerminalHost()
    return () => {
      // On unmount (rare): dispose everything
      for (const handle of xtermHandles.current.values()) disposeHandle(handle)
      xtermHandles.current.clear()
      sessionOwners.current.clear()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Live theme reconciliation ────────────────────────────────────────────
  // When the app theme changes, update every existing terminal in place. xterm
  // supports live `options.theme` swaps without recreating the instance, so
  // scrollback, marks, and shell-integration state are preserved. Uses the
  // optional theme hook so unit tests that mount TerminalsProvider in
  // isolation still render — production always has ThemeProvider above.
  const themeCtx = useThemeOptional()
  const activeTheme = themeCtx?.theme ?? null
  useEffect(() => {
    if (!activeTheme) return
    for (const handle of xtermHandles.current.values()) {
      try {
        handle.term.options.theme = activeTheme.xterm
      } catch { /* ignore — terminal may be mid-disposal */ }
    }
  }, [activeTheme])

  // ─── Mutators ─────────────────────────────────────────────────────────────

  const updateProject = useCallback((projectId: string, fn: (p: ProjectPanelState) => ProjectPanelState) => {
    setStates((prev) => {
      const cur = prev[projectId] ?? initialProjectState(readStored(projectId))
      const next = fn(cur)
      if (next === cur) return prev
      if (next.visibility !== cur.visibility || next.userHeight !== cur.userHeight) {
        writeStored(projectId, { visibility: next.visibility, userHeight: next.userHeight })
      }
      return { ...prev, [projectId]: next }
    })
  }, [])

  const ensureProject = useCallback((projectId: string) => {
    setStates((prev) => {
      if (prev[projectId]) return prev
      return { ...prev, [projectId]: initialProjectState(readStored(projectId)) }
    })
  }, [])

  const getState = useCallback((projectId: string): ProjectPanelState => {
    return statesRef.current[projectId] ?? initialProjectState(readStored(projectId))
  }, [])

  const setVisibility = useCallback((projectId: string, v: PanelVisibility) => {
    updateProject(projectId, (s) => (s.visibility === v ? s : { ...s, visibility: v }))
  }, [updateProject])

  const togglePanel = useCallback((projectId: string) => {
    updateProject(projectId, (s) => ({
      ...s,
      visibility: s.visibility === 'hidden' ? 'restored' : 'hidden',
    }))
  }, [updateProject])

  const setUserHeight = useCallback((projectId: string, h: number) => {
    updateProject(projectId, (s) => (s.userHeight === h ? s : { ...s, userHeight: h }))
  }, [updateProject])

  const setActive = useCallback((projectId: string, id: string) => {
    updateProject(projectId, (s) => (s.activeId === id ? s : { ...s, activeId: id }))
  }, [updateProject])

  // ─── Sync with server on project focus ─────────────────────────────────────

  const activeProjectRef = useRef<string | null>(activeProjectId)
  activeProjectRef.current = activeProjectId

  useEffect(() => {
    if (!activeProjectId) return
    ensureProject(activeProjectId)
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API_ORIGIN}/api/projects/${activeProjectId}/terminals`)
        if (!res.ok) return
        const body = await res.json() as { sessions: TerminalRef[]; limit: number }
        if (cancelled) return
        updateProject(activeProjectId, (s) => {
          const serverIds = new Set(body.sessions.map((r) => r.id))
          // Drop local refs the server no longer knows about (server restart scenario)
          for (const id of s.sessions.map((r) => r.id)) {
            if (!serverIds.has(id)) {
              const h = xtermHandles.current.get(id)
              if (h) { disposeHandle(h); xtermHandles.current.delete(id); sessionOwners.current.delete(id); disposeMarksSession(id) }
            }
          }
          // Merge: server is authoritative for existence; keep client-side name if we have it
          const merged: TerminalRef[] = body.sessions.map((srv) => {
            const local = s.sessions.find((l) => l.id === srv.id)
            if (local) return { ...local, ...srv }
            return srv
          })
          const activeId = merged.find((m) => m.id === s.activeId)?.id ?? merged[0]?.id ?? null
          // Prewarm xterm for each known session so switching is instant
          for (const m of merged) {
            if (!xtermHandles.current.has(m.id)) {
              ensureXtermForSession(m.projectId, m.id, m.cols, m.rows, xtermHandles.current, sessionOwners.current, hostRef.current)
            }
          }
          return { ...s, sessions: merged, activeId }
        })
      } catch { /* non-fatal */ }
    })()
    return () => { cancelled = true }
  }, [activeProjectId, ensureProject, updateProject])

  // ─── Actions: create/rename/kill ───────────────────────────────────────────

  const create = useCallback(async (projectId: string, opts?: { cols?: number; rows?: number; name?: string }): Promise<TerminalRef | null> => {
    const cols = opts?.cols ?? 80
    const rows = opts?.rows ?? 24
    try {
      const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows, name: opts?.name }),
      })
      if (!res.ok) {
        // Surface WHY the terminal could not open instead of silently no-op'ing
        // (the "+ button does nothing" symptom).
        let reason = ''
        try { reason = ((await res.json()) as { error?: string })?.error ?? '' } catch { /* non-JSON body */ }
        toast.error(
          reason === 'terminal_limit_exceeded' ? i18n.t('terminal:errors.limitReached', { max: TERMINAL_MAX_PER_PROJECT })
            : reason === 'terminal_spawn_failed' ? i18n.t('terminal:errors.spawnFailed')
            : reason === 'terminal_name_invalid' ? i18n.t('terminal:errors.invalidName')
            : i18n.t('terminal:errors.openFailed'),
        )
        return null
      }
      const body = await res.json() as { session: TerminalRef }
      const session = body.session
      // Bootstrap xterm + WS
      ensureXtermForSession(
        projectId, session.id, session.cols, session.rows,
        xtermHandles.current, sessionOwners.current, hostRef.current,
        DEFAULT_TERMINAL_SETTINGS, undefined, undefined,
        true, // isFreshSpawn — eligible for sentinel-not-seen toast
      )
      updateProject(projectId, (s) => ({
        ...s,
        sessions: [...s.sessions, session],
        activeId: session.id,
      }))
      return session
    } catch {
      toast.error(i18n.t('terminal:errors.serverUnreachable'))
      return null
    }
  }, [updateProject])

  const createAndType = useCallback(async (projectId: string, text: string, opts?: { cols?: number; rows?: number; name?: string }): Promise<TerminalRef | null> => {
    const session = await create(projectId, opts)
    if (!session) return null
    const handle = xtermHandles.current.get(session.id)
    if (!handle) return session
    const send = () => {
      const ws = handle.ws
      if (!ws) return
      try { ws.send(new TextEncoder().encode(text)) } catch { /* ignore */ }
    }
    if (handle.ws && handle.ws.readyState === WebSocket.OPEN) {
      // Defer one tick so xterm finishes its initial fit/render before the PTY
      // sees input — otherwise the server may resize after we type.
      setTimeout(send, 50)
    } else if (handle.ws) {
      handle.ws.addEventListener('open', () => setTimeout(send, 50), { once: true })
    }
    return session
  }, [])

  const writeToSession = useCallback((sessionId: string, text: string): boolean => {
    const handle = xtermHandles.current.get(sessionId)
    if (!handle?.ws || handle.ws.readyState !== WebSocket.OPEN) return false
    try {
      handle.ws.send(new TextEncoder().encode(text))
      try { handle.term.focus() } catch { /* ignore */ }
      return true
    } catch { return false }
  }, [])

  const rename = useCallback(async (projectId: string, id: string, name: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/terminals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) return false
      const body = await res.json() as { session: TerminalRef }
      updateProject(projectId, (s) => ({
        ...s,
        sessions: s.sessions.map((r) => (r.id === id ? { ...r, name: body.session.name } : r)),
      }))
      return true
    } catch { return false }
  }, [updateProject])

  const kill = useCallback(async (projectId: string, id: string): Promise<void> => {
    // Optimistic: dispose xterm + remove ref
    const h = xtermHandles.current.get(id)
    if (h) { disposeHandle(h); xtermHandles.current.delete(id); sessionOwners.current.delete(id); disposeMarksSession(id) }
    updateProject(projectId, (s) => {
      const remaining = s.sessions.filter((r) => r.id !== id)
      const activeId = s.activeId === id ? (remaining[0]?.id ?? null) : s.activeId
      return { ...s, sessions: remaining, activeId }
    })
    try {
      await fetch(`${API_ORIGIN}/api/projects/${projectId}/terminals/${id}`, { method: 'DELETE' })
    } catch { /* best effort — state already removed locally */ }
  }, [updateProject])

  const focusActive = useCallback((projectId: string) => {
    const s = statesRef.current[projectId]
    if (!s?.activeId) return
    const h = xtermHandles.current.get(s.activeId)
    if (h?.attached) {
      try { h.term.focus() } catch { /* ignore */ }
    }
  }, [])

  const disposeProject = useCallback((projectId: string) => {
    // Called when a project is removed from the app
    for (const [sid, owner] of sessionOwners.current.entries()) {
      if (owner !== projectId) continue
      const h = xtermHandles.current.get(sid)
      if (h) { disposeHandle(h); xtermHandles.current.delete(sid) }
      sessionOwners.current.delete(sid)
    }
    setStates((prev) => {
      if (!prev[projectId]) return prev
      const { [projectId]: _drop, ...rest } = prev
      void _drop
      return rest
    })
    try { localStorage.removeItem(storageKey(projectId)) } catch { /* ignore */ }
  }, [])

  const getContainer = useCallback((sessionId: string): HTMLDivElement | null => {
    const h = xtermHandles.current.get(sessionId)
    return h?.container ?? null
  }, [])

  const notifyAdopted = useCallback((sessionId: string) => {
    const h = xtermHandles.current.get(sessionId)
    if (!h) return
    const justOpened = !h.term.element || h.term.element.parentElement !== h.container
    h.attached = true
    if (justOpened) {
      try { h.term.open(h.container) } catch { /* ignore */ }
      // After xterm is opened, decide on renderer.
      const mode = h.settings.renderMode
      const wantWebgl = mode === 'webgl' || (mode === 'auto' && webgl2Available())
      if (wantWebgl && !h.webgl) {
        void tryLoadWebgl(h.term).then((addon) => {
          if (addon) h.webgl = addon
        })
      }
    }
    try { h.fit.fit() } catch { /* ignore */ }
    try { h.term.focus() } catch { /* ignore */ }
    // Send resize to server based on the fit result
    const cols = h.term.cols, rows = h.term.rows
    if (h.ws && h.ws.readyState === WebSocket.OPEN) {
      try { h.ws.send(JSON.stringify({ type: 'resize', cols, rows })) } catch { /* ignore */ }
    }
  }, [])

  const refitActive = useCallback((sessionId: string) => {
    const h = xtermHandles.current.get(sessionId)
    if (!h || !h.attached) return
    try { h.fit.fit() } catch { /* ignore */ }
    if (h.ws && h.ws.readyState === WebSocket.OPEN) {
      try { h.ws.send(JSON.stringify({ type: 'resize', cols: h.term.cols, rows: h.term.rows })) } catch { /* ignore */ }
    }
  }, [])

  const subscribeMarks = useCallback((sessionId: string, fn: (m: MarkFrame) => void) => {
    const h = xtermHandles.current.get(sessionId)
    if (!h) return () => {}
    h.markListeners.add(fn)
    return () => { h.markListeners.delete(fn) }
  }, [])

  const getCwd = useCallback((sessionId: string): string | null => {
    return xtermHandles.current.get(sessionId)?.currentCwd ?? Object.values(statesRef.current).flatMap((state) => state.sessions).find((session) => session.id === sessionId)?.cwd ?? null
  }, [])

  const getShell = useCallback((sessionId: string): string | null => {
    return Object.values(statesRef.current).flatMap((state) => state.sessions).find((session) => session.id === sessionId)?.shell ?? null
  }, [])

  const getSearchAddon = useCallback((sessionId: string): SearchAddon | null => {
    return xtermHandles.current.get(sessionId)?.search ?? null
  }, [])

  const getTerminalInstance = useCallback((sessionId: string): Terminal | null => {
    return xtermHandles.current.get(sessionId)?.term ?? null
  }, [])

  const subscribeOpenSearch = useCallback((sessionId: string, fn: () => void) => {
    const h = xtermHandles.current.get(sessionId)
    if (!h) return () => {}
    h.openSearchListeners.add(fn)
    return () => { h.openSearchListeners.delete(fn) }
  }, [])

  const value = useMemo<TerminalsContextValue>(() => ({
    states,
    getState, ensureProject, setVisibility, togglePanel, setUserHeight,
    setActive, create, createAndType, writeToSession, rename, kill, focusActive, disposeProject,
    getContainer, notifyAdopted, refitActive, subscribeMarks, getCwd, getShell,
    getSearchAddon, subscribeOpenSearch, getTerminalInstance,
  }), [states, getState, ensureProject, setVisibility, togglePanel, setUserHeight, setActive, create, createAndType, writeToSession, rename, kill, focusActive, disposeProject, getContainer, notifyAdopted, refitActive, subscribeMarks, getCwd, getShell, getSearchAddon, subscribeOpenSearch, getTerminalInstance])

  return <TerminalsContext.Provider value={value}>{children}</TerminalsContext.Provider>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

const NOOP_CONTEXT: TerminalsContextValue = {
  states: {},
  getState: (_id: string) => initialProjectState(null),
  ensureProject: () => {},
  setVisibility: () => {},
  togglePanel: () => {},
  setUserHeight: () => {},
  setActive: () => {},
  create: async () => null,
  createAndType: async () => null,
  writeToSession: () => false,
  rename: async () => false,
  kill: async () => {},
  focusActive: () => {},
  disposeProject: () => {},
  getContainer: () => null,
  notifyAdopted: () => {},
  refitActive: () => {},
  subscribeMarks: () => () => {},
  getCwd: () => null,
  getShell: () => null,
  getSearchAddon: () => null,
  subscribeOpenSearch: () => () => {},
  getTerminalInstance: () => null,
}

/**
 * Returns the terminal context. If called outside a TerminalsProvider (e.g. from
 * legacy mode or test harnesses that don't need terminal behavior), returns a
 * no-op implementation so callers don't crash.
 */
export function useTerminals(): TerminalsContextValue {
  const ctx = useContext(TerminalsContext)
  return ctx ?? NOOP_CONTEXT
}

export function useProjectTerminals(projectId: string | null | undefined): ProjectPanelState {
  const ctx = useTerminals()
  if (!projectId) return initialProjectState(null)
  return ctx.states[projectId] ?? initialProjectState(readStored(projectId))
}

// ─── xterm + WS bootstrap (exported for tests) ────────────────────────────────

type SettingsPersistFn = (projectId: string, patch: { fontSize?: number | null }) => void

function adjustFontSize(
  handles: Map<string, XtermHandle>,
  sessionId: string,
  projectId: string,
  delta: number | 'reset',
  onSettingsPersist?: SettingsPersistFn,
): void {
  const h = handles.get(sessionId)
  if (!h) return
  const current = h.term.options.fontSize ?? DEFAULT_TERMINAL_SETTINGS.fontSize
  let next: number
  if (delta === 'reset') {
    next = h.settings.fontSize
    if (onSettingsPersist) onSettingsPersist(projectId, { fontSize: null })
  } else {
    const candidate = current + delta
    if (candidate < TERMINAL_FONT_SIZE_MIN || candidate > TERMINAL_FONT_SIZE_MAX) return
    next = clampFontSize(candidate)
    if (onSettingsPersist) onSettingsPersist(projectId, { fontSize: next })
  }
  if (next === current) return
  try {
    h.term.options.fontSize = next
    h.fit.fit()
  } catch { /* ignore */ }
}

function jumpToPrompt(handles: Map<string, XtermHandle>, sessionId: string, dir: 'prev' | 'next'): void {
  const h = handles.get(sessionId)
  if (!h) return
  const { promptRows } = getMarks(sessionId)
  if (promptRows.length === 0) return
  const buffer = h.term.buffer.active
  const currentTop = buffer.viewportY
  let targetRow: number | null = null
  if (dir === 'prev') {
    for (let i = promptRows.length - 1; i >= 0; i--) {
      const r = promptRows[i].row
      if (r != null && r < currentTop) { targetRow = r; break }
    }
  } else {
    for (const p of promptRows) {
      const r = p.row
      if (r != null && r > currentTop) { targetRow = r; break }
    }
  }
  if (targetRow == null) return
  try { h.term.scrollToLine(targetRow) } catch { /* ignore */ }
}

function ensureXtermForSession(
  projectId: string,
  sessionId: string,
  cols: number,
  rows: number,
  handles: Map<string, XtermHandle>,
  owners: Map<string, string>,
  host: HTMLDivElement | null,
  settings: TerminalSettings = DEFAULT_TERMINAL_SETTINGS,
  onMark?: (m: MarkFrame) => void,
  onSettingsPersist?: SettingsPersistFn,
  /** True when this session was just spawned via POST /terminals (vs. reconciled
   *  from a server-side list during reattach). The sentinel-not-seen toast only
   *  fires for fresh spawns; reconnecting to a pre-existing PTY (e.g. server
   *  restart, project switch) must not produce a false alarm. */
  isFreshSpawn = false,
): XtermHandle {
  const existing = handles.get(sessionId)
  if (existing) return existing

  const container = document.createElement('div')
  container.style.width = '100%'
  container.style.height = '100%'
  container.className = 'specrails-xterm-container'

  const term = new Terminal({
    cols, rows,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    theme: getActiveTheme().xterm,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
  })
  const fit = new FitAddon()
  const webLinks = new WebLinksAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(webLinks)
  term.loadAddon(search)

  // Custom keybindings: returns false to consume, true to let xterm pass through.
  term.attachCustomKeyEventHandler((event) => {
    // Only react on keydown; let keyup events pass.
    if (event.type !== 'keydown') return true
    const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')
    const cmd = isMac ? event.metaKey : event.ctrlKey
    if (!cmd) return true
    const key = event.key

    // Cmd+C — copy if there is a selection; otherwise let xterm pass it (so Ctrl+C reaches PTY).
    if (key === 'c' || key === 'C') {
      const sel = term.getSelection()
      if (sel.length === 0) return true
      void writeClipboardText(sel)
      event.preventDefault()
      return false
    }
    // Cmd+V — paste from clipboard via term.paste so bracketed-paste mode is honoured.
    // Use the Tauri clipboard plugin so macOS WebKit does not show the system
    // "Paste" permission popup that navigator.clipboard.readText() triggers.
    if (key === 'v' || key === 'V') {
      void readClipboardText().then((text) => {
        if (text) { try { term.paste(text) } catch { /* ignore */ } }
      })
      event.preventDefault()
      return false
    }
    // Cmd+K — clear scrollback.
    if (key === 'k' || key === 'K') {
      try { term.clear() } catch { /* ignore */ }
      event.preventDefault()
      return false
    }
    // Cmd+F — open search overlay (subscribers in TerminalViewport handle UI state).
    if (key === 'f' || key === 'F') {
      event.preventDefault()
      const handle = handles.get(sessionId)
      if (handle) {
        for (const fn of handle.openSearchListeners) { try { fn() } catch { /* ignore */ } }
      }
      return false
    }
    // Cmd+= / Cmd++ / Cmd+- zoom font.
    if (key === '=' || key === '+') {
      event.preventDefault()
      adjustFontSize(handles, sessionId, projectId, +1, onSettingsPersist)
      return false
    }
    if (key === '-' || key === '_') {
      event.preventDefault()
      adjustFontSize(handles, sessionId, projectId, -1, onSettingsPersist)
      return false
    }
    // Cmd+0 — reset to resolved default.
    if (key === '0') {
      event.preventDefault()
      adjustFontSize(handles, sessionId, projectId, 'reset', onSettingsPersist)
      return false
    }
    // Cmd+ArrowUp / Cmd+ArrowDown — jump to previous/next prompt mark.
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault()
      jumpToPrompt(handles, sessionId, key === 'ArrowUp' ? 'prev' : 'next')
      return false
    }
    return true
  })

  // Unicode 11 widths — load unconditionally (silent no-op if font lacks the glyphs).
  try {
    const u11 = new Unicode11Addon()
    term.loadAddon(u11)
    term.unicode.activeVersion = '11'
  } catch { /* addon not available — degrade silently */ }

  // Image addon — load only when imageRendering is enabled in settings.
  if (settings.imageRendering) {
    void loadImageAddon(term)
  }

  // Ligatures — silent no-op when the font has no ligature features.
  void loadLigaturesAddon(term)

  if (host) host.appendChild(container)

  // Use WS_URL (not window.location) — the vite dev server runs on 4201 without
  // WS proxying, while the Express server (real PTY endpoint) lives on 4200.
  // WS_URL already handles dev / production browser / Tauri cases.
  const wsBase = WS_URL || (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
    : 'ws://localhost:4200')
  const wsUrl = `${wsBase}/ws/terminal/${sessionId}?projectId=${encodeURIComponent(projectId)}`

  const protocol = getDesktopTokenProtocol()
  const ws = protocol ? new WebSocket(wsUrl, ['specrails-desktop', protocol]) : new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'

  const disposers: Array<() => void> = []

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      // Control frame
      try {
        const msg = JSON.parse(ev.data) as { type?: string; name?: string; kind?: string; ts?: number; code?: number | null; signal?: number | null; early?: boolean; payload?: { exitCode?: number; path?: string } }
        if (msg?.type === 'ready') {
          // nothing to do — we already allocated xterm
          return
        }
        if (msg?.type === 'exit') {
          // The PTY ended; the server tells us why so we don't show a silent
          // black pane. `early` means it died right after spawn (probable
          // failed start), surfaced as an error toast unless the user typed.
          const handle = handles.get(sessionId)
          if (handle) showSessionEnded(handle, msg.code ?? null, !!msg.early)
          return
        }
        if (msg?.type === 'mark' && typeof msg.kind === 'string' && typeof msg.ts === 'number') {
          const handle = handles.get(sessionId)
          if (handle) {
            if (msg.kind === 'cwd' && msg.payload?.path) handle.currentCwd = msg.payload.path
            const frame: MarkFrame = {
              type: 'mark',
              kind: msg.kind as MarkFrame['kind'],
              payload: msg.payload,
              ts: msg.ts,
              sessionId,
            }
            // Persist into the module-level mark store so React subscribers re-render.
            const buffer = handle.term.buffer.active
            const row = msg.kind === 'prompt-start' ? buffer.cursorY + buffer.viewportY : null
            const beforeIngest = msg.kind === 'post-exec' ? getMarks(sessionId).openPreExec?.startedAt ?? null : null
            ingestMark(sessionId, msg as { kind: string; ts: number; payload?: { exitCode?: number; path?: string } }, { row })
            // Long-running command notification: fire when a post-exec arrives,
            // window is unfocused, and threshold is exceeded.
            if (msg.kind === 'post-exec' && beforeIngest != null && shouldNotify()) {
              const elapsed = msg.ts - beforeIngest
              const longThreshold = handle.settings.longCommandThresholdMs
              const notifyEnabled = handle.settings.notifyOnCompletion
              if (notifyEnabled && elapsed >= longThreshold) {
                void notifyCommandFinished(sessionId, {
                  command: null, // we don't capture the user's command on the client
                  exitCode: msg.payload?.exitCode ?? null,
                  elapsedMs: elapsed,
                })
              }
            }
            for (const fn of handle.markListeners) {
              try { fn(frame) } catch { /* listener error must not break stream */ }
            }
            if (onMark) onMark(frame)
          }
        }
      } catch { /* ignore */ }
      return
    }
    // Binary frame (scrollback or live)
    const h = handles.get(sessionId)
    if (h) h.gotData = true
    const buf = new Uint8Array(ev.data as ArrayBuffer)
    try { term.write(buf) } catch { /* ignore */ }
  }

  /** Show a one-time "process exited" notice in the terminal, and (for an
   *  early death the user did not provoke) an error toast. Idempotent via
   *  handle.exitShown so the exit frame and the socket close don't double up. */
  const showSessionEnded = (h: XtermHandle, code: number | null, early: boolean): void => {
    if (h.exitShown) return
    h.exitShown = true
    try {
      const exitedText = code === null
        ? i18n.t('terminal:session.processExited')
        : i18n.t('terminal:session.processExitedWithCode', { code })
      h.term.write(`\r\n\x1b[2m${exitedText}\x1b[0m\r\n`)
    } catch { /* ignore */ }
    if (early && !h.gotUserInput) {
      toast.error(i18n.t('terminal:errors.exitedImmediately'))
    }
  }

  ws.onclose = (ev) => {
    // Distinguish a deliberate client teardown (kill / project switch) from an
    // unexpected death. For the latter, surface a reason instead of leaving a
    // silent black pane. The server sends an explicit `exit` frame before
    // closing when it can; this close handler is the fallback (e.g. a raw drop).
    const h = handles.get(sessionId)
    if (!h || h.disposing || h.exitShown) return
    const reason = typeof ev?.reason === 'string' ? ev.reason : ''
    const earlyByReason = reason === 'pty_exit_early'
    const earlyByTiming = h.openedAt > 0 && (Date.now() - h.openedAt) < 3000 && !h.gotData && !h.gotUserInput
    showSessionEnded(h, null, earlyByReason || earlyByTiming)
  }

  // Forward user input to the server as binary
  const onDataSub = term.onData((data) => {
    const h = handles.get(sessionId)
    if (h) h.gotUserInput = true
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(new TextEncoder().encode(data)) } catch { /* ignore */ }
    }
  })
  disposers.push(() => onDataSub.dispose())

  // Propagate container resizes to the PTY with a trailing 120ms debounce so
  // sidebar-transition tick-storms coalesce into a single resize.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const RESIZE_DEBOUNCE_MS = 120
  const fitAndSend = () => {
    if (!container.isConnected) return
    try { fit.fit() } catch { return }
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) } catch { /* ignore */ }
    }
  }
  const scheduleFit = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { debounceTimer = null; fitAndSend() }, RESIZE_DEBOUNCE_MS)
  }
  ws.onopen = () => {
    const h = handles.get(sessionId)
    if (h) h.openedAt = Date.now()
    // Sync the PTY size to the already-fitted viewport. notifyAdopted handles the
    // adopt-after-open case; this handles open-after-adopt so the PTY never stays
    // stuck at the 80x24 create-time default in a wide panel.
    fitAndSend()
  }
  const ro = new ResizeObserver(scheduleFit)
  ro.observe(container)
  disposers.push(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
    ro.disconnect()
  })

  const handle: XtermHandle = {
    term, fit, webLinks, search, webgl: null, settings,
    container, ws, attached: false, disposers,
    openedAt: 0, gotData: false, gotUserInput: false, disposing: false, exitShown: false,
    currentCwd: null,
    markListeners: new Set<(ev: MarkFrame) => void>(),
    openSearchListeners: new Set<() => void>(),
  }
  // Sentinel-not-seen detection: if shell integration was requested but no
  // prompt-start mark arrives within 5s, the shim probably didn't bootstrap
  // (user's rc clobbered the hooks, or the shell is unsupported). We track this
  // silently — the gutter / timing badge / notifications just won't appear and
  // the user can read about it in the docs. No toast; the false positives in
  // tmux + restart scenarios were too noisy.
  void isFreshSpawn
  handles.set(sessionId, handle)
  owners.set(sessionId, projectId)
  return handle
}

// ─── Optional addon loaders (lazy import keeps initial bundle small) ──────────

async function loadImageAddon(term: Terminal): Promise<void> {
  try {
    const mod = await import('@xterm/addon-image')
    const ImageAddon = mod.ImageAddon
    const addon = new ImageAddon({ pixelLimit: 8_000_000 })
    term.loadAddon(addon)
  } catch { /* image addon optional */ }
}

async function loadLigaturesAddon(term: Terminal): Promise<void> {
  try {
    const mod = await import('@xterm/addon-ligatures')
    const LigaturesAddon = mod.LigaturesAddon
    term.loadAddon(new LigaturesAddon())
  } catch { /* font may lack ligature features */ }
}

/** Attach WebGL renderer to a Terminal. Caller has already confirmed renderMode allows it. */
export async function tryLoadWebgl(term: Terminal): Promise<{ dispose: () => void } | null> {
  try {
    const mod = await import('@xterm/addon-webgl')
    const WebglAddon = mod.WebglAddon
    const addon = new WebglAddon()
    addon.onContextLoss(() => { try { addon.dispose() } catch { /* ignore */ } })
    term.loadAddon(addon)
    return addon
  } catch {
    return null
  }
}

export function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('experimental-webgl2'))
  } catch { return false }
}

function disposeHandle(handle: XtermHandle): void {
  // Mark intent first so the ws.onclose handler treats this as a deliberate
  // teardown (no "process exited" notice / failure toast).
  handle.disposing = true
  for (const d of handle.disposers) { try { d() } catch { /* ignore */ } }
  handle.disposers = []
  handle.markListeners.clear()
  handle.openSearchListeners.clear()
  try { handle.ws?.close(1000, 'client_dispose') } catch { /* ignore */ }
  handle.ws = null
  try { handle.webgl?.dispose() } catch { /* ignore */ }
  handle.webgl = null
  try { handle.term.dispose() } catch { /* ignore */ }
  try { handle.container.remove() } catch { /* ignore */ }
  // Mark store cleanup happens at the call site (we don't have sessionId here),
  // but we expose the helper for consumers.
}
