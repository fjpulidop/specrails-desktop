/**
 * "Your local changes are saved as a stash" (proactive-local-integration):
 * shown on a delivery card while "Integrate locally" still holds the person's
 * uncommitted work in a git stash — either because re-applying it conflicted
 * (`needs_attention`, the mission agent restores it on its own branch) or
 * because it was not restored yet (`saved`). Offers "Restore my changes" and
 * the copyable stash name. Renders nothing once nothing is held.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Archive, Copy, Loader2, RotateCcw } from 'lucide-react'
import type { PrDeliveryLocalStash } from '../../../types'
import { localStashHeld } from '../lib/pr-delivery'

export interface LocalStashNoticeProps {
  stash: PrDeliveryLocalStash | null | undefined
  /** Re-attempt the apply; omitted ⇒ no Restore button (read-only surface). */
  onRestore?: () => void
  restoring?: boolean
  disabled?: boolean
  /** The delivery has a mission conversation whose agent was briefed. */
  agentBriefed?: boolean
}

export function LocalStashNotice({ stash, onRestore, restoring = false, disabled = false, agentBriefed = false }: LocalStashNoticeProps) {
  const { t } = useTranslation('agent')
  const [copied, setCopied] = useState(false)
  if (!localStashHeld(stash)) return null
  const conflict = stash.state === 'needs_attention'
  const copyName = async () => {
    const value = stash.name || stash.sha
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(t('prCard.localStash.copied'), { description: value })
    } catch {
      toast.info(value)
    }
  }
  return (
    <div
      className="mt-2 rounded-md border border-accent-warning/35 bg-accent-warning/10 px-2 py-1.5 text-label"
      data-testid="local-stash-notice"
      data-state={stash.state}
      data-agent-interactive
    >
      <p className="flex items-center gap-1.5 font-medium text-accent-warning">
        <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {t('prCard.localStash.title')}
      </p>
      <p className="mt-1 leading-4 text-foreground/75">
        {conflict && agentBriefed && stash.restoreBranch
          ? t('prCard.localStash.conflictBody', { branch: stash.branch, restoreBranch: stash.restoreBranch })
          : t('prCard.localStash.savedBody', { branch: stash.branch })}
      </p>
      {conflict && stash.conflictPaths.length > 0 && (
        <div className="mt-1">
          <p className="text-caption text-muted-foreground">{t('prCard.localStash.files')}</p>
          <ul className="mt-0.5 space-y-0.5 font-mono text-caption text-foreground/70" data-testid="local-stash-files">
            {stash.conflictPaths.map((file) => <li key={file} className="break-all">{file}</li>)}
          </ul>
        </div>
      )}
      <code className="mt-1.5 block break-all rounded bg-background/60 px-1.5 py-0.5 font-mono text-caption text-foreground/80" data-testid="local-stash-name">
        {stash.name || stash.sha}
      </code>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {onRestore && (
          <button
            type="button"
            onClick={onRestore}
            disabled={disabled || restoring}
            data-testid="local-stash-restore"
            className="inline-flex items-center gap-1.5 rounded-md border border-accent-warning/45 bg-accent-warning/15 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent-warning/25 disabled:cursor-default disabled:opacity-60"
          >
            {restoring ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RotateCcw className="h-3 w-3" aria-hidden />}
            {restoring ? t('prCard.localStash.restoring') : t('prCard.localStash.restore')}
          </button>
        )}
        <button
          type="button"
          onClick={() => void copyName()}
          data-testid="local-stash-copy"
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs text-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <Copy className="h-3 w-3" aria-hidden />
          {copied ? t('prCard.localStash.copied') : t('prCard.localStash.copy')}
        </button>
      </div>
    </div>
  )
}
