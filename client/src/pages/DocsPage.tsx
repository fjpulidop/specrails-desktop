import { useState, useEffect, useRef, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { BookOpen, ChevronRight, FileText, Loader2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { resolveDocHref } from '../lib/docs-links'
import 'highlight.js/styles/atom-one-dark.css'

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocEntry {
  title: string
  slug: string
}

interface DocCategory {
  name: string
  slug: string
  docs: DocEntry[]
}

interface DocsIndex {
  categories: DocCategory[]
}

interface DocContent {
  title: string
  content: string
  category: string
  slug: string
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function DocsSidebar({
  categories,
  activeCategory,
  activeSlug,
}: {
  categories: DocCategory[]
  activeCategory?: string
  activeSlug?: string
}) {
  const { t } = useTranslation('integrations')
  // Mirrors the Settings dialog's left nav grammar: rounded-lg rows, xs text,
  // accent-primary/15 active state, muted hover.
  return (
    <nav className="w-56 flex-shrink-0 border-r border-border overflow-y-auto py-4 px-3 space-y-4">
      <Link
        to="/docs"
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
          !activeCategory && !activeSlug
            ? 'bg-accent-primary/15 font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
        )}
      >
        <BookOpen className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{t('docs.title')}</span>
      </Link>

      {categories.map((cat) => (
        <div key={cat.slug} className="space-y-0.5">
          <div className="px-2.5 mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {cat.name}
            </span>
            {cat.docs.length > 0 && (
              <span className="text-[9px] font-medium text-muted-foreground/60 bg-muted/40 rounded px-1 py-0.5 leading-none">
                {cat.docs.length}
              </span>
            )}
          </div>
          {cat.docs.length === 0 ? (
            <p className="px-2.5 text-xs text-muted-foreground italic">{t('docs.sidebarEmpty')}</p>
          ) : (
            <ul className="space-y-0.5">
              {cat.docs.map((doc) => {
                const isActive = activeCategory === cat.slug && activeSlug === doc.slug
                return (
                  <li key={doc.slug}>
                    <Link
                      to={`/docs/${cat.slug}/${doc.slug}`}
                      title={doc.title}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                        isActive
                          ? 'bg-accent-primary/15 font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                      )}
                    >
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{doc.title}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ))}
    </nav>
  )
}

// ─── Index view ───────────────────────────────────────────────────────────────

function DocsIndex({ categories }: { categories: DocCategory[] }) {
  const { t } = useTranslation('integrations')
  const total = categories.reduce((sum, c) => sum + c.docs.length, 0)
  const nonEmptyCategories = categories.filter((c) => c.docs.length > 0).length

  // Mirrors a Settings section pane: icon header, uppercase xs section headings
  // + bordered rounded-md list rows (same grammar as the Settings "Projects" list).
  return (
    <div className="max-w-2xl mx-auto py-8 px-6 space-y-5">
      <div className="space-y-1.5">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <BookOpen className="w-4 h-4" />
          {t('docs.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? t('docs.indexEmpty')
            : t('docs.summary', {
                documents: t('docs.documentCount', { count: total }),
                categories: t('docs.categoryCount', { count: nonEmptyCategories }),
              })}
        </p>
      </div>

      {categories.map((cat) => (
        <div key={cat.slug} className="space-y-2">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {cat.name}
          </h2>
          {cat.docs.length === 0 ? (
            <p className="text-xs text-muted-foreground italic pl-2">{t('docs.categoryEmpty')}</p>
          ) : (
            <ul className="space-y-2">
              {cat.docs.map((doc) => (
                <li key={doc.slug}>
                  <Link
                    to={`/docs/${cat.slug}/${doc.slug}`}
                    className="flex items-center gap-3 p-2.5 rounded-md border border-border transition-colors hover:bg-muted/40 group"
                  >
                    <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="text-xs font-medium text-foreground truncate">{doc.title}</span>
                    <ChevronRight className="w-3 h-3 text-muted-foreground ml-auto md:opacity-0 md:group-hover:opacity-100 transition-opacity" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Document view ────────────────────────────────────────────────────────────

// Memoized markdown renderer — only re-renders when the content (or current
// category, which scopes relative links) changes. Relative guide links navigate
// via the router to /docs/<category>/<slug> instead of doing a bare-href full
// reload (which would land off-route).
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
            if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
              e.preventDefault()
              window.open(href, '_blank', 'noopener,noreferrer')
              return
            }
            if (href.startsWith('#')) return
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

function DocView({
  category,
  slug,
  lang,
  scrollContainerRef,
}: {
  category: string
  slug: string
  lang: string
  scrollContainerRef: React.RefObject<HTMLElement | null>
}) {
  // Stale-while-revalidate: keep the previous doc on screen while fetching
  // the next one so navigation between docs doesn't flicker.
  const { t } = useTranslation('integrations')
  const [doc, setDoc] = useState<DocContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)
  const navigate = useNavigate()

  useEffect(() => {
    const requestId = ++requestRef.current
    setError(null)

    fetch(`/api/docs/${category}/${slug}?lang=${encodeURIComponent(lang)}`)
      .then(async (res) => {
        if (res.status === 404) {
          navigate('/docs', { replace: true })
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
        setError(err instanceof Error ? err.message : t('docs.loadError'))
      })
  }, [category, slug, lang, navigate, scrollContainerRef])

  // Full-screen spinner only on the very first load (no previous content).
  if (!doc && !error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error && !doc) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    )
  }

  if (!doc) return null

  return (
    <article className="max-w-2xl mx-auto py-8 px-6">
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
        <MemoMarkdown
          content={doc.content}
          currentCategory={doc.category}
          onNavigateDoc={(cat, s) => navigate(`/docs/${cat}/${s}`)}
        />
      </div>
    </article>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DocsPage() {
  const { category, slug } = useParams<{ category?: string; slug?: string }>()
  const { i18n } = useTranslation('integrations')
  const lang = i18n.language || 'en'
  const [index, setIndex] = useState<DocsIndex | null>(null)
  const [indexLoading, setIndexLoading] = useState(true)
  const scrollRef = useRef<HTMLElement>(null)

  useEffect(() => {
    fetch(`/api/docs?lang=${encodeURIComponent(lang)}`)
      .then((res) => res.json())
      .then((data: DocsIndex) => setIndex(data))
      .catch(() => setIndex({ categories: [] }))
      .finally(() => setIndexLoading(false))
  }, [lang])

  const isDocView = Boolean(category && slug)

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      {indexLoading ? (
        <div className="w-56 flex-shrink-0 border-r border-border flex items-center justify-center">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <DocsSidebar
          categories={index?.categories ?? []}
          activeCategory={category}
          activeSlug={slug}
        />
      )}

      {/* Content */}
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        {isDocView && category && slug ? (
          <DocView category={category} slug={slug} lang={lang} scrollContainerRef={scrollRef} />
        ) : (
          index && <DocsIndex categories={index.categories} />
        )}
      </main>
    </div>
  )
}
