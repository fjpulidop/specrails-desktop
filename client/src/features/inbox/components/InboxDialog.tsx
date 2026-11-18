import { useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, BellOff, CircleCheck, Inbox, OctagonAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { EmptyState } from '../../../components/ui/empty-state'
import { RailTrack } from '../../../components/brand/RailTrack'
import { compactRelativeTime } from '../../../lib/relative-time'
import { cn } from '../../../lib/utils'
import { useInbox, type InboxValue } from '../context/InboxContext'
import { primaryLabelKey, type InboxItem } from '../lib/inbox-model'
import { inboxKindRunState } from '../lib/inbox-run-state'
import { RunStateGlyph } from '../../../components/ui/run-state/run-state-glyph'
import { runStateLook } from '../../../components/ui/run-state/run-state'
import { useInboxItemText } from '../hooks/useInboxItemText'
import { useAttentionPrefs } from '../../../hooks/useAttentionPrefs'
import { notifyError } from '../../../lib/notify-error'

export { primaryLabelKey } from '../lib/inbox-model'

function InboxRow({ item, inbox }: { item: InboxItem; inbox: InboxValue }) {
  const { t } = useTranslation('inbox')
  const [snoozing, setSnoozing] = useState(false)
  const state = inboxKindRunState(item.kind)
  const working = inbox.busy.has(item.id)
  const age = compactRelativeTime(item.at)
  // A failed or blocked run says WHY in plain words; an unknown cause says so, the raw outcome (often English) stays on hover.
  const { title, kindLabel, detail: detailText, rawDetail } = useInboxItemText(item)
  const unseen = inbox.showsUnseen(item)
  return (
    <li className="flex flex-col gap-2 rounded-card border border-border/50 bg-card/40 px-3 py-2.5" data-testid="inbox-row" data-kind={item.kind} data-item-id={item.id} data-cause={item.diagnosis?.kind} data-unseen={unseen || undefined}>
      <div className="flex items-start gap-2.5">
        {/* The kind's state in the status vocabulary (its words are the kind label). */}
        <RunStateGlyph state={state} size="md" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-body text-foreground">
            {unseen && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-primary" data-testid="inbox-unseen-dot">
                <span className="sr-only">{t('unseen')}</span>
              </span>
            )}
            <span className="truncate" title={title}>{title}</span>
          </p>
          <p className="truncate text-caption text-muted-foreground">
            <span className={runStateLook(state).text}>{kindLabel}</span>
            {detailText && <span title={rawDetail ?? undefined}>{` · ${detailText}`}</span>}
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
            {unseen ? (
              <Button size="sm" variant="ghost" data-testid="inbox-mark-read" aria-label={t('markReadItem', { title })} onClick={() => inbox.markRead(item)}>{t('markRead')}</Button>
            ) : (
              <Button size="sm" variant="ghost" data-testid="inbox-mark-unread" aria-label={t('markUnreadItem', { title })} onClick={() => inbox.markUnread(item)}>{t('markUnread')}</Button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

/** The group header's bell: mute or unmute this project's notifications (its items stay listed). */
function ProjectMuteToggle({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t } = useTranslation('inbox')
  const { prefs, update } = useAttentionPrefs()
  const muted = prefs.mutedProjects.includes(projectId)
  const Icon = muted ? BellOff : Bell
  const label = muted ? t('mute.unmute', { project: projectName }) : t('mute.mute', { project: projectName })
  const toggle = (): void => {
    const mutedProjects = muted ? prefs.mutedProjects.filter((id) => id !== projectId) : [...prefs.mutedProjects, projectId]
    update({ mutedProjects }).then(
      () => toast(muted ? t('toast.unmuted', { project: projectName }) : t('toast.muted', { project: projectName })),
      () => notifyError(t('toast.muteFailed')),
    )
  }
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={muted}
      aria-label={label}
      title={label}
      data-testid="inbox-project-mute"
      className={cn(
        'grid h-5 w-5 place-items-center rounded focus-visible:outline focus-visible:outline-ring',
        muted ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  )
}

/** The "Needs you" panel: items grouped by project, a primary action per row, Snooze, Done and read state. */
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
          {inbox.stale && inbox.status === 'ready' && (
            <p role="status" className="text-caption text-muted-foreground" data-testid="inbox-stale">
              {t('stale')}{' '}
              <Button variant="link" size="sm" className="h-auto p-0 text-caption" onClick={() => { void inbox.refresh() }}>{t('error.retry')}</Button>
            </p>
          )}
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
                  <span className="flex shrink-0 items-center gap-1.5 pl-2">
                    <ProjectMuteToggle projectId={group.projectId} projectName={group.projectName} />
                    <span className="tabular-nums">{group.items.length}</span>
                  </span>
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
