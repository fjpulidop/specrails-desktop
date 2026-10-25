import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../dialog'
import { ConfirmDialog } from '../confirm-dialog'
import { nestedDialogLayer } from '../../../lib/layers'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Standard({ size }: { size?: 'confirm' | 'form' | 'wide' | 'workspace' | 'fullscreen' }) {
  return (
    <Dialog open>
      <DialogContent size={size}>
        <DialogHeader>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Consequence</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <input aria-label="first field" />
        </DialogBody>
        <DialogFooter>
          <button type="button">Cancel</button>
          <button type="button">Primary</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

describe('modal standard: anatomy', () => {
  it('applies the size token and the base layer', () => {
    render(<Standard size="form" />)
    const panel = screen.getByRole('dialog')
    expect(panel.getAttribute('data-dialog-size')).toBe('form')
    expect(panel.getAttribute('data-dialog-layer')).toBe('base')
    expect(panel.className).toContain('max-w-lg')
    expect(panel.className).toContain('z-50')
  })

  it('defaults to the wide size', () => {
    render(<Standard />)
    expect(screen.getByRole('dialog').getAttribute('data-dialog-size')).toBe('wide')
  })

  it('renders exactly one close button, inside the header row', () => {
    render(<Standard />)
    const closes = screen.getAllByRole('button', { name: 'Close' })
    expect(closes).toHaveLength(1)
    const header = document.querySelector('[data-dialog-header]')
    expect(header?.contains(closes[0])).toBe(true)
  })

  it('falls back to a corner close button when no header is rendered', () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle className="sr-only">Bare</DialogTitle>
          <p>bare</p>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1)
  })

  it('hides the close button when showCloseButton is false', () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false} aria-describedby={undefined}>
          <DialogHeader><DialogTitle>No close</DialogTitle></DialogHeader>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('uses the 16px title and 13px description scale', () => {
    render(<Standard />)
    expect(screen.getByText('Title').className).toContain('text-base')
    expect(screen.getByText('Consequence').className).toContain('text-body')
  })

  it('uses the shared scrim token', () => {
    render(<Standard />)
    const scrim = document.querySelector('.modal-scrim')
    expect(scrim?.className).toContain('bg-scrim')
  })
})

describe('modal standard: layers', () => {
  it('climbs to the stacked layer when opened inside an entity dialog', () => {
    render(
      <Dialog open>
        <DialogContent layer="entity" aria-describedby={undefined}>
          <DialogTitle>Entity</DialogTitle>
          <Dialog open>
            <DialogContent aria-describedby={undefined} data-testid="nested">
              <DialogTitle>Nested</DialogTitle>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByTestId('nested').getAttribute('data-dialog-layer')).toBe('stacked')
  })

  it('maps parent layers to nested defaults', () => {
    expect(nestedDialogLayer(null)).toBe('base')
    expect(nestedDialogLayer('base')).toBe('base')
    expect(nestedDialogLayer('entity')).toBe('stacked')
    expect(nestedDialogLayer('capture')).toBe('capture')
  })
})

describe('modal standard: focus', () => {
  it('traps Tab inside the panel', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button type="button">behind</button>
        <Standard />
      </>,
    )
    const panel = screen.getByRole('dialog')
    for (let i = 0; i < 6; i += 1) {
      await user.tab()
      expect(panel.contains(document.activeElement)).toBe(true)
    }
  })

  it('returns focus to the trigger on close', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open it</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogHeader><DialogTitle>Focus</DialogTitle></DialogHeader>
            </DialogContent>
          </Dialog>
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'open it' })
    await user.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
    await user.keyboard('{Escape}')
    // Radix returns focus on a 0ms timer after unmount.
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('refocuses a remounted trigger (same identity) instead of dropping focus to body', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = useState(false)
      const [generation, setGeneration] = useState(0)
      return (
        <>
          {/* the trigger node is replaced while the modal is open */}
          <button key={generation} type="button" aria-label="App settings" onClick={() => setOpen(true)}>
            gear
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogHeader><DialogTitle>Settings</DialogTitle></DialogHeader>
              <button type="button" onClick={() => setGeneration((g) => g + 1)}>remount trigger</button>
            </DialogContent>
          </Dialog>
        </>
      )
    }
    render(<Harness />)
    const original = screen.getByRole('button', { name: 'App settings' })
    await user.click(original)
    await user.click(screen.getByRole('button', { name: 'remount trigger' }))
    expect(original.isConnected).toBe(false)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'App settings' })))
  })

  it('Escape closes only the top layer', async () => {
    const user = userEvent.setup()
    const outer = vi.fn()
    const inner = vi.fn()
    render(
      <Dialog open onOpenChange={outer}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Outer</DialogTitle>
          <Dialog open onOpenChange={inner}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Inner</DialogTitle>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>,
    )
    await user.keyboard('{Escape}')
    expect(inner).toHaveBeenCalledWith(false)
    expect(outer).not.toHaveBeenCalled()
  })
})

describe('modal standard: resize grips', () => {
  it('grips live inside the workspace panel and a grip press does not dismiss it', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400, writable: true })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 100, width: 600, height: 400, right: 700, bottom: 500, x: 100, y: 100, toJSON: () => ({}),
    } as DOMRect)
    const onOpenChange = vi.fn()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent size="workspace" movableResizable aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Workspace</DialogTitle></DialogHeader>
        </DialogContent>
      </Dialog>,
    )
    const panel = screen.getByRole('dialog')
    const grip = screen.getByTestId('modal-resize-se')
    expect(panel.contains(grip)).toBe(true)
    // Above the panel's scrim: the grip shares the panel's stacking context,
    // which itself carries the dialog layer.
    expect(panel.className).toContain('z-50')
    act(() => {
      fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 700, clientY: 500 })
      fireEvent.pointerUp(window, { pointerId: 1 })
    })
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('grips are reachable with Tab inside the focus trap', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400, writable: true })
    const user = userEvent.setup()
    render(
      <Dialog open>
        <DialogContent size="workspace" movableResizable showCloseButton={false} aria-describedby={undefined}>
          <DialogTitle>Workspace</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    await user.tab()
    expect(document.activeElement?.getAttribute('data-resize-grip')).toBe('')
  })
})

describe('ConfirmDialog', () => {
  it('focuses the confirm button, orders Cancel before Confirm and uses the tone', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Discard local changes?"
        description="Uncommitted work is lost."
        confirmLabel="Discard changes"
        onConfirm={() => {}}
        tone="default"
        confirmTestId="confirm-go"
      />,
    )
    const confirm = screen.getByTestId('confirm-go')
    expect(document.activeElement).toBe(confirm)
    const footer = document.querySelector('[data-dialog-footer]')!
    const buttons = Array.from(footer.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).toEqual(['Cancel', 'Discard changes'])
    expect(confirm.className).toContain('bg-primary')
    expect(screen.getByRole('dialog').getAttribute('data-dialog-size')).toBe('confirm')
  })

  it('is destructive by default and locks both buttons while busy', () => {
    render(
      <ConfirmDialog open onOpenChange={() => {}} title="Delete?" onConfirm={() => {}} busy confirmTestId="c" />,
    )
    const confirm = screen.getByTestId('c')
    expect(confirm.className).toContain('bg-destructive')
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
