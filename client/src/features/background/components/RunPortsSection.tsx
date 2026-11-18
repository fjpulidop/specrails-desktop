import { useTranslation } from 'react-i18next'
import { AlertTriangle, Cable } from 'lucide-react'
import type { RunPort, RunPortsSnapshot } from '../lib/run-ports-api'

function owner(port: RunPort, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (!port.run) return t('ports.unknownRun')
  return t('ports.run', { rail: port.run.railIndex + 1, ticket: port.run.ticketId, project: port.run.projectName })
}

/**
 * Ports served from run worktrees: each rail's dev server or test server and the block it was
 * assigned. A process listening inside a run's block from elsewhere is flagged (it would make
 * that run's server fail with "address already in use").
 */
export function RunPortsSection({ snapshot }: { snapshot: RunPortsSnapshot | null }) {
  const { t } = useTranslation('resources')
  if (!snapshot || (snapshot.ports.length === 0 && snapshot.supported)) return null
  return <section data-testid="run-ports" aria-label={t('ports.title')} className="space-y-1">
    <div className="flex items-center gap-1.5 px-1 text-caption text-muted-foreground">
      <Cable className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="flex-1">{t('ports.title')}</span>
    </div>
    {!snapshot.supported && <p className="px-1 text-caption text-muted-foreground">{t('ports.unsupported')}</p>}
    <ul>
      {snapshot.ports.map(port => <li key={`${port.pid ?? ''}:${port.host}:${port.port}`} data-testid="run-port" className="flex items-center gap-2 py-0.5 pl-6 text-caption">
        {port.squatting
          ? <AlertTriangle className="h-3 w-3 shrink-0 text-accent-warning" aria-label={t('ports.squatting')} />
          : <span aria-hidden className="w-3 shrink-0" />}
        <span className="num w-14 shrink-0 text-foreground">:{port.port}</span>
        <span className="min-w-0 flex-1 truncate text-foreground" title={port.worktreePath ?? undefined}>
          {owner(port, t)}
          {port.squatting && <span className="text-accent-warning"> · {t('ports.squattingShort')}</span>}
        </span>
        <span className="min-w-0 max-w-24 shrink truncate text-muted-foreground" title={port.command ?? undefined}>{port.command ?? '—'}</span>
        <span className="w-16 shrink-0 text-right text-muted-foreground" title={t(`ports.confidenceHint.${port.confidence}`)}>
          <span aria-hidden>{t(`ports.confidence.${port.confidence}`)}</span>
          <span className="sr-only">{t(`ports.confidenceHint.${port.confidence}`)}</span>
        </span>
      </li>)}
    </ul>
  </section>
}
