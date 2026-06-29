import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Puzzle, AlertTriangle, CheckCircle2, XCircle, Trash2, Download, Loader2 } from 'lucide-react'
import { getApiBase } from '../lib/api'
import { useDesktop, projectProviders } from '../hooks/useDesktop'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import { useProjectCache } from '../hooks/useProjectCache'
import { JiraIntegrationCard } from '../components/jira/JiraIntegrationCard'
import { FEATURE_JIRA } from '../lib/feature-flags'
import { useMovableResizableModal } from '../hooks/useMovableResizableModal'
import { ResizeGrips } from '../components/ui/ResizeGrips'

interface PluginRequirement {
  name: string
  installed?: boolean
  executable?: boolean
  version?: string
  meetsMinimum?: boolean
  minVersion?: string
}

interface PluginCard {
  name: string
  version: string
  description: string
  whatItDoes: string[]
  category?: string
  requirements: PluginRequirement[]
  status: 'installed' | 'deactivated' | 'not-installed' | 'orphan' | 'degraded'
  installedAt?: string
  health?: 'ok' | 'degraded' | 'unknown'
  healthReason?: string
  marketplaceConflicts?: string[]
  marketplaceCachedButDisabled?: string[]
  updateAvailable?: boolean
}

interface PreviewFile {
  path: string
  op: 'create' | 'modify'
  summary?: string
}

interface PreviewResult {
  pluginName: string
  files: PreviewFile[]
  requirements: Array<PluginRequirement>
  platformNote?: string
}

interface PluginEvent {
  type: string
  projectId?: string
  name?: string
  reason?: string
  status?: string
  line?: string
  version?: string
}

export default function IntegrationsPage() {
  const { t } = useTranslation('integrations')
  const { activeProjectId, projects } = useDesktop()
  // Plugins (Serena) are Claude-only — hide them on Codex-only projects. Jira is
  // provider-agnostic and shows for every project.
  const activeProject = projects.find((p) => p.id === activeProjectId)
  const showPlugins = activeProject ? projectProviders(activeProject).includes('claude') : true
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const projectIdRef = useRef(activeProjectId)
  useEffect(() => { projectIdRef.current = activeProjectId }, [activeProjectId])

  const [error, setError] = useState<string | null>(null)
  const [installingFor, setInstallingFor] = useState<string | null>(null)

  const fetcher = useCallback(async (): Promise<PluginCard[]> => {
    const r = await fetch(`${getApiBase()}/plugins`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    return data.plugins ?? []
  }, [])

  const { data: plugins, isLoading, isFirstLoad, refresh } = useProjectCache<PluginCard[]>({
    namespace: 'plugins',
    projectId: activeProjectId,
    initialValue: [],
    fetcher,
  })

  // Auto-refresh on plugin lifecycle WS events.
  useEffect(() => {
    const handler = (raw: unknown) => {
      const msg = raw as PluginEvent
      if (!msg.type) return
      if (msg.projectId && msg.projectId !== projectIdRef.current) return
      if (msg.type.startsWith('plugin.')) refresh()
    }
    registerHandler('integrations-page', handler)
    return () => unregisterHandler('integrations-page')
  }, [registerHandler, unregisterHandler, refresh])

  useEffect(() => {
    if (!isLoading && !plugins) setError('Failed to load plugins')
    else setError(null)
  }, [isLoading, plugins])

  const active = useMemo(() => (plugins ?? []).filter((p) => p.status !== 'orphan'), [plugins])
  const orphans = useMemo(() => (plugins ?? []).filter((p) => p.status === 'orphan'), [plugins])

  if (!activeProjectId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm">
        {t('page.selectProject')}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 border-b border-border px-6 pt-4 pb-3 flex items-center gap-2">
        <Puzzle className="w-4 h-4 text-accent-primary" />
        <div className="flex-1">
          <h1 className="text-lg font-semibold">{t('page.title')}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('page.subtitle')}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isFirstLoad && isLoading ? (
          <SkeletonGrid />
        ) : error && showPlugins ? (
          <ErrorState onRetry={refresh} />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <JiraIntegrationCard activeProjectId={activeProjectId} />
              {showPlugins && active.map((p) => (
                <Card
                  key={p.name}
                  plugin={p}
                  isInstalling={installingFor === p.name}
                  onInstall={() => setInstallingFor(p.name)}
                  onCloseInstall={() => { setInstallingFor(null); refresh() }}
                />
              ))}
            </div>
            {showPlugins && orphans.length > 0 && (
              <div className="mt-10">
                <h2 className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5" /> {t('page.deprecated')}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {orphans.map((p) => (
                    <OrphanCard key={p.name} plugin={p} onRemoved={refresh} />
                  ))}
                </div>
              </div>
            )}
            {!FEATURE_JIRA && (!showPlugins || active.length === 0) && <EmptyState />}
          </>
        )}
      </div>
    </div>
  )
}

function Card({
  plugin,
  isInstalling,
  onInstall,
  onCloseInstall,
}: {
  plugin: PluginCard
  isInstalling: boolean
  onInstall: () => void
  onCloseInstall: () => void
}) {
  const { t } = useTranslation('integrations')
  const [showUninstall, setShowUninstall] = useState(false)

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3 h-full">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{plugin.name}</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              v{plugin.version}
            </span>
            {plugin.status === 'installed' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-success/20 text-accent-success flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> {t('card.statusActive')}
              </span>
            )}
            {plugin.status === 'deactivated' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex items-center gap-1">
                <XCircle className="w-3 h-3" /> {t('card.statusDeactivated')}
              </span>
            )}
            {plugin.status === 'degraded' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-warning/20 text-accent-warning flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> {t('card.statusDegraded')}
              </span>
            )}
            {plugin.updateAvailable && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-info/20 text-accent-info flex items-center gap-1">
                <Download className="w-3 h-3" /> {t('card.updateAvailable')}
              </span>
            )}
          </div>
          {plugin.category && (
            <p className="text-[10px] text-muted-foreground mt-0.5">{plugin.category}</p>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">{plugin.description}</p>

      {plugin.whatItDoes.length > 0 && (
        <ul className="text-xs space-y-1 list-disc pl-4 text-foreground/80">
          {plugin.whatItDoes.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      )}

      {plugin.requirements.length > 0 && (
        <div className="text-[10px] text-muted-foreground">
          {t('card.requires', { list: plugin.requirements.map((r) => `${r.name}${r.minVersion ? ` ≥ ${r.minVersion}` : ''}`).join(', ') })}
        </div>
      )}

      {plugin.healthReason && plugin.status === 'degraded' && (
        <div className="text-[11px] text-accent-warning">
          {plugin.healthReason}
        </div>
      )}
      {plugin.status === 'deactivated' && (
        <div className="text-[11px] text-muted-foreground leading-relaxed">
          <Trans t={t} i18nKey="card.deactivatedHint" components={{ strong: <strong /> }} />
        </div>
      )}
      {plugin.marketplaceConflicts && plugin.marketplaceConflicts.length > 0 && (
        <ConflictResolver pluginName={plugin.name} conflicts={plugin.marketplaceConflicts} />
      )}
      {plugin.marketplaceCachedButDisabled && plugin.marketplaceCachedButDisabled.length > 0 && (
        <CachedButDisabledNotice keys={plugin.marketplaceCachedButDisabled} />
      )}
      {plugin.updateAvailable && <UpdateAvailable pluginName={plugin.name} />}

      <div className="mt-auto pt-2 flex items-center justify-end gap-2">
        {plugin.status === 'not-installed' ? (
          <button
            type="button"
            onClick={onInstall}
            className="text-xs px-3 py-1.5 rounded-md bg-accent-primary text-white hover:opacity-90"
          >
            {t('card.install')}
          </button>
        ) : (
          <>
            <ActiveToggle pluginName={plugin.name} active={plugin.status === 'installed'} />
            <button
              type="button"
              onClick={() => setShowUninstall(true)}
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-destructive/10 hover:text-destructive flex items-center gap-1.5"
            >
              <Trash2 className="w-3 h-3" /> {t('card.uninstall')}
            </button>
          </>
        )}
      </div>

      {isInstalling && (
        <InstallDialog pluginName={plugin.name} onClose={onCloseInstall} />
      )}
      {showUninstall && (
        <UninstallDialog
          pluginName={plugin.name}
          onClose={() => setShowUninstall(false)}
          onUninstalled={() => { setShowUninstall(false); /* parent refresh via WS */ }}
        />
      )}
    </div>
  )
}

function ActiveToggle({ pluginName, active }: { pluginName: string; active: boolean }) {
  const { t } = useTranslation('integrations')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const click = async () => {
    setBusy(true); setError(null)
    try {
      const url = `${getApiBase()}/plugins/${pluginName}/${active ? 'deactivate' : 'activate'}`
      const r = await fetch(url, { method: 'POST' })
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`)
    } catch (err) {
      setError((err as Error).message)
    } finally { setBusy(false) }
  }
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={click}
        role="switch"
        aria-checked={active}
        className={`relative inline-flex items-center h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${
          active ? 'bg-accent-success' : 'bg-muted'
        }`}
        title={active ? t('toggle.titleActive') : t('toggle.titleDeactivated')}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            active ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span className="text-[10px] text-muted-foreground">{active ? t('card.statusActive') : t('common:states.off')}</span>
      {error && <span className="text-[10px] text-destructive">{error}</span>}
    </div>
  )
}

function CachedButDisabledNotice({ keys }: { keys: string[] }) {
  const { t } = useTranslation('integrations')
  return (
    <div className="text-[11px] rounded-md border border-yellow-500/30 aurora-light:border-accent-warning/30 bg-yellow-500/5 aurora-light:bg-accent-warning/10 p-2 leading-relaxed space-y-1">
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="w-3 h-3 text-yellow-500 aurora-light:text-accent-warning mt-0.5 flex-shrink-0" />
        <span>
          <Trans
            t={t}
            i18nKey="cachedNotice.body"
            components={{ strong: <strong />, code: <code className="bg-muted px-1 rounded" /> }}
          />
        </span>
      </div>
      <div className="pl-5 space-y-0.5">
        {keys.map((k) => (
          <pre key={k} className="text-[10px] bg-muted/40 rounded px-1.5 py-0.5 inline-block font-mono">
            /plugin uninstall {k}
          </pre>
        ))}
      </div>
      <div className="pl-5 text-[10px] text-muted-foreground">
        {t('cachedNotice.runInstruction')}
      </div>
    </div>
  )
}

function UpdateAvailable({ pluginName }: { pluginName: string }) {
  const { t } = useTranslation('integrations')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const click = async () => {
    setBusy(true); setError(null)
    try {
      const r = await fetch(`${getApiBase()}/plugins/${pluginName}/update`, { method: 'POST' })
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`)
    } catch (err) {
      setError((err as Error).message)
    } finally { setBusy(false) }
  }
  return (
    <div className="text-[11px] rounded-md border border-accent-info/30 bg-accent-info/5 p-2 leading-relaxed space-y-1.5">
      <div className="flex items-start gap-1.5">
        <Download className="w-3 h-3 text-accent-info mt-0.5 flex-shrink-0" />
        <span>
          <Trans
            t={t}
            i18nKey="update.body"
            components={{ code: <code className="bg-muted px-1 rounded" /> }}
          />
        </span>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={click}
        className="text-[10px] px-2 py-0.5 rounded border border-accent-info/40 hover:bg-accent-info/10 disabled:opacity-50 flex items-center gap-1"
      >
        {busy && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
        <Trans t={t} i18nKey="update.button" components={{ code: <code /> }} />
      </button>
      {error && <div className="text-destructive text-[10px]">{error}</div>}
    </div>
  )
}


function ConflictResolver({ pluginName, conflicts }: { pluginName: string; conflicts: string[] }) {
  const { t } = useTranslation('integrations')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const disable = async (key: string) => {
    setBusy(key); setError(null)
    try {
      const r = await fetch(`${getApiBase()}/plugins/_marketplace/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="text-[11px] rounded-md border border-yellow-500/30 aurora-light:border-accent-warning/30 bg-yellow-500/5 aurora-light:bg-accent-warning/10 p-2 leading-relaxed space-y-1.5">
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="w-3 h-3 text-yellow-500 aurora-light:text-accent-warning mt-0.5 flex-shrink-0" />
        <span>
          <Trans
            t={t}
            i18nKey="conflict.body"
            values={{ name: pluginName }}
            components={{ strong: <strong /> }}
          />
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        {conflicts.map((key) => (
          <button
            key={key}
            type="button"
            disabled={busy === key}
            onClick={() => disable(key)}
            className="text-[10px] px-2 py-0.5 rounded border border-yellow-500/40 aurora-light:border-accent-warning/40 hover:bg-yellow-500/10 aurora-light:hover:bg-accent-warning/10 disabled:opacity-50 flex items-center gap-1"
          >
            {busy === key && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
            <Trans t={t} i18nKey="conflict.disableButton" values={{ key }} components={{ code: <code /> }} />
          </button>
        ))}
      </div>
      {error && <div className="text-destructive">{error}</div>}
    </div>
  )
}

function OrphanCard({ plugin, onRemoved }: { plugin: PluginCard; onRemoved: () => void }) {
  const { t } = useTranslation('integrations')
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    try {
      await fetch(`${getApiBase()}/plugins/${plugin.name}`, { method: 'DELETE' })
      onRemoved()
    } finally { setBusy(false) }
  }
  return (
    <div className="rounded-lg border border-yellow-500/30 aurora-light:border-accent-warning/30 bg-yellow-500/5 aurora-light:bg-accent-warning/10 p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{plugin.name}</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 aurora-light:bg-accent-warning/15 text-yellow-500 aurora-light:text-accent-warning">
          {t('orphan.badge')}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{plugin.description}</p>
      <div className="flex items-center justify-end">
        <button
          type="button"
          disabled={busy}
          onClick={remove}
          className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-destructive/10 hover:text-destructive flex items-center gap-1.5"
        >
          <Trash2 className="w-3 h-3" /> {t('orphan.removeButton')}
        </button>
      </div>
    </div>
  )
}

function InstallDialog({ pluginName, onClose }: { pluginName: string; onClose: () => void }) {
  const { t } = useTranslation('integrations')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [installingPrereq, setInstallingPrereq] = useState<string | null>(null)
  const [prereqLogs, setPrereqLogs] = useState<string[]>([])
  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  const fetchPreview = useCallback(() => {
    setPreview(null)
    setPreviewError(null)
    fetch(`${getApiBase()}/plugins/${pluginName}/preview-install`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: PreviewResult) => setPreview(data))
      .catch((err: Error) => setPreviewError(err.message))
  }, [pluginName])

  useEffect(() => {
    fetchPreview()
  }, [fetchPreview])

  useEffect(() => {
    const handler = (raw: unknown) => {
      const msg = raw as PluginEvent & { prereq?: string; ok?: boolean }
      if (msg.type === 'plugin.install_progress' && msg.name === pluginName && msg.line) {
        setLogs((cur) => [...cur, msg.line!])
      }
      if (msg.type === 'plugin.prereq_install_progress' && msg.line) {
        setPrereqLogs((cur) => [...cur, msg.line!])
      }
      if (msg.type === 'plugin.prereq_installed') {
        setInstallingPrereq(null)
        const reason = (msg as PluginEvent & { reason?: string }).reason
        if (reason) setPrereqLogs((cur) => [...cur, `► ${reason}`])
        // Re-fetch preview so prereq status flips to satisfied.
        if (msg.ok) fetchPreview()
      }
    }
    registerHandler(`install-${pluginName}`, handler)
    return () => unregisterHandler(`install-${pluginName}`)
  }, [pluginName, registerHandler, unregisterHandler, fetchPreview])

  const installPrereq = async (prereq: string) => {
    setInstallingPrereq(prereq)
    setPrereqLogs([t('installDialog.installingPrereq', { name: prereq })])
    try {
      await fetch(`${getApiBase()}/plugins/_prerequisites/${prereq}/install`, { method: 'POST' })
    } catch (err) {
      setPrereqLogs((cur) => [...cur, t('installDialog.prereqStartFailed', { message: (err as Error).message })])
      setInstallingPrereq(null)
    }
  }

  const allPrereqsOk = (preview?.requirements ?? []).every((r) => r.installed && r.executable && r.meetsMinimum)

  const submit = async () => {
    setInstalling(true)
    setInstallError(null)
    try {
      const r = await fetch(`${getApiBase()}/plugins/${pluginName}/install`, { method: 'POST' })
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`)
      setTimeout(onClose, 1500)
    } catch (err) {
      setInstallError((err as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <ModalShell onClose={onClose} title={t('installDialog.title', { name: pluginName })}>
      {previewError && <div className="text-xs text-destructive">{previewError}</div>}
      {!preview && !previewError && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> {t('installDialog.computingChanges')}
        </div>
      )}
      {preview && (
        <>
          {preview.platformNote && (
            <div className="flex items-start gap-2 p-2.5 rounded-md border border-yellow-500/30 aurora-light:border-accent-warning/30 bg-yellow-500/5 aurora-light:bg-accent-warning/10 text-[11px] leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 aurora-light:text-accent-warning mt-0.5 flex-shrink-0" />
              <span>{preview.platformNote}</span>
            </div>
          )}
          <section>
            <h4 className="text-xs font-semibold mb-1.5">{t('installDialog.filesHeading')}</h4>
            <ul className="text-xs space-y-0.5 font-mono">
              {preview.files.map((f, i) => (
                <li key={i} className={f.op === 'create' ? 'text-accent-success' : 'text-accent-info'}>
                  {f.op === 'create' ? '+ ' : '~ '}{f.path}
                  {f.summary && <span className="text-muted-foreground"> {f.summary}</span>}
                </li>
              ))}
            </ul>
          </section>
          {preview.requirements.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold mb-1.5">{t('installDialog.prerequisites')}</h4>
              <ul className="text-xs space-y-1">
                {preview.requirements.map((r) => {
                  const ok = r.installed && r.executable && r.meetsMinimum
                  const supportsAuto = r.name === 'uv'
                  return (
                    <li key={r.name} className="flex items-center gap-2">
                      {ok
                        ? <CheckCircle2 className="w-3 h-3 text-accent-success" />
                        : <XCircle className="w-3 h-3 text-accent-warning" />}
                      <span>{r.name}{r.minVersion ? ` ≥ ${r.minVersion}` : ''}</span>
                      {r.version && <span className="text-muted-foreground">({r.version})</span>}
                      {!ok && supportsAuto && (
                        <button
                          type="button"
                          disabled={installingPrereq === r.name}
                          onClick={() => installPrereq(r.name)}
                          className="ml-auto text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted disabled:opacity-50 flex items-center gap-1"
                        >
                          {installingPrereq === r.name && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                          {t('installDialog.autoInstall')}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
              {prereqLogs.length > 0 && (
                <pre className="mt-2 text-[11px] bg-muted/40 rounded p-2 max-h-24 overflow-auto font-mono">
                  {prereqLogs.join('\n')}
                </pre>
              )}
            </section>
          )}
          {logs.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold mb-1.5">{t('installDialog.progress')}</h4>
              <pre className="text-[11px] bg-muted/40 rounded p-2 max-h-32 overflow-auto font-mono">
                {logs.join('\n')}
              </pre>
            </section>
          )}
          {installError && <div className="text-xs text-destructive">{installError}</div>}
        </>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-border">
          {t('common:actions.cancel')}
        </button>
        <button
          type="button"
          disabled={!preview || !allPrereqsOk || installing}
          onClick={submit}
          className="text-xs px-3 py-1.5 rounded-md bg-accent-primary text-white disabled:opacity-50 flex items-center gap-1.5"
        >
          {installing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          {t('card.install')}
        </button>
      </div>
    </ModalShell>
  )
}

function UninstallDialog({
  pluginName,
  onClose,
  onUninstalled,
}: {
  pluginName: string
  onClose: () => void
  onUninstalled: () => void
}) {
  const { t } = useTranslation('integrations')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    try {
      const r = await fetch(`${getApiBase()}/plugins/${pluginName}`, { method: 'DELETE' })
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`)
      onUninstalled()
    } catch (err) {
      setError((err as Error).message)
    } finally { setBusy(false) }
  }
  return (
    <ModalShell onClose={onClose} title={t('uninstallDialog.title', { name: pluginName })}>
      <p className="text-xs"><Trans t={t} i18nKey="uninstallDialog.body" components={{ code: <code /> }} /></p>
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-border">
          {t('common:actions.cancel')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="text-xs px-3 py-1.5 rounded-md bg-destructive text-white disabled:opacity-50 flex items-center gap-1.5"
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          {t('card.uninstall')}
        </button>
      </div>
    </ModalShell>
  )
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { panelRef, panelStyle, headerHandleProps, resizeHandles, isFloating, guardBackdrop } = useMovableResizableModal()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" tabIndex={-1} onClick={guardBackdrop(onClose)}>
      <div
        ref={panelRef}
        className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md p-5 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
        style={panelStyle}
      >
        <h3 className={`text-sm font-semibold ${isFloating ? 'cursor-grab active:cursor-grabbing' : ''}`} {...headerHandleProps}>{title}</h3>
        {children}
      </div>
      <ResizeGrips handles={resizeHandles} />
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-4 h-40 animate-pulse" />
      ))}
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('integrations')
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3 text-sm text-muted-foreground">
      <AlertTriangle className="w-5 h-5 text-destructive" />
      <p>{t('page.loadError')}</p>
      <button type="button" onClick={onRetry} className="text-xs px-3 py-1.5 rounded-md border border-border">
        {t('common:actions.retry')}
      </button>
    </div>
  )
}

function EmptyState() {
  const { t } = useTranslation('integrations')
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-2 text-sm text-muted-foreground">
      <Puzzle className="w-6 h-6" />
      <p>{t('page.empty')}</p>
    </div>
  )
}
