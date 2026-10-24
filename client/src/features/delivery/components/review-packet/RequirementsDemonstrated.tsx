/**
 * "Requirements demonstrated X/Y" (Core specTrace, feedback-2026-10 task 3.3):
 * which spec requirements a passing test claims with a `[spec:<id>]` tag.
 * Core crossed the tags with the verification receipt (app-verified); the
 * list is advisory evidence and never gates the decision. Requirements the
 * change touches come first: they are what this delivery answers for.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks } from 'lucide-react'
import type { PacketRequirementsDemonstrated } from '../../../../types'

const COLLAPSED = 8

export function RequirementsDemonstrated({ section, multiTicket }: { section: PacketRequirementsDemonstrated; multiTicket: boolean }) {
  const { t } = useTranslation('packet')
  const [expanded, setExpanded] = useState(false)
  const touchedMissing = section.undemonstratedList.filter((item) => item.touched).length
  const complete = section.total > 0 && section.demonstrated === section.total
  const tone = touchedMissing > 0 ? 'warning' : complete ? 'success' : 'info'
  const border = tone === 'warning' ? 'border-accent-warning/30 bg-accent-warning/5' : tone === 'success' ? 'border-accent-success/30 bg-accent-success/5' : 'border-border/60 bg-surface/40'
  const icon = tone === 'warning' ? 'text-accent-warning' : tone === 'success' ? 'text-accent-success' : 'text-accent-info'
  const missing = expanded ? section.undemonstratedList : section.undemonstratedList.slice(0, COLLAPSED)
  const shown = expanded ? section.demonstratedList : section.demonstratedList.slice(0, COLLAPSED)
  const hidden = section.undemonstratedList.length - missing.length + section.demonstratedList.length - shown.length
  const ticket = (id: number) => multiTicket ? <span className="ml-1 text-caption text-muted-foreground">#{id}</span> : null
  return (
    <section className={`rounded-lg border p-4 ${border}`} data-testid="packet-requirements" aria-labelledby="packet-requirements-title">
      <h2 id="packet-requirements-title" className="mb-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
        <ListChecks className={`size-4 ${icon}`} aria-hidden />
        {t('requirements.title', { demonstrated: section.demonstrated, total: section.total })}
      </h2>
      {section.touched > 0 ? (
        <p className="text-xs text-foreground" data-testid="packet-requirements-touched">
          {t('requirements.touched', { demonstrated: section.touchedDemonstrated, total: section.touched })}
        </p>
      ) : null}
      <p className="mt-1 text-caption text-muted-foreground">
        {section.withoutReceipt ? t('requirements.caveatNoReceipt') : t('requirements.caveat')}
      </p>
      {missing.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-label text-foreground">{t('requirements.undemonstratedTitle', { count: section.undemonstratedList.length })}</h3>
          <ul className="mt-1 space-y-1" data-testid="packet-requirements-undemonstrated">
            {missing.map((item) => (
              <li key={`${item.ticketId}:${item.id}`} className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                <span className={`font-mono text-caption ${item.touched ? 'text-accent-warning' : 'text-foreground/80'}`}>{item.id}</span>
                <span className="text-muted-foreground">{t(`requirements.reason.${item.reason}`)}</span>
                {item.touched ? <span className="rounded-full border border-accent-warning/40 px-1.5 text-caption text-accent-warning">{t('requirements.touchedBadge')}</span> : null}
                {ticket(item.ticketId)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {shown.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-label text-foreground">{t('requirements.demonstratedTitle', { count: section.demonstratedList.length })}</h3>
          <ul className="mt-1 space-y-1" data-testid="packet-requirements-demonstrated">
            {shown.map((item) => (
              <li key={`${item.ticketId}:${item.id}`} className="text-xs">
                <span className="font-mono text-caption text-accent-success">{item.id}</span>
                {item.tests[0] ? <span className="ml-1.5 font-mono text-caption text-muted-foreground">{item.tests[0].file}{item.tests[0].line !== null ? `:${item.tests[0].line}` : ''}</span> : null}
                {ticket(item.ticketId)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {section.untaggedList.length > 0 ? (
        <p className="mt-3 text-caption text-muted-foreground" data-testid="packet-requirements-untagged">
          {t('requirements.untagged', { count: section.untaggedList.length, tags: section.untaggedList.slice(0, 3).map((item) => item.tag).join(', ') })}
        </p>
      ) : null}
      {hidden > 0 || expanded ? (
        <button type="button" className="mt-2 text-caption text-accent-primary hover:underline" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t('requirements.showLess') : t('requirements.showAll', { count: hidden })}
        </button>
      ) : null}
    </section>
  )
}
