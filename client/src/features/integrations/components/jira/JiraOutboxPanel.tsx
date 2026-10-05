import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '../../../../components/ui/button'
import { SharedWebSocketContext } from '../../../../hooks/useSharedWebSocket'
import { jiraApi, type OutboxCounts, type OutboxOp } from '../../lib/jira-api'

interface Props {
  projectId: string
  baseUrl: string
  apiBase?: string
  initialCounts?: OutboxCounts
  refreshToken: number
}

const EMPTY_COUNTS: OutboxCounts = { pending: 0, inflight: 0, done: 0, dead: 0 }

/** Mounted per connection by JiraConnectedCard; snapshots never cross projects. */
export function JiraOutboxPanel({ projectId, baseUrl, apiBase, initialCounts, refreshToken }: Props) {
  const { t } = useTranslation('jira')
  const [snapshot, setSnapshot] = useState<{ ops: OutboxOp[]; counts: OutboxCounts } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [retrying, setRetrying] = useState<Set<number>>(() => new Set())
  const alive = useRef(true)
  const revision = useRef(0)
  const ws = useContext(SharedWebSocketContext)
  const handlerId = useId()

  const loadDead = useCallback(async () => {
    if (!alive.current) return
    const request = ++revision.current
    try {
      const result = apiBase ? await jiraApi.listOutbox('dead', apiBase) : await jiraApi.listOutbox('dead')
      if (!alive.current || request !== revision.current) return
      setSnapshot({ ...result, ops: result.ops.filter((op) => op.state === 'dead') })
      setLoadFailed(false)
    } catch {
      if (alive.current && request === revision.current) setLoadFailed(true)
    }
  }, [apiBase])

  useEffect(() => {
    alive.current = true
    void loadDead()
    return () => { alive.current = false; revision.current++ }
  }, [loadDead, refreshToken, initialCounts?.dead, initialCounts?.pending, initialCounts?.inflight, initialCounts?.done, initialCounts?.superseded])

  useEffect(() => {
    if (!ws) return
    ws.registerHandler(handlerId, (message) => {
      if (!message || typeof message !== 'object') return
      const event = message as { type?: unknown; projectId?: unknown }
      if (event.type === 'jira.outbox_changed' && event.projectId === projectId) void loadDead()
    })
    return () => ws.unregisterHandler(handlerId)
  }, [ws, handlerId, projectId, loadDead])

  async function retry(id: number) {
    if (retrying.has(id)) return
    setRetrying((previous) => new Set(previous).add(id))
    try {
      if (apiBase) await jiraApi.retryOutbox(id, apiBase)
      else await jiraApi.retryOutbox(id)
      if (alive.current) await loadDead()
    } catch (error) {
      if (alive.current) toast.error(error instanceof Error ? error.message : t('errors.generic'))
    } finally {
      if (alive.current) setRetrying((previous) => { const next = new Set(previous); next.delete(id); return next })
    }
  }

  const counts = snapshot?.counts ?? initialCounts ?? EMPTY_COUNTS
  const pending = counts.pending + counts.inflight
  return (
    <div className="rounded-md border border-border p-3" data-testid="jira-outbox">
      <p className="text-sm font-medium">{t('outbox.title')}</p>
      <p className={`mt-1 text-xs ${counts.dead > 0 ? 'text-accent-warning' : 'text-muted-foreground'}`}>
        {counts.dead > 0 ? t('outbox.dead', { count: counts.dead }) : pending > 0 ? t('outbox.pending', { count: pending }) : t(counts.superseded ? 'outbox.nonePending' : 'outbox.allSynced')}
      </p>
      {loadFailed && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p role="alert" className="text-xs text-accent-warning">{t('outbox.loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void loadDead()}>{t('outbox.retry')}</Button>
        </div>
      )}
      {!!snapshot?.ops.length && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">{t('outbox.deadHelp')}</p>
          {snapshot.ops.map((op) => {
            const target = op.targetStatus || (op.logicalState ? t(`mapping.${stateLabel(op.logicalState)}`) : null)
            const reason = op.deadReason ?? op.lastError ?? ''
            return (
              <div key={op.id} className="flex items-start justify-between gap-2 rounded border border-border/60 px-2 py-2">
                <div className="min-w-0 space-y-1 text-xs">
                  <p className="break-words">
                    {op.jiraKey ? (
                      <a href={`${baseUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(op.jiraKey)}`} target="_blank" rel="noreferrer" className="font-medium text-accent-primary hover:underline">{op.jiraKey}</a>
                    ) : <span className="font-medium">{t('outbox.issueFallback', { id: op.jiraIssueId })}</span>}
                    {' · '}{t(op.opType === 'transition' ? 'outbox.opTransition' : op.opType === 'comment' ? 'outbox.opComment' : op.opType === 'update' ? 'outbox.opUpdate' : 'outbox.opCreate')}
                  </p>
                  {target && <p className="break-words text-muted-foreground">{t('outbox.target', { status: target })}</p>}
                  <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">{reason}</p>
                </div>
                <Button className="shrink-0" variant="outline" size="sm" disabled={retrying.has(op.id)} onClick={() => void retry(op.id)}>
                  {t(retrying.has(op.id) ? 'outbox.retrying' : 'outbox.retry')}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function stateLabel(state: string): string {
  return state === 'in_progress' ? 'inProgress' : state === 'on_review' ? 'onReview' : state
}
