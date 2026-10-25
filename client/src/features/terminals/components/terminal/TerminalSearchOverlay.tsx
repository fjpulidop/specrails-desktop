import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchAddon } from '@xterm/addon-search'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { useThemeOptional } from '../../../settings/context/ThemeContext'
import { searchDecorations } from '../../lib/search-decorations'

interface Props {
  search: SearchAddon
  onClose: () => void
}

/**
 * In-panel scrollback search. Uses xterm's addon-search for both navigation
 * (`findNext` / `findPrevious`) and inline highlighting (decorations).
 *
 * Visual: anchored top-right of the terminal viewport. Closes on Escape or X.
 */
export function TerminalSearchOverlay({ search, onClose }: Props) {
  const { t } = useTranslation('terminal')
  // Highlight colours follow the active theme's xterm palette.
  const xtermPalette = useThemeOptional()?.theme.xterm ?? null
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [matchInfo, setMatchInfo] = useState<{ current: number; total: number } | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      try { search.clearDecorations() } catch { /* ignore */ }
    }
  }, [search])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function options() {
    return {
      caseSensitive,
      regex,
      wholeWord,
      decorations: searchDecorations(xtermPalette),
    }
  }

  function findNext() {
    if (!query) return
    try { search.findNext(query, options()) } catch { /* ignore */ }
  }
  function findPrev() {
    if (!query) return
    try { search.findPrevious(query, options()) } catch { /* ignore */ }
  }

  // Subscribe to results-changed for the match-count badge.
  useEffect(() => {
    let cleanup = () => {}
    try {
      const handler = search.onDidChangeResults((ev) => {
        if (!ev) { setMatchInfo(null); return }
        setMatchInfo({ current: ev.resultIndex + 1, total: ev.resultCount })
      })
      cleanup = () => { try { handler.dispose() } catch { /* ignore */ } }
    } catch { /* older addon-search may not expose this; ignore */ }
    return cleanup
  }, [search])

  return (
    <div
      className="absolute top-2 right-2 flex items-center gap-1 bg-popover border border-border rounded-md shadow-lg px-2 py-1 z-30 focus-within:ring-2 focus-within:ring-ring"
      role="search"
      data-terminal-search-overlay
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) findPrev(); else findNext() }
        }}
        placeholder={t('search.placeholder')}
        className="bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring text-popover-foreground placeholder:text-muted-foreground w-48"
      />
      {matchInfo && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {matchInfo.current}/{matchInfo.total}
        </span>
      )}
      <button
        type="button"
        title={t('search.previous')}
        aria-label={t('search.previous')}
        onClick={findPrev}
        className="text-popover-foreground hover:text-foreground p-1"
      >
        <ChevronUp size={14} aria-hidden />
      </button>
      <button
        type="button"
        title={t('search.next')}
        aria-label={t('search.next')}
        onClick={findNext}
        className="text-popover-foreground hover:text-foreground p-1"
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      <ToggleButton label="Aa" title={t('search.matchCase')} active={caseSensitive} onToggle={() => setCaseSensitive((v) => !v)} />
      <ToggleButton label=".*" title={t('search.regex')} active={regex} onToggle={() => setRegex((v) => !v)} />
      <ToggleButton label="W" title={t('search.wholeWord')} active={wholeWord} onToggle={() => setWholeWord((v) => !v)} />
      <button
        type="button"
        title={t('search.close')}
        aria-label={t('search.close')}
        onClick={onClose}
        className="text-popover-foreground hover:text-foreground p-1"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}

function ToggleButton({ label, title, active, onToggle }: { label: string; title: string; active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onToggle}
      className={`text-xs px-1.5 py-0.5 rounded font-mono ${active ? 'bg-primary text-primary-foreground' : 'text-popover-foreground hover:bg-accent'}`}
    >
      {label}
    </button>
  )
}
