import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTerminals } from '../../context/TerminalsContext'
import { TerminalSearchOverlay } from './TerminalSearchOverlay'
import { TerminalContextMenu } from './TerminalContextMenu'
import { revealItemInDir, isTauri } from '../../lib/tauri-shell'
import { saveScrollbackToFile } from '../../lib/save-scrollback'
import { quotePathList, windowsShellHint } from '../../lib/shell-quote'
import { writeClipboardText } from '../../lib/tauri-clipboard'
import { PromptGutter } from './PromptGutter'
import { CommandTimingBadge } from './CommandTimingBadge'

interface TerminalViewportProps {
  activeId: string | null
}

/**
 * The viewport slot. Reparents the active session's container DOM node from the
 * hidden terminal host into this element's subtree, and moves it back on unmount
 * or when the active session changes. Never unmounts xterm.
 *
 * Also listens to `transitionend` on ancestor sidebar elements so that, when a
 * sidebar finishes animating, we issue an immediate refit. This complements the
 * trailing-debounced ResizeObserver inside TerminalsContext: the transitionend
 * is the "settle" signal, and the debounced fit is the catch-all.
 */
export function TerminalViewport({ activeId }: TerminalViewportProps) {
  const { t } = useTranslation('terminal')
  const slotRef = useRef<HTMLDivElement | null>(null)
  const terminals = useTerminals()
  const [searchOpen, setSearchOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const tauri = isTauri()

  // Subscribe to "open search overlay" requests for the active session.
  useEffect(() => {
    if (!activeId) return
    return terminals.subscribeOpenSearch(activeId, () => setSearchOpen(true))
  }, [activeId, terminals])

  // Close search and any open menu when the active session changes.
  useEffect(() => { setSearchOpen(false); setMenu(null) }, [activeId])

  const search = activeId ? terminals.getSearchAddon(activeId) : null
  const term = activeId ? terminals.getTerminalInstance(activeId) : null
  const cwd = activeId ? terminals.getCwd(activeId) : null
  const [dragOver, setDragOver] = useState(false)

  const writeToActiveTerminal = useCallback((text: string): boolean => {
    if (!text) return false
    if (activeId && terminals.writeToSession(activeId, text)) return true
    if (!term) return false
    try {
      term.paste(text)
      return true
    } catch {
      return false
    }
  }, [activeId, terminals, term])

  const pasteDroppedFiles = useCallback((files: FileList | null | undefined): boolean => {
    if (!term || !files || files.length === 0) return false
    const paths = Array.from(files)
      .map((file) => getNativeFilePath(file))
      .filter((path): path is string => Boolean(path))
    if (paths.length === 0) return false
    const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '')
    try { return writeToActiveTerminal(quotePathList(paths, isWindows, windowsShellHint(activeId ? terminals.getShell?.(activeId) : null))) }
    catch { toast.error(t('errors.pathPasteUnsafe')); return false }
  }, [term, writeToActiveTerminal, activeId, terminals, t])

  const handleContextMenu = useCallback((ev: React.MouseEvent) => {
    // Always preventDefault so the WebView's native contextmenu does not show.
    ev.preventDefault()
    // Defer to the running app (tmux, vim, htop) when it has enabled mouse
    // tracking — but only when Shift is NOT held. Shift-right-click forces our
    // menu so the user can still get to Copy/Save when an alt-screen app is up.
    if (!ev.shiftKey && term) {
      const mode = (term as unknown as { modes?: { mouseTrackingMode?: string } }).modes?.mouseTrackingMode
      if (mode && mode !== 'none') return
    }
    setMenu({ x: ev.clientX, y: ev.clientY })
  }, [term])

  const handlePaste = useCallback((ev: React.ClipboardEvent<HTMLDivElement>) => {
    if (!term) return
    if (ev.clipboardData.files && ev.clipboardData.files.length > 0) {
      const paths = Array.from(ev.clipboardData.files)
        .map((file) => getNativeFilePath(file))
        .filter((path): path is string => Boolean(path))
      if (paths.length > 0) {
        ev.preventDefault()
        ev.stopPropagation()
        const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '')
        try { writeToActiveTerminal(quotePathList(paths, isWindows, windowsShellHint(activeId ? terminals.getShell?.(activeId) : null))) }
        catch { toast.error(t('errors.pathPasteUnsafe')) }
        return
      }
    }
    const text = ev.clipboardData.getData('text/plain')
    if (!text) return
    ev.preventDefault()
    ev.stopPropagation()
    writeToActiveTerminal(text)
  }, [term, writeToActiveTerminal, activeId, terminals, t])

  const handleCopy = useCallback((ev: React.ClipboardEvent<HTMLDivElement>) => {
    if (!term) return
    const selection = term.getSelection()
    if (!selection) return
    ev.clipboardData.setData('text/plain', selection)
    ev.preventDefault()
    ev.stopPropagation()
  }, [term])

  const handleKeyDownCapture = useCallback((ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (!term) return
    const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')
    const cmd = isMac ? ev.metaKey : ev.ctrlKey
    if (!cmd) return
    if (ev.key === 'c' || ev.key === 'C') {
      const selection = term.getSelection()
      if (!selection) return
      ev.preventDefault()
      ev.stopPropagation()
      void writeClipboardText(selection)
    }
  }, [term])

  useEffect(() => {
    const slot = slotRef.current
    if (!slot || !activeId) return
    const container = terminals.getContainer(activeId)
    if (!container) return
    slot.appendChild(container)
    terminals.notifyAdopted(activeId)
    return () => {
      const host = document.getElementById('specrails-terminal-host')
      if (host && container.parentElement === slot) {
        host.appendChild(container)
      }
    }
  }, [activeId, terminals])

  // transitionend → immediate refit. Walk ancestors to find sidebar-like elements.
  useEffect(() => {
    const slot = slotRef.current
    if (!slot || !activeId) return
    const ancestors: Element[] = []
    let cur: Element | null = slot.parentElement
    while (cur && cur !== document.body) {
      const tag = cur.tagName.toLowerCase()
      if (tag === 'aside' || cur.matches('[data-sidebar]')) {
        ancestors.push(cur)
      }
      cur = cur.parentElement
    }
    if (ancestors.length === 0) return
    const onTransitionEnd = (ev: Event) => {
      const tev = ev as TransitionEvent
      if (tev.propertyName !== 'width' && tev.propertyName !== 'height') return
      terminals.refitActive(activeId)
    }
    ancestors.forEach((a) => a.addEventListener('transitionend', onTransitionEnd))
    return () => {
      ancestors.forEach((a) => a.removeEventListener('transitionend', onTransitionEnd))
    }
  }, [activeId, terminals])

  return (
    <div
      ref={slotRef}
      className={`flex-1 min-w-0 bg-background px-2 py-1 relative ${dragOver ? 'outline outline-2 outline-accent-primary outline-offset-[-2px]' : ''}`}
      role="presentation"
      data-terminal-viewport
      onContextMenu={handleContextMenu}
      onPasteCapture={handlePaste}
      onCopyCapture={handleCopy}
      onKeyDownCapture={handleKeyDownCapture}
      tabIndex={-1}
      onDragEnter={(e) => {
        if (hasFileTransfer(e.dataTransfer)) {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }
      }}
      onDragOver={(e) => {
        if (hasFileTransfer(e.dataTransfer)) {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (hasFileTransfer(e.dataTransfer)) {
          e.preventDefault()
          e.stopPropagation()
          pasteDroppedFiles(e.dataTransfer.files)
        }
        setDragOver(false)
      }}
    >
      {activeId && <PromptGutter sessionId={activeId} />}
      {activeId && <CommandTimingBadge sessionId={activeId} />}
      {searchOpen && search && (
        <TerminalSearchOverlay search={search} onClose={() => setSearchOpen(false)} />
      )}
      {menu && term && (
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          term={term}
          cwd={cwd}
          hasReveal={tauri}
          onClose={() => setMenu(null)}
          onOpenSearch={() => setSearchOpen(true)}
          onReveal={(p) => { void revealItemInDir(p).catch(() => toast.error(t('errors.nativeActionFailed'))) }}
          onSaveScrollback={() => { if (term) void saveScrollbackToFile(term).catch(() => toast.error(t('errors.nativeActionFailed'))) }}
        />
      )}
    </div>
  )
}

function getNativeFilePath(file: File): string | null {
  const path = (file as File & { path?: unknown }).path
  if (typeof path === 'string' && path.length > 0) return path
  return null
}

function hasFileTransfer(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return Array.from(dataTransfer.types).includes('Files')
}
