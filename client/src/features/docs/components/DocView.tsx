import { useState, useEffect, useRef, memo } from 'react'
import { RailTrack } from '../../../components/brand/RailTrack'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { RefreshCw } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { API_ORIGIN } from '../../../lib/origin'
import { Button } from '../../../components/ui/button'
import { resolveDocHref } from '../lib/docs-links'
import 'highlight.js/styles/atom-one-dark.css'

// ─── Shared types ───────────────────────────────────────────────────────────────

export interface DocEntry {
  title: string
  slug: string
}

export interface DocCategory {
  name: string
  slug: string
  docs: DocEntry[]
}

export interface DocsIndex {
  categories: DocCategory[]
}

interface DocContent {
  title: string
  content: string
  category: string
  slug: string
}

/**
 * `/api/docs` is a Desktop-level (not project-scoped) route, so it is prefixed
 * with the API origin — never `getApiBase()`, which is `/api/projects/<id>` and
 * throws when no project is active. Relative URLs break inside Tauri.
 */
export function docsUrl(path = ''): string {
  return `${API_ORIGIN}/api/docs${path}`
}

// ─── Markdown ───────────────────────────────────────────────────────────────────

// Memoized markdown renderer — only re-renders when the content (or the current
// category, which scopes relative links) changes, so navigating between cached
// docs doesn't re-parse / re-highlight.
const MemoMarkdown = memo(function MemoMarkdown({
  content,
  currentCategory,
  onNavigateDoc,
}: {
  content: string
  currentCategory: string
  onNavigateDoc: (category: string, slug: string) => void
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        a({ href, children, ...props }) {
          const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
            if (!href) return
            // External links open in the system browser, never inside the webview.
            if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
              e.preventDefault()
              window.open(href, '_blank', 'noopener,noreferrer')
              return
            }
            if (href.startsWith('#')) return // in-page anchor — let it scroll
            // Internal guide link: never let the browser/router follow the bare
            // href (it lands off-route). Resolve and navigate through the host.
            e.preventDefault()
            const target = resolveDocHref(href, currentCategory)
            if (target) onNavigateDoc(target.category, target.slug)
          }
          return (
            <a href={href} onClick={handleClick} {...props}>
              {children}
            </a>
          )
        },
      }}
    >
      {content}
    </ReactMarkdown>
  )
})

// ─── Document view ──────────────────────────────────────────────────────────────

export function DocView({
  category,
  slug,
  lang,
  onNotFound,
  onNavigate,
  scrollContainerRef,
  className,
}: {
  category: string
  slug: string
  lang: string
  onNotFound: () => void
  onNavigate: (category: string, slug: string) => void
  scrollContainerRef: React.RefObject<HTMLElement | null>
  /** Padding/measure of the article (page vs dialog). */
  className?: string
}) {
  // Stale-while-revalidate: keep the previous doc on screen until the new
  // fetch resolves so navigation between docs doesn't flicker.
  const { t } = useTranslation('integrations')
  const [doc, setDoc] = useState<DocContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Track the latest request so a slow earlier fetch can't overwrite a newer one.
  const requestRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestRef.current
    setError(null)

    fetch(docsUrl(`/${category}/${slug}?lang=${encodeURIComponent(lang)}`))
      .then(async (res) => {
        if (res.status === 404) {
          onNotFound()
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: DocContent | undefined) => {
        if (requestId !== requestRef.current) return // stale
        if (data) {
          setDoc(data)
          // Reset scroll so the new doc starts at the top.
          if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0
        }
      })
      .catch((err: unknown) => {
        if (requestId !== requestRef.current) return
        setError(err instanceof Error ? err.message : '')
      })
  }, [category, slug, lang, onNotFound, scrollContainerRef, attempt])

  // Full-pane spinner only on the very first load (no previous content).
  if (!doc && error === null) {
    return (
      <div className="flex items-center justify-center h-full" role="status" aria-label={t('docs.loading')}>
        <RailTrack running className="w-16 shrink-0" />
      </div>
    )
  }

  if (error !== null && !doc) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
        <p role="alert" className="text-sm text-destructive">{t('docs.loadError')}</p>
        {error && (
          <details className="max-w-md text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t('docs.errorDetails')}</summary>
            <p className="mt-1 font-mono break-words">{error}</p>
          </details>
        )}
        <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          <RefreshCw className="w-3.5 h-3.5" aria-hidden />
          {t('common:actions.retry')}
        </Button>
      </div>
    )
  }

  if (!doc) return null

  return (
    <article className={cn('max-w-2xl mx-auto', className)}>
      <div
        className="prose prose-sm max-w-none
          prose-headings:text-foreground prose-headings:font-bold
          prose-p:text-foreground/90
          prose-a:text-accent-primary prose-a:no-underline hover:prose-a:underline
          prose-strong:text-foreground
          prose-code:text-accent-info prose-code:bg-card prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
          prose-pre:bg-card prose-pre:border prose-pre:border-border prose-pre:rounded-md prose-pre:p-0 prose-pre:overflow-x-auto
          prose-blockquote:border-l-accent-primary prose-blockquote:text-muted-foreground
          prose-hr:border-border
          prose-th:text-foreground prose-td:text-foreground/90
          prose-li:text-foreground/90"
      >
        <MemoMarkdown content={doc.content} currentCategory={doc.category} onNavigateDoc={onNavigate} />
      </div>
    </article>
  )
}
