import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCodeRepository } from './CodeRepositoryContext'
import { useDesktop } from '../../hooks/useDesktop'

const MAX_DISPLAY_LINES = 2000
const MAX_DISPLAY_CHARS = 256_000

interface DiffSnapshot { patch: string; truncated: boolean }

/** A stored patch is evidence of one intervention, not a current worktree snapshot. */
export function RecordedDiff({ path, jobId }: { path: string; jobId: string }) {
  const { activeProjectId } = useDesktop()
  const scope = useCodeRepository()
  const key = JSON.stringify([activeProjectId, scope.apiBase, scope.repositoryPath, path, jobId])
  return <RecordedDiffInner key={key} path={path} jobId={jobId} />
}

function RecordedDiffInner({ path, jobId }: { path: string; jobId: string }) {
  const { t } = useTranslation('code')
  const { apiBase } = useCodeRepository()
  const [snapshot, setSnapshot] = useState<DiffSnapshot | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>('loading')
  const [revision, retry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setState('loading')
    const params = new URLSearchParams({ path, jobId })
    void fetch(`${apiBase}/code/diff?${params}`, { signal: controller.signal }).then(async (res) => {
      if (res.status === 404) { if (!controller.signal.aborted) setState('missing'); return }
      if (!res.ok) throw new Error('Diff request failed')
      const json = await res.json() as Partial<DiffSnapshot>
      if (typeof json.patch !== 'string') throw new Error('Invalid patch response')
      if (!controller.signal.aborted) {
        setSnapshot({ patch: json.patch, truncated: json.truncated === true })
        setState(json.patch ? 'ready' : 'missing')
      }
    }).catch(() => { if (!controller.signal.aborted) setState('failed') })
    return () => controller.abort()
  }, [apiBase, path, jobId, revision])
  const lines = (snapshot?.patch ?? '').slice(0, MAX_DISPLAY_CHARS).split('\n')
  const displayTruncated = lines.length > MAX_DISPLAY_LINES || (snapshot?.patch.length ?? 0) > MAX_DISPLAY_CHARS
  let oldLine: number | null = null
  let newLine: number | null = null
  return <section className="flex min-h-0 flex-col gap-2 text-xs" data-testid="recorded-diff">
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="font-medium">{t('reader.recordedChange', { defaultValue: 'Recorded change' })} · <span className="font-mono" title={jobId}>{jobId.slice(0, 12)}</span></p>
      <p className="mt-1 text-muted-foreground">{t('reader.recordedNotice', { defaultValue: 'This patch records a past run. It may differ from the current registered checkout.' })}</p>
    </div>
    {state === 'loading' && <p role="status">{t('history.loadingDiff')}</p>}
    {state === 'missing' && <p>{t('history.diffUnavailable')}</p>}
    {state === 'failed' && <div role="alert"><p>{t('reader.diffFailed', { defaultValue: 'Could not load the recorded change.' })}</p><button className="mt-2 rounded border px-2 py-1" onClick={() => retry((value) => value + 1)}>{t('reader.retry', { defaultValue: 'Retry' })}</button></div>}
    {state === 'ready' && snapshot && <>
      {snapshot.truncated && <p className="text-accent-warning">{t('reader.patchIncomplete', { defaultValue: 'The stored patch is incomplete. Missing content cannot be reconstructed from this record.' })}</p>}
      {displayTruncated && <p className="text-accent-warning">{t('reader.displayLimited', { defaultValue: 'Preview limited to {{count}} lines or {{chars}} characters. The remaining patch is not shown.', count: MAX_DISPLAY_LINES, chars: MAX_DISPLAY_CHARS })}</p>}
      <div className="max-h-[32rem] overflow-auto rounded-md border border-border bg-background font-mono text-[11px] leading-5" tabIndex={0} aria-label={t('reader.patch', { defaultValue: 'Recorded patch' })}>
        {lines.slice(0, MAX_DISPLAY_LINES).map((line, index) => {
          const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
          let old: number | null = null; let next: number | null = null
          let kind = 'meta'
          if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]) }
          else if (oldLine !== null && newLine !== null) {
            if (line.startsWith('+')) { kind = 'added'; next = newLine++ }
            else if (line.startsWith('-')) { kind = 'removed'; old = oldLine++ }
            else if (line.startsWith(' ')) { kind = 'context'; old = oldLine++; next = newLine++ }
          }
          return <div key={index} data-kind={kind} className={`flex min-w-max ${kind === 'added' ? 'bg-accent-success/10' : kind === 'removed' ? 'bg-destructive/10' : kind === 'meta' ? 'text-muted-foreground' : ''}`}>
            <span aria-hidden className="w-12 shrink-0 select-none border-r border-border/40 px-2 text-right text-muted-foreground">{old}</span>
            <span aria-hidden className="w-12 shrink-0 select-none border-r border-border/40 px-2 text-right text-muted-foreground">{next}</span>
            <code className="whitespace-pre px-3">{line || ' '}</code>
          </div>
        })}
      </div>
    </>}
  </section>
}
