import { useAgentChat } from '../context/AgentChatContext'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { useUiMode } from '../../../context/UiModeContext'
import { PanelBottom, PanelRight, PanelsTopLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMissionSplitViews, type SplitSide } from '../context/MissionSplitViewsContext'

const ITEMS: { key: string; side?: SplitSide; Icon: typeof PanelRight }[] = [
  { key: 'split.open', Icon: PanelsTopLeft },
  { key: 'split.openRight', side: 'right', Icon: PanelRight },
  { key: 'split.openBelow', side: 'down', Icon: PanelBottom },
]

/** Right-click or Shift+F10 offers the split actions without selecting the row:
 * Split view (right of the focused pane when it is wide enough, else below),
 * Open to the right and Open below. Arrows, Home/End move; Escape closes. */
export function MissionConversationMenu({ conversationId, children, onOpen }: {
  conversationId: string; children: ReactNode; onOpen?: () => void
}) {
  const { t } = useTranslation('agent')
  const split = useMissionSplitViews()
  const navigate = useNavigate()
  const location = useLocation()
  const { uiMode, toggleUiMode } = useUiMode()
  const { active } = useAgentChat()
  const visible = uiMode === 'agent' && location.pathname === '/' && (split.conversationIds.includes(conversationId) || split.primaryVisible && active?.id === conversationId)
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
  const openSplit = (side?: SplitSide) => {
    if (side) split.openBeside(conversationId, side)
    else split.open(conversationId)
    if (uiMode !== 'agent') toggleUiMode()
    if (location.pathname !== '/') navigate('/')
    onOpen?.()
    dismiss()
  }
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }
  return <div ref={root} onContextMenu={event => {
    event.preventDefault(); event.stopPropagation()
    trigger.current = root.current?.querySelector<HTMLElement>('button') ?? null
    if (visible) { setPosition(null); return }
    setPosition({ x: event.clientX, y: event.clientY })
  }} onKeyDown={event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault(); event.stopPropagation()
    if (visible) { setPosition(null); return }
    trigger.current = event.target as HTMLElement
    const rect = event.currentTarget.getBoundingClientRect()
    setPosition({ x: rect.left, y: rect.bottom })
  }}>
    {children}
    {position && !visible && createPortal(<div ref={menu} role="menu" aria-label={t('split.menu')} onKeyDown={onMenuKeyDown}
      className="fixed z-[100] w-52 rounded-card border border-border bg-popover p-1 shadow-2"
      style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 216)), top: Math.max(8, Math.min(position.y, window.innerHeight - 120)) }}>
      {ITEMS.map(({ key, side, Icon }, index) => <button key={key} autoFocus={index === 0} type="button" role="menuitem" tabIndex={index === 0 ? 0 : -1}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
        onClick={event => { event.stopPropagation(); openSplit(side) }}>
        <Icon className="h-3.5 w-3.5" aria-hidden />{t(key)}
      </button>)}
    </div>, document.body)}
  </div>
}
