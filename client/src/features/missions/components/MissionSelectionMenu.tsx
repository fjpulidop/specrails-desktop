import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useLocation, useInRouterContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronRight, GitFork, MessageSquarePlus, Plus, LoaderCircle } from 'lucide-react'
import { notifyError } from '../../../lib/notify-error'
import { useUiMode } from '../../../context/UiModeContext'
import { LAYER_CLASS } from '../../../lib/layers'
import { ApiResponseError } from '../../../lib/api-response'
import { useAgentChat } from '../context/AgentChatContext'
import { useMissionSplitViews } from '../context/MissionSplitViewsContext'
import { branchAgentConversation } from '../lib/agent-api'
import { writeComposerDraft } from '../lib/agent-composer-drafts'

/** The Range is in document order even when the person selects backwards. Both
 * ends must be committed messages of THIS transcript, never another pane or editor. */
export function readMissionSelection(root: HTMLElement, selection: Selection | null) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const segments = [...root.querySelectorAll<HTMLElement>('[data-mission-message]')].flatMap(message => {
    if (!range.intersectsNode(message)) return []
    const part = range.cloneRange()
    if (!message.contains(range.startContainer)) part.setStart(message, 0)
    if (!message.contains(range.endContainer)) part.setEnd(message, message.childNodes.length)
    return part.toString().trim() ? [{ message, text: part.toString() }] : []
  })
  const text = selection.toString()
  const throughMessageId = segments[segments.length - 1]?.message.dataset.missionMessage
  // Reject text from a live tail, queued input, or any other non-message UI.
  const compact = (value: string) => value.replace(/\s/g, '')
  if (!text.trim() || !throughMessageId || compact(text) !== compact(segments.map(segment => segment.text).join(''))) return null
  return { text, throughMessageId, range }
}

type Snapshot = { text: string; throughMessageId: string; sourceId: string; queueId: string; x: number; y: number; send: ReturnType<typeof useAgentChat>['send'] }

/** Appears on selection, with right-click / Shift+F10 as keyboard alternatives.
 * Captures the source send closure before focus or the active panel can change. */
export function MissionSelectionMenu({ children }: { children: ReactNode }) {
  // Conversation surfaces also mount in isolated hosts without a route. Only
  // the app shell needs navigation when leaving a board/settings screen.
  const routed = useInRouterContext()
  return routed ? <RoutedSelectionMenu>{children}</RoutedSelectionMenu> : <SelectionMenuContent>{children}</SelectionMenuContent>
}

function RoutedSelectionMenu({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return <SelectionMenuContent showMissionRoute={() => { if (pathname !== '/') navigate('/') }}>{children}</SelectionMenuContent>
}

function SelectionMenuContent({ children, showMissionRoute }: { children: ReactNode; showMissionRoute?: () => void }) {
  const { t } = useTranslation('agent')
  const { active, send, refreshConversations, providersReady } = useAgentChat()
  const split = useMissionSplitViews()
  const { uiMode, toggleUiMode } = useUiMode()
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const origin = useRef<HTMLElement | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [submenu, setSubmenu] = useState(false)
  const [pending, setPending] = useState(false)

  const dismiss = (restoreFocus = false) => {
    setSnapshot(null)
    setSubmenu(false)
    if (restoreFocus) origin.current?.focus({ preventScroll: true })
  }
  const capture = (position?: { x: number; y: number }, keyboard = false) => {
    if (!active || !root.current || busy.current) return false
    const selected = readMissionSelection(root.current, window.getSelection())
    if (!selected) { dismiss(); return false }
    const rect = selected.range.getBoundingClientRect()
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSnapshot(previous => ({ text: selected.text, throughMessageId: selected.throughMessageId, sourceId: active.id,
      queueId: previous?.sourceId === active.id && previous.text === selected.text && previous.throughMessageId === selected.throughMessageId ? previous.queueId : `selection-${crypto.randomUUID()}`, send, x: position?.x ?? rect.left, y: position?.y ?? rect.bottom + 8 }))
    setSubmenu(false)
    if (keyboard) requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }))
    return true
  }

  useLayoutEffect(() => {
    if (!snapshot || !menu.current) return
    const rect = menu.current.getBoundingClientRect()
    menu.current.style.left = `${Math.max(8, Math.min(snapshot.x, window.innerWidth - rect.width - 8))}px`
    menu.current.style.top = `${Math.max(8, Math.min(snapshot.y, window.innerHeight - rect.height - 8))}px`
  }, [snapshot, submenu, pending])

  useEffect(() => {
    if (!snapshot) return
    const pointer = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) dismiss() }
    const change = () => {
      if (!menu.current?.contains(document.activeElement) && !window.getSelection()?.toString().trim()) dismiss()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        event.preventDefault()
        menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
      }
      if (event.key === 'Escape') { event.preventDefault(); dismiss(true) }
      if (event.key === 'Tab') dismiss()
    }
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) dismiss() }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', key)
    document.addEventListener('selectionchange', change)
    window.addEventListener('resize', scroll)
    document.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', pointer)
      document.removeEventListener('keydown', key)
      document.removeEventListener('selectionchange', change)
      window.removeEventListener('resize', scroll)
      document.removeEventListener('scroll', scroll, true)
    }
  }, [snapshot])

  const act = async (mode: 'send' | 'empty' | 'fork') => {
    if (!snapshot || busy.current) return
    busy.current = true
    setPending(true)
    try {
      if (mode === 'send') {
        const result = await snapshot.send(snapshot.text, { queueId: snapshot.queueId })
        if (!result.accepted) return // keep selection and retry identity; the send path reports the error
      } else {
        const conversation = await branchAgentConversation(snapshot.sourceId, snapshot.throughMessageId, mode)
        writeComposerDraft(conversation.id, snapshot.text, [])
        split.open(conversation.id, { focusComposer: true })
        if (uiMode !== 'agent') toggleUiMode()
        showMissionRoute?.()
        void refreshConversations()
      }
      dismiss(mode === 'send')
    } catch (error) {
      notifyError(error instanceof ApiResponseError && error.code === 'endpointUnavailable'
        ? error.message : t('selection.failed'))
    } finally { busy.current = false; setPending(false) }
  }
  const itemClass = 'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50'
  return <div ref={root} className="contents" onPointerUp={event => {
    if (event.button === 0 && root.current?.contains(event.target as Node)) capture()
  }} onContextMenu={event => {
    if (capture({ x: event.clientX, y: event.clientY })) { event.preventDefault(); event.stopPropagation() }
  }} onKeyUp={event => {
    if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) capture()
  }} onKeyDown={event => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      if (capture(undefined, true)) { event.preventDefault(); event.stopPropagation() }
    }
  }}>
    {children}
    {snapshot && createPortal(<div ref={menu} role="menu" aria-label={t('selection.menu')} aria-busy={pending || undefined}
      className={`fixed ${LAYER_CLASS.popover} w-72 max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl`}
      style={{ left: Math.max(8, Math.min(snapshot.x, window.innerWidth - 296)), top: Math.max(8, Math.min(snapshot.y, window.innerHeight - (submenu ? 210 : 100))) }}
      onPointerDown={event => event.preventDefault()} onKeyDown={event => {
        // Portal events bubble through the transcript; keep menu navigation local.
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); dismiss(true) }
        if (event.key === 'Tab') dismiss()
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
          buttons[next]?.focus()
        }
        if (event.key === 'ArrowRight') { event.preventDefault(); setSubmenu(true) }
        if (event.key === 'ArrowLeft') { event.preventDefault(); setSubmenu(false) }
      }}>
      {pending && <div role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />{t('selection.working')}</div>}
      <button type="button" role="menuitem" disabled={pending} aria-haspopup="menu" aria-expanded={submenu} className={itemClass} onClick={() => setSubmenu(value => !value)}>
        <Plus className="h-4 w-4 shrink-0" />{t('selection.start')}<ChevronRight className="ml-auto h-4 w-4" />
      </button>
      {submenu && <div role="menu" aria-label={t('selection.start')} className="ml-3 border-l border-border pl-1">
        <button type="button" role="menuitem" disabled={pending} className={itemClass} onClick={() => void act('empty')}>
          <Plus className="h-4 w-4 shrink-0" /><span>{t('selection.empty')}<span className="block text-xs text-muted-foreground">{t('selection.emptyHint')}</span></span>
        </button>
        <button type="button" role="menuitem" disabled={pending} className={itemClass} onClick={() => void act('fork')}>
          <GitFork className="h-4 w-4 shrink-0" /><span>{t('selection.fork')}<span className="block text-xs text-muted-foreground">{t('selection.forkHint')}</span></span>
        </button>
      </div>}
      <button type="button" role="menuitem" disabled={pending || !!active?.archivedAt || providersReady === false} className={itemClass} onClick={() => void act('send')}>
        <MessageSquarePlus className="h-4 w-4 shrink-0" />{t('selection.add')}
      </button>
    </div>, document.body)}
  </div>
}
