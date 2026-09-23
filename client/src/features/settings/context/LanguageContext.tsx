import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from 'react'
import {
  LANGUAGES,
  LANGUAGE_LOCAL_STORAGE_KEY,
  isLanguageId,
  getActiveLanguage,
  setLanguage as applyLanguageRuntime,
  type LanguageId,
  type LanguageDescriptor,
} from '../../../lib/i18n'
import { getDesktopToken } from '../../../lib/auth'

/**
 * Build headers including the app auth token. Defense-in-depth: the global
 * fetch interceptor in `lib/auth.ts` also attaches X-Desktop-Token to /api/*
 * requests, but explicit attachment here means language switches work even if
 * the interceptor has not yet been installed.
 */
function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  const token = getDesktopToken()
  if (token) headers['X-Desktop-Token'] = token
  return headers
}

interface LanguageContextValue {
  /** Current active language ID — re-renders consumers on change. */
  languageId: LanguageId
  /** Active language descriptor (native name etc.). */
  language: LanguageDescriptor
  /** Switch language hot: updates i18next, localStorage, and persists to server. */
  setLanguage: (id: LanguageId) => Promise<void>
  /** True while a switch is in flight (server PATCH pending). */
  isUpdating: boolean
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

function persistLanguageToLocalStorage(id: LanguageId): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(LANGUAGE_LOCAL_STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

function removeLanguageFromLocalStorage(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(LANGUAGE_LOCAL_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

interface LanguageProviderProps {
  children: ReactNode
  /** Test seam: override fetch/PATCH target. Defaults to real `/api/language`. */
  endpoint?: string
}

/**
 * Desktop-wide language provider. Mirrors ThemeProvider's reconcile pattern:
 *  - Boot value comes from `initI18n()` in main.tsx (localStorage → OS
 *    language → English).
 *  - On mount, reconcile against the server. The server only stores an
 *    EXPLICIT user choice; `{ language: null }` means "never chosen" and the
 *    boot (OS-detected) value is kept without persisting it.
 *  - `setLanguage` applies optimistically (hot switch, no restart), mirrors
 *    to localStorage, then PATCHes the server; failure reverts everywhere.
 */
export function LanguageProvider({ children, endpoint = '/api/language' }: LanguageProviderProps) {
  const [languageId, setLanguageIdState] = useState<LanguageId>(() => getActiveLanguage())
  const [isUpdating, setIsUpdating] = useState(false)
  const reconciledOnMount = useRef(false)

  useEffect(() => {
    if (reconciledOnMount.current) return
    reconciledOnMount.current = true
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(endpoint, { headers: authedHeaders() })
        if (!res.ok) return
        const data = (await res.json()) as { language?: unknown }
        if (cancelled) return
        // Adopt the server value only when it is an explicit stored choice.
        if (isLanguageId(data.language) && data.language !== getActiveLanguage()) {
          await applyLanguageRuntime(data.language)
          persistLanguageToLocalStorage(data.language)
          if (!cancelled) setLanguageIdState(data.language)
        }
      } catch {
        // Server unreachable — keep boot value. Best-effort reconcile.
      }
    })()
    return () => {
      cancelled = true
    }
    // Only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint])

  const setLanguage = useCallback(
    async (next: LanguageId): Promise<void> => {
      if (next === languageId) return
      const previous = languageId
      const hadStoredChoice =
        typeof localStorage !== 'undefined' &&
        isLanguageId(localStorage.getItem(LANGUAGE_LOCAL_STORAGE_KEY))

      // Optimistic apply: hot-switch immediately, mirror to localStorage.
      await applyLanguageRuntime(next)
      persistLanguageToLocalStorage(next)
      setLanguageIdState(next)
      setIsUpdating(true)

      try {
        const res = await fetch(endpoint, {
          method: 'PATCH',
          headers: authedHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ language: next }),
        })
        if (!res.ok) throw new Error(`server rejected language: ${res.status}`)
      } catch (err) {
        // Revert on failure — restore previous language everywhere.
        await applyLanguageRuntime(previous)
        if (hadStoredChoice) persistLanguageToLocalStorage(previous)
        else removeLanguageFromLocalStorage()
        setLanguageIdState(previous)
        throw err
      } finally {
        setIsUpdating(false)
      }
    },
    [languageId, endpoint]
  )

  const value = useMemo<LanguageContextValue>(
    () => ({ languageId, language: LANGUAGES[languageId], setLanguage, isUpdating }),
    [languageId, setLanguage, isUpdating]
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider')
  return ctx
}

/**
 * Non-throwing variant. Returns null when no `<LanguageProvider>` is mounted —
 * production renders always mount one; the null branch only hits in unit
 * tests exercising components in isolation.
 */
export function useLanguageOptional(): LanguageContextValue | null {
  return useContext(LanguageContext)
}
