import { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Command } from 'cmdk'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import {
  Search,
  FolderOpen,
  Zap,
  Briefcase,
  LayoutDashboard,
  BarChart3,
  Activity,
  Settings,
  FileText,
  PieChart,
  MessagesSquare,
  ChevronLeft,
  History,
  Loader2,
} from 'lucide-react'
import { useDesktop } from '../hooks/useDesktop'
import { usePlaceHistory } from '../hooks/usePlaceHistory'
import { useInbox } from '../features/inbox/context/InboxContext'
import { useUndo } from '../hooks/useUndo'
import { useThemeOptional } from '../features/settings/context/ThemeContext'
import { loopsApi } from '../features/loops/lib/loops-api'
import { loopNeedsTicket } from '../features/loops/lib/loop-ticket-need'
import { openAppSettings, openProjectSettings } from '../lib/app-settings-events'
import { usePaletteSurfaces } from '../lib/palette-bridge'
import { isGlobalRoute } from '../lib/sidebar-layout'
import { keyboardLabel } from '../lib/keyboard-label'
import { FEATURE_AGENT_MODE, FEATURE_LOOPS_SECTION } from '../lib/feature-flags'
import { SPEC_PARAM } from '../lib/places'
import {
  MAX_ARG_ROWS,
  MAX_RECENT_PLACES,
  filterArgOptions,
  parseActionQuery,
  rankActions,
  PALETTE_ACTIONS,
  recentActionRows,
  type ArgOption,
  type ArgPage,
  type PaletteAction,
  type PaletteContext,
} from './command-palette/palette-actions'
import { readRecentActionIds, recordRecentAction } from './command-palette/recent-actions'
import { getApiBase } from '../lib/api'
import type { CommandInfo, JobSummary } from '../types'
import { cn } from '../lib/utils'
import { DIALOG_PANEL_CLASS, DIALOG_SCRIM_CLASS, DIALOG_SIZE_CLASS } from './ui/dialog'
import { DIALOG_LAYER_CLASS } from '../lib/layers'
import { useSidebarPin } from '../context/SidebarPinContext'
import { useUiMode } from '../context/UiModeContext'
import { useAgentChat } from '../features/missions/context/AgentChatContext'
import { searchMissions, type MissionSearchHit, type MissionSearchSnippet } from '../features/missions/lib/agent-api'
import {
  groupOrderForMode,
  matchMissionTitles,
  matchesPaletteQuery,
  mergeMissionResults,
  recentMissions,
  MISSION_SEARCH_DEBOUNCE_MS,
  MISSION_SEARCH_LIMIT,
  type MissionSearchRow,
  type PaletteGroup,
} from '../features/missions/lib/mission-search'
import { absoluteTime, compactRelativeTime } from '../lib/relative-time'
import { LiveDot } from './ui/live-dot'

interface PageFrame {
  actionId: string
  page: ArgPage
}

interface CommandPaletteProps {
  onOpenSettings?: () => void
  onOpenAnalytics?: () => void
  onOpenDocs?: () => void
}

/** Server hits are only trusted for the query they answered — a stale answer
 *  must never enrich rows of a newer query. */
interface ServerHits {
  query: string
  hits: MissionSearchHit[]
}

const EMPTY_HITS: MissionSearchHit[] = []

/** Render a server snippet as text with `<mark>` over its highlight ranges. */
function renderSnippet(snippet: MissionSearchSnippet): ReactNode {
  const parts: ReactNode[] = []
  let cursor = 0
  snippet.ranges.forEach(([start, end], i) => {
    if (start > cursor) parts.push(snippet.text.slice(cursor, start))
    parts.push(
      <mark key={i} className="rounded-sm bg-accent-primary/20 px-0.5 text-foreground">
        {snippet.text.slice(start, end)}
      </mark>,
    )
    cursor = end
  })
  if (cursor < snippet.text.length) parts.push(snippet.text.slice(cursor))
  return parts
}

const PALETTE_BY_ID = new Map(PALETTE_ACTIONS.map((a) => [a.id, a]))

/** The second palette page: the options of an action's argument. */
function ArgPageList({ frame, search, loaded, onSelect, itemClass, loadingLabel, failedLabel }: {
  frame: PageFrame
  search: string
  loaded: { options: ArgOption[] | null; failed: boolean } | null
  onSelect: (option: ArgOption) => void
  itemClass: string
  loadingLabel: string
  failedLabel: string
}) {
  const { page } = frame
  const options = page.load ? loaded?.options ?? null : page.options ?? []
  if (options === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status" data-testid="palette-page-loading">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> {loadingLabel}
      </div>
    )
  }
  const visible = filterArgOptions(options, search)
  return (
    <Command.Group heading={page.title} data-testid="palette-page">
      {visible.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground" data-testid="palette-page-empty">
          {loaded?.failed ? failedLabel : page.emptyLabel}
        </div>
      )}
      {visible.slice(0, MAX_ARG_ROWS * 4).map((option) => (
        <Command.Item
          key={option.id}
          value={`opt:${option.id}`}
          disabled={option.disabled}
          onSelect={() => onSelect(option)}
          className={cn(itemClass, option.disabled && 'opacity-50 cursor-not-allowed')}
          data-testid={`palette-option-${option.id}`}
        >
          <span className="flex-1 truncate">{option.label}{option.next ? ' ▸' : ''}</span>
          {option.hint && <span className="shrink-0 text-xs text-muted-foreground">{option.hint}</span>}
        </Command.Item>
      ))}
    </Command.Group>
  )
}

export function CommandPalette({ onOpenSettings, onOpenAnalytics, onOpenDocs }: CommandPaletteProps) {
  const { t } = useTranslation('commands')
  const { t: tAgent } = useTranslation('agent')
  const { t: tLoops } = useTranslation('loops')
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([])
  const [serverHits, setServerHits] = useState<ServerHits>({ query: '', hits: EMPTY_HITS })
  const { projects, activeProjectId, setActiveProjectId } = useDesktop()
  const { leftMode, rightMode, cycleLeftMode, cycleRightMode } = useSidebarPin()
  const { uiMode, setUiMode } = useUiMode()
  const { conversations, liveByConversation, selectConversation, open: openAgentPanel, startNewConversation } = useAgentChat()
  const leftLabel = leftMode === 'pinned-open'
    ? t('palette.sidebar.collapseLeftKeepPinned')
    : leftMode === 'pinned-collapsed'
      ? t('palette.sidebar.unpinLeft')
      : t('palette.sidebar.pinLeftOpen')
  const rightLabel = rightMode === 'pinned-open'
    ? t('palette.sidebar.collapseRightKeepPinned')
    : rightMode === 'pinned-collapsed'
      ? t('palette.sidebar.unpinRight')
      : t('palette.sidebar.pinRightOpen')
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const places = usePlaceHistory()
  const inbox = useInbox()
  const { undoLast, peekUndo } = useUndo()
  const theme = useThemeOptional()
  const surfaces = usePaletteSurfaces()
  // Argument pages (cmdk pages): a stack so multi-step actions (pick a spec,
  // then a rail) return one step per Backspace/Back.
  const [pages, setPages] = useState<PageFrame[]>([])
  const [loadedOptions, setLoadedOptions] = useState<{ frame: PageFrame; options: ArgOption[] | null; failed: boolean } | null>(null)
  const [recentIds, setRecentIds] = useState<string[]>(() => readRecentActionIds())
  const inputRef = useRef<HTMLInputElement>(null)
  const fetchedRef = useRef(false)
  const searchSeq = useRef(0)

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Fetch commands and recent jobs when palette opens
  useEffect(() => {
    if (!open) {
      fetchedRef.current = false
      setSearch('')
      setPages([])
      setLoadedOptions(null)
      return
    }
    setRecentIds(readRecentActionIds())
    if (fetchedRef.current) return
    fetchedRef.current = true

    async function fetchData() {
      try {
        const [configRes, jobsRes] = await Promise.all([
          fetch(`${getApiBase()}/config`),
          fetch(`${getApiBase()}/jobs?limit=10`),
        ])
        if (configRes.ok) {
          const configData = await configRes.json() as { commands: CommandInfo[] }
          setCommands(configData.commands)
        }
        if (jobsRes.ok) {
          const jobsData = await jobsRes.json() as { jobs: JobSummary[] }
          setRecentJobs(jobsData.jobs)
        }
      } catch {
        // Silently fail — palette still works with projects and navigation
      }
    }
    fetchData()
  }, [open])

  // Phase B of mission search: debounced server query, previous request
  // aborted, answers matched back to the query they belong to (D1).
  useEffect(() => {
    const parsed = parseActionQuery(search)
    const q = parsed.explicit ? '' : parsed.text
    const seq = ++searchSeq.current
    if (!open || !q) return
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      searchMissions(q, MISSION_SEARCH_LIMIT, ctrl.signal)
        .then((hits) => {
          if (seq === searchSeq.current) setServerHits({ query: q, hits })
        })
        .catch(() => {
          // Aborted by a newer keystroke, or the server is unreachable — the
          // in-memory title matches keep rendering either way.
        })
    }, MISSION_SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [search, open])

  const untitledMission = tAgent('mission.untitled')
  const missionRows = useMemo<MissionSearchRow[]>(() => {
    const parsedQuery = parseActionQuery(search)
    if (parsedQuery.explicit) return []
    const q = parsedQuery.text
    if (!q) return recentMissions(conversations)
    const titleRows = matchMissionTitles(conversations, q, untitledMission)
    return mergeMissionResults(titleRows, serverHits.query === q ? serverHits.hits : EMPTY_HITS)
  }, [conversations, search, serverHits, untitledMission])

  const projectNameById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])

  const handleSelectProject = useCallback((projectId: string) => {
    setActiveProjectId(projectId)
    setOpen(false)
  }, [setActiveProjectId])

  const handleSelectMission = useCallback((conversationId: string) => {
    setOpen(false)
    void selectConversation(conversationId)
    // On the board the mission lives in the floating panel — surface it.
    if (uiMode !== 'agent') openAgentPanel()
  }, [selectConversation, openAgentPanel, uiMode])

  const handleSelectCommand = useCallback(async (slug: string) => {
    setOpen(false)
    try {
      const res = await fetch(`${getApiBase()}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `/specrails:${slug}` }),
      })
      const data = await res.json() as { jobId?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? t('errors.spawnFailed'))
      toast.success(t('toasts.queued', { name: slug }))
      navigate(`/jobs/${data.jobId}`)
    } catch (err) {
      toast.error(t('errors.spawnFailed'), { description: err instanceof Error ? err.message : undefined })
    }
  }, [navigate, t])

  const handleSelectJob = useCallback((jobId: string) => {
    setOpen(false)
    navigate(`/jobs/${jobId}`)
  }, [navigate])

  const handleNavigate = useCallback((path: string) => {
    setOpen(false)
    navigate(path)
  }, [navigate])

  const handleDesktopAction = useCallback((action: (() => void) | undefined) => {
    if (!action) return
    setOpen(false)
    action()
  }, [])

  const navItemClass = 'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground'

  // cmdk's own fuzzy filter is OFF (a content hit whose title lacks the query
  // would otherwise be hidden), so every group filters itself (D5).
  const parsedQuery = parseActionQuery(search)
  const commandMode = parsedQuery.explicit
  const textQuery = parsedQuery.text
  const visibleProjects = commandMode ? [] : projects.filter((p) => matchesPaletteQuery(textQuery, p.name, [p.slug]))
  const visibleCommands = commandMode ? [] : commands.filter((cmd) => matchesPaletteQuery(textQuery, cmd.name, [cmd.slug, cmd.description ?? '']))
  const visibleJobs = commandMode ? [] : recentJobs.filter((job) => matchesPaletteQuery(textQuery, `${job.command} ${job.id}`, [job.status]))

  interface NavEntry {
    key: string
    label: string
    keywords: string[]
    icon: ReactNode
    onSelect: () => void
  }
  const navEntries: NavEntry[] = [
    { key: 'dashboard', label: t('palette.nav.dashboard'), keywords: ['home'], icon: <LayoutDashboard className="w-4 h-4 text-muted-foreground shrink-0" />, onSelect: () => handleNavigate('/') },
    ...(onOpenAnalytics
      ? [{ key: 'desktopAnalytics', label: t('palette.nav.desktopAnalytics'), keywords: ['cross-project', 'desktop'], icon: <PieChart className="w-4 h-4 text-muted-foreground shrink-0" />, onSelect: () => handleDesktopAction(onOpenAnalytics) }]
      : []),
    { key: 'projectAnalytics', label: t('palette.nav.projectAnalytics'), keywords: ['metrics'], icon: <BarChart3 className="w-4 h-4 text-muted-foreground shrink-0" />, onSelect: () => handleNavigate('/analytics') },
    { key: 'activityFeed', label: t('palette.nav.activityFeed'), keywords: ['log'], icon: <Activity className="w-4 h-4 text-muted-foreground shrink-0" />, onSelect: () => handleNavigate('/activity') },
    { key: 'desktopSettings', label: t('palette.nav.desktopSettings'), keywords: ['configuration'], icon: <Settings className="w-4 h-4 text-muted-foreground shrink-0" />, onSelect: () => (onOpenSettings ? handleDesktopAction(onOpenSettings) : handleNavigate('/settings')) },
    { key: 'docs', label: t('palette.nav.docs'), keywords: ['documentation'], icon: <FileText className="w-4 h-4 text-muted-foreground shrink-0" />, onSelect: () => (onOpenDocs ? handleDesktopAction(onOpenDocs) : handleNavigate('/docs')) },
  ]
  const visibleNav = commandMode ? [] : navEntries.filter((entry) => matchesPaletteQuery(textQuery, entry.label, entry.keywords))

  // ─── Actions (QW1) ─────────────────────────────────────────────────────────
  const focusedSpecParam = Number(searchParams.get(SPEC_PARAM))
  const paletteCtx: PaletteContext = {
    t: t as PaletteContext['t'],
    uiMode,
    projectId: activeProjectId,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    focusedSpecId: Number.isInteger(focusedSpecParam) && focusedSpecParam > 0 ? focusedSpecParam : null,
    surfaces,
    flags: { agentMode: FEATURE_AGENT_MODE, loops: FEATURE_LOOPS_SECTION },
    theme: theme ? { id: theme.themeId, set: theme.setTheme } : null,
    history: places ? { canBack: places.canBack, canForward: places.canForward, back: places.back, forward: places.forward } : null,
    inbox: inbox ? { count: inbox.count, open: inbox.openInbox } : null,
    undoLabel: open ? peekUndo() : null,
    sidebarLabels: { left: leftLabel, right: rightLabel },
    go: {
      navigate,
      setUiMode,
      openAppSettings,
      // Mission mode hosts project settings as a modal; Board mode shows the same sections on /settings.
      openProjectSettings: (section) => { if (uiMode === 'agent') openProjectSettings(section); else navigate('/settings') },
      newMission: () => {
        startNewConversation(activeProjectId)
        if (isGlobalRoute(location.pathname, uiMode)) navigate('/')
      },
      setProject: setActiveProjectId,
      toggleLeftSidebar: cycleLeftMode,
      toggleRightSidebar: cycleRightMode,
      undoLast: () => { void undoLast() },
      listRunnableLoops: async () => (await loopsApi.list()).filter((l) => !loopNeedsTicket(l.graph)).map((l) => ({ id: l.id, name: l.name })),
      runLoop: (loopId, name) => {
        if (!activeProjectId) return
        loopsApi.runStandalone(activeProjectId, loopId)
          .then(({ loopRunId }) => {
            navigate(`/jobs/${loopRunId}`)
            toast.success(tLoops('run.launched', { name }))
          })
          .catch(() => { toast.error(tLoops('errors.save')) })
      },
    },
  }
  const actionRows = open ? rankActions(paletteCtx, search) : { leading: false, rows: [] }
  const recentRows = open && !search.trim() ? recentActionRows(paletteCtx, recentIds) : []
  const recentPlaces = open && !search.trim() && places ? places.recent(MAX_RECENT_PLACES) : []
  const topPage = pages.length > 0 ? pages[pages.length - 1] : null

  const finishAction = (action: PaletteAction, arg?: unknown) => {
    setOpen(false)
    setRecentIds(recordRecentAction(action.id))
    action.run(paletteCtx, arg)
  }

  const selectAction = (action: PaletteAction) => {
    const page = action.page?.(paletteCtx) ?? null
    if (page) {
      setPages([{ actionId: action.id, page }])
      setSearch('')
      return
    }
    finishAction(action)
  }

  const selectOption = (frame: PageFrame, option: ArgOption) => {
    if (option.disabled) return
    if (option.next) {
      setPages((prev) => [...prev, { actionId: frame.actionId, page: option.next as ArgPage }])
      setSearch('')
      return
    }
    const action = PALETTE_BY_ID.get(frame.actionId)
    if (action) finishAction(action, option.arg)
  }

  const popPage = () => {
    setPages((prev) => prev.slice(0, -1))
    setSearch('')
  }

  // A page change keeps typing (and Backspace-to-go-back) working after a mouse pick.
  useEffect(() => { if (open) inputRef.current?.focus() }, [open, pages.length])

  // Options that load when the page opens (loops, Jira workflow statuses).
  useEffect(() => {
    if (!topPage?.page.load) { setLoadedOptions(null); return }
    let alive = true
    setLoadedOptions({ frame: topPage, options: null, failed: false })
    topPage.page.load()
      .then((options) => { if (alive) setLoadedOptions({ frame: topPage, options, failed: false }) })
      .catch(() => { if (alive) setLoadedOptions({ frame: topPage, options: [], failed: true }) })
    return () => { alive = false }
  }, [topPage])

  const actionRow = (action: PaletteAction, label: string, keyPrefix: string) => {
    const Icon = action.icon
    const opensPage = !!action.page && action.page(paletteCtx) !== null
    return (
      <Command.Item
        key={`${keyPrefix}-${action.id}`}
        value={`${keyPrefix}:${action.id}`}
        onSelect={() => selectAction(action)}
        className={navItemClass}
        data-testid={`palette-action-${keyPrefix}-${action.id}`}
      >
        <Icon className="w-4 h-4 text-accent-primary shrink-0" />
        <span className="flex-1 truncate">{label}{opensPage ? ' ▸' : ''}</span>
        {action.shortcut && (
          <kbd className="shrink-0 rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 text-caption text-muted-foreground font-mono">
            {keyboardLabel(action.shortcut)}
          </kbd>
        )}
      </Command.Item>
    )
  }

  const actionsGroup = actionRows.rows.length > 0 && (
    <Command.Group key="actions" heading={t('palette.groups.actions')} data-testid="palette-group-actions">
      {actionRows.rows.map(({ action, label }) => actionRow(action, label, 'a'))}
    </Command.Group>
  )
  const recentActionsGroup = recentRows.length > 0 && (
    <Command.Group key="recentActions" heading={t('palette.groups.recentActions')} data-testid="palette-group-recent-actions">
      {recentRows.map(({ action, label }) => actionRow(action, label, 'r'))}
    </Command.Group>
  )
  const recentPlacesGroup = recentPlaces.length > 0 && (
    <Command.Group key="recentPlaces" heading={t('palette.groups.recentPlaces')} data-testid="palette-group-recent-places">
      {recentPlaces.map((place) => (
        <Command.Item
          key={place.key}
          value={`place:${place.key}`}
          onSelect={() => { setOpen(false); navigate(place.to) }}
          className={navItemClass}
          data-testid="palette-recent-place"
        >
          <History className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate">{place.label}</span>
        </Command.Item>
      ))}
    </Command.Group>
  )

  const groups: Record<PaletteGroup, ReactNode> = {
    missions: missionRows.length > 0 && (
      <Command.Group key="missions" heading={t('palette.groups.missions')} data-testid="palette-group-missions">
        {missionRows.map((row) => {
          const { conversation } = row
          const streaming = liveByConversation.get(conversation.id)?.isStreaming === true
          const projectName = conversation.pinned_project_id
            ? projectNameById.get(conversation.pinned_project_id) ?? null
            : null
          return (
            <Command.Item
              key={conversation.id}
              value={`mission:${conversation.id}`}
              onSelect={() => handleSelectMission(conversation.id)}
              className={cn(navItemClass, 'items-start')}
              data-testid={`palette-mission-${conversation.id}`}
            >
              <MessagesSquare className="w-4 h-4 mt-0.5 text-accent-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{conversation.title?.trim() || untitledMission}</span>
                  {streaming && (
                    <LiveDot
                      size="xs"
                      aria-label={tAgent('mission.working')}
                      data-testid={`palette-mission-live-${conversation.id}`}
                    />
                  )}
                  <span
                    className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground"
                    title={absoluteTime(conversation.updated_at)}
                  >
                    {compactRelativeTime(conversation.updated_at)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 min-w-0 text-xs text-muted-foreground">
                  <span className="shrink-0">{projectName ?? t('palette.missions.home')}</span>
                  {row.snippet && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="truncate" data-testid={`palette-mission-snippet-${conversation.id}`}>
                        {renderSnippet(row.snippet)}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </Command.Item>
          )
        })}
      </Command.Group>
    ),
    projects: visibleProjects.length > 0 && (
      <Command.Group key="projects" heading={t('palette.groups.projects')} data-testid="palette-group-projects">
        {visibleProjects.map((project) => (
          <Command.Item
            key={project.id}
            value={project.name}
            keywords={[project.slug]}
            onSelect={() => handleSelectProject(project.id)}
            className={cn(navItemClass, project.id === activeProjectId && 'text-accent-primary')}
          >
            <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="flex-1 truncate">{project.name}</span>
            {project.id === activeProjectId && (
              <span className="text-xs text-accent-primary font-medium">{t('palette.activeBadge')}</span>
            )}
          </Command.Item>
        ))}
      </Command.Group>
    ),
    spec: visibleCommands.length > 0 && (
      <Command.Group key="spec" heading={t('palette.groups.spec')}>
        {visibleCommands.map((cmd) => (
          <Command.Item
            key={cmd.id}
            value={cmd.name}
            keywords={[cmd.slug, cmd.description ?? '']}
            onSelect={() => handleSelectCommand(cmd.slug)}
            className={navItemClass}
          >
            <Zap className="w-4 h-4 text-accent-info shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="truncate">{cmd.name}</span>
              {cmd.description && (
                <span className="text-xs text-muted-foreground ml-2 truncate">{cmd.description}</span>
              )}
            </div>
          </Command.Item>
        ))}
      </Command.Group>
    ),
    jobs: visibleJobs.length > 0 && (
      <Command.Group key="jobs" heading={t('palette.groups.jobs')}>
        {visibleJobs.map((job) => (
          <Command.Item
            key={job.id}
            value={`${job.command} ${job.id}`}
            keywords={[job.status]}
            onSelect={() => handleSelectJob(job.id)}
            className={navItemClass}
          >
            <Briefcase className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="flex-1 truncate">{job.command}</span>
            <span className={cn(
              'text-xs font-medium',
              job.status === 'completed' && 'text-accent-success',
              job.status === 'failed' && 'text-destructive',
              job.status === 'running' && 'text-accent-info',
              job.status === 'queued' && 'text-muted-foreground',
            )}>
              {t(`common:status.${job.status}`, { defaultValue: job.status })}
            </span>
          </Command.Item>
        ))}
      </Command.Group>
    ),
    navigation: visibleNav.length > 0 && (
      <Command.Group key="navigation" heading={t('palette.groups.navigation')}>
        {visibleNav.map((entry) => (
          <Command.Item key={entry.key} value={entry.label} keywords={entry.keywords} onSelect={entry.onSelect} className={navItemClass}>
            {entry.icon}
            <span>{entry.label}</span>
          </Command.Item>
        ))}
      </Command.Group>
    ),
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      shouldFilter={false}
      label={t('palette.dialogTitle')}
      // cmdk renders a Radix dialog: style its Content as a standard `form`
      // panel and its Overlay with the shared scrim.
      overlayClassName={cn(DIALOG_SCRIM_CLASS, DIALOG_LAYER_CLASS.stacked)}
      contentClassName={cn(DIALOG_PANEL_CLASS, DIALOG_LAYER_CLASS.stacked, DIALOG_SIZE_CLASS.form)}
      className="flex min-h-0 flex-col"
    >
      {/* Radix Title/Description: the dialog's aria-labelledby/-describedby
          resolve to real elements (cmdk's Content only sets aria-label). */}
      <DialogPrimitive.Title className="sr-only">{t('palette.dialogTitle')}</DialogPrimitive.Title>
      <DialogPrimitive.Description className="sr-only">{t('palette.dialogDescription')}</DialogPrimitive.Description>

      {/* Search input */}
      <div className="flex items-center gap-2 px-3 border-b border-border/30">
        {topPage ? (
          <button
            type="button"
            onClick={popPage}
            aria-label={t('palette.actions.back')}
            data-testid="palette-page-back"
            className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        ) : (
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
        <Command.Input
          ref={inputRef}
          value={search}
          onValueChange={setSearch}
          onKeyDown={(e) => {
            // cmdk pages: Backspace on an empty query steps back one page.
            if (e.key === 'Backspace' && !search && pages.length > 0) {
              e.preventDefault()
              popPage()
            }
          }}
          placeholder={topPage ? topPage.page.placeholder : uiMode === 'agent' ? t('palette.searchPlaceholderAgent') : t('palette.searchPlaceholder')}
          className="flex-1 h-11 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 text-xs text-muted-foreground font-mono">
          esc
        </kbd>
      </div>

      {/* Results list — group order follows the UI mode (D6) */}
      <Command.List className="max-h-80 overflow-y-auto p-2">
        {topPage ? (
          <ArgPageList
            frame={topPage}
            search={search}
            loaded={loadedOptions && loadedOptions.frame === topPage ? loadedOptions : null}
            onSelect={(option) => selectOption(topPage, option)}
            itemClass={navItemClass}
            loadingLabel={t('palette.actions.pages.loading')}
            failedLabel={t('palette.actions.pages.loadFailed')}
          />
        ) : (
          <>
            <Command.Empty className="py-8 text-center text-sm text-muted-foreground">
              {t('palette.noResults')}
            </Command.Empty>
            {actionRows.leading && actionsGroup}
            {!search.trim() && recentActionsGroup}
            {!search.trim() && recentPlacesGroup}
            {groupOrderForMode(uiMode).map((group) => groups[group])}
            {!actionRows.leading && actionsGroup}
          </>
        )}
      </Command.List>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border/30 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span><kbd className="font-mono">↑↓</kbd> {t('palette.footer.navigate')}</span>
          <span><kbd className="font-mono">↵</kbd> {t('palette.footer.select')}</span>
          <span><kbd className="font-mono">esc</kbd> {t('palette.footer.close')}</span>
          <span><kbd className="font-mono">&gt;</kbd> {t('palette.footer.actions')}</span>
        </div>
      </div>
    </Command.Dialog>
  )
}
