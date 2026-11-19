import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Download, X } from 'lucide-react'
import { API_ORIGIN } from '../../../lib/origin'
import { notifyError } from '../../../lib/notify-error'
import { Button } from '../../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card'
import { Skeleton } from '../../../components/ui/skeleton'

interface Approval { command: string; tool: string; approvedAt: string; uses: number }

/**
 * "Remembered installs" (app-wide): the machine-wide installs the person approved once for a run
 * (`GET /api/machine-installs`). Specrails runs the same exact command again without asking; Revoke
 * (`DELETE /api/machine-installs`) makes the next run that needs it ask again.
 */
export function MachineInstallsSection() {
  const { t, i18n } = useTranslation('settings')
  const [approvals, setApprovals] = useState<Approval[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetch(`${API_ORIGIN}/api/machine-installs`)
      .then((res) => (res.ok ? res.json() as Promise<{ approvals?: Approval[] }> : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => { if (!cancelled) setApprovals(Array.isArray(data.approvals) ? data.approvals : []) })
      .catch((err: Error) => { if (!cancelled) { setApprovals([]); notifyError(t('machineInstalls.loadFailed'), { detail: err.message, retry: () => setAttempt((value) => value + 1) }) } })
    return () => { cancelled = true }
  }, [t, attempt])
  async function revoke(command: string) {
    setBusy(command)
    try {
      const res = await fetch(`${API_ORIGIN}/api/machine-installs`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json() as { approvals?: Approval[] }
      setApprovals(body.approvals ?? [])
      toast.success(t('machineInstalls.revoked'))
    } catch (err) {
      notifyError(t('machineInstalls.revokeFailed'), { detail: (err as Error).message, retry: () => void revoke(command) })
    } finally {
      setBusy(null)
    }
  }
  if (approvals === null) return <Skeleton className="h-24 rounded-lg" data-testid="section-skeleton" />
  const date = (iso: string): string => {
    const at = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
    return Number.isNaN(at.getTime()) ? iso : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(at)
  }
  return (
    <Card data-testid="machine-installs-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-4 w-4 text-accent-primary" aria-hidden />
          {t('machineInstalls.title')}
        </CardTitle>
        <CardDescription>{t('machineInstalls.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {approvals.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="machine-installs-empty">{t('machineInstalls.empty')}</p>
        ) : (
          <ul className="divide-y divide-border/40 rounded-lg border border-border/40">
            {approvals.map((approval) => (
              <li key={approval.command} className="flex items-center justify-between gap-3 px-3 py-2" data-testid="machine-install-approval">
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate font-mono text-xs text-foreground" title={approval.command}>{approval.command}</p>
                  <p className="text-caption text-muted-foreground">
                    {t('machineInstalls.approvedAt', { date: date(approval.approvedAt) })}
                    {approval.uses > 0 ? ` · ${t('machineInstalls.uses', { count: approval.uses })}` : ''}
                  </p>
                </div>
                <Button type="button" size="sm" variant="outline" disabled={busy === approval.command} aria-busy={busy === approval.command || undefined}
                  aria-label={`${t('machineInstalls.revoke')}: ${approval.command}`} onClick={() => void revoke(approval.command)}>
                  <X className="mr-1 h-3 w-3" aria-hidden />
                  {t('machineInstalls.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
