import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchAddon } from '@xterm/addon-search'
import { ChevronUp, ChevronDown, X } from 'lucide-react'

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
      decorations: {
        matchBackground: '#bd93f9',
        matchOverviewRuler: '#bd93f9',
        activeMatchBackground: '#ff79c6',
        activeMatchColorOverviewRuler: '#ff79c6',
      },
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
      className="absolute top-2 right-2 flex items-center gap-1 bg-[#1f1f29] border border-[#44475a] rounded-md shadow-lg px-2 py-1 z-30"
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
        className="bg-transparent text-sm outline-none text-[#f8f8f2] placeholder:text-[#6272a4] w-48"
      />
      {matchInfo && (
        <span className="text-xs text-[#6272a4] tabular-nums">
          {matchInfo.current}/{matchInfo.total}
        </span>
      )}
      <button
        type="button"
        title={t('search.previous')}
        onClick={findPrev}
        className="text-[#f8f8f2] hover:text-white p-1"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        title={t('search.next')}
        onClick={findNext}
        className="text-[#f8f8f2] hover:text-white p-1"
      >
        <ChevronDown size={14} />
      </button>
      <ToggleButton label="Aa" title={t('search.matchCase')} active={caseSensitive} onToggle={() => setCaseSensitive((v) => !v)} />
      <ToggleButton label=".*" title={t('search.regex')} active={regex} onToggle={() => setRegex((v) => !v)} />
      <ToggleButton label="W" title={t('search.wholeWord')} active={wholeWord} onToggle={() => setWholeWord((v) => !v)} />
      <button
        type="button"
        title={t('search.close')}
        onClick={onClose}
        className="text-[#f8f8f2] hover:text-white p-1"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function ToggleButton({ label, title, active, onToggle }: { label: string; title: string; active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onToggle}
      className={`text-xs px-1.5 py-0.5 rounded font-mono ${active ? 'bg-[#6272a4] text-white' : 'text-[#f8f8f2] hover:bg-[#44475a]'}`}
    >
      {label}
    </button>
  )
}
