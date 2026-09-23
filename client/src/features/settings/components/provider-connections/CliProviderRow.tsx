import { useTranslation } from 'react-i18next'
import { TerminalSquare, Trash2 } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import type { RuntimeCli, RuntimeCliProvider, RuntimeProviderStatus } from '../../lib/agent-runtime'
import { ConnectionStatusPill, pillStateFor } from './ConnectionStatusPill'
import { OverflowMenu } from './OverflowMenu'

interface Props {
  provider: RuntimeCliProvider
  status?: RuntimeProviderStatus
  onRemove: () => void
}

/**
 * One CLI tool, one compact ~44px row: icon · name · version · status pill ·
 * auth text · overflow. CLIs are DETECTED machine properties, so there is
 * nothing to configure — no inputs, no select. Undetected rows dim.
 */
export function CliProviderRow({ provider, status, onRemove }: Props) {
  const { t } = useTranslation('agentRuntime')
  const detected = Boolean(status)
  return (
    <li
      data-testid={`connection-row-${provider.id}`}
      data-kind="cli"
      className={cn(
        'flex min-h-11 items-center gap-3 px-3 py-1.5 transition-colors',
        detected ? 'hover:bg-muted/30' : 'opacity-55',
      )}
    >
      <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md border', detected ? 'border-accent-info/30 bg-accent-info/10 text-accent-info' : 'border-border bg-muted/40 text-muted-foreground')}>
        <TerminalSquare className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-foreground">{t(`cliNames.${provider.cli as RuntimeCli}`)}</span>
        {status?.version && <span className="font-mono text-[11px] text-muted-foreground tabular-nums">v{status.version}</span>}
        <span className="font-mono text-[10px] text-muted-foreground/60">{provider.id}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {detected
          ? <>
            <ConnectionStatusPill state={pillStateFor(status)} />
            <span className={cn('hidden text-[11px] sm:inline', status?.authState === 'authenticated' ? 'text-muted-foreground' : 'text-accent-warning')}>{t(`providers.auth.${status!.authState}`)}</span>
          </>
          : <span className="text-[11px] text-muted-foreground">{t('providers.notDetected')}</span>}
        <OverflowMenu label={t('providers.overflow')} items={[
          { id: 'remove', label: t('providers.remove'), icon: <Trash2 className="h-3.5 w-3.5" aria-hidden />, destructive: true, onSelect: onRemove },
        ]} />
      </div>
    </li>
  )
}
