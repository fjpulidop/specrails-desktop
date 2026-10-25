import { useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, ClipboardCheck, Inbox, MessageCircleQuestion, OctagonAlert, RefreshCw, Wallet, XCircle, type LucideIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { EmptyState } from '../../../components/ui/empty-state'
import { RailTrack } from '../../../components/brand/RailTrack'
import { compactRelativeTime } from '../../../lib/relative-time'
import { cn } from '../../../lib/utils'
import { useInbox, type InboxValue } from '../context/InboxContext'
import type { InboxItem, InboxKind } from '../lib/inbox-model'
import { useDiagnosisText } from '../../recovery/components/FailureDiagnosisCard'

/** Kind → icon and lamp colour (the same tokens the review lamp, failures and warnings use elsewhere). */
const KIND_LOOK: Record<InboxKind, { icon: LucideIcon; tone: string }> = {
  review: { icon: ClipboardCheck, tone: 'text-accent-review' },
  question: { icon: MessageCircleQuestion, tone: 'text-accent-primary' },
  failed: { icon: XCircle, tone: 'text-destructive' },
  blocked: { icon: OctagonAlert, tone: 'text-accent-warning' },
  budget: { icon: Wallet, tone: 'text-accent-warning' },
  jira: { icon: RefreshCw, tone: 'text-accent-warning' },
}

/** i18n key (inbox namespace) of the primary action's label. */
export function primaryLabelKey(item: Pick<InboxItem, 'kind' | 'action'>): string {
  if (item.action === 'raise-cap') return 'actions.raiseCap'
  if (item.action === 'resume-run') return 'actions.resume'
  if (item.action === 'retry-jira') return 'actions.retry'
  if (item.kind === 'question') return 'actions.answer'
  if (item.kind === 'review') return 'actions.openReview'
  return 'actions.open'
}

function InboxRow({ item, inbox }: { item: InboxItem; inbox: InboxValue }) {
  const { t } = useTranslation('inbox')
  const [snoozing, setSnoozing] = useState(false)
  const look = KIND_LOOK[item.kind]
  const Icon = look.icon
  const working = inbox.busy.has(item.id)
  const age = compactRelativeTime(item.at)
  const kindLabel = item.action === 'raise-cap' ? t('kinds.capReached') : t(`kinds.${item.kind}`)
  // A failed or blocked run says WHY in plain words (the same sentence as its diagnosis card); an unknown cause keeps the raw outcome.
  const diagnosis = useDiagnosisText(item.diagnosis ?? { kind: 'unknown', confidence: 'low', phase: null, rounds: null, resetAt: null, detail: null, resumablePhase: null, blocker: null, source: 'desktop', remedies: [] })
  const cause = item.diagnosis && item.diagnosis.kind !== 'unknown' ? diagnosis.headline : null
  // A failure with no known cause says so in the app's language; the raw outcome (often English) stays on hover.
  const rawNoCause = !cause && item.kind === 'failed'
  // A reached cap is worded here, in the app's language, from the structured cap.
  const cap = item.cap
  const title = cap ? t(`cap.title.${cap.scope}.${cap.period}`) : item.title
  const detailText = cap ? t('cap.detail', { spent: cap.spentUsd.toFixed(2), budget: cap.budgetUsd.toFixed(2) }) : cause ?? (rawNoCause ? t('kinds.failedNoCause') : item.detail)
  return (
    <li className="flex flex-col gap-2 rounded-card border border-border/50 bg-card/40 px-3 py-2.5" data-testid="inbox-row" data-kind={item.kind} data-item-id={item.id} data-cause={item.diagnosis?.kind}>
      <div className="flex items-start gap-2.5">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', look.tone)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body text-foreground" title={title}>{title}</p>
          <p className="truncate text-caption text-muted-foreground">
            <span className={look.tone}>{kindLabel}</span>
            {detailText && <span title={rawNoCause && item.detail ? item.detail : undefined}>{` · ${detailText}`}</span>}
            {age ? ` · ${age === 'now' ? t('age.now') : t('age.ago', { age })}` : ''}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-[1.625rem]">
        <Button
          size="sm"
          variant="outline"
          className="focus-visible:border-primary focus-visible:bg-primary focus-visible:text-primary-foreground"
          disabled={working}
          data-inbox-primary=""
          data-testid="inbox-primary"
          aria-label={t('rowLabel', { action: t(primaryLabelKey(item)), title })}
          onClick={() => { void inbox.runPrimary(item) }}
        >
          {working ? t('working') : t(primaryLabelKey(item))}
        </Button>
        {snoozing ? (
          <div className="flex items-center gap-1" role="group" aria-label={t('snoozeFor', { title })}>
            <Button size="sm" variant="outline" data-testid="inbox-snooze-hour" onClick={() => inbox.snooze(item, 'hour')}>{t('snooze.hour')}</Button>
            <Button size="sm" variant="outline" data-testid="inbox-snooze-tomorrow" onClick={() => inbox.snooze(item, 'tomorrow')}>{t('snooze.tomorrow')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setSnoozing(false)}>{t('snooze.cancel')}</Button>
          </div>
        ) : (
          <>
            <Button size="sm" variant="ghost" data-testid="inbox-snooze" aria-label={t('snoozeItem', { title })} onClick={() => setSnoozing(true)}>{t('snooze.label')}</Button>
            <Button size="sm" variant="ghost" data-testid="inbox-done" aria-label={t('doneItem', { title })} onClick={() => inbox.done(item)}>{t('done')}</Button>
          </>
        )}
      </div>
    </li>
  )
}

/** The "Needs you" panel: items grouped by project, a primary action per row, Snooze and Done. */
export function InboxDialog() {
  const { t } = useTranslation('inbox')
  const inbox = useInbox()
  const listRef = useRef<HTMLDivElement>(null)
  if (!inbox) return null

  // Arrow keys walk the rows' primary buttons; Home/End jump to the ends.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const targets = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-inbox-primary]:not(:disabled)') ?? [])
    if (targets.length === 0) return
    const current = targets.findIndex((el) => el === document.activeElement || el.closest('li')?.contains(document.activeElement))
    let next = current
    if (event.key === 'ArrowDown') next = Math.min(targets.length - 1, current + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, current <= 0 ? 0 : current - 1)
    else if (event.key === 'Home') next = 0
    else next = targets.length - 1
    event.preventDefault()
    targets[next]?.focus()
  }

  // Done / Snooze remove the row under the person's finger: hand the focus to the next row (or the previous when it was the
  // last one) instead of dropping it on <body>.
  const keepFocus = (itemId: string): void => {
    const root = listRef.current
    if (!root) return
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="inbox-row"]'))
    const index = rows.findIndex((row) => row.dataset.itemId === itemId)
    const heir = rows[index + 1] ?? rows[index - 1]
    const heirId = heir?.dataset.itemId
    requestAnimationFrame(() => {
      const target = heirId
        ? Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-testid="inbox-row"]') ?? []).find((row) => row.dataset.itemId === heirId)?.querySelector<HTMLElement>('[data-inbox-primary]')
        : null
      if (target) target.focus()
      else listRef.current?.closest<HTMLElement>('[role="dialog"]')?.focus()
    })
  }
  const withFocus: InboxValue = {
    ...inbox,
    done: (item) => { keepFocus(item.id); inbox.done(item) },
    snooze: (item, choice) => { keepFocus(item.id); inbox.snooze(item, choice) },
  }

  const empty = inbox.items.length === 0
  return (
    <Dialog open={inbox.isOpen} onOpenChange={(open) => { if (!open) inbox.closeInbox() }}>
      <DialogContent
        size="form"
        data-testid="inbox-dialog"
        onOpenAutoFocus={(event) => {
          // Land on the first thing to act on, not on the close button.
          const first = listRef.current?.querySelector<HTMLElement>('[data-inbox-primary]:not(:disabled)')
          if (first) { event.preventDefault(); first.focus() }
        }}
      >
        <DialogHeader icon={<Inbox />}>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{empty ? t('subtitleEmpty') : t('subtitle', { count: inbox.count })}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div ref={listRef} onKeyDown={onKeyDown} className="flex flex-col gap-4">
            {empty && inbox.status === 'loading' && (
              <div className="space-y-2" data-testid="inbox-loading">
                <RailTrack running aria-label={t('loading')} />
                <p className="text-body text-muted-foreground">{t('loading')}</p>
              </div>
            )}
            {empty && inbox.status === 'error' && (
              <EmptyState
                icon={<OctagonAlert className="h-4 w-4" />}
                title={t('error.title')}
                description={t('error.description')}
                action={<Button size="sm" variant="outline" onClick={() => { void inbox.refresh() }}>{t('error.retry')}</Button>}
                data-testid="inbox-error"
              />
            )}
            {empty && inbox.status === 'ready' && (
              <EmptyState icon={<CircleCheck className="h-4 w-4" />} title={t('empty.title')} description={t('empty.description')} learnMore="inbox" data-testid="inbox-empty" />
            )}
            {inbox.groups.map((group) => (
              <section key={group.projectId} aria-labelledby={`inbox-group-${group.projectId}`} data-testid="inbox-group" data-project-id={group.projectId}>
                <h3 id={`inbox-group-${group.projectId}`} className="mb-1.5 flex items-center justify-between text-label text-muted-foreground">
                  <span className="truncate">{group.projectName}</span>
                  <span className="shrink-0 pl-2 tabular-nums">{group.items.length}</span>
                </h3>
                <ul role="list" className="flex flex-col gap-1.5">
                  {group.items.map((item) => <InboxRow key={item.id} item={item} inbox={withFocus} />)}
                </ul>
              </section>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
