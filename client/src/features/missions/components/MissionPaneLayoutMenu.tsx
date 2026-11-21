import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowLeftRight, Columns2, Maximize2, SquareSplitHorizontal, Minimize2, PanelBottom, PanelRight, Rows2, X, ChevronLeft,
} from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu'
import { Kbd } from '../../../components/ui/kbd'
import { keyboardLabel } from '../../../lib/keyboard-label'
import { cn } from '../../../lib/utils'
import { useAgentChat } from '../context/AgentChatContext'
import { useMissionWindows } from '../context/MissionWindowsContext'
import { PRIMARY_PANE, useMissionPaneId, useMissionSplitViews, type SplitSide } from '../context/MissionSplitViewsContext'
import { fitsIn, movePaneInDirection, sameShape, splitLeaves, splitPane } from '../lib/mission-split-tree'
import { MISSION_SPLIT_KEYS } from '../lib/mission-split-keys'

type Mode = { kind: 'main' } | { kind: 'open'; side: SplitSide } | { kind: 'swap' }
const MAX_MISSIONS = 8
const ITEM = 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground'

const MOVES: { side: SplitSide; key: 'moveLeft' | 'moveRight' | 'moveUp' | 'moveDown'; Icon: typeof ArrowLeft }[] = [
  { side: 'left', key: 'moveLeft', Icon: ArrowLeft },
  { side: 'right', key: 'moveRight', Icon: ArrowRight },
  { side: 'up', key: 'moveUp', Icon: ArrowUp },
  { side: 'down', key: 'moveDown', Icon: ArrowDown },
]

function focusFirstItem() {
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-pane-layout-menu] [role="menuitem"]:not([aria-disabled="true"])')?.focus())
}

/**
 * A pane's layout menu in its header: open a mission beside it, move it, swap
 * it, zoom it, share the space evenly or close it. Actions that would leave a
 * pane below its minimum size are disabled with the reason as their title.
 */
export function MissionPaneLayoutMenu() {
  const paneId = useMissionPaneId()
  const { t } = useTranslation('agent')
  const { maximizedId } = useMissionSplitViews()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>({ kind: 'main' })
  if (!paneId) return null
  const maximized = maximizedId === paneId
  return <DropdownMenu open={open} onOpenChange={next => { setOpen(next); if (!next) setMode({ kind: 'main' }) }}>
    <DropdownMenuTrigger aria-label={t('split.layoutMenu')} title={t('split.layoutMenu')} data-testid="mission-pane-layout-trigger"
      className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface hover:text-foreground',
        (open || maximized) && 'bg-surface text-foreground')}>
      {/* Not a panel glyph: the title bar's sidebar toggle already is one. */}
      {maximized ? <Minimize2 className="h-4 w-4" aria-hidden /> : <SquareSplitHorizontal className="h-4 w-4" aria-hidden />}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-60" data-pane-layout-menu aria-label={t('split.layoutMenu')}>
      <PaneLayoutItems paneId={paneId} mode={mode} setMode={setMode} />
    </DropdownMenuContent>
  </DropdownMenu>
}

/** The menu's items, computed only while the menu is open. */
function PaneLayoutItems({ paneId, mode, setMode }: { paneId: string; mode: Mode; setMode(mode: Mode): void }) {
  const { t } = useTranslation('agent')
  const split = useMissionSplitViews()
  const { conversations = [] } = useAgentChat()
  const windows = useMissionWindows()
  const panes = useMemo(() => splitLeaves(split.tree), [split.tree])
  const onScreen = new Set(panes.map(id => id === PRIMARY_PANE ? split.primaryId : id))
  const multiple = panes.length > 1
  const maximized = split.maximizedId === paneId
  const size = split.layoutSize()
  const room = (tree: ReturnType<typeof splitPane> | null) => !tree || size.width <= 0 || fitsIn(tree, size)
  const title = (id: string) => {
    const conversationId = id === PRIMARY_PANE ? split.primaryId : id
    if (!conversationId) return t('mission.new')
    return conversations.find(conversation => conversation.id === conversationId)?.title?.trim() || t('untitled')
  }
  const detached = new Set((windows.transfers ?? []).filter(item => item.state === 'detached').map(item => item.conversationId))
  const candidates = conversations
    .filter(conversation => !conversation.archivedAt && !onScreen.has(conversation.id) && !detached.has(conversation.id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, MAX_MISSIONS)
  const noRoom = t('split.noRoom')
  const switchTo = (next: Mode) => { setMode(next); focusFirstItem() }
  const modeItem = (label: string, Icon: typeof ArrowLeft, next: Mode, disabled = false, hint?: string) => (
    <button type="button" role="menuitem" tabIndex={-1} aria-haspopup="menu" aria-disabled={disabled || undefined} disabled={disabled}
      title={disabled ? hint : undefined} className={cn(ITEM, 'disabled:pointer-events-none disabled:opacity-50')}
      onClick={() => { if (!disabled) switchTo(next) }}>
      <Icon className="h-3.5 w-3.5" aria-hidden /><span className="flex-1">{label}</span><span aria-hidden className="text-muted-foreground">›</span>
    </button>
  )
  const shortcut = (keys: string) => <Kbd className="ml-auto" aria-hidden>{keyboardLabel(keys)}</Kbd>

  const content = mode.kind === 'main' ? <>
    {modeItem(t('split.splitRight'), PanelRight, { kind: 'open', side: 'right' })}
    {modeItem(t('split.splitDown'), PanelBottom, { kind: 'open', side: 'down' })}
    {multiple && <>
      <DropdownMenuSeparator />
      {MOVES.map(({ side, key, Icon }) => {
        const next = movePaneInDirection(split.tree, paneId, side)
        const noop = sameShape(next, split.tree)
        const fits = room(next)
        return <DropdownMenuItem key={side} disabled={noop || !fits} title={!noop && !fits ? noRoom : undefined} onSelect={() => split.move(paneId, side)}>
          <Icon className="h-3.5 w-3.5" aria-hidden />{t(`split.${key}`)}
        </DropdownMenuItem>
      })}
      {modeItem(t('split.swap'), ArrowLeftRight, { kind: 'swap' })}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => split.toggleMaximize(paneId)}>
        {maximized ? <Minimize2 className="h-3.5 w-3.5" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />}
        {maximized ? t('split.restore') : t('split.maximize')}{shortcut(MISSION_SPLIT_KEYS.maximize)}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => split.equalize()}>
        <Columns2 className="h-3.5 w-3.5" aria-hidden />{t('split.equalize')}{shortcut(MISSION_SPLIT_KEYS.equalize)}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => split.closePane(paneId)}>
        <X className="h-3.5 w-3.5" aria-hidden />{t('split.closePane')}{shortcut(MISSION_SPLIT_KEYS.close)}
      </DropdownMenuItem>
    </>}
  </> : <>
    <button type="button" role="menuitem" tabIndex={-1} className={ITEM} onClick={() => switchTo({ kind: 'main' })}>
      <ChevronLeft className="h-3.5 w-3.5" aria-hidden />{mode.kind === 'swap' ? t('split.swap') : mode.side === 'right' ? t('split.splitRight') : t('split.splitDown')}
    </button>
    <DropdownMenuSeparator />
    {mode.kind === 'swap'
      ? panes.filter(id => id !== paneId).map(id => <DropdownMenuItem key={id} onSelect={() => split.swap(paneId, id)}>
        <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="truncate">{title(id)}</span>
      </DropdownMenuItem>)
      : candidates.length
        ? candidates.map(conversation => {
          const fits = room(splitPane(split.tree, paneId, conversation.id, mode.side))
          return <DropdownMenuItem key={conversation.id} onSelect={() => split.openBeside(conversation.id, mode.side, paneId)}
            title={fits ? undefined : noRoom}>
            {mode.side === 'right' ? <Columns2 className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Rows2 className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            <span className="truncate">{conversation.title?.trim() || t('untitled')}</span>
            {!fits && <span className="ml-auto shrink-0 text-muted-foreground">{t('split.stacks')}</span>}
          </DropdownMenuItem>
        })
        : <DropdownMenuItem disabled>{t('split.noMissions')}</DropdownMenuItem>}
  </>

  return content
}
