import { useEffect, useRef, useCallback, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { FEATURE_AGENTS_SECTION } from '../lib/feature-flags'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Shortcut {
  keys: string          // Display string, e.g. "G P" or "?"
  /** i18n key in the `commands` namespace — translated at render time by the cheatsheet. */
  descriptionKey: string
  category: 'navigation' | 'actions' | 'general'
}

// All registered shortcuts for the cheatsheet
export const SHORTCUTS: Shortcut[] = [
  // General
  { keys: '?', descriptionKey: 'shortcuts.items.showCheatsheet', category: 'general' },
  { keys: 'Esc', descriptionKey: 'shortcuts.items.closeModal', category: 'general' },
  { keys: '⌘B', descriptionKey: 'shortcuts.items.toggleRightSidebar', category: 'general' },
  { keys: '⌥⌘B', descriptionKey: 'shortcuts.items.toggleLeftSidebar', category: 'general' },
  { keys: '⌘J', descriptionKey: 'shortcuts.items.toggleTerminal', category: 'general' },
  {
    keys: FEATURE_AGENTS_SECTION ? '⌘1–5' : '⌘1–4',
    descriptionKey: FEATURE_AGENTS_SECTION
      ? 'shortcuts.items.navigateProjectPageWithAgents'
      : 'shortcuts.items.navigateProjectPage',
    category: 'general',
  },
  { keys: '⌥⌘1–9', descriptionKey: 'shortcuts.items.switchProject', category: 'general' },

  // Navigation
  { keys: 'G D', descriptionKey: 'shortcuts.items.goDashboard', category: 'navigation' },
  { keys: 'G J', descriptionKey: 'shortcuts.items.goActivity', category: 'navigation' },
  { keys: 'G A', descriptionKey: 'shortcuts.items.goAnalytics', category: 'navigation' },
  { keys: 'G S', descriptionKey: 'shortcuts.items.goSettings', category: 'navigation' },

  // Actions (contextual)
  { keys: 'J', descriptionKey: 'shortcuts.items.nextItem', category: 'actions' },
  { keys: 'K', descriptionKey: 'shortcuts.items.prevItem', category: 'actions' },
]

// ─── Input detection ─────────────────────────────────────────────────────────

function isEditableTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

function isInsideDialog(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el || typeof (el as { closest?: unknown }).closest !== 'function') return false
  return !!el.closest('[role="dialog"]')
}

function isInsideXterm(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el || typeof (el as { closest?: unknown }).closest !== 'function') return false
  return !!el.closest('.specrails-xterm-container, .xterm')
}

// ─── Hook ────────────────────────────────────────────────────────────────────

interface UseKeyboardShortcutsOptions {
  /** Callback to open cheatsheet modal */
  onOpenCheatsheet: () => void
  /** Optional contextual callbacks */
  onListNavigate?: (direction: 'up' | 'down') => void
  /** Sidebar toggles */
  onToggleLeftSidebar?: () => void
  onToggleRightSidebar?: () => void
  /** Switch to project by 1-based index */
  onSwitchProject?: (index: number) => void
  /** Navigate to project page by 1-based index (Dashboard, Jobs, Analytics, Agents, Settings…) */
  onSwitchProjectPage?: (index: number) => void
  /** Toggle the bottom terminal panel (Cmd+J / Ctrl+J) */
  onToggleTerminalPanel?: () => void
  /** Toggle the global agent chat (Cmd+K / Ctrl+K) */
  onToggleAgentChat?: () => void
}

export function useKeyboardShortcuts({
  onOpenCheatsheet,
  onListNavigate,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  onSwitchProject,
  onSwitchProjectPage,
  onToggleTerminalPanel,
  onToggleAgentChat,
}: UseKeyboardShortcutsOptions) {
  const navigate = useNavigate()
  const location = useLocation()
  const pendingPrefix = useRef<string | null>(null)
  const prefixTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Stable refs so the keydown handler never goes stale
  const onOpenCheatsheetRef = useRef(onOpenCheatsheet)
  onOpenCheatsheetRef.current = onOpenCheatsheet
  const onListNavigateRef = useRef(onListNavigate)
  onListNavigateRef.current = onListNavigate
  const onToggleLeftSidebarRef = useRef(onToggleLeftSidebar)
  onToggleLeftSidebarRef.current = onToggleLeftSidebar
  const onToggleRightSidebarRef = useRef(onToggleRightSidebar)
  onToggleRightSidebarRef.current = onToggleRightSidebar
  const onSwitchProjectRef = useRef(onSwitchProject)
  onSwitchProjectRef.current = onSwitchProject
  const onSwitchProjectPageRef = useRef(onSwitchProjectPage)
  onSwitchProjectPageRef.current = onSwitchProjectPage
  const onToggleTerminalPanelRef = useRef(onToggleTerminalPanel)
  onToggleTerminalPanelRef.current = onToggleTerminalPanel
  const onToggleAgentChatRef = useRef(onToggleAgentChat)
  onToggleAgentChatRef.current = onToggleAgentChat
  const locationRef = useRef(location)
  locationRef.current = location

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // ⌘J / Ctrl+J → toggle terminal panel (allowed from xterm too — xterm captures
      // keystrokes but we want this shortcut to work even when terminal is focused).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyJ') {
        if (isInsideDialog(e)) return
        e.preventDefault()
        onToggleTerminalPanelRef.current?.()
        return
      }

      // ⌘K / Ctrl+K → toggle the global agent chat (works from anywhere except
      // an open dialog, so it doesn't hijack other modals' own Cmd+K).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
        if (isInsideDialog(e)) return
        e.preventDefault()
        onToggleAgentChatRef.current?.()
        return
      }

      // Never intercept when typing in inputs or when an xterm has focus
      if (isEditableTarget(e)) return
      if (isInsideXterm(e)) return
      if (isInsideDialog(e)) return

      // ⌘B → toggle right sidebar  (e.code avoids Option layer chars like '∫')
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyB') {
        e.preventDefault()
        onToggleRightSidebarRef.current?.()
        return
      }

      // ⌥⌘B → toggle left sidebar
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyB') {
        e.preventDefault()
        onToggleLeftSidebarRef.current?.()
        return
      }

      // ⌘1–⌘9 → navigate to project page by index
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const match = e.code.match(/^Digit([1-9])$/)
        if (match) {
          e.preventDefault()
          onSwitchProjectPageRef.current?.(parseInt(match[1], 10))
          return
        }
      }

      // ⌥⌘1–⌥⌘9 → switch to project by index
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey) {
        const match = e.code.match(/^Digit([1-9])$/)
        if (match) {
          e.preventDefault()
          onSwitchProjectRef.current?.(parseInt(match[1], 10))
          return
        }
      }

      // Don't intercept other modifier combos
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const key = e.key

      // ─── Second key of a G-sequence ──────────────────────────────────
      if (pendingPrefix.current === 'g') {
        if (prefixTimer.current) clearTimeout(prefixTimer.current)
        pendingPrefix.current = null

        const upper = key.toUpperCase()
        const routes: Record<string, string> = {
          D: '/',
          P: '/',         // G P → projects/dashboard
          J: '/activity',
          A: '/analytics',
          S: '/settings',
        }

        if (routes[upper]) {
          e.preventDefault()
          navigate(routes[upper])
          return
        }
        // Unknown second key — fall through
        return
      }

      // ─── First key handlers ──────────────────────────────────────────

      // ? → cheatsheet
      if (key === '?') {
        e.preventDefault()
        onOpenCheatsheetRef.current()
        return
      }

      // G → start sequence
      if (key === 'g') {
        e.preventDefault()
        pendingPrefix.current = 'g'
        prefixTimer.current = setTimeout(() => {
          pendingPrefix.current = null
        }, 800)
        return
      }

      // J/K → list navigation
      if (key === 'j') {
        onListNavigateRef.current?.('down')
        return
      }
      if (key === 'k') {
        onListNavigateRef.current?.('up')
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      if (prefixTimer.current) clearTimeout(prefixTimer.current)
    }
  }, [navigate])
}

// ─── Cheatsheet state hook ───────────────────────────────────────────────────

export function useCheatsheetState() {
  const [open, setOpen] = useState(false)
  const openCheatsheet = useCallback(() => setOpen(true), [])
  const closeCheatsheet = useCallback(() => setOpen(false), [])
  return { cheatsheetOpen: open, setCheatsheetOpen: setOpen, openCheatsheet, closeCheatsheet }
}
