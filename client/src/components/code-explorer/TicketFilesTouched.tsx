import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FileText, FilePlus2, FileMinus2, GitCommitHorizontal } from 'lucide-react'
import { getApiBase } from '../../lib/api'
import { useDesktop } from '../../hooks/useDesktop'
import { FEATURE_CODE_EXPLORER } from '../../lib/feature-flags'

interface ActivityEntry {
  id: number
  repositoryId: string
  repositoryName: string
  path: string
  kind: 'created' | 'modified' | 'deleted'
  jobId: string | null
  at: number
}
interface ActivityPage { entries: ActivityEntry[]; nextCursor: string | null; truncated: boolean }
interface Props { ticketId: number; onClose: () => void }

export function TicketFilesTouched({ ticketId, onClose }: Props) {
  const { t } = useTranslation('code')
  const navigate = useNavigate()
  const { activeProjectId } = useDesktop()
  const scope = `${activeProjectId}:${ticketId}`
  const activeScope = useRef(scope)
  activeScope.current = scope
  const requestVersion = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const [result, setResult] = useState<{ scope: string; rows: ActivityEntry[]; nextCursor: string | null; truncated: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [failedCursor, setFailedCursor] = useState<string | null>(null)

  const load = useCallback(async (cursor: string | null = null) => {
    controller.current?.abort()
    const ctrl = new AbortController()
    controller.current = ctrl
    const version = ++requestVersion.current
    const current = () => !ctrl.signal.aborted && requestVersion.current === version && activeScope.current === scope
    setLoading(true)
    setError(false)
    setFailedCursor(cursor)
    try {
      const query = new URLSearchParams({ ticketId: String(ticketId), limit: '50' })
      if (cursor) query.set('cursor', cursor)
      const response = await fetch(`${getApiBase()}/code/activity?${query}`, { signal: ctrl.signal })
      if (!response.ok) throw new Error('activity unavailable')
      const page = await response.json() as ActivityPage
      if (!Array.isArray(page.entries)) throw new Error('invalid activity response')
      if (!current()) return
      setResult(previous => {
        // The section lists files, not every intervention. Identical relative
        // paths in different memberships must remain separate addresses.
        const rows = cursor && previous?.scope === scope ? [...previous.rows] : []
        const seen = new Set(rows.map(row => `${row.repositoryId}\0${row.path}`))
        for (const row of page.entries) {
          const key = `${row.repositoryId}\0${row.path}`
          if (!seen.has(key)) { seen.add(key); rows.push(row) }
        }
        return { scope, rows, nextCursor: page.nextCursor, truncated: !!page.truncated || (!!cursor && !!previous?.truncated) }
      })
    } catch {
      if (current()) setError(true)
    } finally {
      if (current()) setLoading(false)
    }
  }, [scope, ticketId])

  useEffect(() => {
    if (!FEATURE_CODE_EXPLORER) return
    setResult(null)
    void load()
    return () => { controller.current?.abort(); requestVersion.current++ }
  }, [load])

  if (!FEATURE_CODE_EXPLORER) return null
  const visible = result?.scope === scope ? result : null
  if (!loading && !error && visible && !visible.rows.length && !visible.truncated && !visible.nextCursor) return null

  return (
    <div>
      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
        {t('ticketFiles.title')}
      </span>
      {loading && !visible && <p className="text-xs text-muted-foreground" role="status">{t('ticketFiles.loading')}</p>}
      {error && <div className="text-xs" role="alert">
        <span>{t('ticketFiles.loadFailed')}</span>{' '}
        <button type="button" onClick={() => { void load(failedCursor) }} className="underline">{t('ticketFiles.retry')}</button>
      </div>}
      {visible?.truncated && <p className="text-xs text-muted-foreground">
        {t('ticketFiles.partial')}{' '}
        <button type="button" disabled={loading} onClick={() => { void load() }} className="underline">{t('ticketFiles.retry')}</button>
      </p>}
      <ul className="space-y-1">
        {visible?.rows.map(row => {
          const Icon = row.kind === 'created' ? FilePlus2 : row.kind === 'deleted' ? FileMinus2 : FileText
          return (
            <li key={`${row.repositoryId}:${row.path}`}>
              <button type="button" onClick={() => {
                const query = new URLSearchParams({ repositoryId: row.repositoryId, path: row.path })
                if (row.jobId) query.set('changeJobId', row.jobId)
                onClose()
                navigate(`/code?${query}`)
              }} className="w-full text-left flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/40">
                <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-[10px] text-muted-foreground truncate max-w-24" title={row.repositoryName}>{row.repositoryName}</span>
                <span className="font-mono truncate flex-1">{row.path}</span>
                {row.jobId && <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-mono shrink-0" title={t('ticketFiles.jobTitle', { jobId: row.jobId })}>
                  <GitCommitHorizontal className="h-3 w-3" />
                  {row.jobId.length > 10 ? row.jobId.slice(0, 10) : row.jobId}
                </span>}
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">{t(`kind.${row.kind}`)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {visible?.nextCursor && <button type="button" disabled={loading} onClick={() => { void load(visible.nextCursor) }} className="text-xs underline mt-2">
        {loading ? t('ticketFiles.loading') : t('ticketFiles.loadMore')}
      </button>}
    </div>
  )
}
