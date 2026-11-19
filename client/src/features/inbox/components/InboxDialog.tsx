import { useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AlarmClock, Bell, BellOff, Check, CircleCheck, Inbox, Mail, MailOpen, MoreHorizontal, OctagonAlert, Sunrise } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { EmptyState } from '../../../components/ui/empty-state'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/tooltip'
import { DIALOG_LAYER_CLASS } from '../../../lib/layers'
import { RailTrack } from '../../../components/brand/RailTrack'
import { compactRelativeTime } from '../../../lib/relative-time'
import { cn } from '../../../lib/utils'
import { useInbox, type InboxValue } from '../context/InboxContext'
import { primaryLabelKey, type InboxItem } from '../lib/inbox-model'
import { inboxItemRunState } from '../lib/inbox-run-state'
import { RunStateGlyph } from '../../../components/ui/run-state/run-state-glyph'
import { runStateLook } from '../../../components/ui/run-state/run-state'
import { useInboxItemText } from '../hooks/useInboxItemText'
import { useAttentionPrefs } from '../../../hooks/useAttentionPrefs'
import { notifyError } from '../../../lib/notify-error'
import { RunQuestionCard } from '../../../components/run-question/RunQuestionCard'

export { primaryLabelKey } from '../lib/inbox-model'

/** Mute or unmute a project's notifications (its items stay listed). */
function useProjectMute(projectId: string, projectName: string) {
  const { t } = useTranslation('inbox')
  const { prefs, update } = useAttentionPrefs()
  const muted = prefs.mutedProjects.includes(projectId)
  const label = muted ? t('mute.unmute', { project: projectName }) : t('mute.mute', { project: projectName })
  const toggle = (): void => {
    const mutedProjects = muted ? prefs.mutedProjects.filter((id) => id !== projectId) : [...prefs.mutedProjects, projectId]
    update({ mutedProjects }).then(
      () => toast(muted ? t('toast.unmuted', { project: projectName }) : t('toast.muted', { project: projectName })),
      () => notifyError(t('toast.muteFailed')),
    )
  }
  return { muted, label, toggle }
}

/**
 * One item: its state, title and why, ONE primary action, and a "More actions"
 * menu (Snooze 1 hour / until tomorrow, Done, Mark as read / unread, Mute the project).
 */
function InboxRow({ item, inbox }: { item: InboxItem; inbox: InboxValue }) {
  const { t } = useTranslation('inbox')
  const state = inboxItemRunState(item)
  const working = inbox.busy.has(item.id)
  const age = compactRelativeTime(item.at)
  // A failed or blocked run says WHY in plain words; an unknown cause says so, the raw outcome (often English) stays on hover.
  const { title, kindLabel, detail: detailText, rawDetail } = useInboxItemText(item)
  const unseen = inbox.showsUnseen(item)
  const mute = useProjectMute(item.projectId, item.projectName)
  const moreLabel = t('more', { title })
  return (
    <li className="flex items-start gap-2.5 rounded-card border border-border/50 bg-card/40 px-3 py-2.5" data-testid="inbox-row" data-kind={item.kind} data-item-id={item.id} data-cause={item.diagnosis?.kind} data-unseen={unseen || undefined}>
      {/* The kind's state in the status vocabulary (its words are the kind label). */}
      <RunStateGlyph state={state} size="md" className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="min-w-0">
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
            {detailText && !item.question && <span title={rawDetail ?? undefined}>{` · ${detailText}`}</span>}
            {age ? ` · ${age === 'now' ? t('age.now') : t('age.ago', { age })}` : ''}
          </p>
        </div>
        {item.kind === 'question' && item.question ? (
          // The question itself, answerable right here; the run stays one click away.
          <div className="space-y-1.5">
            <RunQuestionCard question={item.question} projectId={item.projectId} runId={item.subjectId} density="compact" />
            <Button size="sm" variant="ghost" className="h-7 px-2 text-caption text-muted-foreground" data-testid="inbox-open-run" onClick={() => { void inbox.runPrimary(item) }}>
              {t('actions.open')}
            </Button>
          </div>
        ) : (
        <div>
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
        </div>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={moreLabel}
          title={moreLabel}
          data-testid="inbox-more"
          className="-mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent className={DIALOG_LAYER_CLASS.stacked} aria-label={moreLabel}>
          <DropdownMenuItem data-testid="inbox-snooze-hour" onSelect={() => inbox.snooze(item, 'hour')}>
            <AlarmClock className="h-3.5 w-3.5" aria-hidden />{t('snooze.hour')}
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="inbox-snooze-tomorrow" onSelect={() => inbox.snooze(item, 'tomorrow')}>
            <Sunrise className="h-3.5 w-3.5" aria-hidden />{t('snooze.tomorrow')}
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="inbox-done" onSelect={() => inbox.done(item)}>
            <Check className="h-3.5 w-3.5" aria-hidden />{t('done')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {unseen ? (
            <DropdownMenuItem data-testid="inbox-mark-read" onSelect={() => inbox.markRead(item)}>
              <MailOpen className="h-3.5 w-3.5" aria-hidden />{t('markRead')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem data-testid="inbox-mark-unread" onSelect={() => inbox.markUnread(item)}>
              <Mail className="h-3.5 w-3.5" aria-hidden />{t('markUnread')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem data-testid="inbox-row-mute" onSelect={mute.toggle}>
            {mute.muted ? <Bell className="h-3.5 w-3.5" aria-hidden /> : <BellOff className="h-3.5 w-3.5" aria-hidden />}
            {mute.label}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

/** The group header's bell: mute or unmute this project's notifications (its items stay listed). */
function ProjectMuteToggle({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { muted, label, toggle } = useProjectMute(projectId, projectName)
  const Icon = muted ? BellOff : Bell
  return (
    <TooltipProvider delayDuration={300}>
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={muted}
          aria-label={label}
          data-testid="inbox-project-mute"
          className={cn(
            'grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            muted ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className={DIALOG_LAYER_CLASS.stacked}>{label}</TooltipContent>
    </Tooltip>
    </TooltipProvider>
  )
}

/** The "Needs you" panel: items grouped by project, one primary action per row, the rest behind "More actions". */
export function InboxDialog() {
  const { t } = useTranslation('inbox')
  const inbox = useInbox()
  const listRef = useRef<HTMLDivElement>(null)
  if (!inbox) return null

  // Arrow keys walk the rows' primary buttons; Home/End jump to the ends.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // An open "More actions" menu (or its trigger opening it) handles its own arrows.
    if (event.defaultPrevented || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
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
                  <span className="shrink-0 pl-2">
                    <ProjectMuteToggle projectId={group.projectId} projectName={group.projectName} />
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
