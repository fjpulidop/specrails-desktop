import { useState, useEffect, useRef, memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, ChevronRight, FileText, Loader2 } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../components/ui/dialog'
import { DocView, docsUrl, type DocCategory, type DocsIndex } from './DocView'

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function DocsSidebar({
  categories,
  activeCategory,
  activeSlug,
  onSelect,
  onHome,
}: {
  categories: DocCategory[]
  activeCategory?: string
  activeSlug?: string
  onSelect: (category: string, slug: string) => void
  onHome: () => void
}) {
  const { t } = useTranslation('integrations')
  // Mirrors the Settings dialog's left nav grammar: rounded-lg rows, xs text,
  // accent-primary/15 active state, muted hover.
  return (
    <nav aria-label={t('docs.navLabel')} className="w-48 shrink-0 space-y-4 overflow-y-auto border-r border-border pr-2">
      <button
        onClick={onHome}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
          !activeCategory && !activeSlug
            ? 'bg-accent-primary/15 font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
        )}
      >
        <BookOpen className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{t('docs.title')}</span>
      </button>

      {categories.map((cat) => (
        <div key={cat.slug} className="space-y-0.5">
          <div className="px-2.5 mb-1 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-muted-foreground">
              {cat.name}
            </h2>
            {cat.docs.length > 0 && (
              <span className="text-[11px] font-medium tabular-nums text-muted-foreground bg-muted/40 rounded px-1 py-0.5 leading-none">
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
                    <button
                      onClick={() => onSelect(cat.slug, doc.slug)}
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
                    </button>
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

function DocsIndexView({
  categories,
  onSelect,
}: {
  categories: DocCategory[]
  onSelect: (category: string, slug: string) => void
}) {
  const { t } = useTranslation('integrations')
  const total = categories.reduce((sum, c) => sum + c.docs.length, 0)
  const nonEmptyCategories = categories.filter((c) => c.docs.length > 0).length

  // Mirrors a Settings section pane: xs section headings + bordered
  // rounded-md list rows (same grammar as the Settings "Projects" list).
  return (
    <div className="max-w-2xl mx-auto py-2 px-1 space-y-5">
      <p className="text-[11px] text-muted-foreground">
        {total === 0
          ? t('docs.indexEmpty')
          : t('docs.summary', {
              documents: t('docs.documentCount', { count: total }),
              categories: t('docs.categoryCount', { count: nonEmptyCategories }),
            })}
      </p>

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
                  <button
                    onClick={() => onSelect(cat.slug, doc.slug)}
                    className="w-full flex items-center gap-3 p-2.5 rounded-md border border-border text-left transition-colors hover:bg-muted/40 group"
                  >
                    <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="text-xs font-medium text-foreground truncate">{doc.title}</span>
                    <ChevronRight className="w-3 h-3 text-muted-foreground ml-auto md:opacity-0 md:group-hover:opacity-100 transition-opacity" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Main Dialog ──────────────────────────────────────────────────────────────

interface DocsDialogProps {
  open: boolean
  onClose: () => void
}

function DocsDialogImpl({ open, onClose }: DocsDialogProps) {
  const { t, i18n } = useTranslation('integrations')
  const lang = i18n.language || 'en'
  const [index, setIndex] = useState<DocsIndex | null>(null)
  const [indexLoading, setIndexLoading] = useState(true)
  const [activeCategory, setActiveCategory] = useState<string | undefined>()
  const [activeSlug, setActiveSlug] = useState<string | undefined>()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setIndexLoading(true)
    fetch(docsUrl(`?lang=${encodeURIComponent(lang)}`))
      .then((res) => res.json())
      .then((data: DocsIndex) => setIndex(data))
      .catch(() => setIndex({ categories: [] }))
      .finally(() => setIndexLoading(false))
  }, [open, lang])

  // Stabilise these handlers so `DocView`'s useEffect deps don't change every
  // parent re-render — otherwise every DesktopApp render (job streaming, WS
  // events, etc.) triggers a refetch storm that flickers the panel.
  const handleSelect = useCallback((category: string, slug: string) => {
    setActiveCategory(category)
    setActiveSlug(slug)
  }, [])

  const handleHome = useCallback(() => {
    setActiveCategory(undefined)
    setActiveSlug(undefined)
  }, [])

  const isDocView = Boolean(activeCategory && activeSlug)

  // Same skeleton as the Settings dialog: fixed-size content, visible icon
  // header, left nav + scrollable pane separated by the same gap.
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent movableResizable className="flex max-w-5xl w-[92vw] h-[82vh] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="w-4 h-4" />
            {t('docs.title')}
          </DialogTitle>
          <DialogDescription>
            {t('docs.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 gap-5 py-2">
          {/* Sidebar */}
          {indexLoading ? (
            <div className="w-48 shrink-0 border-r border-border flex items-center justify-center" role="status" aria-label={t('docs.loading')}>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : (
            <DocsSidebar
              categories={index?.categories ?? []}
              activeCategory={activeCategory}
              activeSlug={activeSlug}
              onSelect={handleSelect}
              onHome={handleHome}
            />
          )}

          {/* Content */}
          <div
            ref={scrollRef}
            role="region"
            aria-label={t('docs.title')}
            className="min-w-0 flex-1 overflow-y-auto pr-1"
          >
            {isDocView && activeCategory && activeSlug ? (
              <DocView
                category={activeCategory}
                slug={activeSlug}
                lang={lang}
                onNotFound={handleHome}
                onNavigate={handleSelect}
                scrollContainerRef={scrollRef}
                className="py-2 px-1"
              />
            ) : (
              index && <DocsIndexView categories={index.categories} onSelect={handleSelect} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Memoise the whole dialog so DesktopApp re-renders (job streaming, WS events,
// theme provider, etc.) don't cascade into a markdown re-parse.
const DocsDialog = memo(DocsDialogImpl)
export default DocsDialog
