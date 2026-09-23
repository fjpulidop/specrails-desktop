import { useTranslation } from 'react-i18next'
import { Server, TerminalSquare } from 'lucide-react'
import { RUNTIME_CLI_PROVIDERS, runtimeProviderDisplayName, type RuntimeProvider } from '../../lib/agent-runtime'
import { Input } from '../../../../components/ui/input'
import { Button } from '../../../../components/ui/button'

interface Props {
  provider: RuntimeProvider
  onChange: (next: RuntimeProvider) => void
  onRemove: () => void
}

const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'

/**
 * LEGACY plain connection row (VITE_FEATURE_LOCAL_ENGINES off): editable id,
 * CLI select or base URL + env name, no pill/test/models/rates. The premium
 * layout lives in `CliProviderRow` / `LocalEngineCard`.
 */
export function ConnectionRow({ provider, onChange, onRemove }: Props) {
  const { t } = useTranslation('agentRuntime')
  const local = provider.kind === 'openai-compatible'
  const Icon = local ? Server : TerminalSquare
  return (
    <fieldset className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm transition-colors hover:border-border" data-testid={`connection-row-${provider.id}`}>
      <legend className="flex items-center gap-2 px-1.5 text-sm font-medium">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        {runtimeProviderDisplayName(provider)}
        <span className="rounded-full border border-border bg-muted/40 px-2 py-px text-[10px] font-normal uppercase tracking-wide text-muted-foreground">{t(local ? 'providers.localBadge' : 'providers.cliBadge')}</span>
      </legend>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">{t('providers.id')}<Input value={provider.id} onChange={(e) => onChange({ ...provider, id: e.target.value })} /></label>
          {provider.kind === 'cli'
            ? <label className="space-y-1 text-xs">{t('providers.command')}<select className={selectClass} value={provider.cli} onChange={(e) => onChange({ ...provider, cli: e.target.value as typeof provider.cli })}>{RUNTIME_CLI_PROVIDERS.map((cli) => <option key={cli} value={cli}>{t(`cliNames.${cli}`)}</option>)}</select></label>
            : <>
              <label className="space-y-1 text-xs">{t('providers.baseUrl')}<Input type="url" value={provider.baseUrl} onChange={(e) => onChange({ ...provider, baseUrl: e.target.value })} /></label>
              <label className="space-y-1 text-xs">{t('providers.apiKeyEnv')}<Input value={provider.apiKeyEnv ?? ''} onChange={(e) => onChange({ ...provider, apiKeyEnv: e.target.value || undefined })} /></label>
            </>}
        </div>
        <Button variant="ghost" size="sm" onClick={onRemove}>{t('providers.remove')}</Button>
      </div>
    </fieldset>
  )
}
