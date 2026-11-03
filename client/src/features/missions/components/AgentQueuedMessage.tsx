import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary'
import { CornerUpRight, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAgentChat, type AgentQueuedItem } from '../context/AgentChatContext'
import { useIsStreaming } from '../hooks/useAgentLive'
import { composerDrafts, composerReferenceDrafts, writeComposerDraft } from '../lib/agent-composer-drafts'
import type { AgentAttachment } from '../lib/agent-api'
import { AgentAttachmentChips, AgentContextInlineTokens } from './AgentMessage'
import { AgentDeliveryReceipt } from './AgentDeliveryReceipt'

import { notifyError } from '../../../lib/notify-error'
/** Queue actions never interrupt the running turn or alter the composer's draft. */
export function AgentQueuedMessage({ item, conversationId, attachments, onEdit }: {
  item: AgentQueuedItem
  conversationId?: string
  attachments: AgentAttachment[]
  onEdit: (queueId: string) => void
}) {
  const { t } = useTranslation('agent')
  const { steerQueuedMessage, removeQueuedMessage, send } = useAgentChat()
  const streamingRef = useRef(false)
  streamingRef.current = useIsStreaming()
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

  // Disabled controls say why: a promoted (steered) message is already on its
  // way to the agent, so it can no longer be steered, edited or removed.
  const lockedHint = promoted ? t('queue.promotedHint') : undefined
  const moreRef = useRef<HTMLButtonElement>(null)
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    const focus = (i: number) => items[((i % items.length) + items.length) % items.length]?.focus()
    if (event.key === 'ArrowDown') { event.preventDefault(); focus(index + 1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focus(index - 1) }
    else if (event.key === 'Home') { event.preventDefault(); focus(0) }
    else if (event.key === 'End') { event.preventDefault(); focus(items.length - 1) }
    else if (event.key === 'Tab') { setMenuOpen(false) }
  }
  useEffect(() => {
    // Focus returns to the trigger when the menu closes (same contract as the composer's + menu).
    if (!menuOpen && menuRef.current?.contains(document.activeElement)) moreRef.current?.focus()
  }, [menuOpen])

  const perform = async (action: 'steer' | 'remove') => {
    if (busyRef.current || promoted) return
    busyRef.current = true
    setBusy(true)
    setMenuOpen(false)
    try {
      const result = await (action === 'steer' ? steerQueuedMessage(item.queueId) : removeQueuedMessage(item.queueId))
      if (result === 'conflict') toast.info(t('queue.actionConflict'))
      else if (action === 'remove') {
        // Deleting is one click — give it one click back. While a turn still
        // streams, Undo re-queues the same text and metadata. Once the agent
        // has gone idle a send would be a NEW turn, so Undo restores the text
        // to the composer instead and lets the person decide.
        const { text, contextRefs, attachmentIds } = item
        toast.success(t('queue.removed'), {
          action: {
            label: t('undo'),
            onClick: () => {
              if (streamingRef.current) {
                void send(text, {
                  ...(contextRefs?.length ? { contextRefs } : {}),
                  ...(attachmentIds?.length ? { attachmentIds } : {}),
                })
                return
              }
              if (conversationId) {
                const current = composerDrafts.get(conversationId) ?? ''
                writeComposerDraft(conversationId, current.trim() ? `${current}\n${text}` : text, composerReferenceDrafts.get(conversationId) ?? [])
                toast.info(t('queue.restoredToComposer'))
              }
            },
          },
        })
      }
    } catch {
      // Failed actions retain the queued text, metadata and any unsaved edit.
      notifyError(t('queue.actionFailed'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="flex justify-end" data-testid="agent-queued-message" data-queue-id={item.queueId}>
      <div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-sm border border-dashed border-border/70 bg-foreground/[0.03] text-sm text-muted-foreground">
        <div className="space-y-1 px-3.5 py-2">
          <div className="whitespace-pre-wrap"><AgentContextInlineTokens content={item.text} contextRefs={item.contextRefs} /></div>
          <AgentAttachmentChips conversationId={conversationId} attachments={attachments} />
        </div>
        <div className="flex items-center justify-end gap-1 border-t border-border/40 px-2 py-1.5">
          <div className="mr-auto pl-1.5"><AgentDeliveryReceipt receipt={item.deliveryReceipt ?? 'sent'} /></div>
          <button type="button" disabled={locked} onClick={() => void perform('steer')} title={lockedHint ?? t('queue.steerHint')}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-label hover:bg-foreground/5 disabled:opacity-40 ${FOCUS_RING}`}>
            <CornerUpRight className="h-3.5 w-3.5" />{t('queue.steer')}
          </button>
          <button type="button" disabled={locked} onClick={() => void perform('remove')} aria-label={t('queue.remove')} title={lockedHint ?? t('queue.remove')}
            className={`rounded-md p-1.5 hover:bg-foreground/5 hover:text-destructive disabled:opacity-40 ${FOCUS_RING}`}><Trash2 className="h-3.5 w-3.5" /></button>
          <div className="relative" ref={menuRef}>
            <button type="button" ref={moreRef} disabled={locked} aria-label={t('queue.more')} title={lockedHint ?? t('queue.more')}
              aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}
              className={`rounded-md p-1.5 hover:bg-foreground/5 disabled:opacity-40 ${FOCUS_RING}`}><MoreHorizontal className="h-3.5 w-3.5" /></button>
            {menuOpen && !locked && <div role="menu" aria-label={t('queue.more')} onKeyDown={onMenuKeyDown} className="absolute bottom-full right-0 z-20 mb-1 min-w-28 rounded-lg border border-border bg-card p-1 shadow-xl">
              <button type="button" role="menuitem" autoFocus onClick={() => { onEdit(item.queueId); setMenuOpen(false) }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-caption hover:bg-foreground/5 ${FOCUS_RING}`}><Pencil className="h-3.5 w-3.5" />{t('queue.edit')}</button>
            </div>}
          </div>
        </div>
      </div>
    </div>
  )
}
