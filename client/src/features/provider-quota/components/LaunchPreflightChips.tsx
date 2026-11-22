/**
 * The launch preflight as a row of chips: disk at the worktrees location,
 * provider and GitHub sign-in, and quota left. A failing chip blocks the
 * launch; warnings are told plainly but never block.
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, HelpCircle, RotateCcw, XCircle } from 'lucide-react'
import { LiveDot } from '../../../components/ui/live-dot'
import { cn } from '../../../lib/utils'
import { formatResetTime } from '../lib/format-reset'
import { providerLabel } from '../lib/labels'
import type { PreflightChip, PreflightReport } from '../lib/launch-preflight'

const GUI_LABELS: Record<string, string> = { electron: 'Electron', tauri: 'Tauri', nwjs: 'NW.js', neutralino: 'Neutralino', wails: 'Wails' }

function formatBytes(bytes: number | null, language: string): string {
  if (bytes === null) return '—'
  const gib = bytes / 1024 ** 3
  return gib >= 1 ? `${new Intl.NumberFormat(language, { maximumFractionDigits: gib < 10 ? 1 : 0 }).format(gib)} GB` : `${new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(bytes / 1024 ** 2)} MB`
}

export function chipText(chip: PreflightChip, t: (key: string, options?: Record<string, unknown>) => string, language: string): string {
  switch (chip.kind) {
    case 'disk': return t(`preflight.disk.${chip.state}`, { free: formatBytes(chip.freeBytes, language) })
    case 'provider': return t(`preflight.provider.${chip.status}`, { provider: providerLabel(chip.providerId) })
    case 'github': return t(`preflight.github.${chip.status}`)
    case 'headless': return t(`preflight.headless.${chip.state === 'warn' ? 'warn' : 'ok'}`, { framework: GUI_LABELS[chip.framework] ?? chip.framework })
    case 'quota': {
      const provider = providerLabel(chip.providerId)
      if (chip.level === 'rejected') return chip.rejectedUntil ? t('preflight.quota.rejectedUntil', { provider, time: formatResetTime(chip.rejectedUntil, language) }) : t('preflight.quota.rejected', { provider })
      return t(`preflight.quota.${['ok', 'warning', 'critical'].includes(chip.level) ? chip.level : 'unknown'}`, { provider, percent: Math.round(chip.usedPercent ?? 0) })
    }
  }
}

const LOOK = {
  ok: { icon: CheckCircle2, className: 'border-accent-success/30 text-foreground', iconClass: 'text-accent-success' },
  warn: { icon: AlertTriangle, className: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning', iconClass: 'text-accent-warning' },
  fail: { icon: XCircle, className: 'border-destructive/40 bg-destructive/10 text-destructive', iconClass: 'text-destructive' },
  unknown: { icon: HelpCircle, className: 'border-border text-muted-foreground', iconClass: 'text-muted-foreground' },
} as const

export function LaunchPreflightChips({ report, loading, onRecheck }: { report: PreflightReport | null; loading: boolean; onRecheck?: () => void }) {
  const { t, i18n } = useTranslation('providerQuota')
  return (
    <div className="space-y-1.5" data-testid="launch-preflight">
      <div className="flex items-center gap-2 text-caption text-muted-foreground">
        <span className="font-medium">{t('preflight.label')}</span>
        {loading && <span className="inline-flex items-center gap-1.5" role="status"><LiveDot tone="info" size="xs" aria-hidden />{t('preflight.checking')}</span>}
        {!loading && onRecheck && (
          <button type="button" onClick={onRecheck} className="inline-flex cursor-pointer items-center gap-1 rounded-control px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50">
            <RotateCcw className="h-3 w-3" aria-hidden />{t('preflight.recheck')}
          </button>
        )}
      </div>
      {report && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('preflight.label')}>
          {report.chips.map((chip) => {
            const look = LOOK[chip.state]
            const Icon = look.icon
            return (
              <li key={chip.id} data-testid={`preflight-chip-${chip.id}`} data-state={chip.state}
                className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption', look.className)}>
                <Icon className={cn('h-3 w-3 shrink-0', look.iconClass)} aria-hidden />
                {chipText(chip, t, i18n.language)}
              </li>
            )
          })}
        </ul>
      )}
      {report?.blocking && <p role="alert" className="text-caption text-destructive" data-testid="launch-preflight-blocking">{t('preflight.blocking')}</p>}
    </div>
  )
}
