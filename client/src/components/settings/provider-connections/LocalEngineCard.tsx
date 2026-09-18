import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Server } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { runtimeProviderDisplayName, type RuntimeLocalProvider, type RuntimeProviderStatus } from '../../../lib/agent-runtime'
import { ConnectionStatusPill, pillStateFor } from './ConnectionStatusPill'
import { LocalConnectionEditor, SMALL_MODEL_CONTEXT } from './LocalConnectionEditor'

interface Props {
  provider: RuntimeLocalProvider
  status?: RuntimeProviderStatus
  persisted: boolean
  /** Rates flagged invalid while the editor was open — keeps the card expanded so the fix is visible. */
  invalid?: boolean
  onChange: (next: RuntimeLocalProvider) => void
  onStatus: (next: RuntimeProviderStatus | undefined) => void
  onValidity: (valid: boolean) => void
  onRemove: () => void
}

/** "32k" style token count for the summary chip. */
export function formatContextWindow(tokens: number | undefined): string {
  const value = tokens ?? SMALL_MODEL_CONTEXT
  return value >= 1024 && value % 1024 === 0 ? `${value / 1024}k` : value.toLocaleString()
}

/**
 * One local (OpenAI-compatible) engine: a summary row — Server icon, label,
 * base URL, status pill, model count, agent-loop chip, context window — with
 * a chevron that expands the full `LocalConnectionEditor` inline. Persisted
 * rows start collapsed; a freshly added one opens so the user can fill it in.
 */
export function LocalEngineCard({ provider, status, persisted, invalid = false, onChange, onStatus, onValidity, onRemove }: Props) {
  const { t } = useTranslation('agentRuntime')
  const [expanded, setExpanded] = useState(!persisted)
  const open = expanded || invalid
  const modelCount = status?.models?.length ?? 0
  const loop = provider.agentLoop ?? 'compact'
  const name = runtimeProviderDisplayName(provider)
  const editorId = `local-engine-editor-${provider.id || 'new'}`

  return (
    <div
      data-testid={`connection-row-${provider.id}`}
      data-kind="local"
      data-expanded={open}
      className={cn('rounded-xl border bg-card/60 shadow-sm transition-colors', open ? 'border-accent-primary/30' : 'border-border/70 hover:border-border')}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent-highlight/30 bg-accent-highlight/10 text-accent-highlight">
          <Server className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-medium text-foreground">{name}</span>
            {provider.label?.trim() && <span className="font-mono text-[10px] text-muted-foreground/60">{provider.id}</span>}
            <ConnectionStatusPill state={pillStateFor(status)} latencyMs={status?.latencyMs} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="truncate font-mono">{provider.baseUrl || '—'}</span>
            <span aria-hidden className="text-muted-foreground/40">·</span>
            <span className="tabular-nums">{t('providers.models', { count: modelCount })}</span>
            <span aria-hidden className="text-muted-foreground/40">·</span>
            <span className={cn('rounded-full border px-1.5 py-px text-[10px] font-medium', loop === 'compact' ? 'border-accent-secondary/30 bg-accent-secondary/10 text-accent-secondary' : 'border-border bg-muted/40 text-muted-foreground')} data-testid="agent-loop-chip">
              {t(`providers.agentLoop_${loop}`)}
            </span>
            <span className="tabular-nums" title={t('providers.contextWindow')}>{formatContextWindow(provider.contextWindowTokens)} ctx</span>
          </div>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={editorId}
          aria-label={t(open ? 'providers.collapse' : 'providers.expand')}
          title={t(open ? 'providers.collapse' : 'providers.expand')}
          disabled={invalid}
          onClick={() => setExpanded(!open)}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
        </button>
      </div>
      {open && (
        <div id={editorId} className="border-t border-border/60 px-4 pb-4 pt-3">
          <LocalConnectionEditor provider={provider} status={status} persisted={persisted} onChange={onChange} onStatus={onStatus} onValidity={onValidity} onRemove={onRemove} />
        </div>
      )}
    </div>
  )
}
