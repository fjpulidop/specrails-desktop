import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { repositoryApiBase } from '../../projects/lib/project-repositories'
import type { RuntimeRun } from '../lib/agent-runtime'

/** Key the draft and its retry identity to the project and frozen execution. */
export function RuntimeSteering(props: { projectId: string; run: RuntimeRun; onAccepted(): void }) {
  if (props.run.engineVersion !== 2 || !props.run.steering) return null
  return <SteeringInbox key={`${props.projectId}:${props.run.runId}`} {...props} />
}

function SteeringInbox({ projectId, run, onAccepted }: { projectId: string; run: RuntimeRun; onAccepted(): void }) {
  const { t } = useTranslation('agentRuntime')
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [accepted, setAccepted] = useState<{ id: string; acceptedAt: string } | null>(null)
  const pending = useRef<{ text: string; requestId: string } | null>(null)
  const mounted = useRef(true), inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const steering = run.steering!
  const terminal = run.completion != null || ['succeeded', 'cancelled'].includes(run.status)
  const send = async () => {
    if (inFlight.current || terminal || !draft.trim()) return
    inFlight.current = true; setBusy(true); setError('')
    // A lost HTTP response must not enqueue the same instructions twice.
    if (!pending.current || pending.current.text !== draft) pending.current = { text: draft, requestId: crypto.randomUUID() }
    const request = pending.current
    try {
      const response = await fetch(`${repositoryApiBase(projectId)}/agent-runtime/runs/${encodeURIComponent(run.runId)}/steer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      })
      const data = await response.json() as { id?: string; acceptedAt?: string; message?: string }
      if (!response.ok) throw new Error(data.message ?? t('steering.failed'))
      if (data.id !== request.requestId || typeof data.acceptedAt !== 'string' || !Number.isFinite(Date.parse(data.acceptedAt))) throw new Error(t('steering.failed'))
      if (mounted.current) {
        setAccepted({ id: data.id, acceptedAt: data.acceptedAt }); setDraft(''); pending.current = null
        onAccepted()
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : t('steering.failed')) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  return <section className="space-y-2 rounded-md border border-border p-3" aria-label={t('steering.title')}>
    <h4 className="text-xs font-medium">{t('steering.title')}</h4>
    <p className="text-xs text-muted-foreground">{t('steering.hint')}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {accepted && !steering.receipts.some(receipt => receipt.id === accepted.id) && <p role="status" className="text-xs">{t('steering.accepted')} <code>{accepted.id}</code></p>}
    {steering.receiptsUnavailable && <p className="text-xs text-muted-foreground">{t('steering.unavailable')}</p>}
    <p className="text-xs">{t('steering.counts', { pending: steering.pending, consumed: steering.consumed })}</p>
    {!steering.consumptionReported && <p className="text-xs text-muted-foreground">{t('steering.unreported')}</p>}
    {steering.receipts.length > 0 && <ul className="max-h-48 space-y-2 overflow-auto text-xs">
      {steering.receipts.map(receipt => <li key={receipt.id} className="border-l border-border pl-2">
        <p className="whitespace-pre-wrap break-words">{receipt.preview}</p>
        <p className="text-muted-foreground">{t(receipt.status === 'consumed' && steering.consumptionReported ? 'steering.consumed' : 'steering.pending')} · <time dateTime={receipt.acceptedAt}>{new Date(receipt.acceptedAt).toLocaleString()}</time></p>
        {receipt.status === 'consumed' && steering.consumptionReported && receipt.consumedAttemptId && <code className="break-all">{receipt.consumedAttemptId}</code>}
      </li>)}
    </ul>}
    {steering.truncated && <p className="text-xs text-muted-foreground">{t('steering.truncated')}</p>}
    {!terminal && <>
      <label className="block space-y-1 text-xs">{t('steering.label')}
        <textarea className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1 text-sm" value={draft} maxLength={20000} disabled={busy} onChange={event => setDraft(event.target.value)} />
      </label>
      <Button size="sm" disabled={busy || !draft.trim()} onClick={() => void send()}>{t('steering.send')}</Button>
    </>}
  </section>
}
