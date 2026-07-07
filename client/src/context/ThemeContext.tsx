import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from 'react'
import {
  THEMES,
  DEFAULT_THEME,
  LEGACY_THEME_ID_MAP,
  THEME_LOCAL_STORAGE_KEY,
  isThemeId,
  type ThemeId,
  type ThemeDescriptor,
} from '../lib/themes'
import { getActiveTheme } from '../lib/theme-palette'
import { getDesktopToken } from '../lib/auth'

/**
 * Build headers including the app auth token. Defense-in-depth: the global
 * fetch interceptor in `lib/auth.ts` also attaches X-Desktop-Token to /api/*
 * requests, but explicit attachment here means theme switches work even if
 * the interceptor has not yet been installed (e.g. very early in boot, or
 * in test environments that bypass `installFetchInterceptor`).
 */
function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  const token = getDesktopToken()
  if (token) headers['X-Desktop-Token'] = token
  return headers
}

interface ThemeContextValue {
  /** Current active theme descriptor — re-renders consumers on change. */
  theme: ThemeDescriptor
  /** Current active theme ID. */
  themeId: ThemeId
  /** Switch theme: updates DOM, localStorage, and persists to server. */
  setTheme: (id: ThemeId) => Promise<void>
  /** True while a switch is in flight (server PATCH pending). */
  isUpdating: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function normalizeThemeId(value: unknown): ThemeId | null {
  if (isThemeId(value)) return value
  if (typeof value === 'string') return LEGACY_THEME_ID_MAP[value] ?? null
  return null
}

function readBootTheme(): ThemeId {
  if (typeof document === 'undefined') return DEFAULT_THEME
  const attr = document.documentElement.dataset.theme
  const attrTheme = normalizeThemeId(attr)
  if (attrTheme) {
    if (attrTheme !== attr) {
      applyThemeToDocument(attrTheme)
      persistThemeToLocalStorage(attrTheme)
    }
    return attrTheme
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const v = localStorage.getItem(THEME_LOCAL_STORAGE_KEY)
      const storedTheme = normalizeThemeId(v)
      if (storedTheme) {
        if (storedTheme !== v) {
          applyThemeToDocument(storedTheme)
          persistThemeToLocalStorage(storedTheme)
        }
        return storedTheme
      }
    } catch { /* ignore */ }
  }
  return DEFAULT_THEME
}

function applyThemeToDocument(id: ThemeId): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = id
}

function persistThemeToLocalStorage(id: ThemeId): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(THEME_LOCAL_STORAGE_KEY, id) } catch { /* ignore */ }
}

interface ThemeProviderProps {
  children: ReactNode
  /**
   * Test seam: override fetch/PATCH targets. Defaults to real `/api/theme`.
   */
  endpoint?: string
}

export function ThemeProvider({ children, endpoint = '/api/theme' }: ThemeProviderProps) {
  const [themeId, setThemeIdState] = useState<ThemeId>(() => readBootTheme())
  const [isUpdating, setIsUpdating] = useState(false)
  const reconciledOnMount = useRef(false)

  // On mount: reconcile against server. If server differs from boot value,
  // adopt server (cross-device source of truth) and refresh localStorage.
  useEffect(() => {
    if (reconciledOnMount.current) return
    reconciledOnMount.current = true
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(endpoint, { headers: authedHeaders() })
        if (!res.ok) return
        const data = (await res.json()) as { theme?: unknown }
        if (cancelled) return
        const serverTheme = normalizeThemeId(data.theme)
        if (serverTheme && serverTheme !== themeId) {
          applyThemeToDocument(serverTheme)
          persistThemeToLocalStorage(serverTheme)
          setThemeIdState(serverTheme)
        }
      } catch {
        // Server unreachable — keep boot value. No throw, no toast: this is
        // a best-effort reconcile, not a blocking operation.
      }
    })()
    return () => { cancelled = true }
  // Only run once on mount; themeId is read inside the effect via closure but
  // we deliberately don't re-fire on themeId changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint])

  const setTheme = useCallback(async (next: ThemeId): Promise<void> => {
    if (next === themeId) return
    const previous = themeId

    // Optimistic apply: paint immediately, mirror to localStorage.
    applyThemeToDocument(next)
    persistThemeToLocalStorage(next)
    setThemeIdState(next)
    setIsUpdating(true)

    try {
      const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: authedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ theme: next }),
      })
      if (!res.ok) throw new Error(`server rejected theme: ${res.status}`)
    } catch (err) {
      // Revert on failure — restore previous theme everywhere.
      applyThemeToDocument(previous)
      persistThemeToLocalStorage(previous)
      setThemeIdState(previous)
      throw err
    } finally {
      setIsUpdating(false)
    }
  }, [themeId, endpoint])

  // Memoise so the many useActiveTheme/useTheme consumers (charts, xterm, code
  // explorer, …) only re-render on an actual theme/isUpdating change.
  const value = useMemo<ThemeContextValue>(
    () => ({ theme: THEMES[themeId], themeId, setTheme, isUpdating }),
    [themeId, setTheme, isUpdating],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}

/**
 * Non-throwing variant. Returns null when no `<ThemeProvider>` is mounted —
 * useful for low-level providers (e.g. TerminalsContext) that should still
 * render in tests that exercise them in isolation. Production renders mount
 * ThemeProvider above these consumers, so the null branch never hits at
 * runtime — only in unit tests.
 */
export function useThemeOptional(): ThemeContextValue | null {
  return useContext(ThemeContext)
}

/**
 * Read-only theme accessor with a graceful fallback. Always returns a
 * `ThemeDescriptor`:
 *  - Inside a `<ThemeProvider>`: returns the active context theme (and
 *    re-renders on theme change).
 *  - Outside any provider (unit tests, isolated previews): falls back to
 *    `getActiveTheme()` reading `document.documentElement.dataset.theme` —
 *    static, but correct for the boot frame.
 *
 * Use this in presentational components (charts, decorative UI) that
 * shouldn't crash when mounted without a provider in test fixtures.
 */
export function useActiveTheme(): ThemeDescriptor {
  const ctx = useContext(ThemeContext)
  if (ctx) return ctx.theme
  return getActiveTheme()
}
