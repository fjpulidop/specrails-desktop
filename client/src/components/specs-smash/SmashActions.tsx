import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Split } from 'lucide-react'

import { Button } from '../ui/button'
import { API_ORIGIN } from '../../lib/origin'
import { useSmashInflight } from '../../context/SmashTrackerContext'
import { SmashStatusPills } from './SmashStatusPills'
import { SmashConfirmModal, type SmashMode } from './SmashConfirmModal'
import { isSmashCapable } from '../../lib/provider-capabilities'
import type { LocalTicket } from '../../types'

const CONTRACT_LAYER_MARKER = '## Contract Layer'

export function ticketCanSmash(ticket: LocalTicket, featureFlagOn: boolean): boolean {
  if (!featureFlagOn) return false
  if (ticket.status === 'draft') return false
  if (ticket.parent_epic_id != null) return false
  if (!ticket.description?.includes(CONTRACT_LAYER_MARKER)) return false
  return true
}

export interface SmashActionsProps {
  ticket: LocalTicket
  projectId: string
  provider: string | null | undefined
  featureFlagOn: boolean
  /** When true and épica has children, the action is "Re-SMASH" with confirm. */
  childrenCount: number
}

/**
 * The full SMASH button + confirm modal + streaming pills UX, scoped to a
 * single ticket inside `TicketDetailModal`.
 */
export function SmashActions({
  ticket,
  projectId,
  provider,
  featureFlagOn,
  childrenCount,
}: SmashActionsProps) {
  const { t } = useTranslation('activity')
  const inflight = useSmashInflight(ticket.id)
  const [modalOpen, setModalOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // A ticket's Explore conversation owns its structured-action provider.
  // Resolve it before showing SMASH; while unresolved (or if the origin was
  // deleted) fail closed so a mixed project's Claude primary cannot expose a
  // destructive Re-SMASH for a Kimi-backed spec. A stored NULL provider means
  // the project's primary provider.
  const [originProvider, setOriginProvider] = useState<string | null | undefined>(
    ticket.origin_conversation_id ? undefined : null,
  )

  useEffect(() => {
    const conversationId = ticket.origin_conversation_id
    if (!conversationId) {
      setOriginProvider(null)
      return
    }

    let cancelled = false
    setOriginProvider(undefined)
    void fetch(
      `${API_ORIGIN}/api/projects/${projectId}/chat/conversations/${encodeURIComponent(conversationId)}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`origin conversation lookup failed (${res.status})`)
        const body = await res.json() as { conversation?: { provider?: string | null } }
        if (!cancelled) {
          setOriginProvider(body.conversation?.provider ?? provider ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) setOriginProvider(null)
      })
    return () => { cancelled = true }
  }, [projectId, provider, ticket.origin_conversation_id])

  const effectiveProvider = ticket.origin_conversation_id ? originProvider : provider
  const smashEnabled = featureFlagOn && isSmashCapable(effectiveProvider)
  const isEpic = ticket.is_epic === true
  const showInitial = !isEpic && ticketCanSmash(ticket, smashEnabled)
  const showReSmash = isEpic && smashEnabled
  const isReSmash = isEpic && childrenCount > 0

  const fireSmash = useCallback(
    async (mode: SmashMode) => {
      // Defence in depth: a stale modal or caller mistake must never dispatch
      // a provider-incompatible structured action.
      if (!smashEnabled) return
      setSubmitting(true)
      try {
        const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/tickets/${ticket.id}/smash`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string }
          toast.error(
            body.reason
              ? t('smash.couldNotStartWithReason', { reason: body.reason })
              : t('smash.couldNotStart'),
          )
          return
        }
        // Toast lifecycle is driven by SmashTrackerContext from WS events.
        setModalOpen(false)
      } catch (err) {
        toast.error(t('smash.smashFailed', { message: (err as Error).message }))
      } finally {
        setSubmitting(false)
      }
    },
    [projectId, ticket.id, t, smashEnabled],
  )

  const handleConfirm = useCallback(
    async (mode: SmashMode) => {
      // Check again immediately before the destructive Re-SMASH child delete.
      if (!smashEnabled) return
      if (isReSmash) {
        // Delete current children first, then fire SMASH.
        setSubmitting(true)
        try {
          const delRes = await fetch(`${API_ORIGIN}/api/projects/${projectId}/tickets/${ticket.id}/children`, {
            method: 'DELETE',
          })
          if (!delRes.ok) {
            toast.error(t('smash.couldNotDeleteChildren'))
            setSubmitting(false)
            return
          }
        } catch (err) {
          toast.error(t('smash.deleteFailed', { message: (err as Error).message }))
          setSubmitting(false)
          return
        }
      }
      await fireSmash(mode)
    },
    [isReSmash, fireSmash, projectId, ticket.id, t, smashEnabled],
  )

  if (!showInitial && !showReSmash) return null

  // Streaming: render pills only, hide button.
  if (inflight) {
    return (
      <div className="flex flex-col gap-2" data-testid="smash-actions-streaming">
        <SmashStatusPills stage={inflight.stage} />
      </div>
    )
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setModalOpen(true)}
        className="border-accent-highlight/40 text-accent-highlight hover:bg-accent-highlight/10"
        data-testid={showReSmash ? 'resmash-button' : 'smash-button'}
      >
        <Split className="w-3.5 h-3.5 mr-1.5" />
        {showReSmash ? t('smash.reSmashButton') : t('smash.smashButton')}
      </Button>
      <SmashConfirmModal
        open={modalOpen}
        ticketTitle={ticket.title}
        isReSmash={isReSmash}
        childrenCount={childrenCount}
        submitting={submitting}
        onCancel={() => setModalOpen(false)}
        onConfirm={handleConfirm}
      />
    </>
  )
}
