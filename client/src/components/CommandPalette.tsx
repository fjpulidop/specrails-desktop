import { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Command } from 'cmdk'
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
  PanelLeft,
  PanelRight,
  MessagesSquare,
} from 'lucide-react'
import { useDesktop } from '../hooks/useDesktop'
import { getApiBase } from '../lib/api'
import type { CommandInfo, JobSummary } from '../types'
import { cn } from '../lib/utils'
import { useSidebarPin } from '../context/SidebarPinContext'
import { useUiMode } from '../context/UiModeContext'
import { useAgentChat } from '../context/AgentChatContext'
import { searchMissions, type MissionSearchHit, type MissionSearchSnippet } from '../lib/agent-api'
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
} from '../lib/mission-search'
import { absoluteTime, compactRelativeTime } from '../lib/relative-time'

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

export function CommandPalette({ onOpenSettings, onOpenAnalytics, onOpenDocs }: CommandPaletteProps) {
  const { t } = useTranslation('commands')
  const { t: tAgent } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([])
  const [serverHits, setServerHits] = useState<ServerHits>({ query: '', hits: EMPTY_HITS })
  const { projects, activeProjectId, setActiveProjectId } = useDesktop()
  const { leftMode, rightMode, cycleLeftMode, cycleRightMode } = useSidebarPin()
  const { uiMode } = useUiMode()
  const { conversations, liveByConversation, selectConversation, open: openAgentPanel } = useAgentChat()
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
      return
    }
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
    const q = search.trim()
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
    const q = search.trim()
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
      toast.error(err instanceof Error ? err.message : t('errors.spawnFailed'))
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
  const visibleProjects = projects.filter((p) => matchesPaletteQuery(search, p.name, [p.slug]))
  const visibleCommands = commands.filter((cmd) => matchesPaletteQuery(search, cmd.name, [cmd.slug, cmd.description ?? '']))
  const visibleJobs = recentJobs.filter((job) => matchesPaletteQuery(search, `${job.command} ${job.id}`, [job.status]))

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
    { key: 'leftSidebar', label: leftLabel, keywords: ['sidebar', 'panel', 'left', 'pin', 'collapse', 'unpin', 'cycle'], icon: <PanelLeft className="w-4 h-4 text-muted-foreground shrink-0" />, onSelect: () => { cycleLeftMode(); setOpen(false) } },
    { key: 'rightSidebar', label: rightLabel, keywords: ['sidebar', 'panel', 'right', 'nav', 'pin', 'collapse', 'unpin', 'cycle'], icon: <PanelRight className="w-4 h-4 text-muted-foreground shrink-0" />, onSelect: () => { cycleRightMode(); setOpen(false) } },
  ]
  const visibleNav = navEntries.filter((entry) => matchesPaletteQuery(search, entry.label, entry.keywords))

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
                    <span
                      aria-label={tAgent('mission.working')}
                      data-testid={`palette-mission-live-${conversation.id}`}
                      className="relative flex h-1.5 w-1.5 shrink-0"
                    >
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-primary opacity-60" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent-primary" />
                    </span>
                  )}
                  <span
                    className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/60"
                    title={absoluteTime(conversation.updated_at)}
                  >
                    {compactRelativeTime(conversation.updated_at)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 min-w-0 text-[11px] text-muted-foreground/60">
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
              <span className="text-[10px] text-accent-primary font-medium">{t('palette.activeBadge')}</span>
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
                <span className="text-[11px] text-muted-foreground/60 ml-2 truncate">{cmd.description}</span>
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
              'text-[10px] font-medium',
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
      label={t('palette.label')}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 w-full max-w-lg translate-x-[-50%] translate-y-[-50%]',
        'border border-border/30 bg-popover shadow-2xl backdrop-blur-md rounded-xl overflow-hidden',
      )}
    >
      {/* Visually hidden title for accessibility */}
      <span className="sr-only">{t('palette.label')}</span>

      {/* Search input */}
      <div className="flex items-center gap-2 px-3 border-b border-border/30">
        <Search className="w-4 h-4 text-muted-foreground shrink-0" />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder={uiMode === 'agent' ? t('palette.searchPlaceholderAgent') : t('palette.searchPlaceholder')}
          className="flex-1 h-11 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
        />
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground font-mono">
          esc
        </kbd>
      </div>

      {/* Results list — group order follows the UI mode (D6) */}
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="py-8 text-center text-sm text-muted-foreground">
          {t('palette.noResults')}
        </Command.Empty>
        {groupOrderForMode(uiMode).map((group) => groups[group])}
      </Command.List>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border/30 text-[10px] text-muted-foreground/50">
        <div className="flex items-center gap-3">
          <span><kbd className="font-mono">↑↓</kbd> {t('palette.footer.navigate')}</span>
          <span><kbd className="font-mono">↵</kbd> {t('palette.footer.select')}</span>
          <span><kbd className="font-mono">esc</kbd> {t('palette.footer.close')}</span>
        </div>
      </div>
    </Command.Dialog>
  )
}
