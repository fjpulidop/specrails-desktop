import { isTauri } from '../lib/tauri-shell'
import { MissionConversationMenu } from '../features/missions/components/MissionConversationMenu'
import { useMissionSplitViews } from '../features/missions/context/MissionSplitViewsContext'
import { keyboardLabel } from '../lib/keyboard-label'
import { OPEN_PROJECT_SETTINGS_EVENT, type OpenProjectSettingsDetail } from '../lib/app-settings-events'
import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelLeft, FolderOpen, Plus, BarChart3, BookOpen, Settings, Smartphone, X, Workflow, ChevronRight, ChevronDown, MessageSquare, Bot, LayoutGrid, Search, Home, Heart, Puzzle, RotateCw } from 'lucide-react'
import { cn } from '../lib/utils'
import { useResizableSidebar } from '../hooks/useResizableSidebar'
import { useSidebarHoverIntent } from '../hooks/useSidebarHoverIntent'
import { SidebarResizeGrip } from './SidebarResizeGrip'
import { compactRelativeTime, absoluteTime } from '../lib/relative-time'
import { useAssembleProgress } from '../features/jobs/hooks/useAssembleProgress'
import { useDesktop } from '../hooks/useDesktop'
import type { DesktopProject } from '../hooks/useDesktop'
import { useSidebarPin } from '../context/SidebarPinContext'
import { useUiMode } from '../context/UiModeContext'
import { useAgentChat } from '../features/missions/context/AgentChatContext'
import { useMissionConversationMarks } from '../features/missions/context/MissionExtensionsContext'
import { MissionAttentionMark, MissionModeRowMark } from '../features/missions/components/MissionModeBadge'
import { motion } from 'motion/react'
import { useMissionSessions } from '../features/missions/context/MissionSessionsContext'
import type { AgentConversation } from '../features/missions/lib/agent-api'
import { FEATURE_LOOPS_SECTION, FEATURE_AGENT_MODE } from '../lib/feature-flags'

const ProjectSettingsDialog = lazy(() =>
  import('../features/settings/components/ProjectSettingsDialog').then((m) => ({ default: m.ProjectSettingsDialog })),
)

const TREE_EXPAND_KEY = 'specrails-desktop:agentTreeExpanded'
/** How long a destructive "Remove?" / "Delete?" confirmation stays armed. */
const CONFIRM_RESET_MS = 5000
/** Keyboard focus ring shared by every row button in the sidebar. */
/** Selection marker: a 2 px pill on the inner edge that glides between nav items. */
function NavRailIndicator() {
  return (
    <motion.span
      layoutId="arc-nav-rail"
      aria-hidden="true"
      data-testid="nav-rail-indicator"
      className="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent-primary"
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
    />
  )
}

const ROW_FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2'
/** Expanded-sidebar group label ("Workspace", "Projects"). 12px per the app's text floor. */
const SECTION_LABEL = 'px-2 pt-2 pb-1 text-label font-medium text-muted-foreground'

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

/** A collapsed-rail project tile: the initials of its first two words
 *  ("specrails-desktop" → "SD"), or its first two letters/digits for a single
 *  word, so neighbouring projects stay distinguishable at 44px. */
/**
 * Attention badge on a collapsed rail icon: pinned to the tile's top-right
 * corner, with a background-coloured cut-out so it reads as a badge instead
 * of a dot sitting on the monogram's letters.
 */
const COLLAPSED_BADGE = 'pointer-events-none absolute -right-1.5 -top-1.5 flex items-center justify-center rounded-full bg-background p-[2px] leading-none'

export function projectMonogram(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  const chars = (words[0] ?? '').match(/[\p{L}\p{N}]/gu) ?? []
  return chars.slice(0, 2).join('').toUpperCase() || '?'
}

/** Mission state rolled up over a group of conversations (a project, Home,
 *  Favorites) so a closed or collapsed group still shows what waits inside. */
interface MissionRollup {
  needsAttention: boolean
  hasFailed: boolean
  isLive: boolean
  unreadCount: number
}

function rollupMissions(
  conversations: readonly AgentConversation[],
  sets: {
    attention?: ReadonlySet<string>
    attentionKinds?: ReadonlyMap<string, 'decision' | 'failed'>
    live?: ReadonlySet<string>
    unread?: ReadonlySet<string>
  },
): MissionRollup {
  let needsAttention = false
  let hasFailed = false
  let isLive = false
  let unreadCount = 0
  for (const c of conversations) {
    if (sets.attention?.has(c.id)) {
      needsAttention = true
      if (sets.attentionKinds?.get(c.id) === 'failed') hasFailed = true
    }
    if (sets.live?.has(c.id)) isLive = true
    if (sets.unread?.has(c.id)) unreadCount += 1
  }
  return { needsAttention, hasFailed, isLive, unreadCount }
}

/** The rolled-up marks next to a closed group's label (expanded rail). */
function RollupMarks({ rollup }: { rollup: MissionRollup }) {
  const { t } = useTranslation('agent')
  return (
    <>
      {rollup.needsAttention && <MissionAttentionMark kind={rollup.hasFailed ? 'failed' : 'decision'} />}
      {!rollup.needsAttention && rollup.unreadCount > 0 && (
        <span className="inline-flex shrink-0 items-center" data-testid="rollup-unread">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-primary" />
          <span className="sr-only">{t('unreadCount', { count: rollup.unreadCount })}</span>
        </span>
      )}
      {rollup.isLive && <span className="sr-only">{t('live')}</span>}
    </>
  )
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
  unread = false,
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
  unread?: boolean
  favorite?: boolean
  onSelect: () => void
  onToggleFavorite?: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('agent')
  const label = conversation.title?.trim() || t('untitled')
  const [confirming, setConfirming] = useState(false)
  // Marks next to the title: a delivery waits for the person; the mission is in Flow.
  const chat = useAgentChat()
  const attention = chat.attentionConversationIds?.has(conversation.id) ?? false
  const attentionKind = chat.attentionKinds?.get(conversation.id) ?? 'decision'
  const markRefs = useMemo(() => [{ id: conversation.id, pinned_project_id: conversation.pinned_project_id ?? null }], [conversation.id, conversation.pinned_project_id])
  const modeMark = useMissionConversationMarks(markRefs).get(conversation.id) ?? null
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
      }, CONFIRM_RESET_MS)
    }
  }

  function handleFavoriteClick(e: React.MouseEvent) {
    e.stopPropagation()
    onToggleFavorite?.()
  }

  return (
    <MissionConversationMenu conversationId={conversation.id}>
    <div
      className={cn(
        'group relative flex items-center gap-1 w-full h-7 rounded-md transition-colors',
        expanded ? 'pr-2' : 'justify-center',
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex-1 min-w-0 flex items-center gap-2 h-full rounded-md text-left',
          expanded ? 'pl-7' : 'justify-center',
          ROW_FOCUS,
        )}
        title={!expanded ? label : undefined}
        aria-label={!expanded ? label : undefined}
        aria-current={active ? 'true' : undefined}
      >
        <MessageSquare
          aria-hidden
          className={cn(
            'w-3.5 h-3.5 flex-shrink-0',
            active && 'text-accent-primary',
            // Secondary live cue alongside the title shimmer.
            streaming && !unread && 'text-accent-primary motion-safe:animate-pulse',
            unread && 'conversation-unread-glow',
          )}
        />
        {expanded && (
          <>
            <span className={cn('relative text-xs truncate min-w-0 text-left', unread && 'font-medium text-foreground')}>
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
            {unread && <span aria-hidden className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-primary" data-testid="conversation-unread-dot" />}
            <span className="flex-1" aria-hidden />
            {modeMark && <MissionModeRowMark badge={modeMark} />}
            {attention && <MissionAttentionMark kind={attentionKind} />}
            {unread && <span className="sr-only">{t('unread')}</span>}
            {streaming && <span className="sr-only">{t('live')}</span>}
          </>
        )}
      </button>
      {expanded && (
        <>
          {/* Compact "time since last interaction" (Cursor style) — swaps out
              for the row actions on hover or keyboard focus. */}
          <span
            className={cn(
              'flex-shrink-0 text-xs tabular-nums text-muted-foreground',
              confirming ? 'hidden' : 'group-hover:hidden group-focus-within:hidden',
            )}
            title={absoluteTime(conversation.updated_at)}
          >
            {compactRelativeTime(conversation.updated_at)}
          </span>
          <button
            type="button"
            onClick={handleFavoriteClick}
            className={cn(
              'flex flex-shrink-0 items-center justify-center w-5 h-5 rounded-sm transition-[color,background-color,opacity] hover:bg-muted',
              ROW_FOCUS,
              favorite
                ? 'text-accent-primary hover:text-accent-primary'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-accent-primary',
            )}
            aria-label={favorite ? t('removeFavoriteConversation', { title: label }) : t('addFavoriteConversation', { title: label })}
            title={favorite ? t('removeFavoriteConversation', { title: label }) : t('addFavoriteConversation', { title: label })}
          >
            <Heart className="w-3 h-3" fill={favorite ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            onClick={handleDeleteClick}
            className={cn(
              'flex flex-shrink-0 items-center justify-center rounded-sm transition-[color,background-color,opacity] hover:bg-muted',
              ROW_FOCUS,
              confirming
                ? 'px-1.5 h-5 text-caption font-medium text-destructive bg-destructive/10 hover:bg-destructive/20'
                : 'w-5 h-5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground',
            )}
            aria-label={confirming ? t('confirmDeleteConversation', { title: label }) : t('deleteConversation', { title: label })}
          >
            {confirming ? t('confirmShort') : <X className="w-3 h-3" />}
          </button>
        </>
      )}
    </div>
    </MissionConversationMenu>
  )
}

interface ArcSidebarProps {
  onAddProject: () => void
  onOpenLoops: () => void
  onOpenPlugins: () => void
  onOpenAnalytics: () => void
  onOpenDocs: () => void
  onOpenCompanion?: () => void
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
  unreadConversationIds,
  attentionConversationIds,
  attentionKinds,
  onSelectConversation,
  onToggleConversationFavorite,
  onDeleteConversation,
  onOpenProjectSettings,
  assembleStatus = 'ready',
  onRetryAssemble,
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
  unreadConversationIds?: ReadonlySet<string>
  /** Missions waiting for the person (decision) or with a failed run. */
  attentionConversationIds?: ReadonlySet<string>
  attentionKinds?: ReadonlyMap<string, 'decision' | 'failed'>
  onSelectConversation?: (id: string) => void
  onToggleConversationFavorite?: (id: string) => void
  onDeleteConversation?: (id: string) => void
  /** Hover gear (Agent Mode): open this project's settings modal. */
  onOpenProjectSettings?: () => void
  /** Silent-add workspace assembly state (silent-project-add). */
  assembleStatus?: 'assembling' | 'failed' | 'ready'
  onRetryAssemble?: () => void
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
      }, CONFIRM_RESET_MS)
    }
  }

  // Mission state of this project's conversations, shown on the project row
  // whenever its tree is not on screen (closed, or the rail is collapsed).
  const rollup = useMemo(
    () => agentMode
      ? rollupMissions(conversations, {
          attention: attentionConversationIds,
          attentionKinds,
          live: streamingConversationIds,
          unread: unreadConversationIds,
        })
      : { needsAttention: false, hasFailed: false, isLive: false, unreadCount: 0 },
    [agentMode, conversations, attentionConversationIds, attentionKinds, streamingConversationIds, unreadConversationIds],
  )
  const treeVisible = treeOpen && expanded
  const liveCue = rollup.isLive && !treeVisible

  const showChevron = agentMode && hasTree && expanded
  const projectIcon = expanded ? (
    <FolderOpen
      aria-hidden
      className={cn(
        'flex-shrink-0 w-4 h-4',
        (isActive || liveCue) && 'text-accent-primary',
      )}
    />
  ) : (
    <span
      aria-hidden
      data-testid="project-monogram"
      className={cn(
        'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-caption font-semibold leading-none',
        isActive ? 'text-foreground' : 'bg-muted text-foreground/85',
        liveCue && 'text-accent-primary',
      )}
      style={isActive ? { background: 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)' } as CSSProperties : undefined}
    >
      {projectMonogram(project.name)}
    </span>
  )
  const collapsedBadge = !expanded && rollup.needsAttention && (
    <span className={COLLAPSED_BADGE} data-testid="project-attention-badge">
      <MissionAttentionMark kind={rollup.hasFailed ? 'failed' : 'decision'} />
    </span>
  )

  return (
    <div>
      <div
        className={cn(
          'group relative flex items-center gap-1 w-full h-8 rounded-md transition-colors duration-150',
          expanded ? 'pr-2' : 'justify-center',
          isActive
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
        )}
      >
        {isActive && <NavRailIndicator />}
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-2 h-full rounded-md text-left',
            expanded ? 'pl-2' : 'justify-center',
            ROW_FOCUS,
          )}
          title={!expanded ? project.name : undefined}
          aria-label={!expanded ? project.name : undefined}
          aria-current={isActive ? 'page' : undefined}
          data-project-row={project.id}
        >
          <span className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center">
            <span className={cn('flex', showChevron && 'transition-opacity group-hover:opacity-0 group-focus-within:opacity-0')}>
              {projectIcon}
            </span>
            {collapsedBadge}
          </span>
          {expanded && (
            <>
              <span className="text-xs truncate min-w-0 text-left">{project.name}</span>
              {!treeVisible && <RollupMarks rollup={rollup} />}
              <span className="flex-1" aria-hidden />
            </>
          )}
        </button>
        {showChevron && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleTree?.() }}
            className={cn(
              'absolute left-1.5 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-sm hover:bg-muted',
              'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
              ROW_FOCUS,
            )}
            aria-label={treeOpen ? t('projects.collapse', { name: project.name }) : t('projects.expand', { name: project.name })}
            aria-expanded={treeOpen}
          >
            {treeOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        )}
        {assembleStatus === 'assembling' && (
          <span
            role="status"
            className={cn(
              'flex-shrink-0 h-1.5 w-1.5 rounded-full bg-accent-info motion-safe:animate-pulse',
              !expanded && 'absolute bottom-1 right-1',
            )}
            title={t('projects.assembling')}
            data-testid="assemble-indicator"
          >
            <span className="sr-only">{t('projects.assembling')}</span>
          </span>
        )}
        {assembleStatus === 'failed' && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRetryAssemble?.() }}
            className={cn(
              'flex flex-shrink-0 items-center justify-center gap-1 rounded text-accent-warning bg-accent-warning/10 hover:bg-accent-warning/20 transition-colors',
              ROW_FOCUS,
              expanded ? 'h-5 px-1.5 text-caption font-medium' : 'absolute -bottom-0.5 right-0 h-4 w-4',
            )}
            title={t('projects.assembleFailed')}
            data-testid="assemble-retry"
            aria-label={t('projects.assembleFailed')}
          >
            <RotateCw className="h-3 w-3" aria-hidden />
            {expanded && <span>{t('projects.retrySetup')}</span>}
          </button>
        )}
        {expanded && (
          <>
            {onOpenProjectSettings && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenProjectSettings() }}
                className={cn(
                  'flex-shrink-0 flex items-center justify-center rounded-sm transition-all w-5 h-5',
                  'opacity-0 group-hover:opacity-50 group-focus-within:opacity-60 focus-visible:!opacity-100 hover:!opacity-100 hover:bg-muted',
                  ROW_FOCUS,
                )}
                aria-label={t('projects.settings', { name: project.name })}
                title={t('projects.settings', { name: project.name })}
              >
                <Settings className="w-3 h-3" />
              </button>
            )}
            <button
              type="button"
              onClick={handleRemoveClick}
              className={cn(
                'flex-shrink-0 flex items-center justify-center rounded-sm transition-all',
                ROW_FOCUS,
                confirming
                  ? 'opacity-100 px-1.5 h-5 text-caption font-medium text-destructive bg-destructive/10 hover:bg-destructive/20'
                  : 'w-5 h-5 opacity-0 group-hover:opacity-50 group-focus-within:opacity-60 focus-visible:!opacity-100 hover:!opacity-100 hover:bg-muted'
              )}
              aria-label={confirming ? t('projects.confirmRemove', { name: project.name }) : t('projects.remove', { name: project.name })}
            >
              {confirming ? t('projects.confirmShort') : <X className="w-3 h-3" />}
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
              unread={unreadConversationIds?.has(c.id) ?? false}
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

/** Header row of a virtual conversation group (Favorites, Home). The icon
 *  swaps for a disclosure chevron on hover/focus in the expanded rail. */
function GroupHeader({
  icon,
  label,
  open,
  expanded,
  rollup,
  onClick,
}: {
  icon: (cls: string) => React.ReactNode
  label: string
  open: boolean
  expanded: boolean
  rollup: MissionRollup
  onClick: () => void
}) {
  const treeVisible = open && expanded
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-2 w-full h-8 rounded-md transition-colors',
        'text-muted-foreground hover:text-foreground hover:bg-muted/50',
        expanded ? 'px-2' : 'px-0 justify-center',
        ROW_FOCUS,
      )}
      aria-label={label}
      aria-expanded={open}
      title={!expanded ? label : undefined}
    >
      <span className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center">
        {expanded
          ? (
              <>
                {icon(cn('h-4 w-4 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0', rollup.isLive && !treeVisible && 'text-accent-primary'))}
                <span className="absolute inset-0 hidden items-center justify-center group-hover:flex group-focus-visible:flex">
                  {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </span>
              </>
            )
          : icon(cn('w-4 h-4 flex-shrink-0', rollup.isLive && 'text-accent-primary'))}
        {!expanded && rollup.needsAttention && (
          <span className={COLLAPSED_BADGE}>
            <MissionAttentionMark kind={rollup.hasFailed ? 'failed' : 'decision'} />
          </span>
        )}
      </span>
      {expanded && <span className="text-xs truncate min-w-0 text-left">{label}</span>}
      {!treeVisible && <RollupMarks rollup={expanded ? rollup : { ...rollup, needsAttention: false, unreadCount: 0 }} />}
      {expanded && <span className="flex-1" aria-hidden />}
    </button>
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
  onOpenPlugins,
  onOpenAnalytics,
  onOpenDocs,
  onOpenSettings,
  onOpenCompanion,
}: ArcSidebarProps) {
  const { t } = useTranslation('nav')
  const { t: tAgent } = useTranslation('agent')
  const { projects, activeProjectId, setActiveProjectId, removeProject } = useDesktop()
  const assembleProgress = useAssembleProgress()
  const navigate = useNavigate()
  const location = useLocation()
  const onLoopsRoute = location.pathname.startsWith('/loops')
  const onPluginsRoute = location.pathname.startsWith('/plugins')
  const onGlobalRoute = onLoopsRoute || onPluginsRoute || location.pathname.startsWith('/docs')
  const { leftMode, effectiveLeftMode, cycleLeftMode, setLeftMode } = useSidebarPin()
  const { uiMode, toggleUiMode } = useUiMode()
  const agentChat = useAgentChat()
  // A mission is live while a turn streams or its agents work in the background.
  const { backgroundConversationIds } = useMissionSessions()
  const liveConversationIds = useMemo(
    () => backgroundConversationIds.size === 0 ? agentChat.streamingConversationIds : new Set([...agentChat.streamingConversationIds, ...backgroundConversationIds]),
    [agentChat.streamingConversationIds, backgroundConversationIds],
  )
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
  const rollupSets = {
    attention: agentChat.attentionConversationIds,
    attentionKinds: agentChat.attentionKinds,
    live: liveConversationIds,
    unread: agentChat.unreadConversationIds,
  }
  const favoritesRollup = rollupMissions(favoriteConversations, rollupSets)
  const homeRollup = rollupMissions(homeConversations, rollupSets)

  const [expandedTree, setExpandedTree] = useState<Set<string>>(loadExpanded)
  const favoriteTreeOpen = expandedTree.has(FAVORITES_KEY)
  // Per-project settings modal (Agent Mode hover gear on a project folder).
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const [projectSettingsSection, setProjectSettingsSection] = useState<string | undefined>()
  // ⌘K "Open project settings ▸ <section>" (lib/app-settings-events).
  useEffect(() => {
    const onOpen = (event: Event) => {
      const section = (event as CustomEvent<OpenProjectSettingsDetail>).detail?.section
      setProjectSettingsSection(section)
      setProjectSettingsOpen(true)
    }
    window.addEventListener(OPEN_PROJECT_SETTINGS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_PROJECT_SETTINGS_EVENT, onOpen)
  }, [])
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
  const openTree = (key: string) => {
    setExpandedTree((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      saveExpanded(next)
      return next
    })
  }

  const splitViews = useMissionSplitViews()
  const handleSelectConversation = (id: string) => {
    if (!splitViews.focusExisting(id)) { splitViews.showPrimary(); void agentChat.selectConversation(id) }
    // A global route (/loops, /docs) occupies the center in Agent Mode — leave
    // it so the selected thread is actually visible on the agent surface.
    if (onGlobalRoute) navigate('/')
  }

  const handleDeleteConversation = (id: string) => {
    agentChat.deleteConversation(id).catch(() => {
      toast.error(tAgent('deleteFailed'))
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
      if (!expanded) {
        // Collapsed rail (including a pinned sidebar auto-collapsed in a narrow
        // window): reveal the project's mission list instead of toggling a tree
        // nobody can see.
        hover.setHovered(true)
        openTree(projectId)
        return
      }
      toggleTree(projectId)
      return
    }
    if (projectId === activeProjectId) {
      // Already active: only meaningful when viewing a global page — return to
      // the project's dashboard (no state change would fire the route effect).
      if (onGlobalRoute) {
        navigate('/')
      }
      return
    }
    // Different project: switching activeProjectId fires the route-memory effect,
    // which navigates to that project's last surface (off any global route).
    setActiveProjectId(projectId)
  }

  // `effectiveLeftMode` is the rendered mode: a pinned-open sidebar behaves as
  // unpinned in a narrow window. `leftMode` stays the user's (persisted) choice.
  const unpinned = effectiveLeftMode === 'unpinned'
  const docked = effectiveLeftMode === 'pinned-open'
  // Drag-resizable width (persisted), applied imperatively through the panel
  // ref — 300px expanded, 44px (w-11) collapsed rail.
  const [dragging, setDragging] = useState(false)
  const hover = useSidebarHoverIntent({ enabled: unpinned, dragging })
  const expanded = docked || (unpinned && hover.hovered)
  // The in-flow wrapper only reserves the expanded width when pinned open; a
  // hover-expanded unpinned panel overlays the content instead of reflowing it.
  // The hover-intent hook keeps the panel open during a drag.
  const resize = useResizableSidebar('left-arc', {
    side: 'left', defaultWidth: 300, min: 200, max: 460, collapsedWidth: 44, expanded, docked,
  })
  useEffect(() => { setDragging(resize.dragging) }, [resize.dragging])
  // Esc closes the hover/flyout overlay of a collapsed or unpinned sidebar and
  // returns focus to the active project's row (focus first: the focus handler
  // re-opens the overlay, the explicit close right after wins).
  const closeFlyout = hover.setHovered
  const overlayOpen = unpinned && hover.hovered
  useEffect(() => {
    if (!overlayOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const row = activeProjectId
        ? document.querySelector<HTMLElement>(`[data-project-row="${CSS.escape(activeProjectId)}"]`)
        : null
      row?.focus()
      closeFlyout(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [overlayOpen, activeProjectId, closeFlyout])
  const overlaying = expanded && !docked
  const lit = leftMode !== 'unpinned'
  const pinLabel = t(LEFT_PIN_LABEL_KEY[leftMode])

  /** Collapsed rail: a group header opens the sidebar (pinned) on that group. */
  const expandOnGroup = (key: string) => {
    if (expanded) { toggleTree(key); return }
    setLeftMode('pinned-open')
    // A narrow window renders pinned-open as an overlay: open it now as well.
    hover.setHovered(true)
    openTree(key)
  }

  const navItems = [
    { label: t('arcSidebar.analytics'), icon: BarChart3, action: onOpenAnalytics },
    { label: t('arcSidebar.docs'), icon: BookOpen, action: onOpenDocs },
    ...(onOpenCompanion ? [{ label: t('arcSidebar.companion'), icon: Smartphone, action: onOpenCompanion }] : []),
  ]

  async function handleRemove(project: DesktopProject) {
    try {
      await removeProject(project.id)
    } catch {
      // errors handled via toast in parent
    }
  }

  function handleModeRadioKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    toggleUiMode()
    const group = e.currentTarget.parentElement
    requestAnimationFrame(() => group?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus())
  }

  const rowClass = (activeRow: boolean) => cn(
    'relative flex items-center gap-2 w-full h-8 rounded-md transition-colors duration-150',
    expanded ? 'px-2' : 'px-0 justify-center',
    activeRow
      ? 'bg-muted text-foreground'
      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
    ROW_FOCUS,
  )

  return (
    <aside
      ref={resize.wrapperRef}
      aria-label={t('arcSidebar.landmark')}
      className="relative h-full flex-shrink-0 transition-[width] duration-200 ease-in-out"
      {...hover.handlers}
    >
    <div
      ref={resize.panelRef}
      data-testid="arc-sidebar-panel"
      data-overlay={overlaying || undefined}
      className={cn(
        'absolute inset-y-0 left-0 z-30 flex flex-col border-r border-border bg-background overflow-hidden',
        // Width is set imperatively by useResizableSidebar (px). The transition
        // animates collapse/expand + keyboard nudges; a drag turns it off itself.
        'transition-[width,box-shadow] duration-200 ease-in-out',
        overlaying && 'shadow-xl',
      )}
    >
      {expanded && (
        <SidebarResizeGrip
          side="left"
          dragging={resize.dragging}
          width={resize.width}
          min={200}
          max={460}
          label={t('arcSidebar.resize')}
          onPointerDown={resize.onGripPointerDown}
          onKeyDown={resize.onGripKeyDown}
        />
      )}
      {/* Header (browser only — the desktop title bar carries the pin button) */}
      {!isTauri() && <div
        className={cn(
          'flex items-center h-12 border-b border-border flex-shrink-0',
          expanded ? 'px-3 justify-between' : 'justify-center'
        )}
      >
        {expanded && (
          <span className="text-xs font-medium whitespace-nowrap overflow-hidden text-muted-foreground">
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
              : 'text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/50',
            ROW_FOCUS,
          )}
          aria-label={pinLabel}
          aria-pressed={lit}
          title={t('sidebarPin.withShortcut', { label: pinLabel, shortcut: keyboardLabel('⌘B') })}
        >
          <PanelLeft className="w-4 h-4" />
        </button>
      </div>}

      {/* Agent Mode cluster — mode switch (both modes), New agent + Search (agent) */}
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
                ROW_FOCUS,
              )}
              aria-label={tAgent('newAgent')}
              title={!expanded ? tAgent('newAgent') : undefined}
            >
              <Plus className="w-4 h-4 flex-shrink-0" />
              {expanded && <span className="text-xs whitespace-nowrap">{tAgent('newAgent')}</span>}
            </button>
          )}
          {expanded ? (
            <div
              role="radiogroup"
              aria-label={tAgent('modeSwitch.label')}
              className="grid grid-cols-2 gap-0.5 rounded-md border border-border p-0.5"
              data-testid="ui-mode-switch"
            >
              {([
                { mode: 'agent', label: tAgent('modeSwitch.mission'), Icon: Bot },
                { mode: 'kanban', label: tAgent('modeSwitch.board'), Icon: LayoutGrid },
              ] as const).map(({ mode, label, Icon }) => {
                const checked = uiMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    onClick={() => { if (!checked) toggleUiMode() }}
                    onKeyDown={handleModeRadioKeyDown}
                    className={cn(
                      'flex h-7 min-w-0 items-center justify-center gap-1.5 rounded px-2 text-xs transition-colors',
                      checked
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                      ROW_FOCUS,
                    )}
                  >
                    <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', checked && 'text-accent-primary')} aria-hidden />
                    <span className="truncate">{label}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <button
              type="button"
              onClick={toggleUiMode}
              className={rowClass(false)}
              aria-label={tAgent('modeSwitch.current', { mode: agentMode ? tAgent('modeSwitch.mission') : tAgent('modeSwitch.board') })}
              title={tAgent('modeSwitch.current', { mode: agentMode ? tAgent('modeSwitch.mission') : tAgent('modeSwitch.board') })}
              data-testid="ui-mode-switch"
            >
              {agentMode
                ? <Bot className="w-4 h-4 flex-shrink-0 text-accent-primary" />
                : <LayoutGrid className="w-4 h-4 flex-shrink-0 text-accent-primary" />}
            </button>
          )}
          {agentMode && (
            <button
              type="button"
              onClick={openCommandPalette}
              className={rowClass(false)}
              aria-label={tAgent('search')}
              title={!expanded ? tAgent('search') : undefined}
            >
              <Search className="w-4 h-4 flex-shrink-0" />
              {expanded && <span className="text-xs whitespace-nowrap">{tAgent('search')}</span>}
            </button>
          )}
        </div>
      )}

      {/* Loops + Plugins — global tools, above the project list */}
      {FEATURE_LOOPS_SECTION && (
        <>
          <nav aria-label={t('arcSidebar.sectionTools')} className="py-2 px-1.5">
            {expanded && <div className={SECTION_LABEL} aria-hidden>{t('arcSidebar.sectionTools')}</div>}
            <button
              type="button"
              onClick={onOpenLoops}
              className={rowClass(onLoopsRoute)}
              aria-label={t('arcSidebar.loops')}
              aria-current={onLoopsRoute ? 'page' : undefined}
              title={!expanded ? t('arcSidebar.loops') : undefined}
            >
              {onLoopsRoute && <NavRailIndicator />}
              <Workflow className={cn('w-4 h-4 flex-shrink-0', onLoopsRoute && 'text-accent-primary')} />
              {expanded && <span className="text-xs whitespace-nowrap">{t('arcSidebar.loops')}</span>}
            </button>
            <button
              type="button"
              onClick={onOpenPlugins}
              className={cn('mt-0.5', rowClass(onPluginsRoute))}
              aria-label={t('arcSidebar.plugins')}
              aria-current={onPluginsRoute ? 'page' : undefined}
              title={!expanded ? t('arcSidebar.plugins') : undefined}
            >
              {onPluginsRoute && <NavRailIndicator />}
              <Puzzle className={cn('w-4 h-4 flex-shrink-0', onPluginsRoute && 'text-accent-primary')} />
              {expanded && <span className="text-xs whitespace-nowrap">{t('arcSidebar.plugins')}</span>}
            </button>
          </nav>
          <div className="border-t border-border" aria-hidden />
        </>
      )}

      {/* Projects list */}
      <nav aria-label={t('arcSidebar.sectionProjects')} className="flex-1 overflow-y-auto py-2 px-1.5 space-y-0.5">
        {agentMode && favoriteConversations.length > 0 && (
          <div className="mb-2 space-y-0.5 border-b border-border/70 pb-2">
            <GroupHeader
              icon={(cls) => <Heart aria-hidden className={cn(cls, 'fill-current text-accent-primary')} />}
              label={tAgent('favoriteMissions')}
              open={favoriteTreeOpen}
              expanded={expanded}
              rollup={favoritesRollup}
              onClick={() => expandOnGroup(FAVORITES_KEY)}
            />
            {favoriteTreeOpen && expanded && (
              <div className="mt-0.5 space-y-0.5">
                {favoriteConversations.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === agentChat.active?.id}
                    streaming={liveConversationIds.has(c.id)}
                    unread={agentChat.unreadConversationIds.has(c.id)}
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
        {expanded && <div className={SECTION_LABEL} aria-hidden>{t('arcSidebar.sectionProjects')}</div>}
        {/* Home group (agent mode) — conversations with no pinned project */}
        {agentMode && homeConversations.length > 0 && (
          <div>
            <GroupHeader
              icon={(cls) => <Home aria-hidden className={cls} />}
              label={tAgent('home')}
              open={expandedTree.has(HOME_KEY)}
              expanded={expanded}
              rollup={homeRollup}
              onClick={() => expandOnGroup(HOME_KEY)}
            />
            {expandedTree.has(HOME_KEY) && expanded && (
              <div className="mt-0.5 space-y-0.5">
                {homeConversations.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === agentChat.active?.id}
                    streaming={liveConversationIds.has(c.id)}
                    unread={agentChat.unreadConversationIds.has(c.id)}
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
              isActive={project.id === activeProjectId && !onGlobalRoute}
              expanded={expanded}
              onSelect={() => handleSelectProject(project.id)}
              onRemove={() => handleRemove(project)}
              agentMode={agentMode}
              hasTree={convs.length > 0}
              treeOpen={expandedTree.has(project.id)}
              onToggleTree={() => toggleTree(project.id)}
              conversations={convs}
              activeConversationId={agentChat.active?.id ?? null}
              streamingConversationIds={liveConversationIds}
              unreadConversationIds={agentChat.unreadConversationIds}
              attentionConversationIds={agentChat.attentionConversationIds}
              attentionKinds={agentChat.attentionKinds}
              onSelectConversation={handleSelectConversation}
              onToggleConversationFavorite={handleToggleFavoriteConversation}
              onDeleteConversation={handleDeleteConversation}
              assembleStatus={assembleProgress.statusFor(project.id)}
              onRetryAssemble={() => { void assembleProgress.retry(project.id) }}
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
          className={rowClass(false)}
          aria-label={t('projects.addProject')}
          title={!expanded ? t('projects.addProject') : undefined}
        >
          <Plus className="w-4 h-4 flex-shrink-0" />
          {expanded && <span className="text-xs whitespace-nowrap">{t('projects.addProject')}</span>}
        </button>
      </nav>

      {/* App-level tools + settings */}
      <div className="border-t border-border py-2 px-1.5 space-y-0.5">
        {navItems.map(({ label, icon: Icon, action }) => (
          <button
            key={label}
            type="button"
            onClick={action}
            className={rowClass(false)}
            aria-label={label}
            title={!expanded ? label : undefined}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {expanded && <span className="text-xs truncate">{label}</span>}
          </button>
        ))}
        <button
          type="button"
          onClick={onOpenSettings}
          className={rowClass(false)}
          aria-label={t('arcSidebar.settings')}
          title={!expanded ? t('arcSidebar.settings') : undefined}
        >
          <Settings className="w-4 h-4 flex-shrink-0" />
          {expanded && <span className="text-xs truncate">{t('arcSidebar.settings')}</span>}
        </button>
      </div>

      {projectSettingsOpen && (
        <Suspense fallback={null}>
          <ProjectSettingsDialog open initialSection={projectSettingsSection} onClose={() => { setProjectSettingsOpen(false); setProjectSettingsSection(undefined) }} />
        </Suspense>
      )}
    </div>
    </aside>
  )
}
