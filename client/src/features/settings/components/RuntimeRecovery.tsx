import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import type { RuntimeRun } from '../lib/agent-runtime'

/** Each checkbox authorizes one physical attempt, not every visit of a node. */
export function RuntimeRecovery({ run, busy, onRecover }: { run: RuntimeRun; busy: boolean; onRecover(attempts: string[]): void }) {
  const { t } = useTranslation('agentRuntime')
  const [selected, setSelected] = useState<string[]>([])
  const available = run.recoverableSteps
  const admitted = selected.filter(id => available.includes(id))
  return <fieldset className="space-y-2 rounded-md border border-border p-2" disabled={busy}>
    <legend className="px-1 text-xs">{t('runs.selectRecovery')}</legend>
    {available.map(id => {
      const attempt = run.recoveryAttempts?.find(item => item.attemptId === id)
      return <label key={id} className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={admitted.includes(id)} onChange={event => setSelected(values => event.target.checked ? [...values.filter(value => value !== id), id] : values.filter(value => value !== id))} />
        <span className="break-all">{attempt ? `${attempt.nodePath} · ${attempt.scopeId} · ` : ''}{id}</span>
      </label>
    })}
    <Button size="sm" disabled={busy || !admitted.length} onClick={() => onRecover(admitted)}>{t('runs.recover')}</Button>
  </fieldset>
}
