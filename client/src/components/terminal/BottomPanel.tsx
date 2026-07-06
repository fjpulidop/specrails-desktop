import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import {
  useTerminals,
  DEFAULT_USER_HEIGHT, PANEL_MIN_HEIGHT, TERMINAL_MAX_PER_PROJECT,
  type ProjectPanelState,
} from '../../context/TerminalsContext'
import { openExternalUrl } from '../../lib/tauri-shell'
import { DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from '../../lib/terminal-settings-types'
import { TERMINAL_SETTINGS_UPDATED_EVENT, type TerminalSettingsUpdatedEventDetail } from '../../lib/terminal-settings-events'
import { registerTauriDragDrop } from '../../lib/tauri-drag-drop'
import type { ProviderId } from '../../lib/provider-capabilities'
import { ShortcutContextMenu } from './ShortcutContextMenu'
import { CliLaunchMenu } from './CliLaunchMenu'
import { TerminalTopBar } from './TerminalTopBar'
import { TerminalSidebar } from './TerminalSidebar'
import { TerminalViewport } from './TerminalViewport'
import { TerminalDragHandle } from './TerminalDragHandle'
import { EmptyTerminalPlaceholder } from './EmptyTerminalPlaceholder'

const PANEL_CURTAIN_MS = 300
type PanelCurtainPhase = 'hidden' | 'opening' | 'open' | 'closing'

interface BottomPanelProps {
  projectId: string
  /** Project's primary CLI provider — drives the Sparkles shortcut label when a
   *  single provider is installed (claude vs codex). */
  provider?: ProviderId
  /** All installed providers. When >1, the Sparkles shortcut opens a picker. */
  providers?: readonly string[]
  state: ProjectPanelState
  /** Full project viewport height in px — used for maximize computation. */
  viewportHeight: number
  statusBarHeight: number
}

export function BottomPanel({ projectId, provider = 'claude', providers, state, viewportHeight, statusBarHeight }: BottomPanelProps) {
  const t = useTerminals()
  const { t: translate } = useTranslation('terminal')
  const navigate = useNavigate()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [livePreviewHeight, setLivePreviewHeight] = useState<number | null>(null)
  const [settings, setSettings] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS)
  const [shortcutMenu, setShortcutMenu] = useState<{ x: number; y: number; kind: 'browser' | 'script' } | null>(null)
  const [cliMenu, setCliMenu] = useState<{ x: number; y: number } | null>(null)
  const [curtainPhase, setCurtainPhase] = useState<PanelCurtainPhase>(() =>
    state.visibility === 'hidden' ? 'hidden' : 'open',
  )
  const didMountRef = useRef(false)
  const installedProviders = providers && providers.length > 0 ? providers : [provider]
  const multiProvider = installedProviders.length > 1

  const loadSettings = useCallback(async (cancelled: () => boolean = () => false) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/terminal-settings`)
      if (!res.ok) return
      const body = await res.json() as { resolved?: TerminalSettings }
      if (!cancelled() && body?.resolved) setSettings(body.resolved)
    } catch { /* ignore — keep current settings */ }
  }, [projectId])

  // Resolve terminal settings (project override → desktop default) for this project,
  // so the shortcut buttons use the configured values.
  useEffect(() => {
    let cancelled = false
    void loadSettings(() => cancelled)
    return () => { cancelled = true }
  }, [loadSettings])

  useEffect(() => {
    const onSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<TerminalSettingsUpdatedEventDetail>).detail
      if (detail?.mode === 'project' && detail.projectId !== projectId) return
      void loadSettings()
    }
    window.addEventListener(TERMINAL_SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => window.removeEventListener(TERMINAL_SETTINGS_UPDATED_EVENT, onSettingsUpdated)
  }, [loadSettings, projectId])

  const maxHeight = Math.max(PANEL_MIN_HEIGHT, viewportHeight - statusBarHeight - 40)
  const userHeight = Math.min(Math.max(state.userHeight || DEFAULT_USER_HEIGHT, PANEL_MIN_HEIGHT), maxHeight)
  const height =
    state.visibility === 'maximized' ? Math.max(PANEL_MIN_HEIGHT, viewportHeight - statusBarHeight) :
    livePreviewHeight ?? userHeight
  const curtainOpen = curtainPhase === 'open'
  const visualHeight = curtainOpen ? height : 0
  const footerless = statusBarHeight === 0

  const canCreate = state.sessions.length < TERMINAL_MAX_PER_PROJECT
  const hasActive = state.activeId !== null

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }

    let timeout: ReturnType<typeof setTimeout> | null = null
    let frame: number | null = null
    if (state.visibility === 'hidden') {
      setCurtainPhase('closing')
      timeout = setTimeout(() => setCurtainPhase('hidden'), PANEL_CURTAIN_MS)
    } else {
      setCurtainPhase('opening')
      frame = requestAnimationFrame(() => setCurtainPhase('open'))
    }
    return () => {
      if (timeout) clearTimeout(timeout)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [state.visibility])

  useEffect(() => {
    let disposed = false
    let controller: { dispose: () => void } | null = null
    void registerTauriDragDrop(() => {
      const panel = panelRef.current
      const activeId = state.activeId
      if (!panel || !activeId || state.visibility === 'hidden') return null
      return {
        viewportEl: panel,
        writeText: (text: string) => {
          if (t.writeToSession(activeId, text)) return true
          const term = t.getTerminalInstance(activeId)
          try {
            term?.paste(text)
            return Boolean(term)
          } catch {
            return false
          }
        },
      }
    }).then((c) => {
      if (disposed) c.dispose()
      else controller = c
    })
    return () => {
      disposed = true
      controller?.dispose()
    }
  }, [state.activeId, state.visibility, t])

  const handleCreate = useCallback(() => {
    if (!canCreate) return
    void t.create(projectId)
  }, [canCreate, projectId, t])

  const launchCli = useCallback((which: ProviderId) => {
    if (!canCreate) return
    // The provider id IS the CLI binary name (claude / codex / gemini), so the
    // shell command typed below is the provider verbatim — never hardcode a
    // two-provider fallback that would relaunch claude for a gemini project.
    const baseName = which || 'claude'
    const numberSuffix = new RegExp(`^${baseName} \\(\\d+\\)$`)
    const matches = state.sessions.filter(
      (s) => s.name === baseName || numberSuffix.test(s.name),
    )
    const name = matches.length === 0 ? baseName : `${baseName} (${matches.length + 1})`
    void t.createAndType(projectId, `${baseName}\n`, { name })
  }, [canCreate, projectId, state.sessions, t])

  const handleOpenCli = useCallback((anchor?: { x: number; y: number }) => {
    if (!canCreate) return
    // Multi-provider: open a picker so the user chooses which CLI to launch.
    // Single-provider: launch directly (unchanged behaviour).
    if (multiProvider && anchor) {
      setCliMenu(anchor)
      return
    }
    launchCli(provider)
  }, [canCreate, multiProvider, provider, launchCli])

  const handleOpenBrowser = useCallback(() => {
    void openExternalUrl(settings.browserShortcutUrl)
  }, [settings.browserShortcutUrl])

  const handlePasteScript = useCallback(() => {
    if (!state.activeId) return
    if (!settings.quickScript) return
    t.writeToSession(state.activeId, settings.quickScript)
  }, [settings.quickScript, state.activeId, t])

  const handleConfigureBrowser = useCallback((anchor: { x: number; y: number }) => {
    setShortcutMenu({ ...anchor, kind: 'browser' })
  }, [])
  const handleConfigureScript = useCallback((anchor: { x: number; y: number }) => {
    setShortcutMenu({ ...anchor, kind: 'script' })
  }, [])
  const handleNavigateToSetting = useCallback((kind: 'browser' | 'script') => {
    const hash = kind === 'browser' ? '#terminal-browser-shortcut-url' : '#terminal-quick-script'
    navigate(`/settings${hash}`)
  }, [navigate])

  const handleKillActive = useCallback(() => {
    if (!state.activeId) return
    void t.kill(projectId, state.activeId)
  }, [projectId, state.activeId, t])

  const handleToggleMaximize = useCallback(() => {
    t.setVisibility(projectId, state.visibility === 'maximized' ? 'restored' : 'maximized')
  }, [projectId, state.visibility, t])

  const handleCollapse = useCallback(() => {
    t.setVisibility(projectId, 'hidden')
  }, [projectId, t])

  // Reset live preview when visibility changes (e.g. maximize)
  useEffect(() => { setLivePreviewHeight(null) }, [state.visibility])

  if (curtainPhase === 'hidden') return null

  return (
    <div
      ref={panelRef}
      className={cn(
        'relative flex flex-col shrink-0 overflow-hidden origin-bottom transform-gpu bg-background/95',
        'border-t border-border/40',
        'transition-[height,opacity,transform,clip-path] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
      )}
      style={{
        height: visualHeight,
        opacity: curtainOpen ? 1 : 0,
        transform: curtainOpen
          ? 'translateY(0) scaleY(1)'
          : `translateY(${footerless ? 14 : 8}px) scaleY(${footerless ? 0.96 : 0.985})`,
        clipPath: curtainOpen ? 'inset(0 0 0 0)' : 'inset(100% 0 0 0)',
      }}
      data-testid="terminal-bottom-panel"
    >
      <TerminalDragHandle
        height={userHeight}
        maxHeight={maxHeight}
        onHeightPreview={(h) => setLivePreviewHeight(h)}
        onHeightCommit={(h) => {
          setLivePreviewHeight(null)
          t.setUserHeight(projectId, h)
          if (state.visibility === 'maximized') t.setVisibility(projectId, 'restored')
        }}
      />
      <TerminalTopBar
        visibility={state.visibility}
        canCreate={canCreate}
        hasActive={hasActive}
        provider={provider}
        providers={installedProviders}
        onCreate={handleCreate}
        onOpenCli={handleOpenCli}
        onOpenBrowser={handleOpenBrowser}
        onPasteScript={handlePasteScript}
        pasteScriptDisabled={!hasActive || !settings.quickScript}
        onConfigureBrowser={handleConfigureBrowser}
        onConfigureScript={handleConfigureScript}
        onKillActive={handleKillActive}
        onToggleMaximize={handleToggleMaximize}
        onCollapse={handleCollapse}
      />
      {shortcutMenu && (
        <ShortcutContextMenu
          x={shortcutMenu.x}
          y={shortcutMenu.y}
          label={shortcutMenu.kind === 'browser' ? translate('shortcutMenu.configureBrowserUrl') : translate('shortcutMenu.editQuickScript')}
          onSelect={() => handleNavigateToSetting(shortcutMenu.kind)}
          onClose={() => setShortcutMenu(null)}
        />
      )}
      {cliMenu && (
        <CliLaunchMenu
          x={cliMenu.x}
          y={cliMenu.y}
          providers={installedProviders}
          onSelect={(p) => launchCli(p)}
          onClose={() => setCliMenu(null)}
        />
      )}
      <div className="flex-1 flex min-h-0">
        {state.sessions.length === 0 ? (
          <EmptyTerminalPlaceholder onCreate={handleCreate} />
        ) : (
          <>
            <TerminalViewport activeId={state.activeId} />
            <TerminalSidebar
              sessions={state.sessions}
              activeId={state.activeId}
              onActivate={(id) => t.setActive(projectId, id)}
              onRename={(id, name) => void t.rename(projectId, id, name)}
              onKill={(id) => void t.kill(projectId, id)}
            />
          </>
        )}
      </div>
    </div>
  )
}
