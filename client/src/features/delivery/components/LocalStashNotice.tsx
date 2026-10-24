/**
 * "Your local changes are saved as a stash" (proactive-local-integration):
 * shown on a delivery card while "Integrate locally" still holds the person's
 * uncommitted work in a git stash, or while Specrails' own server-side
 * restoration of a conflicting stash needs them:
 *  - `saved`: not restored yet → "Restore my changes".
 *  - `needs_attention`: re-applying conflicted. Specrails restores it itself
 *    on `restoreBranch` in a separate worktree (never the read-only mission
 *    agent): `resolving` → `ready` (review the restored files, then "Bring
 *    them back to <branch>" or "Discard the restored branch") or `failed`.
 * The stash stays until the person brings the changes back. Renders nothing
 * once nothing is held or pending.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Archive, Copy, GitMerge, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import type { PrDeliveryLocalStash } from '../../../types'
import { localRestorePending, localStashHeld } from '../lib/pr-delivery'

export type LocalStashAction = 'restore' | 'bring-back' | 'discard-branch'

export interface LocalStashNoticeProps {
  stash: PrDeliveryLocalStash | null | undefined
  /** Re-attempt the apply; omitted ⇒ no Restore button (read-only surface). */
  onRestore?: () => void
  /** Fast-forward the target to the reviewed restore branch. */
  onBringBack?: () => void
  /** Remove the restore branch (the stash is kept). */
  onDiscardBranch?: () => void
  /** The action whose request is in flight. */
  pendingAction?: LocalStashAction | null
  disabled?: boolean
}

const actionClass = 'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-60'
const primaryClass = `${actionClass} border-accent-warning/45 bg-accent-warning/15 text-foreground hover:bg-accent-warning/25`
const quietClass = `${actionClass} border-border/60 text-foreground/70 hover:bg-muted/40 hover:text-foreground`

export function LocalStashNotice({ stash, onRestore, onBringBack, onDiscardBranch, pendingAction = null, disabled = false }: LocalStashNoticeProps) {
  const { t } = useTranslation('agent')
  const [copied, setCopied] = useState(false)
  const held = localStashHeld(stash)
  if (!stash || (!held && !localRestorePending(stash))) return null
  const restore = stash.restore && stash.restore.status !== 'discarded' && stash.restore.status !== 'brought_back' ? stash.restore : null
  const restoreBranch = restore?.branch ?? stash.restoreBranch ?? ''
  const conflict = stash.state === 'needs_attention'
  const busy = disabled || pendingAction !== null
  const spinner = <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />
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
  const vars = { branch: stash.branch, restoreBranch }
  const body = restore?.status === 'resolving'
    ? t('prCard.localStash.restoringBody', vars)
    : restore?.status === 'ready'
      ? t(restore.resolvedBy === 'resolver' ? 'prCard.localStash.readyBodyResolved' : 'prCard.localStash.readyBodyClean', vars)
      : restore?.status === 'failed'
        ? t('prCard.localStash.failedBody', vars)
        : conflict
          ? t('prCard.localStash.conflictBody', vars)
          : t('prCard.localStash.savedBody', vars)
  const conflictFiles = restore?.status === 'failed' && restore.conflictPaths.length > 0 ? restore.conflictPaths : stash.conflictPaths
  return (
    <div
      className="mt-2 rounded-md border border-accent-warning/35 bg-accent-warning/10 px-2 py-1.5 text-label"
      data-testid="local-stash-notice"
      data-state={stash.state}
      data-restore={restore?.status ?? 'none'}
      data-agent-interactive
    >
      <p className="flex items-center gap-1.5 font-medium text-accent-warning">
        {restore?.status === 'resolving'
          ? <Loader2 className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
          : <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        {t('prCard.localStash.title')}
      </p>
      <p className="mt-1 leading-4 text-foreground/75" data-testid="local-stash-body">{body}</p>
      {restore?.status === 'failed' && restore.detail && (
        <p className="mt-1 break-words text-caption text-muted-foreground" data-testid="local-restore-detail">{restore.detail}</p>
      )}
      {conflict && restore?.status !== 'ready' && conflictFiles.length > 0 && (
        <div className="mt-1">
          <p className="text-caption text-muted-foreground">{t('prCard.localStash.files')}</p>
          <ul className="mt-0.5 space-y-0.5 font-mono text-caption text-foreground/70" data-testid="local-stash-files">
            {conflictFiles.map((file) => <li key={file} className="break-all">{file}</li>)}
          </ul>
        </div>
      )}
      {restore?.status === 'ready' && restore.files.length > 0 && (
        <div className="mt-1">
          <p className="text-caption text-muted-foreground">{t('prCard.localStash.restoredFiles', vars)}</p>
          <ul className="mt-0.5 space-y-0.5 font-mono text-caption text-foreground/70" data-testid="local-restore-files">
            {restore.files.map((file) => (
              <li key={file.path} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 break-all">{file.path}</span>
                <span className="shrink-0 tabular-nums">
                  {file.added === null || file.removed === null
                    ? t('prCard.localStash.binary')
                    : <><span className="text-accent-success">+{file.added}</span> <span className="text-destructive">−{file.removed}</span></>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {restore && restore.managedPaths.length > 0 && (
        <p className="mt-1 text-caption text-muted-foreground" data-testid="local-restore-managed">
          {t('prCard.localStash.managedNote', { files: restore.managedPaths.slice(0, 3).join(', ') + (restore.managedPaths.length > 3 ? ' …' : '') })}
        </p>
      )}
      {held && (
        <code className="mt-1.5 block break-all rounded bg-background/60 px-1.5 py-0.5 font-mono text-caption text-foreground/80" data-testid="local-stash-name">
          {stash.name || stash.sha}
        </code>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {held && restore?.status === 'ready' && onBringBack && (
          <button type="button" onClick={onBringBack} disabled={busy} data-testid="local-restore-bring-back" className={primaryClass}>
            {pendingAction === 'bring-back' ? spinner : <GitMerge className="h-3 w-3" aria-hidden />}
            {pendingAction === 'bring-back' ? t('prCard.localStash.bringingBack') : t('prCard.localStash.bringBack', vars)}
          </button>
        )}
        {held && onRestore && restore?.status !== 'resolving' && restore?.status !== 'ready' && (
          <button type="button" onClick={onRestore} disabled={busy} data-testid="local-stash-restore" className={primaryClass}>
            {pendingAction === 'restore' ? spinner : <RotateCcw className="h-3 w-3" aria-hidden />}
            {pendingAction === 'restore' ? t('prCard.localStash.restoring') : t('prCard.localStash.restore')}
          </button>
        )}
        {(restore?.status === 'ready' || restore?.status === 'failed') && onDiscardBranch && (
          <button type="button" onClick={onDiscardBranch} disabled={busy} data-testid="local-restore-discard" className={quietClass}>
            {pendingAction === 'discard-branch' ? spinner : <Trash2 className="h-3 w-3" aria-hidden />}
            {pendingAction === 'discard-branch' ? t('prCard.localStash.discarding') : t('prCard.localStash.discardBranch')}
          </button>
        )}
        {held && (
          <button type="button" onClick={() => void copyName()} data-testid="local-stash-copy" className={quietClass}>
            <Copy className="h-3 w-3" aria-hidden />
            {copied ? t('prCard.localStash.copied') : t('prCard.localStash.copy')}
          </button>
        )}
      </div>
    </div>
  )
}
