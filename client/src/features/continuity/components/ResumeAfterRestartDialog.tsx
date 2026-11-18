import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { History } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { fetchResumeOffers, settleResumeOffers, type InterruptedRun, type ResumeOffer } from '../../../lib/continuity-api'
import { sendAgentMessage } from '../../missions/lib/agent-api'
import { useInbox } from '../../inbox/context/InboxContext'
import type { InboxItem } from '../../inbox/lib/inbox-model'
import { interruptedRunItems, resumeQueueId } from '../lib/continuity-model'

type RowKey = `mission:${string}` | `run:${string}`

/**
 * "Pick up where you left off": after a restart (quit, update or an
 * unexpected stop), lists the mission turns that were cut and the rail/loop
 * runs this restart paused. Nothing resumes until the person clicks Resume:
 * a mission continues its own provider session with a short continuation
 * message; a run uses its existing Resume action (the inbox's). "Not now"
 * dismisses the mission offers; paused runs stay in the Inbox.
 */
export function ResumeAfterRestartDialog() {
  const { t, i18n } = useTranslation('safety')
  const inbox = useInbox()
  const [offers, setOffers] = useState<ResumeOffer[] | null>(null)
  const [interrupted, setInterrupted] = useState<InterruptedRun[]>([])
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<RowKey>>(new Set())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [failed, setFailed] = useState<Set<RowKey>>(new Set())
  const [decided, setDecided] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetchResumeOffers(controller.signal)
      .then((result) => { setOffers(result.offers); setInterrupted(result.runs) })
      .catch(() => setOffers([]))
    return () => controller.abort()
  }, [])

  const runs: InboxItem[] = useMemo(
    () => (inbox && inbox.status === 'ready' ? interruptedRunItems(inbox.items, interrupted) : []),
    [inbox, interrupted],
  )

  // Open once per launch, as soon as both lists are known and one is not empty.
  useEffect(() => {
    if (decided || offers === null || (inbox && inbox.status === 'loading')) return
    if (offers.length === 0 && runs.length === 0) return
    setSelected(new Set<RowKey>([...offers.map((o) => `mission:${o.conversationId}` as RowKey), ...runs.map((r) => `run:${r.id}` as RowKey)]))
    setOpen(true)
    setDecided(true)
  }, [decided, offers, runs, inbox])

  const toggle = useCallback((key: RowKey, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const allKeys = useMemo(() => [...(offers ?? []).map((o) => `mission:${o.conversationId}` as RowKey), ...runs.map((r) => `run:${r.id}` as RowKey)], [offers, runs])
  const allSelected = allKeys.length > 0 && allKeys.every((key) => selected.has(key))
  const busy = progress !== null

  async function resumeSelected() {
    const missions = (offers ?? []).filter((o) => selected.has(`mission:${o.conversationId}`))
    const pickedRuns = runs.filter((r) => selected.has(`run:${r.id}`))
    const total = missions.length + pickedRuns.length
    if (total === 0) return
    const failures = new Set<RowKey>()
    let done = 0
    setProgress({ done, total })
    for (const offer of missions) {
      try {
        await sendAgentMessage(offer.conversationId, t(`resume.prompt.${offer.trigger}`), { queueId: resumeQueueId(offer) })
        await settleResumeOffers([offer.conversationId])
      } catch {
        failures.add(`mission:${offer.conversationId}`)
      }
      setProgress({ done: ++done, total })
    }
    for (const run of pickedRuns) {
      try {
        await inbox?.runPrimary(run)
      } catch {
        failures.add(`run:${run.id}`)
      }
      setProgress({ done: ++done, total })
    }
    setProgress(null)
    setFailed(failures)
    if (failures.size === 0) {
      // Offers the person left unticked are dismissed: they chose not to resume them.
      const skipped = (offers ?? []).filter((o) => !selected.has(`mission:${o.conversationId}`)).map((o) => o.conversationId)
      await settleResumeOffers(skipped, { runs: true }).catch(() => undefined)
      setOpen(false)
      toast.success(t('resume.resumed', { count: total }))
    }
  }

  async function notNow() {
    await settleResumeOffers((offers ?? []).map((o) => o.conversationId), { runs: true }).catch(() => undefined)
    setOpen(false)
  }

  const selectedCount = allKeys.filter((key) => selected.has(key)).length
  const time = (iso: string) => new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
  const triggers = new Set((offers ?? []).map((o) => o.trigger))
  const description = triggers.size === 1 ? t(`resume.description.${[...triggers][0]}`) : t('resume.description.mixed')

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) void notNow() }}>
      <DialogContent size="form">
        <DialogHeader icon={<History />}>
          <DialogTitle>{t('resume.title')}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-3">
            {allKeys.length > 1 && (
              <label className="flex items-center gap-2 text-label text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={busy}
                  onChange={(event) => setSelected(event.target.checked ? new Set(allKeys) : new Set())}
                />
                {t('resume.selectAll')}
              </label>
            )}
            {(offers ?? []).length > 0 && (
              <section aria-labelledby="resume-missions-heading" className="flex flex-col gap-1.5">
                <h3 id="resume-missions-heading" className="text-label font-medium text-muted-foreground">{t('resume.missions', { count: offers!.length })}</h3>
                {offers!.map((offer) => {
                  const key = `mission:${offer.conversationId}` as RowKey
                  return (
                    <label key={key} className="flex items-start gap-2 rounded-control px-2 py-1.5 hover:bg-muted/40">
                      <input type="checkbox" className="mt-0.5" checked={selected.has(key)} disabled={busy} onChange={(event) => toggle(key, event.target.checked)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body text-foreground">{offer.title ?? t('resume.untitled')}</span>
                        <span className="block text-caption text-muted-foreground">
                          {t(`resume.trigger.${offer.trigger}`)} · {t('resume.startedAt', { time: time(offer.startedAt) })}
                        </span>
                        {failed.has(key) && <span role="alert" className="block text-caption text-accent-warning">{t('resume.failed')}</span>}
                      </span>
                    </label>
                  )
                })}
              </section>
            )}
            {runs.length > 0 && (
              <section aria-labelledby="resume-runs-heading" className="flex flex-col gap-1.5">
                <h3 id="resume-runs-heading" className="text-label font-medium text-muted-foreground">{t('resume.runs', { count: runs.length })}</h3>
                {runs.map((run) => {
                  const key = `run:${run.id}` as RowKey
                  return (
                    <label key={key} className="flex items-start gap-2 rounded-control px-2 py-1.5 hover:bg-muted/40">
                      <input type="checkbox" className="mt-0.5" checked={selected.has(key)} disabled={busy} onChange={(event) => toggle(key, event.target.checked)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body text-foreground">{run.title}</span>
                        <span className="block text-caption text-muted-foreground">{run.projectName} · {t('resume.runPaused')}</span>
                        {failed.has(key) && <span role="alert" className="block text-caption text-accent-warning">{t('resume.failed')}</span>}
                      </span>
                    </label>
                  )
                })}
              </section>
            )}
            <p className="text-caption text-muted-foreground">{t('resume.nothingAutomatic')}</p>
          </div>
        </DialogBody>
        <DialogFooter start={progress ? <span className="text-caption text-muted-foreground" role="status">{t('resume.progress', { done: progress.done, total: progress.total })}</span> : undefined}>
          <Button variant="ghost" disabled={busy} onClick={() => void notNow()}>{t('resume.notNow')}</Button>
          <Button disabled={busy || selectedCount === 0} onClick={() => void resumeSelected()}>
            {t('resume.resume', { count: selectedCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
