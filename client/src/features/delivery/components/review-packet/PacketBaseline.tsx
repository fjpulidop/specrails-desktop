/**
 * "Spec created where the work passed" (Core baselineOnTouch, feedback-2026-10
 * task 3.4): when the change reached code no capability described, the run
 * first wrote characterization tests (proven on the unchanged code) and a
 * minimal as-built spec. Its cost is shown apart from the change's own cost.
 */
import { useTranslation } from 'react-i18next'
import { Landmark } from 'lucide-react'
import type { PacketBaseline as Baseline } from '../../../../types'
import { formatUsd } from '../../../../lib/format-usd'

const MAX_FILES = 6

function money(value: number | null): string | null {
  return value === null ? null : formatUsd(value)
}

export function PacketBaseline({ entries, multiTicket }: { entries: Baseline[]; multiTicket: boolean }) {
  const { t } = useTranslation('packet')
  return (
    <section className="rounded-lg border border-border/60 bg-surface/40 p-4" data-testid="packet-baseline" aria-labelledby="packet-baseline-title">
      <h2 id="packet-baseline-title" className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Landmark className="size-4 text-accent-info" aria-hidden />
        {t('baseline.title')}
      </h2>
      <ul className="space-y-3">
        {entries.map((entry) => {
          const blocked = entry.status === 'failed' || entry.status === 'violated'
          const requirements = entry.capabilities.reduce((sum, item) => sum + item.requirements, 0)
          const module = entry.uncovered.slice(0, MAX_FILES)
          const cost = entry.cost ? money(entry.cost.costUsd) : null
          return (
            <li key={`${entry.ticketId}:${entry.change ?? ''}`} className="space-y-1" data-testid={`packet-baseline-${entry.status}`}>
              <p className={`text-sm ${blocked ? 'text-accent-warning' : 'text-foreground'}`}>
                {t(`baseline.status.${entry.status}`, { requirements, tests: entry.tests.length })}
                {multiTicket ? <span className="ml-1 text-caption text-muted-foreground">#{entry.ticketId}</span> : null}
              </p>
              {module.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('baseline.module')}{' '}
                  <span className="font-mono text-caption text-foreground/80">{module.join(', ')}</span>
                  {entry.uncovered.length > module.length ? ` ${t('baseline.more', { count: entry.uncovered.length - module.length })}` : ''}
                </p>
              ) : null}
              {entry.capabilities.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('baseline.spec')}{' '}
                  {entry.capabilities.map((item) => (
                    <span key={item.capability} className="mr-2 font-mono text-caption text-foreground/80">
                      {t('baseline.capability', { capability: item.capability, requirements: item.requirements, demonstrated: item.demonstrated })}
                    </span>
                  ))}
                </p>
              ) : null}
              {blocked && entry.reason ? <p className="text-xs text-accent-warning" data-testid="packet-baseline-reason">{entry.reason}</p> : null}
              <p className="text-caption text-muted-foreground" data-testid="packet-baseline-cost">
                {cost ? t('baseline.cost', { amount: cost, turns: entry.cost?.invocations ?? 0 }) : t('baseline.costUnknown')}
              </p>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 text-caption text-muted-foreground">{t('baseline.caveat')}</p>
    </section>
  )
}
