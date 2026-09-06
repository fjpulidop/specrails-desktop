import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Terminal } from '@xterm/xterm'
import { readClipboardText, writeClipboardText } from '../../lib/tauri-clipboard'

interface Props {
  /** Anchor coordinates (clientX/Y) where the menu should appear. */
  x: number
  y: number
  term: Terminal
  cwd: string | null
  /** Whether this runtime can do "Open this directory" (Tauri only). */
  hasReveal: boolean
  onClose: () => void
  onOpenSearch: () => void
  onReveal: (path: string) => void
  onSaveScrollback: () => void
}

/**
 * A minimal positioned context menu for the active terminal viewport. We avoid
 * Radix because the whole flow is keyboard- and mouse-triggered relative to a
 * canvas target; a plain absolutely-positioned div with click-outside dismissal
 * is enough.
 */
export function TerminalContextMenu({ x, y, term, cwd, hasReveal, onClose, onOpenSearch, onReveal, onSaveScrollback }: Props) {
  const { t } = useTranslation('terminal')
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Flip when near right/bottom edges of the viewport so the menu does not overflow.
  const flippedX = typeof window !== 'undefined' && x + 220 > window.innerWidth ? x - 220 : x
  const flippedY = typeof window !== 'undefined' && y + 260 > window.innerHeight ? y - 260 : y

  const modifier = /Mac/i.test(navigator.platform || '') ? '⌘' : 'Ctrl+'
  const selection = term.getSelection()
  const hasSelection = selection.length > 0

  function copy() {
    if (!hasSelection) return
    void writeClipboardText(selection)
    onClose()
  }
  function paste() {
    void readClipboardText().then((t) => {
      if (t) { try { term.paste(t) } catch { /* ignore */ } }
    })
    onClose()
  }
  function selectAll() {
    try { term.selectAll() } catch { /* ignore */ }
    onClose()
  }
  function clear() {
    try { term.clear() } catch { /* ignore */ }
    onClose()
  }
  function search() {
    onOpenSearch(); onClose()
  }
  function save() {
    onSaveScrollback(); onClose()
  }
  function reveal() {
    if (cwd) onReveal(cwd)
    onClose()
  }

  return (
    <div
      ref={ref}
      role="menu"
      data-terminal-context-menu
      style={{ position: 'fixed', left: flippedX, top: flippedY, minWidth: 200 }}
      className="bg-[#1f1f29] border border-[#44475a] rounded-md shadow-lg py-1 z-50 text-sm"
    >
      <Item onClick={copy} disabled={!hasSelection} label={t('common:actions.copy')} shortcut={modifier + 'C'} />
      <Item onClick={paste} label={t('contextMenu.paste')} shortcut={modifier + 'V'} />
      <Item onClick={selectAll} label={t('contextMenu.selectAll')} shortcut={modifier + 'A'} />
      <Divider />
      <Item onClick={clear} label={t('contextMenu.clear')} shortcut={modifier + 'K'} />
      <Item onClick={search} label={t('contextMenu.search')} shortcut={modifier + 'F'} />
      <Item onClick={save} label={t('contextMenu.saveScrollback')} />
      {cwd && hasReveal && (
        <>
          <Divider />
          <Item onClick={reveal} label={t('contextMenu.openPath', { path: truncate(cwd, 40) })} />
        </>
      )}
    </div>
  )
}

function Item({ onClick, label, shortcut, disabled }: { onClick: () => void; label: string; shortcut?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => { if (!disabled) onClick() }}
      disabled={disabled}
      className={`w-full text-left px-3 py-1.5 flex justify-between items-center ${disabled ? 'text-[#6272a4] cursor-not-allowed' : 'text-[#f8f8f2] hover:bg-[#44475a]'}`}
    >
      <span>{label}</span>
      {shortcut && <span className="text-xs text-[#6272a4] tabular-nums">{shortcut}</span>}
    </button>
  )
}

function Divider() {
  return <div className="my-1 border-t border-[#44475a]" />
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return '…' + s.slice(s.length - n + 1)
}
