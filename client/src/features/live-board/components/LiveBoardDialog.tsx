import { Dialog, DialogContent } from '../../../components/ui/dialog'
import { useLiveBoard } from '../context/LiveBoardContext'
import { useLiveBoardData } from '../hooks/useLiveBoardData'
import { LiveBoardPanel } from './LiveBoardPanel'

/** The live board over the current place (`?live=1`), in the main window. Reads only while open. */
export function LiveBoardDialog() {
  const board = useLiveBoard()
  const data = useLiveBoardData(!!board?.isOpen)
  if (!board) return null
  return (
    <Dialog open={board.isOpen} onOpenChange={(open) => { if (!open) board.closeBoard() }}>
      <DialogContent size="fullscreen" data-testid="live-board-dialog">
        {board.isOpen && <LiveBoardPanel data={data} actions={board.actions} onOpenInWindow={board.openInWindow} />}
      </DialogContent>
    </Dialog>
  )
}

export default LiveBoardDialog
