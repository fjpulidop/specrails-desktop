import { useEffect, useMemo, useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { BookOpen, Search } from 'lucide-react'
import { SHORTCUTS, type Shortcut } from '../hooks/useKeyboardShortcuts'
import { isMacKeyboard, keyboardLabel } from '../lib/keyboard-label'
import { API_ORIGIN } from '../lib/origin'
import { openDocs } from '../lib/docs-events'
import { Input } from './ui/input'
import { Kbd } from './ui/kbd'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog'

interface KeyboardShortcutsCheatsheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const CATEGORY_LABEL_KEYS: Record<Shortcut['category'], string> = {
  general: 'shortcuts.categories.general',
  navigation: 'shortcuts.categories.navigation',
  actions: 'shortcuts.categories.actions',
  missions: 'shortcuts.categories.missions',
}

const CATEGORY_ORDER: Shortcut['category'][] = ['general', 'navigation', 'actions', 'missions']

/** A guide page or section that matches the search (`GET /api/docs/search`). */
interface GuideMatch {
  category: string
  categoryName: string
  slug: string
  title: string
  heading: string | null
  anchor: string | null
}

const GUIDE_SEARCH_DEBOUNCE_MS = 200
const GUIDE_SEARCH_MIN_CHARS = 2

/** Case-insensitive match of a shortcut's description, keys or group against the query. */
export function filterShortcutGroups<T extends { label: string; shortcuts: Shortcut[] }>(
  groups: T[],
  query: string,
  describe: (shortcut: Shortcut) => string,
): T[] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return groups
  return groups
    .map((group) => ({
      ...group,
      shortcuts: group.shortcuts.filter((shortcut) =>
        group.label.toLocaleLowerCase().includes(q)
        || describe(shortcut).toLocaleLowerCase().includes(q)
        || keyboardLabel(shortcut.keys).toLocaleLowerCase().includes(q)),
    }))
    .filter((group) => group.shortcuts.length > 0)
}

/** Guide titles/headings matching `query` in the current language; null while unknown. */
function useGuideSearch(query: string, lang: string): { matches: GuideMatch[]; settled: boolean } {
  const [state, setState] = useState<{ query: string; matches: GuideMatch[] } | null>(null)
  const trimmed = query.trim()
  useEffect(() => {
    if (trimmed.length < GUIDE_SEARCH_MIN_CHARS) {
      setState(null)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`${API_ORIGIN}/api/docs/search?lang=${encodeURIComponent(lang)}&q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : { results: [] }))
        .then((data: { results?: GuideMatch[] }) => setState({ query: trimmed, matches: Array.isArray(data.results) ? data.results : [] }))
        .catch(() => { if (!controller.signal.aborted) setState({ query: trimmed, matches: [] }) })
    }, GUIDE_SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [trimmed, lang])
  return { matches: state?.query === trimmed ? state.matches : [], settled: state?.query === trimmed }
}

function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
  const { t } = useTranslation('commands')
  const keys = keyboardLabel(shortcut.keys).split(' ')
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-body text-muted-foreground">{t(shortcut.descriptionKey)}</span>
      <div className="flex items-center gap-1 ml-4 shrink-0">
        {keys.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </div>
    </div>
  )
}

export function KeyboardShortcutsCheatsheet({ open, onOpenChange }: KeyboardShortcutsCheatsheetProps) {
  const { t, i18n } = useTranslation('commands')
  const [query, setQuery] = useState('')
  const allGroups = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: t(CATEGORY_LABEL_KEYS[cat]),
    shortcuts: SHORTCUTS.filter((s) => s.category === cat && (!s.platform || s.platform === (isMacKeyboard() ? 'mac' : 'other'))),
  })).filter((g) => g.shortcuts.length > 0)
  const grouped = useMemo(
    () => filterShortcutGroups(allGroups, query, (shortcut) => t(shortcut.descriptionKey)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- groups derive from static data + t
    [query, t],
  )
  const searching = query.trim().length > 0
  const guide = useGuideSearch(open ? query : '', i18n.language || 'en')

  const openGuide = (match: GuideMatch) => {
    onOpenChange(false)
    openDocs({ category: match.category, slug: match.slug, anchor: match.anchor, heading: match.heading })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setQuery(''); onOpenChange(next) }}>
      <DialogContent size="form" data-testid="shortcuts-cheatsheet">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>
            <Trans i18nKey="shortcuts.subtitle" ns="commands">
              Press <Kbd>?</Kbd> anywhere to toggle this panel
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('shortcuts.searchPlaceholder')}
              aria-label={t('shortcuts.searchLabel')}
              data-testid="shortcuts-search"
              className="pl-8"
            />
          </div>
          {searching && grouped.length === 0 && (
            <p role="status" className="text-caption text-muted-foreground" data-testid="shortcuts-no-match">
              {t('shortcuts.noShortcuts', { query: query.trim() })}
            </p>
          )}
          {grouped.map((group) => (
            <div key={group.category}>
              <h3 className="text-label font-semibold text-muted-foreground mb-2">
                {group.label}
              </h3>
              <div className="divide-y divide-border/30">
                {group.shortcuts.map((s) => (
                  <ShortcutRow key={s.keys} shortcut={s} />
                ))}
              </div>
            </div>
          ))}
          {searching && (guide.matches.length > 0 || (guide.settled && grouped.length === 0)) && (
            <div data-testid="shortcuts-guides">
              <h3 className="text-label font-semibold text-muted-foreground mb-2">{t('shortcuts.guidesHeading')}</h3>
              {guide.matches.length === 0 ? (
                <p role="status" className="text-caption text-muted-foreground">{t('shortcuts.noGuides', { query: query.trim() })}</p>
              ) : (
                <ul className="divide-y divide-border/30">
                  {guide.matches.map((match) => (
                    <li key={`${match.category}/${match.slug}/${match.anchor ?? match.heading ?? ''}`}>
                      <button
                        type="button"
                        onClick={() => openGuide(match)}
                        aria-label={t('shortcuts.openGuide', { title: match.heading ? `${match.title} › ${match.heading}` : match.title })}
                        className="flex w-full items-center gap-2 rounded-control py-1.5 text-left text-body text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <BookOpen className="size-3.5 shrink-0" aria-hidden />
                        <span className="min-w-0 truncate" aria-hidden>
                          {match.title}
                          {match.heading && <span className="text-muted-foreground/80"> › {match.heading}</span>}
                        </span>
                        <span className="ml-auto shrink-0 text-caption text-muted-foreground/80" aria-hidden>{match.categoryName}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
