import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react'
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Download,
  FolderKanban,
  Globe2,
  Loader2,
  PlugZap,
  Power,
  Puzzle,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  Trash2,
  Wrench,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { JiraConnectWizard } from '../components/jira/JiraConnectWizard'
import { API_ORIGIN } from '../lib/origin'
import { cn } from '../lib/utils'
import { projectProviders, useDesktop, type DesktopProject } from '../hooks/useDesktop'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'

type ScopeFilter = 'all' | 'global' | 'project'
type Provider = 'codex' | 'claude'
type HeadroomPhase = 'idle' | 'installing' | 'installed' | 'starting-proxy' | 'active' | 'failed'
type HeadroomInstallSource = 'managed' | 'system'

interface HeadroomIssue {
  code: string
  title: string
  guidance: string
  detail?: string
  command?: string
}

interface HeadroomProviderMetric {
  provider: Provider
  label: string
  active: boolean
  available: boolean
  detectedRoute: boolean
  requests: number
  inputTokensSaved: number
  outputTokens: number
  outputTokensSaved: number
  outputSavingsPercent: number
  outputSavingsMethod: 'estimated' | 'measured' | 'none'
  outputSavingsAllocated: boolean
}

interface HeadroomMetricsState {
  updatedAt: string | null
  proxyStatsAvailable: boolean
  durableSavingsAvailable: boolean
  outputSavingsAvailable: boolean
  outputSavingsMethod: 'estimated' | 'measured' | null
  outputConfidence: { lowPercent: number; highPercent: number } | null
  providers: Record<Provider, HeadroomProviderMetric>
  lastIssue: HeadroomIssue | null
}

interface HeadroomLearningState {
  enabled: boolean
  baselineReady: boolean
  baselineSamples: number
  updatedAt: string | null
  lastIssue: HeadroomIssue | null
}

interface HeadroomState {
  installed: boolean
  installSource: HeadroomInstallSource | null
  version: string | null
  executablePath: string | null
  uvPath: string | null
  port: number
  phase: HeadroomPhase
  activeProviders: Record<Provider, boolean>
  availableProviders: Record<Provider, boolean>
  detectedRoutes: Record<Provider, boolean>
  proxyRunning: boolean
  proxyPid: number | null
  learning: HeadroomLearningState
  metrics: HeadroomMetricsState
  lastIssue: HeadroomIssue | null
  updatedAt: string | null
}

interface PluginRequirement {
  name: string
  installed?: boolean
  executable?: boolean
  version?: string
  meetsMinimum?: boolean
  minVersion?: string
}

interface ProjectPluginCard {
  name: string
  version: string
  description: string
  whatItDoes: string[]
  requirements: PluginRequirement[]
  status: 'installed' | 'deactivated' | 'not-installed' | 'orphan' | 'degraded'
  healthReason?: string
}

interface PreviewResult {
  files: Array<{ path: string; op: 'create' | 'modify'; summary?: string }>
  requirements: PluginRequirement[]
  platformNote?: string
}

interface CatalogPlugin {
  id: 'headroom-ai' | 'jira' | 'serena'
  title: string
  scope: 'global' | 'project'
  icon: ComponentType<{ className?: string }>
  description: string
  installed: boolean
  status: string
  statusLabel: string
  actionKind: 'install' | 'review' | 'manage'
  actionLabel: string
  busy?: boolean
  action: () => void
}

function emptyProviderMetric(provider: Provider): HeadroomProviderMetric {
  return {
    provider,
    label: provider === 'codex' ? 'Codex' : 'Claude',
    active: false,
    available: false,
    detectedRoute: false,
    requests: 0,
    inputTokensSaved: 0,
    outputTokens: 0,
    outputTokensSaved: 0,
    outputSavingsPercent: 0,
    outputSavingsMethod: 'none',
    outputSavingsAllocated: false,
  }
}

function emptyHeadroomMetrics(): HeadroomMetricsState {
  return {
    updatedAt: null,
    proxyStatsAvailable: false,
    durableSavingsAvailable: false,
    outputSavingsAvailable: false,
    outputSavingsMethod: null,
    outputConfidence: null,
    providers: {
      codex: emptyProviderMetric('codex'),
      claude: emptyProviderMetric('claude'),
    },
    lastIssue: null,
  }
}

const DEFAULT_HEADROOM: HeadroomState = {
  installed: false,
  installSource: null,
  version: null,
  executablePath: null,
  uvPath: null,
  port: 8787,
  phase: 'idle',
  activeProviders: { codex: false, claude: false },
  availableProviders: { codex: false, claude: false },
  detectedRoutes: { codex: false, claude: false },
  proxyRunning: false,
  proxyPid: null,
  learning: {
    enabled: false,
    baselineReady: false,
    baselineSamples: 0,
    updatedAt: null,
    lastIssue: null,
  },
  metrics: emptyHeadroomMetrics(),
  lastIssue: null,
  updatedAt: null,
}

function normalizeHeadroomState(state: Partial<HeadroomState> | null | undefined): HeadroomState {
  const metrics = state?.metrics ?? emptyHeadroomMetrics()
  return {
    ...DEFAULT_HEADROOM,
    ...state,
    activeProviders: { ...DEFAULT_HEADROOM.activeProviders, ...state?.activeProviders },
    availableProviders: { ...DEFAULT_HEADROOM.availableProviders, ...state?.availableProviders },
    detectedRoutes: { ...DEFAULT_HEADROOM.detectedRoutes, ...state?.detectedRoutes },
    learning: { ...DEFAULT_HEADROOM.learning, ...state?.learning },
    metrics: {
      ...emptyHeadroomMetrics(),
      ...metrics,
      providers: {
        codex: { ...emptyProviderMetric('codex'), ...metrics.providers?.codex },
        claude: { ...emptyProviderMetric('claude'), ...metrics.providers?.claude },
      },
    },
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const issue = (data as { issue?: HeadroomIssue }).issue
    throw Object.assign(new Error(issue?.title ?? (data as { error?: string }).error ?? `HTTP ${res.status}`), { payload: data })
  }
  return data as T
}

function projectApi(projectId: string): string {
  return `${API_ORIGIN}/api/projects/${projectId}`
}

function formatCompactNumber(value: number, locale = 'en'): string {
  if (!Number.isFinite(value)) return '0'
  try {
    return Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, value))
  } catch {
    return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, value))
  }
}

function formatTokenCount(value: number, locale: string, tokenLabel: string): string {
  return `${formatCompactNumber(value, locale)} ${tokenLabel}`
}

export default function PluginsPage() {
  const { t } = useTranslation('integrations')
  const { projects } = useDesktop()
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [headroom, setHeadroom] = useState<HeadroomState>(DEFAULT_HEADROOM)
  const [loadingHeadroom, setLoadingHeadroom] = useState(true)
  const [headroomBusy, setHeadroomBusy] = useState<string | null>(null)
  const [headroomLogs, setHeadroomLogs] = useState<string[]>([])
  const [headroomOpen, setHeadroomOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [projectWizard, setProjectWizard] = useState<null | 'jira' | 'serena'>(null)
  const [projectSummary, setProjectSummary] = useState({ jira: 0, serena: 0, projects: 0 })

  const refreshHeadroom = useCallback(async () => {
    try {
      const data = await fetch(`${API_ORIGIN}/api/global-plugins/headroom`).then((r) => readJson<{ state: HeadroomState }>(r))
      setHeadroom(normalizeHeadroomState(data.state))
    } finally {
      setLoadingHeadroom(false)
    }
  }, [])

  useEffect(() => {
    void refreshHeadroom()
  }, [refreshHeadroom])

  useEffect(() => {
    const handler = (raw: unknown) => {
      const msg = raw as { type?: string; line?: string }
      if (msg.type !== 'plugin.headroom_progress') return
      if (msg.line) setHeadroomLogs((cur) => [...cur.slice(-80), msg.line!])
      void refreshHeadroom()
    }
    registerHandler('plugins-page', handler)
    return () => unregisterHandler('plugins-page')
  }, [registerHandler, unregisterHandler, refreshHeadroom])

  useEffect(() => {
    let cancelled = false
    async function loadProjectSummary() {
      const rows = await Promise.all(projects.map(async (project) => {
        const [jira, plugins] = await Promise.all([
          fetch(`${projectApi(project.id)}/jira/connection`)
            .then((r) => readJson<{ connected: boolean }>(r))
            .catch(() => ({ connected: false })),
          fetch(`${projectApi(project.id)}/plugins`)
            .then((r) => readJson<{ plugins: ProjectPluginCard[] }>(r))
            .catch(() => ({ plugins: [] })),
        ])
        const serena = plugins.plugins.find((p) => p.name === 'serena')
        return {
          jira: jira.connected ? 1 : 0,
          serena: serena && serena.status !== 'not-installed' && serena.status !== 'orphan' ? 1 : 0,
        }
      }))
      if (cancelled) return
      setProjectSummary({
        jira: rows.reduce((n, r) => n + r.jira, 0),
        serena: rows.reduce((n, r) => n + r.serena, 0),
        projects: projects.length,
      })
    }
    void loadProjectSummary()
    return () => { cancelled = true }
  }, [projects])

  async function headroomAction(label: string, run: () => Promise<unknown>) {
    setHeadroomBusy(label)
    setHeadroomLogs([])
    try {
      const result = await run()
      const state = (result as { state?: HeadroomState }).state
      if (state) setHeadroom(normalizeHeadroomState(state))
    } catch (err) {
      const payload = (err as Error & { payload?: { state?: HeadroomState } }).payload
      if (payload?.state) setHeadroom(normalizeHeadroomState(payload.state))
    } finally {
      setHeadroomBusy(null)
      void refreshHeadroom()
    }
  }

  const globalCatalog = useMemo<CatalogPlugin[]>(() => [
    {
      id: 'headroom-ai',
      title: 'Headroom AI',
      scope: 'global' as const,
      icon: PlugZap,
      description: t('plugins.catalog.headroom.description'),
      installed: headroom.installed,
      status: headroom.lastIssue
        ? 'attention'
        : headroom.installed
          ? (headroom.activeProviders.codex || headroom.activeProviders.claude
              ? (headroom.installSource === 'system' ? 'external-active' : 'active')
              : (headroom.installSource === 'system' ? 'external' : 'installed'))
          : 'available',
      statusLabel: headroom.lastIssue
        ? t('plugins.status.attention')
        : headroom.installed
          ? (headroom.activeProviders.codex || headroom.activeProviders.claude
              ? (headroom.installSource === 'system' ? t('plugins.status.externalActive') : t('plugins.status.active'))
              : (headroom.installSource === 'system' ? t('plugins.status.external') : t('plugins.status.installed')))
          : t('plugins.status.available'),
      actionKind: headroom.lastIssue ? 'review' : headroom.installed ? 'manage' : 'install',
      actionLabel: headroom.lastIssue ? t('plugins.actions.review') : headroom.installed ? t('plugins.actions.manage') : t('plugins.actions.install'),
      busy: headroomBusy === 'install',
      action: () => {
        if (headroom.lastIssue || headroom.installed) {
          setHeadroomOpen(true)
          return
        }
        void headroomAction('install', () =>
          fetch(`${API_ORIGIN}/api/global-plugins/headroom/install`, { method: 'POST' }).then((r) => readJson(r)),
        )
      },
    },
  ], [headroom, headroomBusy, t])

  const projectCatalog = useMemo<CatalogPlugin[]>(() => [
    {
      id: 'jira',
      title: 'Jira',
      scope: 'project' as const,
      icon: FolderKanban,
      description: t('plugins.catalog.jira.description'),
      installed: projectSummary.jira > 0,
      status: projectSummary.jira > 0 ? 'configured' : 'available',
      statusLabel: projectSummary.jira > 0
        ? t('plugins.status.configuredCount', { count: projectSummary.jira })
        : t('plugins.status.available'),
      actionKind: projectSummary.jira > 0 ? 'manage' : 'install',
      actionLabel: projectSummary.jira > 0 ? t('plugins.actions.manage') : t('plugins.actions.install'),
      action: () => setProjectWizard('jira'),
    },
    {
      id: 'serena',
      title: 'Serena',
      scope: 'project' as const,
      icon: TerminalSquare,
      description: t('plugins.catalog.serena.description'),
      installed: projectSummary.serena > 0,
      status: projectSummary.serena > 0 ? 'installed' : 'available',
      statusLabel: projectSummary.serena > 0
        ? t('plugins.status.installedCount', { count: projectSummary.serena })
        : t('plugins.status.available'),
      actionKind: projectSummary.serena > 0 ? 'manage' : 'install',
      actionLabel: projectSummary.serena > 0 ? t('plugins.actions.manage') : t('plugins.actions.install'),
      action: () => setProjectWizard('serena'),
    },
  ], [projectSummary, t])

  const normalizedQuery = query.trim().toLowerCase()
  const matchesCatalog = (p: CatalogPlugin) => {
    const haystack = `${p.title} ${p.description} ${p.statusLabel} ${t(`plugins.scope.${p.scope}`)}`.toLowerCase()
    return haystack.includes(normalizedQuery)
  }
  const catalog = [...globalCatalog, ...projectCatalog]
  const filteredCatalog = catalog.filter((p) => {
    if (scope !== 'all' && p.scope !== scope) return false
    return matchesCatalog(p)
  })
  const installedGlobalCatalog = filteredCatalog.filter((p) => p.scope === 'global' && p.installed)
  const installedProjectCatalog = filteredCatalog.filter((p) => p.scope === 'project' && p.installed)
  const availableGlobalCatalog = filteredCatalog.filter((p) => p.scope === 'global' && !p.installed)
  const availableProjectCatalog = filteredCatalog.filter((p) => p.scope === 'project' && !p.installed)
  const hasInstalledMatches = installedGlobalCatalog.length > 0 || installedProjectCatalog.length > 0
  const hasAvailableMatches = availableGlobalCatalog.length > 0 || availableProjectCatalog.length > 0

  const installedCount = [
    headroom.installed,
    projectSummary.jira > 0,
    projectSummary.serena > 0,
  ].filter(Boolean).length

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg border border-accent-primary/25 bg-accent-primary/10 text-accent-primary">
            <Puzzle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-normal">{t('plugins.page.title')}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('plugins.page.subtitle')}
            </p>
          </div>
          <div className="mr-12 flex items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-xs">
            <ShieldCheck className="h-3.5 w-3.5 text-accent-success" />
            <span className="text-muted-foreground">{t('plugins.page.readyCount', { count: installedCount })}</span>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('plugins.search.placeholder')}
              className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none transition-colors focus:border-accent-primary/60"
            />
          </label>
          <div className="inline-flex h-9 rounded-lg border border-border bg-card p-1">
            {(['all', 'global', 'project'] as ScopeFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                className={cn(
                  'rounded-md px-3 text-xs capitalize transition-colors',
                  scope === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`plugins.filters.${value}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        <section className="mb-6">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {t('plugins.sections.installed')}
          </div>
          {hasInstalledMatches ? (
            <PluginSectionGroups
              globalPlugins={installedGlobalCatalog}
              projectPlugins={installedProjectCatalog}
            />
          ) : (
            <PluginEmptyState text={normalizedQuery ? t('plugins.empty.installedSearch') : t('plugins.empty.installed')} />
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Puzzle className="h-3.5 w-3.5" />
            {t('plugins.sections.available')}
          </div>

          {hasAvailableMatches ? (
            <PluginSectionGroups
              globalPlugins={availableGlobalCatalog}
              projectPlugins={availableProjectCatalog}
            />
          ) : (
            <PluginEmptyState text={normalizedQuery ? t('plugins.empty.availableSearch') : t('plugins.empty.allInstalled')} />
          )}
        </section>
      </div>

      <Dialog open={headroomOpen} onOpenChange={setHeadroomOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-xl overflow-x-hidden p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>{t('plugins.headroom.title')}</DialogTitle>
            <DialogDescription>
              {t('plugins.headroom.dialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <HeadroomPanel
            state={headroom}
            loading={loadingHeadroom}
            busy={headroomBusy}
            logs={headroomLogs}
            onInstall={() => headroomAction('install', () =>
              fetch(`${API_ORIGIN}/api/global-plugins/headroom/install`, { method: 'POST' }).then((r) => readJson(r)),
            )}
            onToggleProvider={(provider, active) => headroomAction(`${active ? 'deactivate' : 'activate'}-${provider}`, () =>
              fetch(`${API_ORIGIN}/api/global-plugins/headroom/${active ? 'deactivate' : 'activate'}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider }),
              }).then((r) => readJson(r)),
            )}
            onDeactivateAll={() => headroomAction('deactivate-all', async () => {
              let result: unknown = { state: headroom }
              for (const provider of (['codex', 'claude'] as Provider[])) {
                if (!headroom.activeProviders[provider]) continue
                result = await fetch(`${API_ORIGIN}/api/global-plugins/headroom/deactivate`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ provider }),
                }).then((r) => readJson(r))
              }
              return result
            })}
            onUninstall={() => headroomAction('uninstall', () =>
              fetch(`${API_ORIGIN}/api/global-plugins/headroom/uninstall`, { method: 'POST' }).then((r) => readJson(r)),
            )}
            onSetPort={(port) => headroomAction('port', () =>
              fetch(`${API_ORIGIN}/api/global-plugins/headroom/port`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ port }),
              }).then((r) => readJson(r)),
            )}
            onOpenDiagnostics={() => setDiagnosticsOpen(true)}
          />
        </DialogContent>
      </Dialog>

      <ProjectPluginWizard
        plugin={projectWizard}
        projects={projects}
        onClose={() => setProjectWizard(null)}
      />
      <DiagnosticsDialog open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
    </div>
  )
}

function PluginSectionGroups({
  globalPlugins,
  projectPlugins,
}: {
  globalPlugins: CatalogPlugin[]
  projectPlugins: CatalogPlugin[]
}) {
  const { t } = useTranslation('integrations')
  const showBoth = globalPlugins.length > 0 && projectPlugins.length > 0

  return (
    <div className={cn('grid grid-cols-1 gap-4', showBoth && 'xl:grid-cols-2')}>
      {globalPlugins.length > 0 && (
        <section>
          <PluginGroupHeader
            title={t('plugins.groups.global.title')}
            detail={t('plugins.groups.global.detail')}
            scope="global"
          />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,320px))] justify-start gap-3">
            {globalPlugins.map((plugin) => (
              <PluginCard key={plugin.id} plugin={plugin} />
            ))}
          </div>
        </section>
      )}

      {projectPlugins.length > 0 && (
        <section>
          <PluginGroupHeader
            title={t('plugins.groups.project.title')}
            detail={t('plugins.groups.project.detail')}
            scope="project"
          />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,320px))] justify-start gap-3">
            {projectPlugins.map((plugin) => (
              <PluginCard key={plugin.id} plugin={plugin} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function PluginEmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-[74px] max-w-[320px] items-center rounded-lg border border-dashed border-border bg-card/35 px-3 text-xs text-muted-foreground">
      {text}
    </div>
  )
}

function ScopeBadge({ scope }: { scope: 'global' | 'project' }) {
  const { t } = useTranslation('integrations')
  return (
    <span className={cn(
      'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
      scope === 'global' ? 'bg-accent-primary/10 text-accent-primary' : 'bg-accent-info/10 text-accent-info',
    )}>
      {t(`plugins.scope.${scope}`)}
    </span>
  )
}

function PluginGroupHeader({
  title,
  detail,
  scope,
}: {
  title: string
  detail: string
  scope: 'global' | 'project'
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <div className={cn(
        'h-px flex-1',
        scope === 'global' ? 'bg-accent-primary/30' : 'bg-accent-info/30',
      )} />
      <div className="flex items-center gap-2 rounded-md border border-border bg-card/70 px-2 py-1">
        <ScopeBadge scope={scope} />
        <span className="text-xs font-medium">{title}</span>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">{detail}</span>
      </div>
      <div className={cn(
        'h-px flex-1',
        scope === 'global' ? 'bg-accent-primary/30' : 'bg-accent-info/30',
      )} />
    </div>
  )
}

function PluginCard({ plugin }: { plugin: CatalogPlugin }) {
  const { t } = useTranslation('integrations')
  const Icon = plugin.icon
  const isGlobal = plugin.scope === 'global'
  const isAttention = plugin.status === 'attention'
  const ActionIcon = plugin.busy
    ? Loader2
    : plugin.actionKind === 'install'
      ? Download
      : plugin.actionKind === 'review'
        ? AlertTriangle
        : Settings2
  const statusClassName = cn(
    'shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none',
    isAttention
      ? 'border-accent-warning/30 bg-accent-warning/10 text-accent-warning'
      : plugin.installed
        ? 'border-accent-success/25 bg-accent-success/10 text-accent-success'
        : 'border-border bg-muted text-muted-foreground',
  )

  return (
    <article className="grid h-[88px] w-full grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border bg-card/70 px-3 transition-colors hover:border-accent-primary/35 hover:bg-card">
      <div className={cn(
        'grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg border',
        isGlobal
          ? 'border-accent-primary/25 bg-accent-primary/10 text-accent-primary'
          : 'border-accent-info/25 bg-accent-info/10 text-accent-info',
      )}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold leading-5">{plugin.title}</h2>
        <p className="mt-1 truncate text-[11px] leading-4 text-muted-foreground">{plugin.description}</p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <ScopeBadge scope={plugin.scope} />
          <span className={statusClassName}>{plugin.statusLabel}</span>
        </div>
      </div>
      <button
        type="button"
        disabled={plugin.busy}
        onClick={plugin.action}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
      >
        <ActionIcon className={cn('h-3.5 w-3.5', plugin.busy && 'animate-spin')} />
        {plugin.busy ? t('plugins.actions.installing') : plugin.actionLabel}
      </button>
    </article>
  )
}

function HeadroomPanel({
  state,
  loading,
  busy,
  logs,
  onInstall,
  onToggleProvider,
  onDeactivateAll,
  onUninstall,
  onSetPort,
  onOpenDiagnostics,
}: {
  state: HeadroomState
  loading: boolean
  busy: string | null
  logs: string[]
  onInstall: () => void
  onToggleProvider: (provider: Provider, active: boolean) => void
  onDeactivateAll: () => void
  onUninstall: () => void
  onSetPort: (port: number) => void
  onOpenDiagnostics: () => void
}) {
  const { t } = useTranslation('integrations')
  const [portDraft, setPortDraft] = useState(String(state.port))
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  useEffect(() => setPortDraft(String(state.port)), [state.port])
  useEffect(() => {
    if (!state.installed) setConfirmUninstall(false)
  }, [state.installed])
  const activeAny = state.activeProviders.codex || state.activeProviders.claude
  const externalInstall = state.installSource === 'system'

  return (
    <aside className="w-full min-w-0 overflow-hidden rounded-lg border border-border bg-card/80 p-4">
      <div className="mb-4 flex items-start gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-lg border border-accent-primary/25 bg-accent-primary/10 text-accent-primary">
          <PlugZap className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t('plugins.headroom.title')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('plugins.headroom.panelDescription')}
          </p>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2 text-xs">
        <Metric
          label={t('plugins.headroom.metrics.install')}
          value={loading ? t('plugins.headroom.metrics.checking') : state.installed ? t('plugins.headroom.metrics.ready') : t('plugins.headroom.metrics.missing')}
          good={state.installed}
        />
        <Metric
          label={t('plugins.headroom.metrics.source')}
          value={state.installSource === 'system' ? t('plugins.headroom.metrics.system') : state.installSource === 'managed' ? t('plugins.headroom.metrics.specrails') : t('plugins.headroom.metrics.none')}
          good={state.installed}
        />
        <Metric
          label={t('plugins.headroom.metrics.proxy')}
          value={state.proxyRunning ? `:${state.port}` : activeAny ? t('plugins.headroom.metrics.starting') : t('plugins.headroom.metrics.off')}
          good={state.proxyRunning || !activeAny}
        />
      </div>

      {state.lastIssue && <IssueBox issue={state.lastIssue} />}

      {!state.installed ? (
        <button
          type="button"
          disabled={!!busy}
          onClick={onInstall}
          className="mb-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-accent-primary px-3 text-xs font-medium text-white disabled:opacity-50"
        >
          {busy === 'install' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {t('plugins.headroom.actions.installWithUv')}
        </button>
      ) : (
        <div className="mb-4 space-y-2">
          <ProviderToggle
            provider="codex"
            active={state.activeProviders.codex}
            available={state.availableProviders.codex}
            detectedRoute={state.detectedRoutes.codex}
            busy={busy === 'activate-codex' || busy === 'deactivate-codex'}
            onClick={() => onToggleProvider('codex', state.activeProviders.codex)}
          />
          <ProviderToggle
            provider="claude"
            active={state.activeProviders.claude}
            available={state.availableProviders.claude}
            detectedRoute={state.detectedRoutes.claude}
            busy={busy === 'activate-claude' || busy === 'deactivate-claude'}
            onClick={() => onToggleProvider('claude', state.activeProviders.claude)}
          />
          {activeAny && (
            <button
              type="button"
              disabled={!!busy}
              onClick={onDeactivateAll}
              className="flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-border bg-background/45 text-xs hover:bg-muted/50 disabled:opacity-50"
            >
              {busy === 'deactivate-all' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              {t('plugins.headroom.actions.disableAllRoutes')}
            </button>
          )}
        </div>
      )}

      {state.installed && <HeadroomMetricsPanel state={state} />}

      <div className="mb-4 rounded-lg border border-border bg-background/45 p-3">
        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">{t('plugins.headroom.port.label')}</label>
        <div className="flex gap-2">
          <input
            value={portDraft}
            onChange={(e) => setPortDraft(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
          />
          <button
            type="button"
            disabled={!!busy || Number(portDraft) === state.port}
            onClick={() => onSetPort(Number(portDraft))}
            className="rounded-md border border-border px-2 text-xs hover:bg-muted disabled:opacity-50"
          >
            {t('plugins.headroom.port.apply')}
          </button>
        </div>
      </div>

      {logs.length > 0 && (
        <pre className="mb-3 max-h-32 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded-lg border border-border bg-background/60 p-2 text-[10px] text-muted-foreground">
          {logs.join('\n')}
        </pre>
      )}

      <button
        type="button"
        onClick={onOpenDiagnostics}
        className="mb-2 flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-border text-xs hover:bg-muted/50"
      >
        <Wrench className="h-3.5 w-3.5" />
        {t('plugins.headroom.actions.viewDiagnostics')}
      </button>

      {state.installed && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3">
          {!confirmUninstall ? (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setConfirmUninstall(true)}
              className="flex h-8 w-full items-center justify-center gap-2 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {externalInstall ? t('plugins.headroom.actions.detachHeadroom') : t('plugins.headroom.actions.uninstallHeadroom')}
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {externalInstall
                  ? t('plugins.headroom.confirmDetach')
                  : t('plugins.headroom.confirmUninstall')}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => setConfirmUninstall(false)}
                  className="h-8 rounded-md border border-border text-xs hover:bg-muted/50 disabled:opacity-50"
                >
                  {t('plugins.actions.cancel')}
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={onUninstall}
                  className="flex h-8 items-center justify-center gap-2 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground disabled:opacity-50"
                >
                  {busy === 'uninstall' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {externalInstall ? t('plugins.headroom.actions.detach') : t('plugins.headroom.actions.uninstall')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

function Metric({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-background/45 p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 font-medium', good ? 'text-foreground' : 'text-accent-warning')}>{value}</div>
    </div>
  )
}

function IssueBox({ issue }: { issue: HeadroomIssue }) {
  const { t } = useTranslation('integrations')
  const issueKey = `plugins.headroom.issues.${issue.code}`
  const title = t(`${issueKey}.title`, { defaultValue: issue.title })
  const guidance = t(`${issueKey}.guidance`, { defaultValue: issue.guidance })

  return (
    <div className="mb-3 rounded-lg border border-accent-warning/35 bg-accent-warning/10 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-warning" />
        <div className="min-w-0">
          <div className="text-xs font-medium">{title}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{guidance}</p>
          <div className="mt-1 text-[10px] text-muted-foreground">{t('plugins.headroom.issueCode', { code: issue.code })}</div>
        </div>
      </div>
    </div>
  )
}

function HeadroomMetricsPanel({ state }: { state: HeadroomState }) {
  const { t } = useTranslation('integrations')
  const metrics = state.metrics
  const outputMeasured = metrics.outputSavingsAvailable
  const providerMetrics = (['codex', 'claude'] as Provider[]).map((provider) => ({
    provider,
    metric: metrics.providers[provider],
  }))
  const hasInputSavings = providerMetrics.some(({ metric }) => metric.inputTokensSaved > 0)
  const hasActiveProvider = providerMetrics.some(({ metric }) => metric.active)
  const statusLabel = outputMeasured
    ? t('plugins.headroom.savings.statusInputOutput')
    : hasInputSavings
      ? t('plugins.headroom.savings.statusInputOnly')
      : hasActiveProvider
        ? t('plugins.headroom.savings.statusRouting')
        : t('plugins.headroom.savings.statusInactive')
  const statusEmphasis = outputMeasured || hasInputSavings
  return (
    <div className="mb-4 rounded-lg border border-border bg-background/45 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <BarChart3 className="h-3.5 w-3.5 text-accent-primary" />
          <div className="truncate text-xs font-medium">{t('plugins.headroom.savings.title')}</div>
        </div>
        <span className={cn(
          'shrink-0 rounded border px-1.5 py-0.5 text-[10px]',
          statusEmphasis
            ? 'border-accent-success/25 bg-accent-success/10 text-accent-success'
            : hasActiveProvider
              ? 'border-accent-primary/25 bg-accent-primary/10 text-accent-primary'
            : 'border-border bg-muted text-muted-foreground',
        )}>
          {statusLabel}
        </span>
      </div>

      <div className="grid gap-2">
        {providerMetrics.map(({ provider, metric }) => (
          <ProviderMetricRow
            key={provider}
            metric={metric}
            outputAvailable={metrics.outputSavingsAvailable}
          />
        ))}
      </div>

      <div className="mt-2 flex items-center justify-end gap-2 text-[10px] text-muted-foreground">
        {metrics.updatedAt
          ? t('plugins.headroom.savings.updatedLive')
          : t('plugins.headroom.savings.baselineSamples', { count: state.learning.baselineSamples })}
      </div>
    </div>
  )
}

function ProviderMetricRow({
  metric,
  outputAvailable,
}: {
  metric: HeadroomProviderMetric
  outputAvailable: boolean
}) {
  const { t, i18n } = useTranslation('integrations')
  const unavailable = !metric.available
  const muted = unavailable || !metric.active
  const tokenLabel = t('plugins.headroom.savings.tokens')
  const inputValue = formatTokenCount(metric.inputTokensSaved, i18n.language, tokenLabel)
  const inputDetail = metric.requests > 0
    ? t('plugins.headroom.savings.requestCount', { count: formatCompactNumber(metric.requests, i18n.language) })
    : unavailable
      ? t('plugins.headroom.provider.noProjectUsesProvider')
      : metric.active
        ? t('plugins.headroom.savings.inputSavingsActive')
        : t('plugins.headroom.savings.routeDisabled')
  const outputValue = outputAvailable
    ? formatTokenCount(metric.outputTokensSaved, i18n.language, t('plugins.headroom.savings.tokens'))
    : (metric.active ? t('plugins.headroom.savings.learning') : t('plugins.headroom.savings.off'))
  const outputDetail = outputAvailable
    ? t('plugins.headroom.savings.requestDetail', {
        method: t(`plugins.headroom.savings.methods.${metric.outputSavingsMethod}`),
        count: formatCompactNumber(metric.requests, i18n.language),
      })
    : unavailable
      ? t('plugins.headroom.provider.noProjectUsesProvider')
      : metric.active
        ? metric.outputTokens > 0
          ? t('plugins.headroom.savings.outputObserved', {
              value: formatTokenCount(metric.outputTokens, i18n.language, t('plugins.headroom.savings.tokens')),
            })
          : t('plugins.headroom.savings.waitingForShapedResponses')
        : t('plugins.headroom.savings.routeDisabled')

  return (
    <div className={cn(
      'rounded-md border border-border bg-card/45 px-2.5 py-2',
      muted && 'opacity-70',
    )}>
      <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-xs font-medium">{metric.label}</span>
          {metric.detectedRoute && (
            <span className="rounded bg-accent-primary/10 px-1.5 py-0.5 text-[9px] uppercase text-accent-primary">
              {t('plugins.headroom.savings.detected')}
            </span>
          )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase text-muted-foreground">{t('plugins.headroom.savings.inputSaved')}</div>
          <div className="mt-0.5 truncate text-xs font-semibold tabular-nums text-foreground">{inputValue}</div>
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{inputDetail}</div>
        </div>

        <div className="min-w-0 text-right">
          <div className="text-[10px] font-medium uppercase text-muted-foreground">{t('plugins.headroom.savings.outputSaved')}</div>
          <div className={cn('mt-0.5 truncate text-xs font-semibold tabular-nums', outputAvailable ? 'text-foreground' : 'text-muted-foreground')}>
            {outputValue}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{outputDetail}</div>
        </div>
      </div>
    </div>
  )
}

function ProviderToggle({
  provider,
  active,
  available,
  detectedRoute,
  busy,
  onClick,
}: {
  provider: Provider
  active: boolean
  available: boolean
  detectedRoute: boolean
  busy: boolean
  onClick: () => void
}) {
  const { t } = useTranslation('integrations')
  const statusText = !available
    ? t('plugins.headroom.provider.noProjectUsesProvider')
    : active
      ? t('plugins.headroom.provider.routedThroughHeadroom')
      : detectedRoute
        ? t('plugins.headroom.provider.detectedExternalRoute')
        : t('plugins.headroom.provider.notRouted')

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || !available}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-background/45 p-3 text-left hover:bg-muted/35 disabled:opacity-50"
    >
      <div className={cn('grid h-8 w-8 place-items-center rounded-md', active ? 'bg-accent-success/15 text-accent-success' : 'bg-muted text-muted-foreground')}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe2 className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium capitalize">{provider}</div>
        <div className="text-[11px] text-muted-foreground">
          {statusText}
        </div>
      </div>
      <span className={cn('h-5 w-9 rounded-full p-0.5 transition-colors', active ? 'bg-accent-success' : 'bg-muted')}>
        <span className={cn('block h-4 w-4 rounded-full bg-white shadow transition-transform', active && 'translate-x-4')} />
      </span>
    </button>
  )
}

function ProjectPluginWizard({
  plugin,
  projects,
  onClose,
}: {
  plugin: 'jira' | 'serena' | null
  projects: DesktopProject[]
  onClose: () => void
}) {
  const { t } = useTranslation('integrations')
  const [projectId, setProjectId] = useState('')
  useEffect(() => setProjectId(''), [plugin])
  const selected = projects.find((p) => p.id === projectId) ?? null

  return (
    <Dialog open={!!plugin} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl overflow-x-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{plugin === 'jira' ? t('plugins.projectWizard.configureJira') : t('plugins.projectWizard.installSerena')}</DialogTitle>
          <DialogDescription>
            {t('plugins.projectWizard.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
          <div className="rounded-lg border border-border bg-card/70 p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">{t('plugins.projectWizard.chooseProject')}</div>
            <div className="max-h-[52vh] space-y-1 overflow-auto">
              {projects.map((project) => {
                const disabled = plugin === 'serena' && !projectProviders(project).includes('claude')
                return (
                  <button
                    key={project.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => setProjectId(project.id)}
                    className={cn(
                      'w-full rounded-md px-2 py-2 text-left transition-colors',
                      project.id === projectId ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/45 hover:text-foreground',
                      disabled && 'cursor-not-allowed opacity-45',
                    )}
                  >
                    <div className="truncate text-xs font-medium">{project.name}</div>
                    <div className="truncate text-[10px]">{disabled ? t('plugins.projectWizard.requiresClaudeProvider') : project.path}</div>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="min-h-[360px] rounded-lg border border-border bg-card/70 p-4">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t('plugins.projectWizard.selectProjectToContinue')}
              </div>
            ) : plugin === 'jira' ? (
              <JiraConnectWizard
                apiBase={projectApi(selected.id)}
                onConnected={onClose}
                onSkip={onClose}
              />
            ) : (
              <SerenaInstall project={selected} onDone={onClose} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SerenaInstall({ project, onDone }: { project: DesktopProject; onDone: () => void }) {
  const { t } = useTranslation('integrations')
  const [plugin, setPlugin] = useState<ProjectPluginCard | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    const data = await fetch(`${projectApi(project.id)}/plugins`).then((r) => readJson<{ plugins: ProjectPluginCard[] }>(r))
    const serena = data.plugins.find((p) => p.name === 'serena') ?? null
    setPlugin(serena)
    if (serena?.status === 'not-installed') {
      const p = await fetch(`${projectApi(project.id)}/plugins/serena/preview-install`).then((r) => readJson<PreviewResult>(r))
      setPreview(p)
    }
  }, [project.id])

  useEffect(() => { void refresh().catch((err) => setError((err as Error).message)) }, [refresh])

  async function install() {
    setBusy(true)
    setError(null)
    try {
      await fetch(`${projectApi(project.id)}/plugins/serena/install`, { method: 'POST' }).then((r) => readJson(r))
      await refresh()
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const prereqsOk = (preview?.requirements ?? []).every((r) => r.installed && r.executable && r.meetsMinimum)
  const pluginStatusLabel = plugin
    ? t(`plugins.projectStatus.${plugin.status}`, { defaultValue: plugin.status })
    : ''
  const pluginDescription = plugin?.name === 'serena'
    ? t('plugins.catalog.serena.description')
    : plugin?.description

  if (!plugin && !error) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('plugins.serena.loading')}</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{t('plugins.serena.titleForProject', { name: project.name })}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('plugins.serena.description')}</p>
      </div>
      {plugin && (
        <div className="rounded-lg border border-border bg-background/45 p-3">
          <div className="text-xs font-medium">{t('plugins.serena.status', { status: pluginStatusLabel })}</div>
          {pluginDescription && <p className="mt-1 text-xs text-muted-foreground">{pluginDescription}</p>}
        </div>
      )}
      {preview && (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs font-medium">{t('plugins.serena.files')}</div>
            <ul className="space-y-1 text-xs font-mono">
              {preview.files.map((file) => (
                <li key={file.path} className={file.op === 'create' ? 'text-accent-success' : 'text-accent-info'}>
                  {file.op === 'create' ? '+ ' : '~ '}{file.path}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium">{t('plugins.serena.prerequisites')}</div>
            <ul className="space-y-1 text-xs">
              {preview.requirements.map((req) => {
                const ok = req.installed && req.executable && req.meetsMinimum
                return (
                  <li key={req.name} className="flex items-center gap-2">
                    {ok ? <CheckCircle2 className="h-3 w-3 text-accent-success" /> : <AlertTriangle className="h-3 w-3 text-accent-warning" />}
                    <span>{req.name}{req.minVersion ? ` >= ${req.minVersion}` : ''}</span>
                    {req.version && <span className="text-muted-foreground">({req.version})</span>}
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-md border border-border px-3 py-1.5 text-xs">{t('plugins.actions.cancel')}</button>
        <button
          type="button"
          disabled={busy || plugin?.status !== 'not-installed' || !prereqsOk}
          onClick={install}
          className="flex items-center gap-2 rounded-md bg-accent-primary px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {t('plugins.actions.install')}
        </button>
      </div>
    </div>
  )
}

function DiagnosticsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('integrations')
  const [data, setData] = useState<unknown>(null)
  useEffect(() => {
    if (!open) return
    void fetch(`${API_ORIGIN}/api/global-plugins/headroom/diagnostics`)
      .then((r) => readJson(r))
      .then(setData)
      .catch((err) => setData({ error: (err as Error).message }))
  }, [open])
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Settings2 className="h-4 w-4" /> {t('plugins.diagnostics.title')}</DialogTitle>
          <DialogDescription>
            {t('plugins.diagnostics.description')}
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-[62vh] overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-xs">
          {JSON.stringify(data, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  )
}
