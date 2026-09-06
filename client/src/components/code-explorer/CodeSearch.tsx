import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileSearch, Loader2, Search } from 'lucide-react'
import { useCodeRepository } from './CodeRepositoryContext'
import { repositoryApiBase } from '../../lib/project-repositories'
import type { ExplorerLocation } from './explorer-types'

interface SearchMatch {
  repositoryId?: string
  repositoryName?: string
  path: string
  lineNumber?: number
  snippet?: string
  snippetTruncated?: boolean
}

interface SearchResults {
  matches: SearchMatch[]
  truncated?: boolean
  repositories?: Array<{ repositoryId: string; repositoryName: string; status: string }>
  scan?: { scannedFiles?: number; durationMs?: number }
}

export function CodeSearch({ projectId, repositoryName, multipleRepositories, active = true, onOpen }: {
  active?: boolean
  projectId: string
  repositoryName?: string
  multipleRepositories: boolean
  onOpen: (location: ExplorerLocation) => void
}) {
  const { t } = useTranslation('code')
  const { apiBase, repositoryId, repositoryPath } = useCodeRepository()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'find' | 'search'>('find')
  const [allRepositories, setAllRepositories] = useState(multipleRepositories)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [withinPath, setWithinPath] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const across = multipleRepositories && allRepositories
  const requestBase = across ? repositoryApiBase(projectId) : apiBase
  const ownerId = across ? undefined : repositoryId
  const ownerName = across ? undefined : repositoryName
  const ownerPath = across ? undefined : repositoryPath
  const generation = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (active) inputRef.current?.focus() }, [active])

  useEffect(() => {
    const id = ++generation.current
    const controller = new AbortController()
    setResults(null)
    setFailed(false)
    const text = query.trim()
    if (!text) { setLoading(false); return () => controller.abort() }
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: text, limit: kind === 'find' ? '50' : '100' })
        if (kind === 'search') params.set('caseSensitive', String(caseSensitive))
        // Project discovery supports a path prefix in both modes; scoped /find
        // ranks filenames only, so the path control is for literal search.
        if (kind === 'search' && withinPath.trim()) params.set('path', withinPath.trim())
        if (across) params.set('kind', kind)
        const response = await fetch(`${requestBase}/code/${across ? 'discover' : kind}?${params}`, { signal: controller.signal })
        if (!response.ok) throw new Error('search_failed')
        const data = await response.json() as SearchResults
        if (!Array.isArray(data.matches)) throw new Error('invalid_search_response')
        if (!controller.signal.aborted && id === generation.current) {
          setResults({ ...data, matches: data.matches.map(match => ({ ...match, repositoryId: match.repositoryId ?? ownerId, repositoryName: match.repositoryName ?? ownerName })) })
        }
      } catch {
        if (!controller.signal.aborted && id === generation.current) setFailed(true)
      } finally {
        if (!controller.signal.aborted && id === generation.current) setLoading(false)
      }
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, kind, caseSensitive, withinPath, retry, across, requestBase, ownerId, ownerName, ownerPath])

  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t('explore.search')}>
    <div className="space-y-2 border-b border-border p-3">
      <div className="flex gap-1 rounded-lg bg-muted/40 p-1">
        {(['find', 'search'] as const).map(value => <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)} className={`flex-1 rounded-md px-2 py-1.5 text-xs ${kind === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{t(`search.${value}`)}</button>)}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} maxLength={256} aria-label={t('search.query')} placeholder={t(kind === 'find' ? 'search.filePlaceholder' : 'search.contentPlaceholder')} className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-xs outline-none focus:border-accent-primary" />
      </div>
      {multipleRepositories && <select aria-label={t('search.scope')} value={allRepositories ? 'all' : 'current'} onChange={event => setAllRepositories(event.target.value === 'all')} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs">
        <option value="all">{t('search.allRepositories')}</option>
        <option value="current">{repositoryName ?? t('search.currentRepository')}</option>
      </select>}
      {kind === 'search' && <>
        <input value={withinPath} onChange={event => setWithinPath(event.target.value)} placeholder={t('search.pathPlaceholder')} aria-label={t('search.withinPath')} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-accent-primary" />
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} />{t('search.caseSensitive')}</label>
      </>}
    </div>
    <div className="min-h-0 flex-1 overflow-auto" aria-busy={loading}>
      {!query.trim() && <div className="space-y-2 px-5 py-8 text-center text-xs text-muted-foreground"><FileSearch className="mx-auto h-7 w-7 opacity-50" /><p>{t('search.hint')}</p></div>}
      {loading && <p role="status" className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('search.loading')}</p>}
      {failed && <div role="alert" className="space-y-2 p-4 text-xs"><p>{t('search.failed')}</p><button type="button" className="text-accent-primary underline" onClick={() => setRetry(value => value + 1)}>{t('explore.retry')}</button></div>}
      {results && <>
        <div role="status" className="space-y-1 border-b border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
          <p>{t('search.results', { count: results.matches.length })}</p>
          {results.truncated && <p className="text-amber-600 dark:text-amber-400">{t('search.partial')}</p>}
          {results.repositories?.filter(repo => !['ok', 'partial'].includes(repo.status)).map(repo => <p key={repo.repositoryId}>{t('search.repositoryIncomplete', { name: repo.repositoryName })}</p>)}
        </div>
        {results.matches.length === 0 && <p className="p-4 text-xs text-muted-foreground">{t(results.truncated ? 'search.noMatchesPartial' : 'search.noMatches')}</p>}
        <ul className="divide-y divide-border/40">{results.matches.map((match, index) => <li key={`${match.repositoryId}:${match.path}:${match.lineNumber ?? 0}:${index}`}>
          <button type="button" onClick={() => onOpen({ repositoryId: match.repositoryId, path: match.path, line: match.lineNumber })} className="w-full space-y-1 px-3 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-primary" title={`${match.repositoryName ?? ''} / ${match.path}`}>
            {multipleRepositories && <span className="block text-[10px] font-medium text-accent-primary">{match.repositoryName}</span>}
            <span className="block break-all font-mono text-xs text-foreground">{match.path}{match.lineNumber ? <span className="text-accent-primary">:{match.lineNumber}</span> : null}</span>
            {match.snippet !== undefined && <span className="block overflow-hidden text-ellipsis whitespace-pre font-mono text-[11px] text-muted-foreground">{match.snippetTruncated ? '… ' : ''}{match.snippet}</span>}
          </button>
        </li>)}</ul>
      </>}
    </div>
  </section>
}
