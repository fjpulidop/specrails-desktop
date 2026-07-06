import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PanelLeft, FolderOpen, Plus, BarChart2, BookOpen, Settings, X, Workflow, ChevronRight, ChevronDown, MessageSquare, Bot, LayoutGrid, Search, Home, Heart } from 'lucide-react'
import { cn } from '../lib/utils'
import { useResizableSidebar } from '../hooks/useResizableSidebar'
import { SidebarResizeGrip } from './SidebarResizeGrip'
import { compactRelativeTime, absoluteTime } from '../lib/relative-time'
import { useDesktop } from '../hooks/useDesktop'
import type { DesktopProject } from '../hooks/useDesktop'
import { useSidebarPin } from '../context/SidebarPinContext'
import { useUiMode } from '../context/UiModeContext'
import { useAgentChat } from '../context/AgentChatContext'
import type { AgentConversation } from '../lib/agent-api'
import { FEATURE_LOOPS_SECTION, FEATURE_AGENT_MODE } from '../lib/feature-flags'

const ProjectSettingsDialog = lazy(() =>
  import('./settings/ProjectSettingsDialog').then((m) => ({ default: m.ProjectSettingsDialog })),
)

const TREE_EXPAND_KEY = 'specrails-desktop:agentTreeExpanded'

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(TREE_EXPAND_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function saveExpanded(s: Set<string>): void {
  try { localStorage.setItem(TREE_EXPAND_KEY, JSON.stringify([...s])) } catch { /* ignore */ }
}

/** Dispatch the same synthetic Cmd+K the title-bar SearchPill uses so the
 *  already-mounted CommandPalette opens (works on Windows/Linux via ctrlKey). */
function openCommandPalette(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }))
}

/** Sentinel key for the Home (null-pinned) conversation group. */
const HOME_KEY = '__home__'
/** Sentinel key for the virtual Favorite missions group. */
const FAVORITES_KEY = '__favorites__'

function ConversationRow({
  conversation,
  active,
  expanded,
  streaming = false,
  favorite = false,
  onSelect,
  onToggleFavorite,
  onDelete,
}: {
  conversation: AgentConversation
  active: boolean
  expanded: boolean
  /** A live agent turn (prompt sent / reply streaming) — sweeps a highlight
   *  over the title; on stop the sweep fades out slowly. */
  streaming?: boolean
  favorite?: boolean
  onSelect: () => void
  onToggleFavorite?: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('agent')
  const label = conversation.title?.trim() || t('untitled')
  const [confirming, setConfirming] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep the shimmer overlay mounted briefly after the turn ends so its
  // opacity can ease to zero (the requested "slow stop") instead of snapping.
  const [fading, setFading] = useState(false)
  const prevStreamingRef = useRef(streaming)
  useEffect(() => {
    if (prevStreamingRef.current && !streaming) {
      setFading(true)
      const timer = setTimeout(() => setFading(false), 900)
      prevStreamingRef.current = streaming
      return () => clearTimeout(timer)
    }
    prevStreamingRef.current = streaming
  }, [streaming])

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  function handleDeleteClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (confirming) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      setConfirming(false)
      onDelete()
    } else {
      setConfirming(true)
      confirmTimerRef.current = setTimeout(() => {
        setConfirming(false)
        confirmTimerRef.current = null
      }, 3000)
    }
  }

  function handleFavoriteClick(e: React.MouseEvent) {
    e.stopPropagation()
    onToggleFavorite?.()
  }

  function handleSelectKeyDown(e: React.KeyboardEvent) {
    // Keys pressed on the inner delete button must reach IT, not select the row.
    if (e.target !== e.currentTarget) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onSelect()
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleSelectKeyDown}
      className={cn(
        'group relative flex items-center gap-2 w-full h-7 rounded-md transition-colors',
        expanded ? 'pl-7 pr-2' : 'px-0 justify-center',
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
      )}
      title={!expanded ? label : undefined}
      aria-current={active ? 'true' : undefined}
    >
      <MessageSquare
        className={cn(
          'w-3.5 h-3.5 flex-shrink-0',
          active && 'text-accent-primary',
          // Secondary live cue alongside the title shimmer.
          streaming && 'text-accent-primary animate-pulse',
        )}
      />
      {expanded && (
        <>
          <span className="relative text-[11px] truncate flex-1 text-left">
            {label}
            {(streaming || fading) && (
              <span
                aria-hidden
                className={cn(
                  'title-shimmer pointer-events-none absolute inset-0 truncate transition-opacity duration-700',
                  streaming ? 'opacity-100' : 'opacity-0',
                )}
              >
                {label}
              </span>
            )}
          </span>
          {/* Compact "time since last interaction" (Cursor style) — swaps out
              for the delete action on hover so the row never shows both. */}
          <span
            className={cn(
              'flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/45',
              confirming ? 'hidden' : 'group-hover:hidden',
            )}
            title={absoluteTime(conversation.updated_at)}
          >
            {compactRelativeTime(conversation.updated_at)}
          </span>
          <button
            type="button"
            onClick={handleFavoriteClick}
            className={cn(
              'flex-shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-muted',
              favorite
                ? 'flex w-3.5 h-3.5 text-accent-primary hover:text-accent-primary'
                : 'hidden group-hover:flex w-3.5 h-3.5 text-muted-foreground/60 hover:text-accent-primary',
            )}
            aria-label={favorite ? t('removeFavoriteConversation', { title: label }) : t('addFavoriteConversation', { title: label })}
            title={favorite ? t('removeFavoriteConversation', { title: label }) : t('addFavoriteConversation', { title: label })}
          >
            <Heart className="w-2.5 h-2.5" fill={favorite ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            onClick={handleDeleteClick}
            className={cn(
              'flex-shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-muted',
              confirming
                ? 'flex px-1 h-4 text-[10px] text-destructive bg-destructive/10 hover:bg-destructive/20'
                : 'hidden group-hover:flex w-3.5 h-3.5 text-muted-foreground/60 hover:text-foreground'
            )}
            aria-label={confirming ? t('confirmDeleteConversation', { title: label }) : t('deleteConversation', { title: label })}
          >
            {confirming ? t('confirmShort') : <X className="w-2.5 h-2.5" />}
          </button>
        </>
      )}
    </div>
  )
}

interface ArcSidebarProps {
  onAddProject: () => void
  onOpenLoops: () => void
  onOpenAnalytics: () => void
  onOpenDocs: () => void
  onOpenSettings: () => void
}

function ProjectItem({
  project,
  isActive,
  expanded,
  onSelect,
  onRemove,
  agentMode = false,
  hasTree = false,
  treeOpen = false,
  onToggleTree,
  conversations = [],
  activeConversationId = null,
  streamingConversationIds,
  onSelectConversation,
  onToggleConversationFavorite,
  onDeleteConversation,
  onOpenProjectSettings,
}: {
  project: DesktopProject
  isActive: boolean
  expanded: boolean
  onSelect: () => void
  onRemove: () => void
  agentMode?: boolean
  hasTree?: boolean
  treeOpen?: boolean
  onToggleTree?: () => void
  conversations?: AgentConversation[]
  activeConversationId?: string | null
  /** Ids of EVERY conversation with a live agent turn — background threads keep
   *  their title shimmer, not just the focused one. */
  streamingConversationIds?: ReadonlySet<string>
  onSelectConversation?: (id: string) => void
  onToggleConversationFavorite?: (id: string) => void
  onDeleteConversation?: (id: string) => void
  /** Hover gear (Agent Mode): open this project's settings modal. */
  onOpenProjectSettings?: () => void
}) {
  const { t } = useTranslation('nav')
  const [confirming, setConfirming] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  function handleRemoveClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (confirming) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      setConfirming(false)
      onRemove()
    } else {
      setConfirming(true)
      confirmTimerRef.current = setTimeout(() => {
        setConfirming(false)
        confirmTimerRef.current = null
      }, 3000)
    }
  }

  function handleSelectKeyDown(e: React.KeyboardEvent) {
    // Keys pressed on inner buttons (chevron / remove) must reach THEM, not select the row.
    if (e.target !== e.currentTarget) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onSelect()
  }

  const showChevron = agentMode && hasTree && expanded
  const projectIcon = (
    <FolderOpen
      className={cn(
        'flex-shrink-0 w-4 h-4',
        isActive && 'text-accent-primary'
      )}
    />
  )

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={handleSelectKeyDown}
        className={cn(
          'group relative flex items-center gap-2 w-full h-8 rounded-md transition-colors',
          expanded ? 'px-2' : 'px-0 justify-center',
          isActive
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
        )}
        title={!expanded ? project.name : undefined}
        aria-current={isActive ? 'page' : undefined}
      >
        {showChevron ? (
          <span className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center">
            <span className="flex transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {projectIcon}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleTree?.() }}
              className="absolute inset-0 hidden items-center justify-center rounded-sm hover:bg-muted group-hover:flex group-focus-within:flex"
              aria-label={treeOpen ? t('projects.collapse', { name: project.name }) : t('projects.expand', { name: project.name })}
              aria-expanded={treeOpen}
            >
              {treeOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          </span>
        ) : (
          projectIcon
        )}
        {expanded && (
          <>
            <span className="text-xs truncate flex-1 text-left">{project.name}</span>
            {onOpenProjectSettings && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenProjectSettings() }}
                className={cn(
                  'flex-shrink-0 flex items-center justify-center rounded-sm transition-all w-3.5 h-3.5',
                  'opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-muted',
                )}
                aria-label={t('projects.settings', { name: project.name })}
                title={t('projects.settings', { name: project.name })}
              >
                <Settings className="w-2.5 h-2.5" />
              </button>
            )}
            <button
              type="button"
              onClick={handleRemoveClick}
              className={cn(
                'flex-shrink-0 flex items-center justify-center rounded-sm transition-all',
                'opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-muted',
                confirming
                  ? 'opacity-100 px-1 h-4 text-[10px] text-destructive bg-destructive/10 hover:bg-destructive/20'
                  : 'w-3.5 h-3.5'
              )}
              aria-label={confirming ? t('projects.confirmRemove', { name: project.name }) : t('projects.remove', { name: project.name })}
            >
              {confirming ? t('projects.confirmShort') : <X className="w-2.5 h-2.5" />}
            </button>
          </>
        )}
      </div>
      {agentMode && treeOpen && expanded && conversations.length > 0 && (
        <div className="mt-0.5 space-y-0.5">
          {conversations.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === activeConversationId}
              streaming={streamingConversationIds?.has(c.id) ?? false}
              expanded={expanded}
              onSelect={() => onSelectConversation?.(c.id)}
              onToggleFavorite={() => onToggleConversationFavorite?.(c.id)}
              onDelete={() => onDeleteConversation?.(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const LEFT_PIN_LABEL_KEY: Record<'pinned-open' | 'pinned-collapsed' | 'unpinned', string> = {
  'pinned-open': 'sidebarPin.left.pinnedOpen',
  'pinned-collapsed': 'sidebarPin.left.pinnedCollapsed',
  'unpinned': 'sidebarPin.left.unpinned',
}

export function ArcSidebar({
  onAddProject,
  onOpenLoops,
  onOpenAnalytics,
  onOpenDocs,
  onOpenSettings,
}: ArcSidebarProps) {
  const { t } = useTranslation('nav')
  const { t: tAgent } = useTranslation('agent')
  const { projects, activeProjectId, setActiveProjectId, removeProject } = useDesktop()
  const navigate = useNavigate()
  const location = useLocation()
  const onLoopsRoute = location.pathname.startsWith('/loops')
  const onGlobalRoute = onLoopsRoute || location.pathname.startsWith('/docs')
  const { leftMode, cycleLeftMode } = useSidebarPin()
  const { uiMode, toggleUiMode } = useUiMode()
  const agentChat = useAgentChat()
  const agentMode = uiMode === 'agent'

  // Conversations grouped by pinned project (null → Home). A pin to a
  // since-removed project folds into Home — nothing server-side nulls
  // pinned_project_id on project removal, and an unrendered bucket would make
  // the conversation permanently unreachable.
  const grouped = useMemo(() => {
    const map = new Map<string, AgentConversation[]>()
    const liveProjectIds = new Set(projects.map((p) => p.id))
    for (const c of agentChat.conversations) {
      if (agentChat.favoriteConversationIds.has(c.id)) continue
      const key = c.pinned_project_id && liveProjectIds.has(c.pinned_project_id) ? c.pinned_project_id : HOME_KEY
      const arr = map.get(key)
      if (arr) arr.push(c)
      else map.set(key, [c])
    }
    return map
  }, [agentChat.conversations, agentChat.favoriteConversationIds, projects])
  const favoriteConversations = useMemo(
    () => agentChat.conversations.filter((c) => agentChat.favoriteConversationIds.has(c.id)),
    [agentChat.conversations, agentChat.favoriteConversationIds],
  )
  const homeConversations = grouped.get(HOME_KEY) ?? []

  const [expandedTree, setExpandedTree] = useState<Set<string>>(loadExpanded)
  const favoriteTreeOpen = expandedTree.has(FAVORITES_KEY)
  // Per-project settings modal (Agent Mode hover gear on a project folder).
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  // Default-expand the active project the first time we enter Agent Mode.
  useEffect(() => {
    if (!agentMode || !activeProjectId) return
    setExpandedTree((prev) => {
      if (prev.has(activeProjectId)) return prev
      const next = new Set(prev)
      next.add(activeProjectId)
      saveExpanded(next)
      return next
    })
    // Only on entering agent mode / active project change.
  }, [agentMode, activeProjectId])

  const toggleTree = (projectId: string) => {
    setExpandedTree((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      saveExpanded(next)
      return next
    })
  }

  const handleSelectConversation = (id: string) => {
    void agentChat.selectConversation(id)
    // A global route (/loops, /docs) occupies the center in Agent Mode — leave
    // it so the selected thread is actually visible on the agent surface.
    if (onGlobalRoute) navigate('/')
  }

  const handleDeleteConversation = (id: string) => {
    agentChat.deleteConversation(id).catch(() => {
      /* network failure — the list refresh on next open reconciles */
    })
  }

  const handleToggleFavoriteConversation = (id: string) => {
    agentChat.toggleFavoriteConversation(id)
  }

  // Selecting a project from the sidebar. When the user is on a GLOBAL route
  // (/loops, /docs) and taps a project, switching activeProjectId alone doesn't
  // leave the global page — and tapping the ALREADY-active project is a no-op
  // (no state change → the route-memory effect never fires). So when on a global
  // route, navigate the active project back to its dashboard explicitly; a
  // different project still goes through setActiveProjectId (the route-memory
  // effect restores its last surface).
  function handleSelectProject(projectId: string) {
    // Agent Mode: selecting a project sets it active AND toggles its tree —
    // never navigates routes (the center is the agent surface, not a route).
    if (agentMode) {
      setActiveProjectId(projectId)
      toggleTree(projectId)
      return
    }
    if (projectId === activeProjectId) {
      // Already active: only meaningful when viewing a global page — return to
      // the project's dashboard (no state change would fire the route effect).
      if (location.pathname.startsWith('/loops') || location.pathname.startsWith('/docs')) {
        navigate('/')
      }
      return
    }
    // Different project: switching activeProjectId fires the route-memory effect,
    // which navigates to that project's last surface (off any global route).
    setActiveProjectId(projectId)
  }
  const [hovered, setHovered] = useState(false)
  const expanded = leftMode === 'pinned-open' || (leftMode === 'unpinned' && hovered)
  // Drag-resizable width (persisted), applied imperatively through the panel ref
  // — 240px (w-60) expanded, 44px (w-11) collapsed rail. The mouseleave guard
  // below keeps `hovered` true during a drag so an unpinned rail can't collapse
  // out from under the resize.
  const resize = useResizableSidebar('left-arc', {
    side: 'left', defaultWidth: 240, min: 200, max: 460, collapsedWidth: 44, expanded,
  })
  const lit = leftMode !== 'unpinned'
  const pinLabel = t(LEFT_PIN_LABEL_KEY[leftMode])

  const navItems = [
    { label: t('arcSidebar.docs'), icon: BookOpen, action: onOpenDocs },
    { label: t('arcSidebar.analytics'), icon: BarChart2, action: onOpenAnalytics },
    { label: t('arcSidebar.settings'), icon: Settings, action: onOpenSettings },
  ]

  async function handleRemove(project: DesktopProject) {
    try {
      await removeProject(project.id)
    } catch {
      // errors handled via toast in parent
    }
  }

  return (
    <div
      ref={resize.panelRef}
      className={cn(
        'relative flex flex-col h-full border-r border-border bg-background flex-shrink-0 overflow-hidden',
        // Width is set imperatively by useResizableSidebar (px). The transition
        // animates collapse/expand + keyboard nudges; a drag turns it off itself.
        'transition-[width] duration-200 ease-in-out',
      )}
      onMouseEnter={() => { if (leftMode === 'unpinned') setHovered(true) }}
      onMouseLeave={() => { if (leftMode === 'unpinned' && !resize.dragging) setHovered(false) }}
    >
      {expanded && (
        <SidebarResizeGrip
          side="left"
          dragging={resize.dragging}
          width={resize.width}
          min={200}
          max={460}
          label={t('arcSidebar.resize', { defaultValue: 'Resize sidebar' })}
          onPointerDown={resize.onGripPointerDown}
          onKeyDown={resize.onGripKeyDown}
        />
      )}
      {/* Header */}
      <div
        className={cn(
          'flex items-center h-12 border-b border-border flex-shrink-0',
          expanded ? 'px-3 justify-between' : 'justify-center'
        )}
      >
        {expanded && (
          <span className="font-mono text-sm font-bold whitespace-nowrap overflow-hidden text-accent-primary">
            {t('arcSidebar.desktopTitle')}
          </span>
        )}
        <button
          type="button"
          onClick={cycleLeftMode}
          className={cn(
            'flex items-center justify-center w-7 h-7 rounded-md transition-colors flex-shrink-0',
            lit
              ? 'text-foreground bg-muted'
              : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50'
          )}
          aria-label={pinLabel}
          title={t('sidebarPin.withShortcut', { label: pinLabel, shortcut: '⌥⌘B' })}
        >
          <PanelLeft className="w-4 h-4" />
        </button>
      </div>

      {/* Agent Mode cluster — Switch (both modes), New agent + Search (agent) */}
      {FEATURE_AGENT_MODE && (
        <div className="py-2 px-1.5 space-y-0.5 border-b border-border">
          {agentMode && (
            <button
              type="button"
              onClick={() => {
                // Default the draft pin to the active project (null ⇒ Home).
                agentChat.startNewConversation(activeProjectId)
                if (onGlobalRoute) navigate('/')
              }}
              className={cn(
                'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
                'bg-accent-primary/15 text-accent-primary hover:bg-accent-primary/25',
                expanded ? 'px-2' : 'px-0 justify-center',
              )}
              aria-label={tAgent('newAgent')}
              title={!expanded ? tAgent('newAgent') : undefined}
            >
              <Plus className="w-4 h-4 flex-shrink-0" />
              {expanded && <span className="text-xs whitespace-nowrap">{tAgent('newAgent')}</span>}
            </button>
          )}
          <button
            type="button"
            onClick={toggleUiMode}
            className={cn(
              'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
              'text-muted-foreground hover:text-foreground hover:bg-muted/50',
              expanded ? 'px-2' : 'px-0 justify-center',
            )}
            aria-label={agentMode ? tAgent('switchToKanban') : tAgent('switchToAgent')}
            title={agentMode ? tAgent('switchToKanban') : tAgent('switchToAgent')}
          >
            {agentMode
              ? <LayoutGrid className="w-4 h-4 flex-shrink-0" />
              : <Bot className="w-4 h-4 flex-shrink-0 text-accent-primary" />}
            {expanded && (
              <span className="min-w-0 truncate text-xs">
                {agentMode ? tAgent('switchToKanban') : tAgent('switchToAgent')}
              </span>
            )}
          </button>
          {agentMode && (
            <button
              type="button"
              onClick={openCommandPalette}
              className={cn(
                'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
                'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                expanded ? 'px-2' : 'px-0 justify-center',
              )}
              aria-label={tAgent('search')}
              title={!expanded ? tAgent('search') : undefined}
            >
              <Search className="w-4 h-4 flex-shrink-0" />
              {expanded && <span className="text-xs whitespace-nowrap">{tAgent('search')}</span>}
            </button>
          )}
        </div>
      )}

      {/* Loops — global section, above the project list with a separator below */}
      {FEATURE_LOOPS_SECTION && (
        <>
          <div className="py-2 px-1.5">
            <button
              type="button"
              onClick={onOpenLoops}
              className={cn(
                'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
                expanded ? 'px-2' : 'px-0 justify-center',
                onLoopsRoute
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
              aria-label={t('arcSidebar.loops')}
              aria-current={onLoopsRoute ? 'page' : undefined}
              title={!expanded ? t('arcSidebar.loops') : undefined}
            >
              <Workflow className={cn('w-4 h-4 flex-shrink-0', onLoopsRoute && 'text-accent-primary')} />
              {expanded && <span className="text-xs whitespace-nowrap">{t('arcSidebar.loops')}</span>}
            </button>
          </div>
          <div className="border-t border-border" aria-hidden />
        </>
      )}

      {/* Projects list */}
      <div className="flex-1 overflow-y-auto py-2 px-1.5 space-y-0.5">
        {agentMode && favoriteConversations.length > 0 && (
          <div className="mb-2 space-y-0.5 border-b border-border/70 pb-2">
            <button
              type="button"
              onClick={() => toggleTree(FAVORITES_KEY)}
              className={cn(
                'group flex items-center gap-2 w-full h-8 rounded-md transition-colors',
                'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                expanded ? 'px-2' : 'px-0 justify-center',
              )}
              aria-label={tAgent('favoriteMissions')}
              aria-expanded={favoriteTreeOpen}
              title={!expanded ? tAgent('favoriteMissions') : undefined}
            >
              {expanded
                ? (
                    <span className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center">
                      <Heart className="h-4 w-4 fill-current text-accent-primary transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />
                      <span className="absolute inset-0 hidden items-center justify-center group-hover:flex group-focus-visible:flex">
                        {favoriteTreeOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </span>
                    </span>
                  )
                : <Heart className="w-4 h-4 flex-shrink-0 fill-current text-accent-primary" />}
              {expanded && <span className="text-xs truncate flex-1 text-left">{tAgent('favoriteMissions')}</span>}
            </button>
            {favoriteTreeOpen && expanded && (
              <div className="mt-0.5 space-y-0.5">
                {favoriteConversations.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === agentChat.active?.id}
                    streaming={agentChat.streamingConversationIds.has(c.id)}
                    favorite
                    expanded={expanded}
                    onSelect={() => handleSelectConversation(c.id)}
                    onToggleFavorite={() => handleToggleFavoriteConversation(c.id)}
                    onDelete={() => handleDeleteConversation(c.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {/* Home group (agent mode) — conversations with no pinned project */}
        {agentMode && homeConversations.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggleTree(HOME_KEY)}
              className={cn(
                'group flex items-center gap-2 w-full h-8 rounded-md transition-colors',
                'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                expanded ? 'px-2' : 'px-0 justify-center',
              )}
              aria-label={tAgent('home')}
              aria-expanded={expandedTree.has(HOME_KEY)}
              title={!expanded ? tAgent('home') : undefined}
            >
              {expanded
                ? (
                    <span className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center">
                      <Home className="h-4 w-4 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />
                      <span className="absolute inset-0 hidden items-center justify-center group-hover:flex group-focus-visible:flex">
                        {expandedTree.has(HOME_KEY) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </span>
                    </span>
                  )
                : <Home className="w-4 h-4 flex-shrink-0" />}
              {expanded && <span className="text-xs truncate flex-1 text-left">{tAgent('home')}</span>}
            </button>
            {expandedTree.has(HOME_KEY) && expanded && (
              <div className="mt-0.5 space-y-0.5">
                {homeConversations.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === agentChat.active?.id}
                    streaming={agentChat.streamingConversationIds.has(c.id)}
                    expanded={expanded}
                    onSelect={() => handleSelectConversation(c.id)}
                    onToggleFavorite={() => handleToggleFavoriteConversation(c.id)}
                    onDelete={() => handleDeleteConversation(c.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {projects.map((project) => {
          const convs = grouped.get(project.id) ?? []
          return (
            <ProjectItem
              key={project.id}
              project={project}
              isActive={project.id === activeProjectId && !onLoopsRoute}
              expanded={expanded}
              onSelect={() => handleSelectProject(project.id)}
              onRemove={() => handleRemove(project)}
              agentMode={agentMode}
              hasTree={convs.length > 0}
              treeOpen={expandedTree.has(project.id)}
              onToggleTree={() => toggleTree(project.id)}
              conversations={convs}
              activeConversationId={agentChat.active?.id ?? null}
              streamingConversationIds={agentChat.streamingConversationIds}
              onSelectConversation={handleSelectConversation}
              onToggleConversationFavorite={handleToggleFavoriteConversation}
              onDeleteConversation={handleDeleteConversation}
              onOpenProjectSettings={agentMode ? () => {
                // The settings sections talk to the ACTIVE project's API base —
                // opening a project's settings selects it first (same semantics
                // as clicking the folder).
                setActiveProjectId(project.id)
                setProjectSettingsOpen(true)
              } : undefined}
            />
          )
        })}

        {/* Add project */}
        <button
          type="button"
          onClick={onAddProject}
          className={cn(
            'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
            'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            expanded ? 'px-2' : 'px-0 justify-center'
          )}
          aria-label={t('projects.addProject')}
          title={!expanded ? t('projects.addProject') : undefined}
        >
          <Plus className="w-4 h-4 flex-shrink-0" />
          {expanded && <span className="text-xs whitespace-nowrap">{t('projects.addProject')}</span>}
        </button>
      </div>

      {/* Desktop nav items */}
      <div className="border-t border-border py-2 px-1.5 space-y-0.5">
        {navItems.map(({ label, icon: Icon, action }) => (
          <button
            key={label}
            type="button"
            onClick={action}
            className={cn(
              'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
              'text-muted-foreground hover:text-foreground hover:bg-muted/50',
              expanded ? 'px-2' : 'px-0 justify-center'
            )}
            aria-label={label}
            title={!expanded ? label : undefined}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {expanded && <span className="text-xs whitespace-nowrap">{label}</span>}
          </button>
        ))}
      </div>

      {projectSettingsOpen && (
        <Suspense fallback={null}>
          <ProjectSettingsDialog open onClose={() => setProjectSettingsOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}
