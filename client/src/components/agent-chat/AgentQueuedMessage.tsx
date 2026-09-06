import { useEffect, useRef, useState } from 'react'
import { CornerUpRight, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAgentChat, type AgentQueuedItem } from '../../context/AgentChatContext'
import type { AgentAttachment } from '../../lib/agent-api'
import { AgentAttachmentChips, AgentContextInlineTokens } from './AgentMessage'
import { AgentDeliveryReceipt } from './AgentDeliveryReceipt'

/** Queue actions never interrupt the running turn or alter the composer's draft. */
export function AgentQueuedMessage({ item, conversationId, attachments, onEdit }: {
  item: AgentQueuedItem
  conversationId?: string
  attachments: AgentAttachment[]
  onEdit: (queueId: string) => void
}) {
  const { t } = useTranslation('agent')
  const { steerQueuedMessage, removeQueuedMessage } = useAgentChat()
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const promoted = item.deliveryMode === 'steer'
  const locked = busy || promoted

  useEffect(() => {
    if (!menuOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [menuOpen])

  const perform = async (action: 'steer' | 'remove') => {
    if (busyRef.current || promoted) return
    busyRef.current = true
    setBusy(true)
    setMenuOpen(false)
    try {
      const result = await (action === 'steer' ? steerQueuedMessage(item.queueId) : removeQueuedMessage(item.queueId))
      if (result === 'conflict') toast.info(t('queue.actionConflict'))
    } catch {
      // Failed actions retain the queued text, metadata and any unsaved edit.
      toast.error(t('queue.actionFailed'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="flex justify-end" data-testid="agent-queued-message" data-queue-id={item.queueId}>
      <div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-sm border border-dashed border-border/70 bg-foreground/[0.03] text-sm text-foreground/75">
        <div className="space-y-1 px-3.5 py-2">
          <div className="whitespace-pre-wrap"><AgentContextInlineTokens content={item.text} contextRefs={item.contextRefs} /></div>
          <AgentAttachmentChips conversationId={conversationId} attachments={attachments} />
        </div>
        <div className="flex items-center justify-end gap-1 border-t border-border/40 px-2 py-1.5">
          <div className="mr-auto pl-1.5"><AgentDeliveryReceipt receipt={item.deliveryReceipt ?? 'sent'} /></div>
          <button type="button" disabled={locked} onClick={() => void perform('steer')} title={t('queue.steerHint')}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-foreground/5 disabled:opacity-40">
            <CornerUpRight className="h-3.5 w-3.5" />{t('queue.steer')}
          </button>
          <button type="button" disabled={locked} onClick={() => void perform('remove')} aria-label={t('queue.remove')} title={t('queue.remove')}
            className="rounded-md p-1.5 hover:bg-foreground/5 hover:text-destructive disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>
          <div className="relative" ref={menuRef}>
            <button type="button" disabled={locked} aria-label={t('queue.more')} title={t('queue.more')}
              aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}
              className="rounded-md p-1.5 hover:bg-foreground/5 disabled:opacity-40"><MoreHorizontal className="h-3.5 w-3.5" /></button>
            {menuOpen && !locked && <div role="menu" aria-label={t('queue.more')} className="absolute bottom-full right-0 z-20 mb-1 min-w-28 rounded-lg border border-border bg-card p-1 shadow-xl">
              <button type="button" role="menuitem" autoFocus onClick={() => { onEdit(item.queueId); setMenuOpen(false) }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-foreground/5"><Pencil className="h-3.5 w-3.5" />{t('queue.edit')}</button>
            </div>}
          </div>
        </div>
      </div>
    </div>
  )
}
