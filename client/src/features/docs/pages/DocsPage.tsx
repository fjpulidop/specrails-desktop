import { useState, useEffect, useRef, useCallback } from 'react'
import { RailTrack } from '../../../components/brand/RailTrack'
import { useTranslation } from 'react-i18next'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { BookOpen, ChevronRight, FileText } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { DocView, docsUrl, type DocCategory, type DocsIndex as DocsIndexData } from '../components/DocView'

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
    <nav aria-label={t('docs.navLabel')} className="w-56 flex-shrink-0 border-r border-border overflow-y-auto py-4 px-3 space-y-4">
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
            <h2 className="text-xs font-semibold text-muted-foreground">
              {cat.name}
            </h2>
            {cat.docs.length > 0 && (
              <span className="text-caption font-medium tabular-nums text-muted-foreground bg-muted/40 rounded px-1 py-0.5 leading-none">
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

  // Mirrors a Settings section pane: icon header, xs section headings
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
          <h2 className="text-xs font-semibold text-muted-foreground">
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
                    <span className="text-label text-foreground truncate">{doc.title}</span>
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

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DocsPage() {
  const { category, slug } = useParams<{ category?: string; slug?: string }>()
  const { t, i18n } = useTranslation('integrations')
  const navigate = useNavigate()
  const lang = i18n.language || 'en'
  const [index, setIndex] = useState<DocsIndexData | null>(null)
  const [indexLoading, setIndexLoading] = useState(true)
  const scrollRef = useRef<HTMLElement>(null)

  useEffect(() => {
    fetch(docsUrl(`?lang=${encodeURIComponent(lang)}`))
      .then((res) => res.json())
      .then((data: DocsIndexData) => setIndex(data))
      .catch(() => setIndex({ categories: [] }))
      .finally(() => setIndexLoading(false))
  }, [lang])

  // Stable handlers so DocView's fetch effect does not re-run on every render.
  const handleNotFound = useCallback(() => navigate('/docs', { replace: true }), [navigate])
  const handleNavigate = useCallback(
    (cat: string, s: string) => navigate(`/docs/${cat}/${s}`),
    [navigate],
  )

  const isDocView = Boolean(category && slug)

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      {indexLoading ? (
        <div className="w-56 flex-shrink-0 border-r border-border flex items-center justify-center" role="status" aria-label={t('docs.loading')}>
          <RailTrack running className="w-16 shrink-0" />
        </div>
      ) : (
        <DocsSidebar
          categories={index?.categories ?? []}
          activeCategory={category}
          activeSlug={slug}
        />
      )}

      {/* Content */}
      <section ref={scrollRef} className="flex-1 overflow-y-auto">
        {isDocView && category && slug ? (
          <DocView
            category={category}
            slug={slug}
            lang={lang}
            onNotFound={handleNotFound}
            onNavigate={handleNavigate}
            scrollContainerRef={scrollRef}
            className="py-8 px-6"
          />
        ) : (
          index && <DocsIndex categories={index.categories} />
        )}
      </section>
    </div>
  )
}
