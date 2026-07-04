import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { CheckCircle2, AlertTriangle, RefreshCw, XCircle, Package } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import type { SetupPrerequisite, SetupPrerequisitesStatus } from '../hooks/usePrerequisites'

interface Props {
  status: SetupPrerequisitesStatus | null
  isLoading: boolean
  error: Error | null
  onRefresh?: () => void
  onMoreInfo?: () => void
}

function formatVersionLabel(item: SetupPrerequisite, t: TFunction): string {
  if (item.error === 'corrupted-bundle') {
    return t('setup:prerequisites.corruptedBundle')
  }
  if (!item.installed) return t('setup:prerequisites.notInstalled')
  if (item.executable === false) {
    if (item.resolvedPath && item.executionError) {
      return t('setup:prerequisites.failedToExecuteAtWithError', { path: item.resolvedPath, error: item.executionError })
    }
    if (item.resolvedPath) {
      return t('setup:prerequisites.failedToExecuteAt', { path: item.resolvedPath })
    }
    if (item.executionError) {
      return t('setup:prerequisites.failedToExecuteWithError', { error: item.executionError })
    }
    return t('setup:prerequisites.failedToExecute')
  }
  if (!item.meetsMinimum && item.minVersion) {
    return t('setup:prerequisites.needsMinimum', {
      version: item.version ?? t('setup:prerequisites.unknownVersion'),
      minVersion: item.minVersion,
    })
  }
  return item.version ?? t('setup:prerequisites.installedLabel')
}

export function PrerequisitesPanel({ status, isLoading, error, onRefresh, onMoreInfo }: Props) {
  const { t } = useTranslation('setup')
  if (isLoading && !status) {
    return (
      <div
        data-testid="prerequisites-panel"
        data-state="loading"
        className="rounded-lg border border-border/30 bg-background/30 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full bg-muted-foreground/20 animate-pulse" />
          <div className="h-3 w-32 rounded bg-muted-foreground/15 animate-pulse" />
        </div>
      </div>
    )
  }

  if (error && !status) {
    return (
      <div
        data-testid="prerequisites-panel"
        data-state="error"
        className="rounded-lg border border-border/40 bg-background/40 px-3 py-2"
      >
        <p className="text-[11px] text-muted-foreground">
          {t('prerequisites.verifyError')}
        </p>
      </div>
    )
  }

  if (!status) return null

  if (status.ok) {
    return (
      <div
        data-testid="prerequisites-panel"
        data-state="ok"
        className="rounded-lg border border-accent-success/25 bg-accent-success/5 px-3 py-2"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <CheckCircle2 className="w-4 h-4 text-accent-success flex-shrink-0" />
            <p className="text-xs font-medium text-foreground">{t('prerequisites.allDetected')}</p>
          </div>
          {onRefresh && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={isLoading}
              className="h-7 px-2 gap-1.5 text-[11px] flex-shrink-0"
            >
              <RefreshCw className={cn('w-3 h-3', isLoading && 'animate-spin')} />
              {t('common:actions.refresh')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  // status.ok === false
  const missingCount = status.missingRequired?.length ?? 0
  // In desktop mode all missing required tools are bundled. If every missing entry
  // is a corrupted-bundle error, suppress the "More info" / install-instructions path
  // because the fix is reinstalling the app, not installing system tools.
  const allMissingAreCorrupted =
    missingCount > 0 &&
    (status.missingRequired ?? []).every((item) => item.error === 'corrupted-bundle')
  const hasCorruptedBundle =
    (status.missingRequired ?? []).some((item) => item.error === 'corrupted-bundle')

  return (
    <div
      data-testid="prerequisites-panel"
      data-state="missing"
      className={cn(
        'rounded-lg border px-3 py-2',
        hasCorruptedBundle
          ? 'border-destructive/40 bg-destructive/10'
          : 'border-accent-primary/40 bg-accent-primary/10',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle className={cn('w-4 h-4 flex-shrink-0', hasCorruptedBundle ? 'text-destructive' : 'text-accent-primary')} />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">
              {allMissingAreCorrupted
                ? t('prerequisites.bundleCorruptedTitle')
                : t('prerequisites.toolsRequired', { count: missingCount })}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {allMissingAreCorrupted
                ? t('prerequisites.reinstallHint')
                : t('prerequisites.installMissingHint')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {onMoreInfo && !allMissingAreCorrupted && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onMoreInfo}
              className="h-7 px-2 gap-1.5 text-[11px]"
              data-testid="prerequisites-more-info"
            >
              {t('prerequisites.moreInfo')}
            </Button>
          )}
          {onRefresh && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={isLoading}
              className="h-7 px-2 gap-1.5 text-[11px]"
            >
              <RefreshCw className={cn('w-3 h-3', isLoading && 'animate-spin')} />
              {t('common:actions.refresh')}
            </Button>
          )}
        </div>
      </div>

      <ul className="mt-2 space-y-1">
        {status.prerequisites.map((item) => {
          const isCorrupted = item.error === 'corrupted-bundle'
          const isBundledOk = item.bundled === true && item.executable === true && !isCorrupted
          const ok = !isCorrupted && item.installed && item.meetsMinimum
          // Optional tools (gh, uv) never block Add Project — a missing one
          // renders muted, not alarm-red.
          // Only the genuinely optional tools: providers are required:false too
          // (the "at least one" rule lives elsewhere) and npm/npx flip to
          // required:false under the bundled-offline setup — neither should
          // carry an "(optional)" tag.
          const isOptionalTool = item.key === 'gh' || item.key === 'uv'
          const missingOptional = !ok && !isCorrupted && isOptionalTool
          return (
            <li
              key={item.key}
              data-testid={`prereq-row-${item.key}`}
              data-ok={ok ? 'true' : 'false'}
              data-bundled={item.bundled ? 'true' : undefined}
              data-corrupted={isCorrupted ? 'true' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md border px-2 py-1.5 text-[11px]',
                isCorrupted
                  ? 'border-destructive/40 bg-destructive/10 text-foreground'
                  : ok
                    ? 'border-border/30 bg-background/30 text-muted-foreground'
                    : missingOptional
                      ? 'border-border/30 bg-background/30 text-muted-foreground'
                      : 'border-accent-primary/30 bg-background/50 text-foreground',
              )}
            >
              {isCorrupted ? (
                <XCircle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />
              ) : isBundledOk ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-accent-success flex-shrink-0" />
              ) : ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-accent-success flex-shrink-0" />
              ) : missingOptional ? (
                <XCircle className="w-3.5 h-3.5 text-muted-foreground/60 flex-shrink-0" />
              ) : (
                <XCircle className="w-3.5 h-3.5 text-accent-primary flex-shrink-0" />
              )}
              <span className="font-medium">{item.label}</span>
              {isOptionalTool && (
                <span className="text-[10px] text-muted-foreground/70">
                  {t('prerequisites.optional')}
                </span>
              )}
              {item.key === 'gh' && item.executable && item.authenticated === false && (
                <span
                  data-testid="prereq-gh-noauth"
                  className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium bg-accent-warning/15 text-accent-warning border border-accent-warning/30"
                >
                  {t('prerequisites.ghNoAuth')}
                </span>
              )}
              {isBundledOk && (
                <span
                  data-testid={`prereq-bundled-badge-${item.key}`}
                  className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium bg-accent-secondary/20 text-accent-secondary border border-accent-secondary/30"
                >
                  <Package className="w-2.5 h-2.5" />
                  {t('prerequisites.bundledBadge')}
                </span>
              )}
              <span className={cn('text-muted-foreground', isCorrupted && 'text-destructive/80')}>
                — {formatVersionLabel(item, t)}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
