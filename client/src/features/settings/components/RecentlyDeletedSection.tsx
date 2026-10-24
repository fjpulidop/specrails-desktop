import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FileText, MessageSquare, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import { useDesktop } from '../../../hooks/useDesktop'
import { Button } from '../../../components/ui/button'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { EmptyState } from '../../../components/ui/empty-state'
import { toDate } from '../../../lib/relative-time'
import { listDeletedSpecs, purgeSpec, restoreSpec, type DeletedSpec } from '../../specs/lib/trash-api'
import {
  listDeletedAgentConversations,
  purgeAgentConversation,
  restoreAgentConversation,
  type DeletedAgentConversation,
} from '../../missions/lib/agent-api'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { SettingsCard } from './SettingsCard'

type Target =
  | { kind: 'spec'; id: number; title: string }
  | { kind: 'mission'; id: string; title: string }

/**
 * Project settings → "Recently deleted". Specs and missions removed with Undo
 * (or the delete action) stay here for the retention window, restorable, and
 * can be removed for good — the one step here that still asks first.
 */
export function RecentlyDeletedSection() {
  const { activeProjectId } = useDesktop()
  return activeProjectId ? <RecentlyDeleted key={activeProjectId} projectId={activeProjectId} /> : null
}

function RecentlyDeleted({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation('undo')
  const { refreshConversations } = useAgentChat()
  const [specs, setSpecs] = useState<DeletedSpec[]>([])
  const [missions, setMissions] = useState<DeletedAgentConversation[]>([])
  const [days, setDays] = useState(30)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<Target | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [s, m] = await Promise.all([listDeletedSpecs(projectId, signal), listDeletedAgentConversations(projectId, signal)])
      if (signal?.aborted || !alive.current) return
      setSpecs(Array.isArray(s?.items) ? s.items : [])
      setMissions(Array.isArray(m?.items) ? m.items : [])
      setDays(s?.retentionDays || m?.retentionDays || 30)
      setState('ready')
    } catch {
      if (signal?.aborted || !alive.current) return
      setState('error')
    }
  }, [projectId])

  useEffect(() => {
    const controller = new AbortController()
    setState('loading')
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const date = (iso: string | null | undefined): string => {
    const d = iso ? toDate(iso) : null
    return d ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(d) : ''
  }
  const missionTitle = (item: DeletedAgentConversation): string => item.conversation.title?.trim() || t('recent.untitled')

  async function restore(target: Target) {
    const key = `${target.kind}:${target.id}`
    setBusyKey(key)
    try {
      if (target.kind === 'spec') await restoreSpec(projectId, target.id)
      else {
        await restoreAgentConversation(target.id)
        await refreshConversations()
      }
      toast.success(t('recent.restored', { title: target.title }))
      await load()
    } catch {
      toast.error(t('recent.restoreFailed'))
    } finally {
      if (alive.current) setBusyKey(null)
    }
  }

  async function removeForGood(target: Target) {
    const key = `${target.kind}:${target.id}`
    setBusyKey(key)
    try {
      if (target.kind === 'spec') await purgeSpec(projectId, target.id)
      else await purgeAgentConversation(target.id)
      toast.success(t('recent.deletedForever'))
      setConfirming(null)
      await load()
    } catch {
      toast.error(t('recent.deleteFailed'))
    } finally {
      if (alive.current) setBusyKey(null)
    }
  }

  const empty = state === 'ready' && specs.length === 0 && missions.length === 0

  return (
    <SettingsCard
      title={t('recent.title')}
      description={t('recent.description', { days })}
      data-testid="recently-deleted"
    >
      {state === 'loading' && <div className="h-16 motion-safe:animate-pulse rounded-card bg-muted/30" aria-hidden />}
      {state === 'error' && (
        <EmptyState
          icon={<Undo2 className="h-4 w-4" />}
          title={t('recent.loadFailed')}
          action={<Button size="sm" variant="outline" onClick={() => { setState('loading'); void load() }}>{t('recent.retry')}</Button>}
          data-testid="recently-deleted-error"
        />
      )}
      {empty && (
        <EmptyState
          icon={<Trash2 className="h-4 w-4" />}
          title={t('recent.emptyTitle')}
          description={t('recent.emptyBody', { days })}
          learnMore="recentlyDeleted"
          data-testid="recently-deleted-empty"
        />
      )}
      {state === 'ready' && specs.length > 0 && (
        <section aria-label={t('recent.specs')} className="space-y-1.5">
          <h4 className="flex items-center gap-1.5 text-label text-muted-foreground">
            <FileText className="h-3.5 w-3.5" aria-hidden /> {t('recent.specs')}
          </h4>
          <ul className="space-y-1.5">
            {specs.map((item) => {
              const title = `#${item.ticket.id} ${item.ticket.title}`
              const target: Target = { kind: 'spec', id: item.ticket.id, title: item.ticket.title }
              return (
                <DeletedRow
                  key={`spec-${item.ticket.id}`}
                  testId={`deleted-spec-${item.ticket.id}`}
                  title={title}
                  meta={`${t('recent.deletedOn', { date: date(item.deletedAt) })} · ${t('recent.purgesOn', { date: date(item.purgeAt) })}`}
                  busy={busyKey === `spec:${item.ticket.id}`}
                  onRestore={() => void restore(target)}
                  onDelete={() => setConfirming(target)}
                />
              )
            })}
          </ul>
        </section>
      )}
      {state === 'ready' && missions.length > 0 && (
        <section aria-label={t('recent.missions')} className="space-y-1.5">
          <h4 className="flex items-center gap-1.5 text-label text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden /> {t('recent.missions')}
          </h4>
          <ul className="space-y-1.5">
            {missions.map((item) => {
              const title = missionTitle(item)
              const target: Target = { kind: 'mission', id: item.conversation.id, title }
              return (
                <DeletedRow
                  key={`mission-${item.conversation.id}`}
                  testId={`deleted-mission-${item.conversation.id}`}
                  title={title}
                  meta={`${t('recent.deletedOn', { date: date(item.deletedAt) })} · ${t('recent.purgesOn', { date: date(item.purgeAt) })}`}
                  busy={busyKey === `mission:${item.conversation.id}`}
                  onRestore={() => void restore(target)}
                  onDelete={() => setConfirming(target)}
                />
              )
            })}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => { if (!open && busyKey === null) setConfirming(null) }}
        title={t('recent.confirmTitle')}
        description={confirming ? t(confirming.kind === 'spec' ? 'recent.confirmSpec' : 'recent.confirmMission', { title: confirming.title }) : null}
        confirmLabel={t('recent.deleteForever')}
        busy={busyKey !== null}
        onConfirm={() => { if (confirming) return removeForGood(confirming) }}
        testId="recently-deleted-confirm"
      />
    </SettingsCard>
  )
}

function DeletedRow({ title, meta, busy, onRestore, onDelete, testId }: {
  title: string
  meta: string
  busy: boolean
  onRestore: () => void
  onDelete: () => void
  testId: string
}) {
  const { t } = useTranslation('undo')
  return (
    <li className="flex items-center gap-3 rounded-card border border-border/50 px-3 py-2" data-testid={testId}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-body text-foreground">{title}</p>
        <p className="truncate text-caption text-muted-foreground">{meta}</p>
      </div>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onRestore} data-testid={`${testId}-restore`}>
        <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
        {t('recent.restore')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={onDelete}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        data-testid={`${testId}-delete`}
      >
        <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
        {t('recent.deleteForever')}
      </Button>
    </li>
  )
}
