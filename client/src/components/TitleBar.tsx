import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Search, Square, X } from 'lucide-react'
import { useDesktop } from '../hooks/useDesktop'
import { useUiMode } from '../context/UiModeContext'

// ─── Detect Tauri environment ─────────────────────────────────────────────────

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// ─── Detect macOS (traffic lights active via titleBarStyle: Overlay) ─────────

function isMacOverlay(): boolean {
  return isTauriEnv() && /mac/i.test(navigator.platform)
}

// ─── Window control button ────────────────────────────────────────────────────

interface WinButtonProps {
  onClick: () => void
  icon: React.ReactNode
  hoverColor?: string
  hoverTextColor?: string
  ariaLabel: string
}

function WinButton({
  onClick,
  icon,
  hoverColor = 'var(--color-accent)',
  hoverTextColor = 'var(--color-accent-foreground)',
  ariaLabel,
}: WinButtonProps) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 34,
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
        border: 'none',
        cursor: 'pointer',
        background: hovered ? hoverColor : 'transparent',
        color: hovered ? hoverTextColor : 'var(--color-muted-foreground)',
        transition: 'background 0.12s ease, color 0.12s ease',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      {icon}
    </button>
  )
}

// ─── macOS search pill ────────────────────────────────────────────────────────

function SearchPill({ projectName, hidden = false }: { projectName: string | null; hidden?: boolean }) {
  const { t } = useTranslation('nav')
  const [hovered, setHovered] = useState(false)

  function handleClick() {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
    )
  }

  // Agent Mode hides the pill with a fade (stays mounted so the CSS transition
  // runs BOTH ways: fade-out entering agent, fade-in returning to kanban).
  return (
    <button
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={t('titleBar.searchShortcut')}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: `translate(-50%, -50%) scale(${hidden ? 0.96 : 1})`,
        width: '40%',
        maxWidth: 360,
        minWidth: 160,
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 9999,
        border: '1px solid color-mix(in srgb, var(--color-border) 70%, transparent)',
        cursor: 'pointer',
        background: hovered
          ? 'color-mix(in srgb, var(--color-accent) 82%, transparent)'
          : 'color-mix(in srgb, var(--color-surface) 72%, transparent)',
        color: projectName ? 'var(--color-foreground)' : 'var(--color-muted-foreground)',
        fontSize: 12,
        fontWeight: 400,
        letterSpacing: 0,
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? 'none' : 'auto',
        transition: 'background 0.12s ease, opacity 0.22s ease, transform 0.22s ease',
        // pill is clickable, not a drag target
        WebkitAppRegion: 'no-drag',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      } as React.CSSProperties}
    >
      <Search
        size={11}
        style={{ flexShrink: 0, opacity: projectName ? 0.72 : 0.48 }}
      />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {projectName ?? t('titleBar.searchPlaceholder')}
      </span>
    </button>
  )
}

// ─── TitleBar component ───────────────────────────────────────────────────────

/**
 * Custom frameless titlebar for the Tauri desktop app.
 *
 * macOS (titleBarStyle: Overlay): compact 28px drag region + centered search pill.
 * Windows/Linux: matching compact chrome with centered search pill and quiet
 * custom window controls.
 *
 * Renders null in browser / non-Tauri contexts — no impact on web usage.
 * Must be mounted as the very first child of the root layout so it sits at
 * the top of the window and the drag region covers the full width.
 */
export function TitleBar() {
  if (!isTauriEnv()) return null

  const macOverlay = isMacOverlay()

  if (macOverlay) {
    return <MacTitleBar />
  }

  return <DefaultTitleBar />
}

function MacTitleBar() {
  const { projects, activeProjectId } = useDesktop()
  const { uiMode } = useUiMode()
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null

  return (
    <div
      data-tauri-drag-region
      style={{
        position: 'relative',
        height: 28,
        minHeight: 28,
        background: 'var(--color-background-deep)',
        display: 'flex',
        alignItems: 'center',
        userSelect: 'none',
        flexShrink: 0,
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <SearchPill projectName={activeProject?.name ?? null} hidden={uiMode === 'agent'} />
    </div>
  )
}

function DefaultTitleBar() {
  const { t } = useTranslation('nav')
  const { projects, activeProjectId } = useDesktop()
  const { uiMode } = useUiMode()
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null
  const appWindow = getCurrentWindow()

  const handleMinimize = useCallback(() => {
    void appWindow.minimize()
  }, [appWindow])

  const handleMaximize = useCallback(() => {
    void appWindow.toggleMaximize()
  }, [appWindow])

  const handleClose = useCallback(() => {
    void appWindow.close()
  }, [appWindow])

  return (
    <div
      data-tauri-drag-region
      style={{
        position: 'relative',
        height: 36,
        minHeight: 36,
        background: 'var(--color-background-deep)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 10px',
        userSelect: 'none',
        flexShrink: 0,
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      {/* Absolutely positioned — never occupies a flex slot, so rendering it in
          both modes keeps the in-flow children identical. */}
      <SearchPill projectName={activeProject?.name ?? null} hidden={uiMode === 'agent'} />

      <div data-tauri-drag-region style={{ minWidth: 116, height: '100%' }} />

      {/* Right: native-feeling window controls for frameless Windows/Linux */}
      <div
        style={{
          minWidth: 116,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 2,
          alignItems: 'center',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <WinButton
          onClick={handleMinimize}
          icon={<Minus size={14} strokeWidth={1.8} />}
          ariaLabel={t('titleBar.minimizeWindow')}
        />
        <WinButton
          onClick={handleMaximize}
          icon={<Square size={12} strokeWidth={1.8} />}
          ariaLabel={t('titleBar.maximizeWindow')}
        />
        <WinButton
          onClick={handleClose}
          icon={<X size={15} strokeWidth={1.8} />}
          hoverColor="var(--color-destructive)"
          hoverTextColor="var(--color-destructive-foreground)"
          ariaLabel={t('titleBar.closeWindow')}
        />
      </div>
    </div>
  )
}
