import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDesktop } from '../../../hooks/useDesktop'
import { repositoryApiBase, projectRepositories } from '../../projects/lib/project-repositories'
import { formatVerificationCommand, parseVerificationCommand, isAgentRuntimeSettingsResponse, isVerificationSuggestionsResponse, type AgentRuntimeConfig, type AgentRuntimeSettingsResponse, type RuntimeVerificationCommand, type VerificationSuggestion } from '../lib/agent-runtime'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card'
import { Input } from '../../../components/ui/input'
import { Button } from '../../../components/ui/button'

const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'
interface VerificationRow { label?: string; original?: RuntimeVerificationCommand; repositoryId: string; line: string; reason?: string }
function rowsFrom(commands: RuntimeVerificationCommand[]): VerificationRow[] { return commands.map(command => ({ original: command, label: command.label, repositoryId: command.repositoryId, line: formatVerificationCommand(command) })) }
function rowsFromSuggestions(suggestions: VerificationSuggestion[]): VerificationRow[] { return suggestions.map(suggestion => ({ repositoryId: suggestion.repositoryId, line: formatVerificationCommand(suggestion), reason: suggestion.reason })) }

export function AgentRuntimeSettingsSection() {
  const { activeProjectId, projects } = useDesktop()
  const cache = useRef(new Map<string, AgentRuntimeSettingsResponse>())
  const project = projects.find(item => item.id === activeProjectId)
  return activeProjectId ? <RuntimeSettings key={activeProjectId} projectId={activeProjectId} cache={cache.current} repositories={projectRepositories(project).map(({ id, name }) => ({ id, name }))} /> : null
}

function RuntimeSettings({ projectId, cache, repositories }: { projectId: string; cache: Map<string, AgentRuntimeSettingsResponse>; repositories: Array<{ id: string; name: string }> }) {
  const { t } = useTranslation('agentRuntime')
  const cached = cache.get(projectId)
  const [config, setConfig] = useState<AgentRuntimeConfig | null>(cached?.config ?? null)
  const [rows, setRows] = useState<VerificationRow[]>(rowsFrom(cached?.config.verification ?? []))
  const [busy, setBusy] = useState(false), [detecting, setDetecting] = useState(false)
  const [detected, setDetected] = useState<'none' | 'some' | null>(null)
  const [loading, setLoading] = useState(!cached), [error, setError] = useState(''), [saved, setSaved] = useState(false), [unsaved, setUnsaved] = useState(false), [reload, setReload] = useState(0)
  const dirty = useRef(false), mounted = useRef(true)
  const endpoint = `${repositoryApiBase(projectId)}/agent-runtime/config`
  function updateRows(next: VerificationRow[]) { dirty.current = true; setUnsaved(true); setSaved(false); setRows(next) }
  const suggestionsEndpoint = `${repositoryApiBase(projectId)}/agent-runtime/verification-suggestions`

  async function detect(): Promise<VerificationSuggestion[] | null> {
    try {
      const response = await fetch(suggestionsEndpoint, { cache: 'no-store' })
      if (!response.ok) return null
      const data = await response.json() as unknown
      return isVerificationSuggestionsResponse(data) ? data.suggestions : null
    } catch { return null }
  }

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    fetch(endpoint, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(t('loadFailed'))
      const data = await response.json() as AgentRuntimeSettingsResponse
      if (!isAgentRuntimeSettingsResponse(data)) throw new Error(t('loadFailed'))
      if (cancelled) return
      cache.set(projectId, data)
      if (!dirty.current) {
        setConfig(data.config)
        setRows(rowsFrom(data.config.verification))
        // A project that never saved runtime settings starts from its own
        // detected checks, so nothing has to be typed to get a verified run.
        if (!data.configured && data.config.verification.length === 0) {
          const suggestions = await detect()
          if (cancelled || dirty.current) return
          if (suggestions?.length) { setRows(rowsFromSuggestions(suggestions)); setDetected('some') }
          else if (suggestions) setDetected('none')
        }
      }
      setError('')
    }).catch(() => { if (!cancelled) setError(t('loadFailed')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; mounted.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, projectId, cache, reload, t])

  function readVerification(): RuntimeVerificationCommand[] | null {
    const commands: RuntimeVerificationCommand[] = []
    for (const row of rows) {
      if (!row.line.trim() && !row.repositoryId) continue
      const parsed = parseVerificationCommand(row.line)
      if (!parsed || !row.repositoryId) { setError(t('verification.invalidLine', { line: row.line || '∅' })); return null }
      commands.push({ ...row.original, ...(row.label !== undefined ? { label: row.label.trim() || undefined } : {}), repositoryId: row.repositoryId, ...parsed })
    }
    return commands
  }

  async function detectNow() {
    setDetecting(true); setError('')
    try {
      const suggestions = await detect()
      if (!mounted.current) return
      if (!suggestions) { setError(t('verification.detectFailed')); return }
      const known = new Set(rows.map((row) => `${row.repositoryId}\0${row.line}`))
      const fresh = rowsFromSuggestions(suggestions).filter((row) => !known.has(`${row.repositoryId}\0${row.line}`))
      updateRows([...rows, ...fresh])
      setDetected(suggestions.length ? 'some' : 'none')
    } finally { if (mounted.current) setDetecting(false) }
  }

  async function save() {
    if (!config || busy) return
    setError('')
    setSaved(false)
    const commands = readVerification()
    if (!commands) return
    setBusy(true)
    try {
      const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config, verification: commands }) })
      const data = await response.json() as AgentRuntimeSettingsResponse & { error?: string; message?: string }
      if (!response.ok) throw new Error(data.message ?? data.error ?? t('saveFailed'))
      if (!isAgentRuntimeSettingsResponse(data)) throw new Error(t('saveFailed'))
      cache.set(projectId, data)
      if (!mounted.current) return
      dirty.current = false; setUnsaved(false)
      setConfig(data.config); setRows(rowsFrom(data.config.verification)); setSaved(true)
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : t('saveFailed')) }
    finally { if (mounted.current) setBusy(false) }
  }

  function renderVerification() {
    return <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('verification.hint')}</p>
        <Button size="sm" variant="secondary" disabled={detecting} onClick={() => void detectNow()}>{detecting ? t('verification.detecting') : t('verification.detect')}</Button>
      </div>
      {detected === 'some' && !rows.some((row) => !row.reason) && <p role="status" className="text-xs text-accent-success">{t('verification.detected')}</p>}
      {detected === 'none' && rows.length === 0 && <p role="status" className="text-xs text-muted-foreground">{t('verification.nothingDetected')}</p>}
      {rows.map((row, index) => <div key={index} className="grid gap-2 sm:grid-cols-[minmax(8rem,1fr)_2fr_auto]">
        <label className="space-y-1 text-xs">{t('verification.repository')}
          {repositories.length
            ? <select className={selectClass} value={row.repositoryId} onChange={(event) => updateRows(rows.map((item, i) => i === index ? { ...item, repositoryId: event.target.value } : item))}>
              {!repositories.some((repository) => repository.id === row.repositoryId) && <option value={row.repositoryId}>{row.repositoryId || '—'}</option>}
              {repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.name}</option>)}
            </select>
            : <Input value={row.repositoryId} onChange={(event) => updateRows(rows.map((item, i) => i === index ? { ...item, repositoryId: event.target.value } : item))} />}
        </label>
        <div className="space-y-1 text-xs">
          <label className="block space-y-1">{t('verification.command')}<Input className="font-mono" spellCheck={false} placeholder="npm test" value={row.line} onChange={(event) => updateRows(rows.map((item, i) => i === index ? { ...item, line: event.target.value, reason: undefined } : item))} /></label>
          <label className="block space-y-1">{t('verification.label')}<Input maxLength={256} value={row.label ?? ''} onChange={event => updateRows(rows.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} /></label>
          {row.reason && <span className="block text-[11px] text-muted-foreground">{t('verification.reason', { reason: row.reason })}</span>}
        </div>
        <div className="flex items-end gap-1">
          <Button size="sm" variant="ghost" aria-label={`${t('verification.moveUp')} ${index + 1}`} disabled={index === 0} onClick={() => { const moved = [...rows]; [moved[index - 1], moved[index]] = [moved[index], moved[index - 1]]; updateRows(moved) }}>↑</Button>
          <Button size="sm" variant="ghost" aria-label={`${t('verification.moveDown')} ${index + 1}`} disabled={index === rows.length - 1} onClick={() => { const moved = [...rows]; [moved[index + 1], moved[index]] = [moved[index], moved[index + 1]]; updateRows(moved) }}>↓</Button>
          <Button size="sm" variant="ghost" onClick={() => updateRows(rows.filter((_, i) => i !== index))}>{t('verification.remove')}</Button></div>
      </div>)}
      <Button size="sm" variant="ghost" onClick={() => updateRows([...rows, { repositoryId: repositories[0]?.id ?? '', line: '' }])}>{t('verification.add')}</Button>
    </>
  }

  return <Card id="agent-runtime-settings">
    <CardHeader><CardTitle>{t('verification.title')}</CardTitle><CardDescription>{t('loopAgents.projectHint')}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {loading && <p role="status">{t('loading')}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {!config && !loading && <Button onClick={() => { setLoading(true); setReload(value => value + 1) }}>{t('retry')}</Button>}
      {config && <fieldset disabled={busy} className="space-y-3">{renderVerification()}
        <div className="sticky bottom-3 flex items-center justify-end gap-3 rounded border bg-card p-2" data-testid="runtime-save-pill" data-unsaved={unsaved}>
          {unsaved && <span>{t('unsavedChanges')}</span>}
          {saved && <p role="status">{t('saved')}</p>}
          <Button disabled={busy} onClick={() => void save()}>{busy ? t('saving') : t('save')}</Button>
        </div>
      </fieldset>}
    </CardContent>
  </Card>
}
