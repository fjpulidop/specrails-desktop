import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { useDesktop } from '../../../hooks/useDesktop'
import { RailPrDecisionProvider } from '../../delivery/context/RailPrDecisionContext'
import type { LiveBoardActions } from '../context/LiveBoardContext'
import { useLiveBoardData } from '../hooks/useLiveBoardData'
import { primaryOf, type LiveBoardWindowResult, type LiveCard } from '../lib/live-board-model'
import { LiveBoardPanel } from './LiveBoardPanel'

const JobDetailModal = lazy(() => import('../../jobs/components/JobDetailModal').then(module => ({ default: module.JobDetailModal })))
const ReviewPacketPage = lazy(() => import('../../delivery/pages/ReviewPacketPage'))

export interface LiveBoardWindowProps {
  /** Sends a card action to the main window, which runs it with the app's own handlers (and comes forward). */
  report: (result: LiveBoardWindowResult) => void
  onClose: () => void
}

/** What the board window shows over itself: a run's detail or a delivery's review. */
export type LiveBoardDetail = { kind: 'run'; projectId: string; jobId: string } | { kind: 'review'; projectId: string; deliveryId: string }

/**
 * Where a card action goes from the board's own window. A run and a review open
 * over the board, in this window: the board is a place to follow work (often on
 * a second screen), and reading or deciding one card should not take the person
 * away from it. A mission, and every inbox action that is not "open this run /
 * review" (resume, retry, raise a cap, resume a chain), runs in the main window,
 * where missions live; the board stays open.
 */
export function boardWindowRoute(card: LiveCard, action: 'open' | 'primary'): LiveBoardDetail | 'main' | null {
  const open = (): LiveBoardDetail | 'main' | null => {
    if (card.conversationId) return 'main'
    return card.jobId ? { kind: 'run', projectId: card.projectId, jobId: card.jobId } : null
  }
  if (action === 'open') return open()
  const primary = primaryOf(card)
  if (primary.kind === 'review') return { kind: 'review', projectId: card.projectId, deliveryId: primary.deliveryId }
  if (primary.kind === 'open') return open()
  if (primary.kind === 'inbox') {
    const { item } = primary
    if (item.action === 'open-review') return { kind: 'review', projectId: card.projectId, deliveryId: item.subjectId }
    if (item.action === 'open-run') return { kind: 'run', projectId: card.projectId, jobId: item.subjectId }
    return 'main'
  }
  return null
}

/**
 * The live board in its own native window (a second screen). The window reads
 * the board itself. Runs and reviews open over it; missions and the inbox's
 * other actions run in the main window (`boardWindowRoute`).
 */
export function LiveBoardWindow({ report, onClose }: LiveBoardWindowProps) {
  const data = useLiveBoardData(true)
  const [detail, setDetail] = useState<LiveBoardDetail | null>(null)
  const route = useCallback((card: LiveCard, action: 'open' | 'primary') => {
    const target = boardWindowRoute(card, action)
    if (target === 'main') report({ action, card })
    else if (target) setDetail(target)
  }, [report])
  const actions = useMemo<LiveBoardActions>(() => ({
    primary: (card) => route(card, 'primary'),
    open: (card) => route(card, 'open'),
    busy: () => false,
    openInbox: () => report({ action: 'inbox' }),
  }), [route, report])
  const closeDetail = useCallback(() => setDetail(null), [])
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent size="fullscreen" data-testid="live-board-window">
        <LiveBoardPanel data={data} actions={actions} />
        {detail && <BoardDetail detail={detail} onClose={closeDetail} />}
      </DialogContent>
    </Dialog>
  )
}

/**
 * A run or a review over the board, as an in-window modal (a surface window
 * never opens another native window). This window's own project selection
 * (its isolated desktop state) follows the card, so the review's project-bound
 * calls go to the card's project; the main window's project never changes.
 */
function BoardDetail({ detail, onClose }: { detail: LiveBoardDetail; onClose: () => void }) {
  const { t } = useTranslation('nav')
  const { activeProjectId, setActiveProjectId } = useDesktop()
  useEffect(() => {
    if (detail.kind === 'review' && activeProjectId !== detail.projectId) setActiveProjectId(detail.projectId)
  }, [detail, activeProjectId, setActiveProjectId])
  if (detail.kind === 'run') {
    return <Suspense fallback={null}><JobDetailModal jobId={detail.jobId} projectId={detail.projectId} onClose={onClose} /></Suspense>
  }
  const ready = activeProjectId === detail.projectId
  return (
    <RailPrDecisionProvider activeProjectId={ready ? detail.projectId : null}>
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent size="fullscreen" data-testid="live-board-review">
          <DialogHeader icon={<Eye />}>
            <DialogTitle>{t('arcSidebar.review')}</DialogTitle>
            <DialogDescription className="sr-only">{t('globalSurfaceModal.reviewDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="p-0 overflow-auto">
            <Suspense fallback={null}>
              {ready && <ReviewPacketPage key={detail.deliveryId} prDeliveryId={detail.deliveryId} onClose={onClose} />}
            </Suspense>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </RailPrDecisionProvider>
  )
}

export default LiveBoardWindow
