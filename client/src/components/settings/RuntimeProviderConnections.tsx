import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RUNTIME_CLI_PROVIDERS, nextRuntimeProviderId, type RuntimeProvider } from '../../lib/agent-runtime'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

/** Connections belong to the app; projects reference their stable IDs. */
export function RuntimeProviderConnections() {
  const { t } = useTranslation('agentRuntime')
  const [providers, setProviders] = useState<RuntimeProvider[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/api/runtime-providers').then(async response => {
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.providers)) throw new Error(data.message ?? t('loadFailed'))
      if (!cancelled) setProviders(data.providers)
    }).catch(error => { if (!cancelled) setError(error.message) })
    return () => { cancelled = true }
  }, [t])
  const update = (next: RuntimeProvider[]) => { setProviders(next); setSaved(false) }
  const change = (index: number, provider: RuntimeProvider) => update(providers!.map((item, i) => i === index ? provider : item))
  const add = (kind: RuntimeProvider['kind']) => {
    const id = nextRuntimeProviderId(providers!, kind === 'cli' ? 'cli' : 'local')
    update([...providers!, kind === 'cli' ? { id, kind, cli: 'claude' } : { id, kind, baseUrl: 'http://127.0.0.1:11434/v1' }])
  }
  async function save() {
    setBusy(true); setError(''); setSaved(false)
    try {
      const response = await fetch('/api/runtime-providers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message ?? t('saveFailed'))
      setProviders(data.providers); setSaved(true)
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="space-y-4">
    <div><h2 className="text-base font-medium">{t('providers.globalTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('providers.globalHint')}</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!providers && !error && <p role="status">{t('loading')}</p>}
    {providers && <fieldset disabled={busy} className="space-y-3">
      {providers.map((provider, index) => <fieldset key={index} className="space-y-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">{provider.id}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">{t('providers.id')}<Input value={provider.id} onChange={e => change(index, { ...provider, id: e.target.value })} /></label>
          {provider.kind === 'cli' ? <label className="space-y-1 text-xs">{t('providers.command')}<select className="h-9 w-full rounded-md border border-input bg-background px-2" value={provider.cli} onChange={e => change(index, { ...provider, cli: e.target.value as typeof provider.cli })}>{RUNTIME_CLI_PROVIDERS.map(cli => <option key={cli} value={cli}>{t(`cliNames.${cli}`)}</option>)}</select></label> : <>
            <label className="space-y-1 text-xs">{t('providers.baseUrl')}<Input type="url" value={provider.baseUrl} onChange={e => change(index, { ...provider, baseUrl: e.target.value })} /></label>
            <label className="space-y-1 text-xs">{t('providers.apiKeyEnv')}<Input value={provider.apiKeyEnv ?? ''} onChange={e => change(index, { ...provider, apiKeyEnv: e.target.value || undefined })} /></label>
          </>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => update(providers.filter((_, i) => i !== index))}>{t('providers.remove')}</Button>
      </fieldset>)}
      <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" onClick={() => add('cli')}>{t('providers.addCli')}</Button><Button variant="secondary" size="sm" onClick={() => add('openai-compatible')}>{t('providers.addLocal')}</Button></div>
      <div className="flex items-center justify-end gap-3">{saved && <p role="status" className="text-sm text-accent-success">{t('saved')}</p>}<Button disabled={busy} onClick={() => void save()}>{t(busy ? 'saving' : 'save')}</Button></div>
    </fieldset>}
  </section>
}
