import { ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import type { PolicyDenial } from './policy-denial'

/**
 * One system row: a tool call Specrails' in-turn policy blocked. Used by the
 * job/loop logs and the mission transcript. Says what was blocked and why;
 * there is nothing to act on, so it is a notice, not a card.
 */
export function PolicyDeniedNotice({ denial, className, compact = false }: { denial: PolicyDenial; className?: string; compact?: boolean }) {
  const { t } = useTranslation('safety')
  const rule = t(`policy.rules.${denial.rule}`)
  return (
    <div
      role="note"
      aria-label={t('policy.blocked')}
      className={cn(
        'flex items-start gap-2 rounded-control border border-accent-warning/30 bg-accent-warning/5 text-foreground',
        compact ? 'px-2 py-1' : 'px-3 py-2',
        className,
      )}
    >
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-warning" aria-hidden />
      <div className="min-w-0 flex-1 text-label">
        <span className="font-medium">{t('policy.blocked')}</span>
        <span className="text-muted-foreground"> · {rule}{denial.tool ? ` · ${denial.tool}` : ''}</span>
        {denial.reason ? <p className="mt-0.5 break-words text-caption text-muted-foreground">{denial.reason}</p> : null}
      </div>
    </div>
  )
}
