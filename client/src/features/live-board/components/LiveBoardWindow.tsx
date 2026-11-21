import { useMemo } from 'react'
import { Dialog, DialogContent } from '../../../components/ui/dialog'
import type { LiveBoardActions } from '../context/LiveBoardContext'
import { useLiveBoardData } from '../hooks/useLiveBoardData'
import type { LiveBoardWindowResult } from '../lib/live-board-model'
import { LiveBoardPanel } from './LiveBoardPanel'

export interface LiveBoardWindowProps {
  /** Sends a card action to the main window, which runs it with the app's own handlers (and comes forward). */
  report: (result: LiveBoardWindowResult) => void
  onClose: () => void
}

/**
 * The live board in its own native window (a second screen). The window reads
 * the board itself; every card action is forwarded to the main window, where
 * the inbox, the missions and the places live.
 */
export function LiveBoardWindow({ report, onClose }: LiveBoardWindowProps) {
  const data = useLiveBoardData(true)
  const actions = useMemo<LiveBoardActions>(() => ({
    primary: (card) => report({ action: 'primary', card }),
    open: (card) => report({ action: 'open', card }),
    busy: () => false,
    openInbox: () => report({ action: 'inbox' }),
  }), [report])
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent size="fullscreen" data-testid="live-board-window">
        <LiveBoardPanel data={data} actions={actions} />
      </DialogContent>
    </Dialog>
  )
}

export default LiveBoardWindow
