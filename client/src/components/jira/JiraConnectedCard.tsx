import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { jiraApi, type ConnectionState, type JiraStatusOption, type OutboxOp, type SpecLogicalState } from '../../lib/jira-api'

const STATE_KEYS: SpecLogicalState[] = ['todo', 'in_progress', 'on_review', 'done', 'cancelled']
const STATE_LABEL: Record<SpecLogicalState, string> = {
  todo: 'todo',
  in_progress: 'inProgress',
  on_review: 'onReview',
  done: 'done',
  cancelled: 'cancelled',
}

/**
 * Connected-state management for a project's Jira board: status header, the
 * hot-swap enable toggle, Sync now, the dead-letter list with retry, and
 * disconnect. Shared by the Integrations Jira card (and previously the Settings
 * section). `state.connection` must be present.
 */
export function JiraConnectedCard({ state, onChanged }: { state: ConnectionState; onChanged: () => void }) {
  const { t } = useTranslation('jira')
  const connection = state.connection!
  const [enabled, setEnabled] = useState(connection.enabled)
  const [syncing, setSyncing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deadOps, setDeadOps] = useState<OutboxOp[]>([])
  const [statuses, setStatuses] = useState<JiraStatusOption[]>([])
  const [discardStatus, setDiscardStatus] = useState(connection.discardStatus ?? '')
  const [statusMap, setStatusMap] = useState<Partial<Record<SpecLogicalState, string>>>(connection.statusMap ?? {})
  const counts = state.outbox ?? { pending: 0, inflight: 0, done: 0, dead: 0 }

  const loadDead = useCallback(async () => {
    try {
      const { ops } = await jiraApi.listOutbox('dead')
      setDeadOps(ops)
    } catch {
      setDeadOps([])
    }
  }, [])

  useEffect(() => {
    void loadDead()
  }, [loadDead])

  // Load the board's statuses for the discard "move-to" picker (best-effort).
  useEffect(() => {
    let cancelled = false
    jiraApi
      .listStatuses()
      .then(({ statuses: list }) => { if (!cancelled) setStatuses(list) })
      .catch(() => { if (!cancelled) setStatuses([]) })
    return () => { cancelled = true }
  }, [])

  async function changeDiscardStatus(next: string) {
    const prev = discardStatus
    setDiscardStatus(next)
    try {
      await jiraApi.patchConnection({ discardStatus: next || null })
      onChanged()
    } catch (e) {
      setDiscardStatus(prev)
      toast.error(errMsg(e, t))
    }
  }

  async function changeStatusMap(state: SpecLogicalState, value: string) {
    const prev = statusMap
    const next = { ...statusMap, [state]: value || undefined }
    setStatusMap(next)
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Partial<Record<SpecLogicalState, string>>
    try {
      await jiraApi.patchConnection({ statusMap: Object.keys(clean).length ? clean : null })
      onChanged()
    } catch (e) {
      setStatusMap(prev)
      toast.error(errMsg(e, t))
    }
  }

  async function toggle() {
    const next = !enabled
    setEnabled(next)
    setBusy(true)
    try {
      await jiraApi.setEnabled(next)
    } catch (e) {
      setEnabled(!next)
      toast.error(errMsg(e, t))
    } finally {
      setBusy(false)
    }
  }

  async function syncNow() {
    setSyncing(true)
    try {
      const r = await jiraApi.syncNow()
      toast.success(t('status.syncedToast', { count: r.upserted }))
    } catch (e) {
      toast.error(errMsg(e, t))
    } finally {
      setSyncing(false)
    }
  }

  async function disconnect() {
    if (!window.confirm(t('status.disconnectConfirm'))) return
    setBusy(true)
    try {
      await jiraApi.disconnect()
      toast.success(t('status.disconnectedToast'))
      onChanged()
    } catch (e) {
      toast.error(errMsg(e, t))
    } finally {
      setBusy(false)
    }
  }

  async function retry(id: number) {
    try {
      await jiraApi.retryOutbox(id)
      await loadDead()
    } catch (e) {
      toast.error(errMsg(e, t))
    }
  }

  const pending = counts.pending + counts.inflight

  return (
    <div className="space-y-4" data-testid="jira-connected">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">{t('status.connected', { key: connection.jiraProjectKey })}</p>
          <p className="text-xs text-muted-foreground">
            {connection.baseUrl} · {connection.deployment === 'cloud' ? t('review.cloud') : t('review.dc')}
          </p>
        </div>
        <a href={`${connection.baseUrl}/browse/${connection.jiraProjectKey}`} target="_blank" rel="noreferrer" className="text-xs text-accent-primary hover:underline">
          {t('badge.openInJira')}
        </a>
      </div>

      <div className="flex items-center justify-between rounded-md border border-border p-3">
        <div>
          <p className="text-sm font-medium">{t('status.enabledLabel')}</p>
          <p className="text-xs text-muted-foreground">{enabled ? t('status.enabledHelp') : t('status.pausedHelp')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t('status.enabledLabel')}
          disabled={busy}
          onClick={toggle}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${enabled ? 'bg-accent-success' : 'bg-input'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
      </div>

      <div className="rounded-md border border-border p-3" data-testid="jira-status-map">
        <p className="text-sm font-medium">{t('wizard.step3Title')}</p>
        <p className="mt-0.5 mb-2 text-xs text-muted-foreground">{t('mapping.intro')}</p>
        <div className="space-y-2">
          {STATE_KEYS.map((s) => (
            <label key={s} className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{t(`mapping.${STATE_LABEL[s]}`)}</span>
              <select
                value={statusMap[s] ?? ''}
                onChange={(e) => void changeStatusMap(s, e.target.value)}
                className="w-44 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                data-testid={`jira-statusmap-${s}`}
              >
                <option value="">{t('mapping.auto')}</option>
                {statuses.map((st) => (
                  <option key={st.id} value={st.name}>{st.name}</option>
                ))}
                {statusMap[s] && !statuses.some((st) => st.name === statusMap[s]) && (
                  <option value={statusMap[s]}>{statusMap[s]}</option>
                )}
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-border p-3">
        <p className="text-sm font-medium">{t('discard.configLabel')}</p>
        <p className="mt-0.5 mb-2 text-xs text-muted-foreground">{t('discard.configHelp')}</p>
        <select
          value={discardStatus}
          onChange={(e) => void changeDiscardStatus(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          data-testid="jira-discard-status-select"
        >
          <option value="">{t('discard.configNone')}</option>
          {statuses.map((st) => (
            <option key={st.id} value={st.name}>{st.name}</option>
          ))}
          {discardStatus && !statuses.some((s) => s.name === discardStatus) && (
            <option value={discardStatus}>{discardStatus}</option>
          )}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing}>
          {syncing ? t('status.syncing') : t('status.syncNow')}
        </Button>
        <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy} className="text-destructive">
          {t('status.disconnect')}
        </Button>
      </div>

      <div className="rounded-md border border-border p-3" data-testid="jira-outbox">
        <p className="text-sm font-medium">{t('outbox.title')}</p>
        {counts.dead > 0 ? (
          <p className="mt-1 text-xs text-accent-warning">{t('outbox.dead', { count: counts.dead })}</p>
        ) : pending > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{t('outbox.pending', { count: pending })}</p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">{t('outbox.allSynced')}</p>
        )}
        {deadOps.length > 0 && (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-muted-foreground">{t('outbox.deadHelp')}</p>
            {deadOps.map((op) => (
              <div key={op.id} className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1">
                <span className="truncate text-xs">
                  {opLabel(op, t)} · {op.deadReason ?? op.lastError ?? ''}
                </span>
                <Button variant="outline" size="sm" onClick={() => retry(op.id)}>
                  {t('outbox.retry')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function opLabel(op: OutboxOp, t: (k: string) => string): string {
  if (op.opType === 'transition') return t('outbox.opTransition')
  if (op.opType === 'comment') return t('outbox.opComment')
  return t('outbox.opCreate')
}

function errMsg(e: unknown, t: (k: string) => string): string {
  return e instanceof Error ? e.message : t('errors.generic')
}
