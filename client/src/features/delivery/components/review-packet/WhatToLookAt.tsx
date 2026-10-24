/**
 * "What to look at": the AI reviewer's advisory risk brief (Core
 * `reviewBrief: 1`), rendered first in the review packet in a fixed order —
 * risks (high first), behaviour changes, invariants touched, untested paths,
 * human checks. It guides attention; it is never presented as a measurement.
 *
 * File references stay as plain monospace text: the packet links no files
 * elsewhere, and the Code explorer shows the base checkout rather than the
 * delivery branch, so a link could open a different version of the line.
 */
import { useTranslation } from 'react-i18next'
import { Compass } from 'lucide-react'
import type { PacketWhatToLookAt, ReviewRiskSeverity } from '../../../../types'

export const SEVERITY_TONE: Record<ReviewRiskSeverity, string> = {
  high: 'border-destructive/40 bg-destructive/10 text-destructive',
  medium: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning',
  low: 'border-border bg-background-deep/50 text-muted-foreground',
}

const INVARIANT_TONE: Record<'kept' | 'changed' | 'at-risk', string> = {
  kept: 'text-accent-success',
  changed: 'text-accent-info',
  'at-risk': 'text-accent-warning',
}

export function SeverityChip({ severity }: { severity: ReviewRiskSeverity }) {
  const { t } = useTranslation('packet')
  return (
    <span className={`shrink-0 rounded-full border px-1.5 py-px text-caption font-medium ${SEVERITY_TONE[severity]}`} data-testid="brief-severity">
      {t(`brief.severity.${severity}`)}
    </span>
  )
}

function Ref({ value }: { value: string | null }) {
  return value ? <code className="break-all rounded bg-background-deep/60 px-1 font-mono text-caption text-accent-info">{value}</code> : null
}

function TicketTag({ ticketId, show }: { ticketId: number; show: boolean }) {
  return show ? <span className="shrink-0 font-mono text-caption text-muted-foreground">#{ticketId}</span> : null
}

function Group({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId}>
      <h3 className="mb-1 text-xs font-medium text-foreground/80">{title}</h3>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  )
}

export function WhatToLookAt({ brief, multiTicket }: { brief: PacketWhatToLookAt; multiTicket: boolean }) {
  const { t } = useTranslation('packet')
  return (
    <section className="rounded-lg border border-accent-primary/30 bg-accent-primary/5 p-4" data-testid="packet-what-to-look-at" aria-labelledby="packet-what-to-look-at-title">
      <h2 id="packet-what-to-look-at-title" className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Compass className="size-4 text-accent-primary" aria-hidden />
        {t('brief.title')}
      </h2>
      <p className="mb-3 mt-0.5 text-caption text-muted-foreground">{t('brief.caveat')}</p>
      <div className="space-y-3 text-sm">
        {brief.risks.length > 0 ? (
          <Group title={t('brief.sections.risks')} testId="brief-risks">
            {brief.risks.map((risk, index) => (
              <li key={`risk-${index}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" data-testid="brief-risk">
                <SeverityChip severity={risk.severity} />
                {risk.area ? <span className="text-caption uppercase tracking-wide text-muted-foreground">{t(`brief.area.${risk.area}`, { defaultValue: risk.area })}</span> : null}
                <span className="min-w-0 flex-1 text-foreground">{risk.whatToLookAt}</span>
                <Ref value={risk.ref} />
                <TicketTag ticketId={risk.ticketId} show={multiTicket} />
              </li>
            ))}
          </Group>
        ) : null}
        {brief.behaviourChanges.length > 0 ? (
          <Group title={t('brief.sections.behaviourChanges')} testId="brief-behaviour">
            {brief.behaviourChanges.map((change, index) => (
              <li key={`behaviour-${index}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="min-w-0 flex-1 text-foreground">{change.what}</span>
                {change.userVisible ? (
                  <span className="rounded-full border border-accent-info/40 bg-accent-info/10 px-1.5 py-px text-caption text-accent-info">{t('brief.userVisible')}</span>
                ) : null}
                <Ref value={change.where} />
                <TicketTag ticketId={change.ticketId} show={multiTicket} />
              </li>
            ))}
          </Group>
        ) : null}
        {brief.invariantsTouched.length > 0 ? (
          <Group title={t('brief.sections.invariantsTouched')} testId="brief-invariants">
            {brief.invariantsTouched.map((entry, index) => (
              <li key={`invariant-${index}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                {entry.status ? <span className={`shrink-0 text-caption font-medium ${INVARIANT_TONE[entry.status]}`}>{t(`brief.invariantStatus.${entry.status}`)}</span> : null}
                <span className="min-w-0 flex-1 text-foreground">{entry.invariant}</span>
                <Ref value={entry.evidence} />
                <TicketTag ticketId={entry.ticketId} show={multiTicket} />
              </li>
            ))}
          </Group>
        ) : null}
        {brief.untested.length > 0 ? (
          <Group title={t('brief.sections.untested')} testId="brief-untested">
            {brief.untested.map((entry, index) => (
              <li key={`untested-${index}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <Ref value={entry.path} />
                {entry.why ? <span className="min-w-0 flex-1 text-muted-foreground">{entry.why}</span> : null}
                <TicketTag ticketId={entry.ticketId} show={multiTicket} />
              </li>
            ))}
          </Group>
        ) : null}
        {brief.humanChecks.length > 0 ? (
          <Group title={t('brief.sections.humanChecks')} testId="brief-human-checks">
            {brief.humanChecks.map((check, index) => (
              <li key={`check-${index}`} className="flex items-baseline gap-2">
                <span aria-hidden className="mt-0.5 inline-block size-3 shrink-0 rounded-sm border border-border" />
                <span className="min-w-0 flex-1 text-foreground">{check.text}</span>
                <TicketTag ticketId={check.ticketId} show={multiTicket} />
              </li>
            ))}
          </Group>
        ) : null}
        {brief.divergences.length > 0 ? (
          <Group title={t('brief.sections.divergences')} testId="brief-divergences">
            {brief.divergences.map((entry, index) => (
              <li key={`divergence-${index}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <code className="font-mono text-caption text-accent-info">{entry.requirement}</code>
                <span className="min-w-0 flex-1 text-foreground">{entry.observed}</span>
                <TicketTag ticketId={entry.ticketId} show={multiTicket} />
              </li>
            ))}
          </Group>
        ) : null}
        {brief.diagnostics.length > 0 ? (
          <div className="rounded-md border border-border/60 bg-background-deep/40 px-3 py-2 text-xs text-muted-foreground" data-testid="brief-diagnostic">
            <p>{t('brief.diagnostic')}</p>
            {brief.diagnostics.map((entry, index) => (
              <p key={`diagnostic-${index}`} className="mt-1 font-mono text-caption">
                {multiTicket ? `#${entry.ticketId} · ` : ''}{entry.message}
              </p>
            ))}
          </div>
        ) : null}
        {brief.droppedEntries > 0 ? (
          <p className="text-caption text-muted-foreground" data-testid="brief-dropped">{t('brief.dropped', { count: brief.droppedEntries })}</p>
        ) : null}
      </div>
    </section>
  )
}
