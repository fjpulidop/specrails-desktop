import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitPullRequest } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { runFixCiOnPr, showMissionInMainWindow, type PrCiRunResult } from '../lib/pr-ci-run'

/** Refusals worded for people; anything else shows the server's own detail. */
const KNOWN_ERRORS = new Set([
  'pr_url_invalid', 'pr_no_push_access', 'pr_repository_not_in_any_project', 'pr_project_ambiguous', 'pr_not_open',
  'pr_fork_unsupported', 'target_pr_not_found', 'pr_github_unavailable', 'engine_unsupported', 'pr_ci_disabled',
])

/**
 * Loops ▸ Fix PR CI ▸ Run on a PR: the person pastes a pull request URL; the
 * built-in loop starts on it in a mission of the project that owns the PR's
 * repository, after the host has checked the PR is open, on the same
 * repository and pushable by the person's GitHub account.
 */
export function RunOnPrDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('loops')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Extract<PrCiRunResult, { ok: false }> | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!url.trim() || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await runFixCiOnPr(url, projectId ?? undefined)
      if (!result.ok) {
        setFailure(result)
        // A failed start still has its mission (the card states why); offer to open it.
        return
      }
      toast.success(t(result.alreadyRunning ? 'runOnPr.alreadyRunning' : 'runOnPr.started'))
      await showMissionInMainWindow(result.conversationId).catch(() => {})
      onClose()
    } catch {
      setFailure({ ok: false, error: 'network', detail: '' })
    } finally {
      setBusy(false)
    }
  }

  const message = failure && (KNOWN_ERRORS.has(failure.error) ? t(`runOnPr.errors.${failure.error}`) : failure.detail || t('runOnPr.errors.generic'))
  const choices = failure?.error === 'pr_project_ambiguous' ? failure.projects ?? [] : []

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <DialogContent size="form" data-testid="run-on-pr-dialog">
        <DialogHeader icon={<GitPullRequest />}>
          <DialogTitle>{t('runOnPr.title')}</DialogTitle>
          <DialogDescription>{t('runOnPr.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="contents">
          <DialogBody className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-foreground">{t('runOnPr.urlLabel')}</span>
              <Input
                autoFocus
                value={url}
                onChange={event => { setUrl(event.target.value); setFailure(null); setProjectId(null) }}
                placeholder="https://github.com/owner/repo/pull/123"
                spellCheck={false}
                data-testid="run-on-pr-url"
              />
            </label>
            {choices.length > 0 && (
              <fieldset className="flex flex-col gap-1.5 text-sm" data-testid="run-on-pr-projects">
                <legend className="mb-1 text-muted-foreground">{t('runOnPr.chooseProject')}</legend>
                {choices.map(project => (
                  <label key={project.id} className="flex items-center gap-2">
                    <input type="radio" name="run-on-pr-project" className="accent-accent-primary" checked={projectId === project.id} onChange={() => setProjectId(project.id)} />
                    {project.name}
                  </label>
                ))}
              </fieldset>
            )}
            {message && !(choices.length > 0 && projectId) && (
              <p role="alert" className="text-sm text-destructive" data-testid="run-on-pr-error">{message}</p>
            )}
            {failure?.conversationId && (
              <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => { void showMissionInMainWindow(failure.conversationId!).catch(() => {}); onClose() }}>
                {t('runOnPr.openMission')}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">{t('runOnPr.hint')}</p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t('runOnPr.cancel')}</Button>
            <Button type="submit" disabled={busy || !url.trim() || (choices.length > 0 && !projectId)} data-testid="run-on-pr-submit">
              {busy ? t('runOnPr.checking') : t('runOnPr.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
