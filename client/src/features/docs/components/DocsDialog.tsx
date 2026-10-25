import { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, FileText, GraduationCap, Search } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { replayTour } from '../../../lib/onboarding-events'
import { cn } from '../../../lib/utils'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import { DocView, docsUrl, type DocCategory, type DocScrollRequest, type DocsIndex } from './DocView'
import type { DocsTarget } from '../../../lib/docs-events'

// ─── Sidebar ──────────────────────────────────────────────────────────────────

/** Case-insensitive title filter; categories without a match are hidden. */
function filterDocCategories(categories: DocCategory[], query: string): DocCategory[] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return categories
  return categories
    .map((cat) => ({ ...cat, docs: cat.docs.filter((doc) => doc.title.toLocaleLowerCase().includes(q)) }))
    .filter((cat) => cat.docs.length > 0)
}

function DocsSidebar({
  categories,
  activeCategory,
  activeSlug,
  onSelect,
  filterRef,
}: {
  categories: DocCategory[]
  activeCategory?: string
  activeSlug?: string
  onSelect: (category: string, slug: string) => void
  filterRef: React.RefObject<HTMLInputElement | null>
}) {
  const { t } = useTranslation('integrations')
  const [query, setQuery] = useState('')
  const visible = useMemo(() => filterDocCategories(categories, query), [categories, query])
  const filtering = query.trim().length > 0
  // Mirrors the Settings dialog's left nav grammar: rounded-lg rows, xs text,
  // accent-primary/15 active state, muted hover.
  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-border/40">
      <div className="shrink-0 p-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={filterRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('docs.filterPlaceholder')}
            aria-label={t('docs.filterPlaceholder')}
            data-testid="docs-filter"
            className="pl-8"
          />
        </div>
      </div>
      <nav aria-label={t('docs.navLabel')} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3">
        {filtering && visible.length === 0 && (
          <p className="px-2.5 text-xs text-muted-foreground" role="status">{t('docs.filterNoResults', { query: query.trim() })}</p>
        )}
        {visible.map((cat) => (
          <div key={cat.slug} className="space-y-0.5">
            <div className="px-2.5 mb-1 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-muted-foreground">
                {cat.name}
              </h2>
              {cat.docs.length > 0 && (
                <span className="text-label tabular-nums text-muted-foreground bg-muted/40 rounded px-1 py-0.5 leading-none">
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
                        aria-current={isActive ? 'page' : undefined}
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
    </div>
  )
}

/** Eight placeholder rows in the sidebar's shape while the index loads. */
function DocsSidebarSkeleton({ label }: { label: string }) {
  return (
    <div
      className="flex w-56 shrink-0 flex-col gap-2 border-r border-border/40 p-3"
      role="status"
      aria-label={label}
      data-testid="docs-sidebar-skeleton"
    >
      <div className="h-8 rounded-md bg-muted/40 motion-safe:animate-pulse" />
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          data-skeleton-row=""
          className="h-6 rounded-lg bg-muted/40 motion-safe:animate-pulse"
          style={{ width: `${[70, 85, 60, 90, 75, 65, 80, 55][i]}%` }}
        />
      ))}
    </div>
  )
}

// ─── Main Dialog ──────────────────────────────────────────────────────────────

interface DocsDialogProps {
  open: boolean
  onClose: () => void
  /** Land on this page/section (a "Learn more" hint or a cheatsheet result). `nonce` re-fires the same target. */
  target?: (DocsTarget & { nonce: number }) | null
}

function DocsDialogImpl({ open, onClose, target = null }: DocsDialogProps) {
  const { t, i18n } = useTranslation('integrations')
  const { t: tOnboarding } = useTranslation('onboarding')
  const lang = i18n.language || 'en'
  const [index, setIndex] = useState<DocsIndex | null>(null)
  const [indexLoading, setIndexLoading] = useState(true)
  const [activeCategory, setActiveCategory] = useState<string | undefined>()
  const [activeSlug, setActiveSlug] = useState<string | undefined>()
  const scrollRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Land on the first guide once per index load (no index page that repeats
  // the sidebar). A 404 clears the selection without re-landing (no loop).
  const landedRef = useRef(false)
  const [scrollRequest, setScrollRequest] = useState<DocScrollRequest | null>(null)

  // A hint asked for a specific page/section: select it (even before the index
  // has loaded, so the first-guide landing below stands down) and scroll there.
  useEffect(() => {
    if (!open) {
      setScrollRequest(null)
      return
    }
    if (!target) return
    setActiveCategory(target.category)
    setActiveSlug(target.slug)
    setScrollRequest({ category: target.category, slug: target.slug, anchor: target.anchor, heading: target.heading, nonce: target.nonce })
  }, [open, target])

  useEffect(() => {
    if (!open) return
    setIndexLoading(true)
    landedRef.current = false
    fetch(docsUrl(`?lang=${encodeURIComponent(lang)}`))
      .then((res) => res.json())
      .then((data: DocsIndex) => setIndex(data))
      .catch(() => setIndex({ categories: [] }))
      .finally(() => setIndexLoading(false))
  }, [open, lang])

  useEffect(() => {
    if (indexLoading || !index || landedRef.current) return
    landedRef.current = true
    if (activeCategory && activeSlug) return
    const first = index.categories.find((c) => c.docs.length > 0)
    if (first) {
      setActiveCategory(first.slug)
      setActiveSlug(first.docs[0].slug)
    }
  }, [index, indexLoading, activeCategory, activeSlug])

  // Stabilise these handlers so `DocView`'s useEffect deps don't change every
  // parent re-render — otherwise every DesktopApp render (job streaming, WS
  // events, etc.) triggers a refetch storm that flickers the panel.
  const handleSelect = useCallback((category: string, slug: string) => {
    setActiveCategory(category)
    setActiveSlug(slug)
  }, [])

  const handleNotFound = useCallback(() => {
    setActiveCategory(undefined)
    setActiveSlug(undefined)
  }, [])

  useEffect(() => {
    if (!open || indexLoading) return
    const active = document.activeElement
    if (active === contentRef.current || active === document.body) filterRef.current?.focus()
  }, [open, indexLoading])

  const categories = index?.categories ?? []
  const total = categories.reduce((sum, c) => sum + c.docs.length, 0)
  const isDocView = Boolean(activeCategory && activeSlug)

  // Same skeleton as the Settings dialog: workspace size, icon header, left
  // nav + scrollable pane (full-bleed split body, each pane scrolls itself).
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent
        size="workspace"
        // Reachable from hints inside floating panels (chat, Flow), which sit
        // above the base layer: the guide must open over them, not behind.
        layer="stacked"
        movableResizable
        persistKey="specrails.modal.docs"
        data-testid="docs-modal"
        ref={contentRef}
        // Start in the filter: the sidebar is the way into every guide. While
        // the index still loads, park focus on the panel; the effect above
        // moves it to the filter once the sidebar mounts.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(filterRef.current ?? contentRef.current)?.focus()
        }}
      >
        <DialogHeader
          icon={<BookOpen />}
          actions={
            // Help ▸ Replay tour: the platform tour is re-opened from here (and ⌘K), not from the Welcome screen.
            <Button variant="ghost" size="sm" className="gap-1.5" data-testid="docs-replay-tour" onClick={() => { onClose(); replayTour() }}>
              <GraduationCap className="size-3.5" aria-hidden />
              {tOnboarding('help.replayTour')}
            </Button>
          }
        >
          <DialogTitle>{t('docs.title')}</DialogTitle>
          <DialogDescription>
            {indexLoading
              ? t('docs.loading')
              : total > 0
                ? t('docs.guideCount', { count: total })
                : t('docs.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex p-0 overflow-hidden">
          {indexLoading ? (
            <DocsSidebarSkeleton label={t('docs.loading')} />
          ) : (
            total > 0 && (
              <DocsSidebar
                categories={categories}
                activeCategory={activeCategory}
                activeSlug={activeSlug}
                onSelect={handleSelect}
                filterRef={filterRef}
              />
            )
          )}

          {/* Content */}
          <div
            ref={scrollRef}
            role="region"
            aria-label={t('docs.title')}
            className="min-w-0 flex-1 overflow-y-auto px-5 py-4"
          >
            {isDocView && activeCategory && activeSlug ? (
              <DocView
                category={activeCategory}
                slug={activeSlug}
                lang={lang}
                onNotFound={handleNotFound}
                onNavigate={handleSelect}
                scrollContainerRef={scrollRef}
                scrollRequest={scrollRequest}
                className="py-2 px-1"
              />
            ) : indexLoading ? null : total === 0 ? (
              <p className="mx-auto max-w-2xl text-body text-muted-foreground">{t('docs.indexEmpty')}</p>
            ) : (
              <p role="alert" className="mx-auto max-w-2xl text-sm text-destructive">{t('docs.loadError')}</p>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

// Memoise the whole dialog so DesktopApp re-renders (job streaming, WS events,
// theme provider, etc.) don't cascade into a markdown re-parse.
const DocsDialog = memo(DocsDialogImpl)
export default DocsDialog
