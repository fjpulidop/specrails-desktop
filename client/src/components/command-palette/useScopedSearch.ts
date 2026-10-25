import { useEffect, useState } from 'react'
import { getApiBase } from '../../lib/api'
import { API_ORIGIN } from '../../lib/origin'
import type { Snippet } from './snippet'
import { SCOPE_ROW_CAPS, SCOPE_SEARCH_DEBOUNCE_MS, scopeNeedsProject, type SearchScope } from './search-scopes'

/** The scopes answered by a request (`missions` and `settings` are answered in memory / by the mission store). */
export type RemoteScope = Extract<SearchScope, 'specs' | 'files' | 'logs' | 'docs'>

export interface SpecRow { kind: 'spec'; id: number; title: string; status: string; field: string; snippet: Snippet | null }
export interface FileRow { kind: 'file'; path: string; sizeBytes: number }
export interface LogRow { kind: 'log'; jobId: string; command: string; status: string; field: string; snippet: Snippet }
export interface DocRow { kind: 'doc'; category: string; categoryName: string; slug: string; title: string; heading: string | null; anchor: string | null }
export type ScopedRow = SpecRow | FileRow | LogRow | DocRow

export type ScopedStatus = 'idle' | 'loading' | 'ready' | 'failed'

export function isRemoteScope(scope: SearchScope | null): scope is RemoteScope {
  return scope === 'specs' || scope === 'files' || scope === 'logs' || scope === 'docs'
}

function snippetOf(value: unknown): Snippet | null {
  if (!value || typeof value !== 'object') return null
  const v = value as { text?: unknown; ranges?: unknown }
  return typeof v.text === 'string' ? { text: v.text, ranges: Array.isArray(v.ranges) ? (v.ranges as Snippet['ranges']) : [] } : null
}

async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

export async function fetchScoped(scope: RemoteScope, query: string, lang: string, signal: AbortSignal): Promise<ScopedRow[]> {
  const limit = SCOPE_ROW_CAPS[scope]
  const q = encodeURIComponent(query)
  if (scope === 'specs') {
    const data = await getJson(`${getApiBase()}/search/specs?q=${q}&limit=${limit}`, signal)
    return (Array.isArray(data.results) ? data.results : []).slice(0, limit).map((r: Record<string, unknown>) => ({
      kind: 'spec' as const, id: Number(r.id), title: String(r.title ?? ''), status: String(r.status ?? ''), field: String(r.field ?? ''), snippet: snippetOf(r.snippet),
    }))
  }
  if (scope === 'logs') {
    const data = await getJson(`${getApiBase()}/search/jobs?q=${q}&limit=${limit}`, signal)
    return (Array.isArray(data.results) ? data.results : []).slice(0, limit).map((r: Record<string, unknown>) => ({
      kind: 'log' as const, jobId: String(r.jobId), command: String(r.command ?? ''), status: String(r.status ?? ''), field: String(r.field ?? ''),
      snippet: snippetOf(r.snippet) ?? { text: String(r.command ?? ''), ranges: [] },
    }))
  }
  if (scope === 'files') {
    const data = await getJson(`${getApiBase()}/code/find?q=${q}&limit=${limit}`, signal)
    return (Array.isArray(data.matches) ? data.matches : []).slice(0, limit).map((r: Record<string, unknown>) => ({
      kind: 'file' as const, path: String(r.path), sizeBytes: Number(r.sizeBytes ?? 0),
    }))
  }
  const data = await getJson(`${API_ORIGIN}/api/docs/search?lang=${encodeURIComponent(lang)}&q=${q}`, signal)
  return (Array.isArray(data.results) ? data.results : []).slice(0, limit).map((r: Record<string, unknown>) => ({
    kind: 'doc' as const, category: String(r.category), categoryName: String(r.categoryName ?? r.category), slug: String(r.slug), title: String(r.title ?? ''),
    heading: typeof r.heading === 'string' ? r.heading : null, anchor: typeof r.anchor === 'string' ? r.anchor : null,
  }))
}

interface Settled { key: string; rows: ScopedRow[]; failed: boolean }

/**
 * Debounced, abortable request for a remote scope. Answers are only trusted for
 * the exact scope/project/query they were asked for, so a stale response never
 * paints a newer query; project switches restart the request.
 */
export function useScopedSearch(args: { scope: SearchScope | null; text: string; open: boolean; projectId: string | null; lang: string }): { rows: ScopedRow[]; status: ScopedStatus } {
  const { scope, open, projectId, lang } = args
  const text = args.text.trim()
  const active = open && isRemoteScope(scope) && text.length > 0 && (!scopeNeedsProject(scope) || projectId !== null)
  const key = active ? `${scope}|${scope && scopeNeedsProject(scope) ? projectId : ''}|${lang}|${text}` : ''
  const [settled, setSettled] = useState<Settled | null>(null)

  useEffect(() => {
    if (!active || !isRemoteScope(scope)) return
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      fetchScoped(scope, text, lang, ctrl.signal)
        .then((rows) => { if (!ctrl.signal.aborted) setSettled({ key, rows, failed: false }) })
        .catch(() => { if (!ctrl.signal.aborted) setSettled({ key, rows: [], failed: true }) })
    }, SCOPE_SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
    // `key` already encodes scope, project, language and text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!active) return { rows: [], status: 'idle' }
  if (settled?.key === key) return { rows: settled.rows, status: settled.failed ? 'failed' : 'ready' }
  return { rows: [], status: 'loading' }
}
