import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPortal } from 'react-dom'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { useToastsUsableOverModals } from '../toasts-over-modals'

afterEach(cleanup)

function Page({ guard, onRetry, onClose }: { guard: boolean; onRetry: () => void; onClose: () => void }) {
  return (
    <>
      {guard && <Guard />}
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent size="form">
          <DialogHeader><DialogTitle>Edit</DialogTitle><DialogDescription>d</DialogDescription></DialogHeader>
        </DialogContent>
      </Dialog>
      {createPortal(<ol data-sonner-toaster=""><li data-sonner-toast=""><button type="button" onClick={onRetry}>Retry</button></li></ol>, document.body)}
    </>
  )
}
function Guard() { useToastsUsableOverModals(); return null }

describe('toasts over an open modal', () => {
  it('a press on a toast does not close the modal, and the toast button still works', async () => {
    const onRetry = vi.fn()
    const onClose = vi.fn()
    render(<Page guard onRetry={onRetry} onClose={onClose} />)
    await new Promise(r => setTimeout(r, 10)) // Radix arms its outside-press listener after mount
    const retry = screen.getByText('Retry')
    fireEvent.pointerDown(retry)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('without the guard, the same press closes the modal (what it prevents)', async () => {
    const onClose = vi.fn()
    render(<Page guard={false} onRetry={() => {}} onClose={onClose} />)
    await new Promise(r => setTimeout(r, 10))
    fireEvent.pointerDown(screen.getByText('Retry'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
