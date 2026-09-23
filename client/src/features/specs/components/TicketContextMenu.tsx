import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Trans, useTranslation } from 'react-i18next'
import { Trash2, ChevronRight, Circle, CheckCircle2, AlertCircle, Flag, ArrowUp, ArrowRight, ArrowDown } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import { useJiraDiscard } from '../../integrations/context/JiraDiscardContext'
import { DiscardSpecDialog } from '../../integrations/components/jira/DiscardSpecDialog'
import type { TicketStatus, TicketPriority, LocalTicket } from '../../../types'

// ─── Status and Priority display maps ─────────────────────────────────────────

const STATUS_ITEMS: { value: TicketStatus; labelKey: string; icon: React.ReactNode; className: string }[] = [
  {
    value: 'todo',
    labelKey: 'ticketStatus.todo',
    icon: <Circle className="w-3.5 h-3.5 text-slate-400 aurora-light:text-muted-foreground" />,
    className: 'text-slate-400 aurora-light:text-muted-foreground',
  },
  {
    value: 'done',
    labelKey: 'ticketStatus.done',
    icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 aurora-light:text-accent-success" />,
    className: 'text-emerald-400 aurora-light:text-accent-success',
  },
]

const PRIORITY_ITEMS: { value: TicketPriority; labelKey: string; icon: React.ReactNode; className: string }[] = [
  {
    value: 'critical',
    labelKey: 'priority.critical',
    icon: <AlertCircle className="w-3.5 h-3.5 text-red-400 aurora-light:text-destructive" />,
    className: 'text-red-400 aurora-light:text-destructive',
  },
  {
    value: 'high',
    labelKey: 'priority.high',
    icon: <ArrowUp className="w-3.5 h-3.5 text-orange-400 aurora-light:text-accent-warning" />,
    className: 'text-orange-400 aurora-light:text-accent-warning',
  },
  {
    value: 'medium',
    labelKey: 'priority.medium',
    icon: <ArrowRight className="w-3.5 h-3.5 text-yellow-400 aurora-light:text-accent-warning" />,
    className: 'text-yellow-400 aurora-light:text-accent-warning',
  },
  {
    value: 'low',
    labelKey: 'priority.low',
    icon: <ArrowDown className="w-3.5 h-3.5 text-slate-400 aurora-light:text-muted-foreground" />,
    className: 'text-slate-400 aurora-light:text-muted-foreground',
  },
]

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TicketContextMenuProps {
  ticket: Pick<LocalTicket, 'id' | 'title' | 'status' | 'priority' | 'source' | 'jira_key'>
  onDelete: (ticketId: number) => void
  onStatusChange: (ticketId: number, status: TicketStatus) => void
  onPriorityChange: (ticketId: number, priority: TicketPriority) => void
  children: React.ReactNode
  className?: string
}

interface MenuPosition {
  x: number
  y: number
}

type ActiveSubmenu = 'status' | 'priority' | null

// ─── Context Menu Portal ──────────────────────────────────────────────────────

interface ContextMenuPortalProps {
  position: MenuPosition
  ticket: TicketContextMenuProps['ticket']
  activeSubmenu: ActiveSubmenu
  onSetSubmenu: (sub: ActiveSubmenu) => void
  onStatusChange: (status: TicketStatus) => void
  onPriorityChange: (priority: TicketPriority) => void
  onDeleteRequest: () => void
  /** When set, the first item is "Move to <label>" instead of Delete (Jira). */
  discardLabel?: string
  onDiscardRequest?: () => void
  onClose: () => void
}

function ContextMenuPortal({
  position,
  ticket,
  activeSubmenu,
  onSetSubmenu,
  onStatusChange,
  onPriorityChange,
  onDeleteRequest,
  discardLabel,
  onDiscardRequest,
  onClose,
}: ContextMenuPortalProps) {
  const { t } = useTranslation('tickets')
  const menuRef = useRef<HTMLDivElement>(null)

  // Constrain to viewport
  const [adjustedPos, setAdjustedPos] = useState(position)
  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    setAdjustedPos({
      x: rect.right > vw ? Math.max(0, position.x - rect.width) : position.x,
      y: rect.bottom > vh ? Math.max(0, position.y - rect.height) : position.y,
    })
  }, [position])

  const handleItemClick = useCallback((fn: () => void) => {
    fn()
    onClose()
  }, [onClose])

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('contextMenu.ariaLabel')}
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
      className="fixed z-[200] min-w-[180px] rounded-lg border border-border/50 bg-popover shadow-xl text-xs py-1"
    >
      {/* Move to <status> (Jira-backed spec) — else Delete */}
      {discardLabel && onDiscardRequest ? (
        <button
          role="menuitem"
          type="button"
          onClick={() => { onDiscardRequest(); onClose() }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-accent-info hover:bg-accent-info/10 transition-colors"
          data-testid="jira-move-to-menuitem"
        >
          <ArrowRight className="w-3.5 h-3.5 shrink-0" />
          {discardLabel}
        </button>
      ) : (
        <button
          role="menuitem"
          type="button"
          onClick={() => { onDeleteRequest(); onClose() }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-400 aurora-light:text-destructive hover:bg-red-500/10 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5 shrink-0" />
          {t('contextMenu.deleteTicket')}
        </button>
      )}

      <div className="my-1 h-px bg-border/40" role="separator" />

      {/* Change status */}
      <div
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={activeSubmenu === 'status'}
        className={cn(
          'relative flex w-full items-center justify-between gap-2 px-3 py-2 cursor-pointer select-none text-foreground/80 hover:bg-accent/50 hover:text-foreground transition-colors',
          activeSubmenu === 'status' && 'bg-accent/50 text-foreground'
        )}
        onMouseEnter={() => onSetSubmenu('status')}
        onClick={(e) => {
          e.stopPropagation()
          onSetSubmenu(activeSubmenu === 'status' ? null : 'status')
        }}
      >
        <span className="flex items-center gap-2">
          <Circle className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          {t('contextMenu.changeStatus')}
        </span>
        <ChevronRight className="w-3 h-3 text-muted-foreground" />

        {activeSubmenu === 'status' && (
          <div
            role="menu"
            aria-label={t('contextMenu.statusOptions')}
            className="absolute left-full top-0 ml-1 min-w-[150px] rounded-lg border border-border/50 bg-popover shadow-xl py-1 z-[201]"
          >
            {STATUS_ITEMS.map((item) => (
              <button
                key={item.value}
                role="menuitem"
                type="button"
                onClick={() => handleItemClick(() => onStatusChange(item.value))}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors',
                  item.className,
                  ticket.status === item.value && 'bg-accent/30 font-semibold'
                )}
              >
                {item.icon}
                {t(item.labelKey)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Set priority */}
      <div
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={activeSubmenu === 'priority'}
        className={cn(
          'relative flex w-full items-center justify-between gap-2 px-3 py-2 cursor-pointer select-none text-foreground/80 hover:bg-accent/50 hover:text-foreground transition-colors',
          activeSubmenu === 'priority' && 'bg-accent/50 text-foreground'
        )}
        onMouseEnter={() => onSetSubmenu('priority')}
        onClick={(e) => {
          e.stopPropagation()
          onSetSubmenu(activeSubmenu === 'priority' ? null : 'priority')
        }}
      >
        <span className="flex items-center gap-2">
          <Flag className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          {t('contextMenu.setPriority')}
        </span>
        <ChevronRight className="w-3 h-3 text-muted-foreground" />

        {activeSubmenu === 'priority' && (
          <div
            role="menu"
            aria-label={t('contextMenu.priorityOptions')}
            className="absolute left-full top-0 ml-1 min-w-[140px] rounded-lg border border-border/50 bg-popover shadow-xl py-1 z-[201]"
          >
            {PRIORITY_ITEMS.map((item) => (
              <button
                key={item.value}
                role="menuitem"
                type="button"
                onClick={() => handleItemClick(() => onPriorityChange(item.value))}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors',
                  item.className,
                  ticket.priority === item.value && 'bg-accent/30 font-semibold'
                )}
              >
                {item.icon}
                {t(item.labelKey)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── TicketContextMenu ────────────────────────────────────────────────────────

/**
 * Right-click context menu for any ticket surface (list row, grid card, post-it).
 * Wraps children and intercepts `contextmenu` events.
 *
 * @example
 * <TicketContextMenu
 *   ticket={ticket}
 *   onDelete={handleDelete}
 *   onStatusChange={handleStatusChange}
 *   onPriorityChange={handlePriorityChange}
 * >
 *   <TicketRow ticket={ticket} />
 * </TicketContextMenu>
 */
export function TicketContextMenu({
  ticket,
  onDelete,
  onStatusChange,
  onPriorityChange,
  children,
  className,
}: TicketContextMenuProps) {
  const { t } = useTranslation('tickets')
  const { t: tj } = useTranslation('jira')
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<MenuPosition>({ x: 0, y: 0 })
  const [activeSubmenu, setActiveSubmenu] = useState<ActiveSubmenu>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showDiscard, setShowDiscard] = useState(false)

  // Jira-synced project + Jira-backed spec + configured status → "Move to <status>"
  const { discardStatus } = useJiraDiscard()
  const canDiscard = !!discardStatus && ticket.source === 'jira' && !!ticket.jira_key

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setActiveSubmenu(null)
  }, [])

  // Close on Escape or click outside
  useEffect(() => {
    if (!menuOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMenu()
    }
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Element
      if (!target.closest('[role="menu"]')) closeMenu()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [menuOpen, closeMenu])

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
    setActiveSubmenu(null)
    setMenuOpen(true)
  }

  function handleDeleteConfirmed() {
    onDelete(ticket.id)
    setShowDeleteConfirm(false)
  }

  return (
    <>
      <div
        onContextMenu={handleContextMenu}
        className={className}
        data-ticket-id={ticket.id}
      >
        {children}
      </div>

      {menuOpen &&
        createPortal(
          <ContextMenuPortal
            position={menuPos}
            ticket={ticket}
            activeSubmenu={activeSubmenu}
            onSetSubmenu={setActiveSubmenu}
            onStatusChange={(status) => onStatusChange(ticket.id, status)}
            onPriorityChange={(priority) => onPriorityChange(ticket.id, priority)}
            onDeleteRequest={() => setShowDeleteConfirm(true)}
            discardLabel={canDiscard ? tj('discard.moveButton', { status: discardStatus }) : undefined}
            onDiscardRequest={canDiscard ? () => setShowDiscard(true) : undefined}
            onClose={closeMenu}
          />,
          document.body
        )}

      {canDiscard && discardStatus && (
        <DiscardSpecDialog
          open={showDiscard}
          onOpenChange={setShowDiscard}
          ticket={{ id: ticket.id, title: ticket.title, jira_key: ticket.jira_key }}
          discardStatus={discardStatus}
        />
      )}

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteDialog.title')}</DialogTitle>
            <DialogDescription>
              <Trans
                t={t}
                i18nKey="deleteDialog.body"
                values={{ id: ticket.id, title: ticket.title }}
                components={{ strong: <span className="font-semibold text-foreground" /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowDeleteConfirm(false)}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteConfirmed}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('common:actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
