import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { useUiMode } from '../../../context/UiModeContext'
import { Columns2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMissionSplitViews } from '../context/MissionSplitViewsContext'

/** Right-click or Shift+F10 opens the same action without selecting the row. */
export function MissionConversationMenu({ conversationId, children, onOpen }: {
  conversationId: string; children: ReactNode; onOpen?: () => void
}) {
  const { t } = useTranslation('agent')
  const split = useMissionSplitViews()
  const navigate = useNavigate()
  const location = useLocation()
  const { uiMode, toggleUiMode } = useUiMode()
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const dismiss = () => { setPosition(null); trigger.current?.focus() }
  useEffect(() => {
    if (!position) return
    const down = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setPosition(null) }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
        dismiss()
      }
    }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key) }
  }, [position])
  return <div ref={root} onContextMenu={event => {
    event.preventDefault(); event.stopPropagation()
    trigger.current = root.current?.querySelector<HTMLElement>('[tabindex="0"]') ?? null
    setPosition({ x: event.clientX, y: event.clientY })
  }} onKeyDown={event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault(); event.stopPropagation()
    trigger.current = event.target as HTMLElement
    const rect = event.currentTarget.getBoundingClientRect()
    setPosition({ x: rect.left, y: rect.bottom })
  }}>
    {children}
    {position && createPortal(<div ref={menu} role="menu" aria-label={t('split.menu')}
      className="fixed z-[100] w-48 rounded-lg border border-border bg-popover p-1 shadow-xl"
      style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 200)), top: Math.max(8, Math.min(position.y, window.innerHeight - 52)) }}>
      <button autoFocus type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
        onClick={event => { event.stopPropagation(); split.open(conversationId); if (uiMode !== 'agent') toggleUiMode(); if (location.pathname !== '/') navigate('/'); onOpen?.(); dismiss() }}>
        <Columns2 className="h-4 w-4" />{t('split.open')}
      </button>
    </div>, document.body)}
  </div>
}
