// "Create initial commit" — offered wherever `repository_has_no_commits` is
// shown. Creates one empty commit in the project's primary repository, then
// hands control back (the caller retries or re-enables its launch).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitCommitHorizontal, Loader2 } from 'lucide-react'
import { createInitialCommit, initialCommitErrorMessage } from '../lib/initial-commit'

interface Props {
  projectId: string
  onCreated: () => void
  className?: string
}

export function InitialCommitButton({ projectId, onCreated, className }: Props) {
  const { t } = useTranslation('common')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await createInitialCommit(projectId)
    setBusy(false)
    if (result.ok) onCreated()
    else setError(initialCommitErrorMessage(t, result.code))
  }

  return (
    <div className={className}>
      <button
        type="button"
        data-agent-interactive
        data-testid="initial-commit-create"
        onClick={() => void create()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-surface/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <GitCommitHorizontal className="h-3.5 w-3.5" aria-hidden />}
        {busy ? t('initialCommit.creating') : t('initialCommit.action')}
      </button>
      {error && <p role="alert" data-testid="initial-commit-error" className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
