import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ShieldAlert } from 'lucide-react'
import { blockerCommandLine, type LoopCompletion, type LoopHostBlocker } from './completion-model'

/** Premium blocked state: the host could not satisfy a precondition, so the run stopped before any correction round. */
function HostBlockerBlock({ blocker }: { blocker: LoopHostBlocker }) {
  const { t } = useTranslation('loops')
  const [copied, setCopied] = useState(false)
  const command = blockerCommandLine(blocker)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable — subtle, non-critical control
    }
  }
  return <div data-testid="loop-completion-blocker" className="rounded-md border border-accent-warning/40 bg-accent-warning/5 px-3 py-2.5 space-y-1.5">
    <p className="flex items-center gap-1.5 font-medium text-accent-warning">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t('core.hostBlocked')}</span>
      <span className="ml-auto rounded-full border border-accent-warning/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider">{t(`core.blockerKind.${blocker.kind}`, { defaultValue: blocker.kind })}</span>
    </p>
    {blocker.reason && <p className="text-foreground/80">{blocker.reason}</p>}
    {command && <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">{t('core.failingCommand')}</span>
        <button type="button" onClick={() => void copy()} aria-label={t('core.copyCommand')} title={t('core.copyCommand')} className="p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer">
          {copied ? <Check className="h-2.5 w-2.5 text-accent-success" /> : <Copy className="h-2.5 w-2.5" />}
        </button>
        {copied && <span className="text-[9px] text-accent-success">{t('core.copiedCommand')}</span>}
      </div>
      <pre className="mt-0.5 font-mono text-[10px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">{command}{blocker.cwd ? `  # ${t('core.inDirectory', { cwd: blocker.cwd })}` : ''}</pre>
    </div>}
    <p><span className="font-medium">{t('core.requiredAction')}:</span> {blocker.requiredAction}</p>
  </div>
}

export function LoopCompletionSummary({ result }: { result: LoopCompletion }) {
  const { t } = useTranslation('jobs')
  const {t: tl} = useTranslation('loops')
  const core = result.core
  const status = (value: string) => t(`completion.status.${value}`, { defaultValue: value })
  return <section aria-label={t('completion.title')} className="border-b border-border/40 px-4 py-3 text-xs space-y-2" data-testid="loop-completion">
    <p className="font-medium">{t('completion.execution')}: {status(result.execution)}</p>
    {result.completion ? <div className="space-y-1">
      <p className={result.completion.ok ? 'text-accent-success' : 'text-accent-warning'}>{tl('core.acceptance')}: {status(result.completion.ok ? 'complete' : 'blocked')}</p>
      <p>{tl('core.verified')}: {status(result.completion.verified ? 'verified' : 'unverified')}</p>
      {result.completion.blocker ? <HostBlockerBlock blocker={result.completion.blocker} /> : result.completion.reasons.map((reason,index) => <p key={index} className="text-foreground/70">{reason}</p>)}
    </div> : core ? <>
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {(['implementation', 'validation', 'archive', 'delivery'] as const).map(key => <div key={key}>
          <dt className="text-foreground/70">{t(`completion.${key}`)}</dt>
          <dd className={core.completion[key] === 'with-exceptions' || core.completion[key] === 'blocked' ? 'text-accent-warning font-medium' : 'font-medium'}>{status(core.completion[key])}</dd>
        </div>)}
      </dl>
      <details>
        <summary className="cursor-pointer">{t('completion.evidence')}</summary>
        <div className="space-y-2 pt-2 break-words">
          <p className="text-foreground/70">{t('completion.snapshot', { change: core.change, at: core.recordedAt })}</p>
          {core.completion.reasons.map((reason, i) => <p key={`reason-${i}`}>{reason}</p>)}
          {core.exceptions.map((exception, i) => <div key={`exception-${i}`}>
            <p className="font-medium">{exception.requirement}</p>
            <p>{exception.reason} — {exception.impact}</p>
            <p>{t('completion.acceptedBy', { by: exception.acceptedBy })}: {exception.approvalEvidence}</p>
          </div>)}
          {core.checks.map((check, i) => <div key={`check-${i}`}>
            <p className="font-medium">{check.name}: {status(check.status)} ({t(check.required ? 'completion.required' : 'completion.supplementary')})</p>
            <p>{check.scope} — {check.limitations}</p>
            <p className="text-foreground/70">{check.evidence.join('; ')}</p>
          </div>)}
          {core.findings.map((finding, i) => <p key={`finding-${i}`}>{finding}</p>)}
          {core.phases.map(phase => <p key={phase.name}>{phase.name}: {status(phase.status)} · {phase.durationMs == null ? t('completion.unavailable') : `${(phase.durationMs / 1000).toFixed(1)}s`} · {phase.attempts == null ? t('completion.unavailable') : t('completion.attempts', { count: phase.attempts })}</p>)}
          <p className="text-foreground/70">{t('completion.phaseCostUnavailable')}</p>
        </div>
      </details>
    </> : <p className="text-foreground/70">{t('completion.noCoreEvidence')}</p>}
  </section>
}
