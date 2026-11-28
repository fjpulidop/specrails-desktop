import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { Suspense, useState } from 'react'
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, SurfaceWindowFrame } from '../dialog'
import { ConfirmDialog } from '../confirm-dialog'
import { Surface, useNativeWindowHandoff } from '../surface'
import {
  NATIVE_SURFACES_PREF_KEY,
  loadSurfaceGeometry,
  nativeSurfaceEnabled,
  openSurfaceWindow,
  saveSurfaceGeometry,
  surfaceWindowRoute,
  type SurfaceWindowEvent,
} from '../../../lib/native-surfaces'

const invoke = vi.fn()
let emitted: ((event: { payload: SurfaceWindowEvent }) => void) | null = null
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, callback: (event: { payload: SurfaceWindowEvent }) => void) => { emitted = callback; return () => { emitted = null } }),
  emit: vi.fn(async () => {}),
}))
const close = vi.fn(async () => {})
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: vi.fn(async () => ({ close })) } }))

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent size="workspace">
        <DialogHeader><DialogTitle>Settings</DialogTitle><DialogDescription>Prefs</DialogDescription></DialogHeader>
      </DialogContent>
    </Dialog>
  )
}

function Opener({ onResult }: { onResult?: (result: unknown) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      <button type="button" onClick={() => setOpen(false)}>Dismiss</button>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      <Surface id="app-settings" open={open} params={{ section: 'appearance', settingId: undefined }} onClose={() => setOpen(false)} onResult={onResult}>
        <SettingsModal open={open} onClose={() => setOpen(false)} />
      </Surface>
    </>
  )
}

beforeEach(() => {
  invoke.mockReset()
  close.mockClear()
  emitted = null
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  cleanup()
  setTauri(false)
})

describe('Surface: web fallback', () => {
  it('renders the Radix modal in the browser and never calls the host', () => {
    render(<Opener />)
    fireEvent.click(screen.getByText('Open settings'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('dialog').getAttribute('data-dialog-size')).toBe('workspace')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('is disabled outside Tauri, inside a surface window, and when switched off', () => {
    expect(nativeSurfaceEnabled('app-settings')).toBe(false)
    setTauri(true)
    expect(nativeSurfaceEnabled('app-settings')).toBe(true)
    localStorage.setItem(NATIVE_SURFACES_PREF_KEY, 'off')
    expect(nativeSurfaceEnabled('app-settings')).toBe(false)
    localStorage.clear()
    window.history.replaceState(null, '', '/?surfaceWindow=job-detail&requestId=r1&jobId=j1')
    expect(nativeSurfaceEnabled('app-settings')).toBe(false)
  })

  it('falls back to the modal when the native window cannot open', async () => {
    setTauri(true)
    invoke.mockRejectedValueOnce(new Error('older host'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<Opener />)
    fireEvent.click(screen.getByText('Open settings'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
  })
})

describe('Surface: native window in Tauri', () => {
  it('[spec:project-settings-surface/native-window-or-app-modal-presentation] opens Project Settings for the requested project and block and returns focus on close', async () => {
    setTauri(true)
    invoke.mockImplementation(async (_cmd: string, args: { requestId: string }) => ({ windowLabel: 'surface-project-settings-1', requestId: args.requestId, reused: false }))
    const onClose = vi.fn()
    const { rerender } = render(<button>Project settings</button>)
    const trigger = screen.getByRole('button', { name: 'Project settings' })
    trigger.focus()
    rerender(<><button>Project settings</button><Surface id="project-settings" open params={{ projectId: 'p1', settingId: 'recentlyDeleted' }} onClose={onClose}>
      <SettingsModal open onClose={onClose} />
    </Surface></>)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('surface_window_open', expect.objectContaining({
      surface: 'project-settings', params: { projectId: 'p1', settingId: 'recentlyDeleted' },
    })))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const requestId = invoke.mock.calls[0][1].requestId as string
    await act(async () => { emitted?.({ payload: { kind: 'closed', surface: 'project-settings', requestId, windowLabel: 'surface-project-settings-1' } }) })
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Project settings' })).toHaveFocus()
  })

  it('opens a window with serializable params instead of the modal, and closes on the closed event', async () => {
    setTauri(true)
    invoke.mockImplementation(async (_cmd: string, args: { requestId: string }) => ({ windowLabel: 'surface-app-settings-1', requestId: args.requestId, reused: false }))
    const onResult = vi.fn()
    render(<Opener onResult={onResult} />)
    fireEvent.click(screen.getByText('Open settings'))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const [command, args] = invoke.mock.calls[0] as [string, { surface: string; params: Record<string, string>; requestId: string; background?: unknown }]
    expect(command).toBe('surface_window_open')
    expect(args.surface).toBe('app-settings')
    expect(args.params).toEqual({ section: 'appearance' })
    // The window is created on the theme's panel color (null when no CSS is loaded).
    expect('background' in args).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()

    // A result for another request is ignored; ours reaches onResult.
    await act(async () => { emitted?.({ payload: { kind: 'result', surface: 'app-settings', requestId: 'other', windowLabel: 'x', result: 1 } }) })
    await act(async () => { emitted?.({ payload: { kind: 'result', surface: 'app-settings', requestId: args.requestId, windowLabel: 'surface-app-settings-1', result: { action: 'openBudget' } } }) })
    expect(onResult).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith({ action: 'openBudget' })

    await act(async () => { emitted?.({ payload: { kind: 'closed', surface: 'app-settings', requestId: args.requestId, windowLabel: 'surface-app-settings-1' } }) })
    expect(screen.getByTestId('state').textContent).toBe('closed')
    expect(close).not.toHaveBeenCalled()
  })

  it('follows the request of a reused window', async () => {
    setTauri(true)
    invoke.mockResolvedValue({ windowLabel: 'surface-app-settings-1', requestId: 'req-original', reused: true })
    render(<Opener />)
    fireEvent.click(screen.getByText('Open settings'))
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    await act(async () => { emitted?.({ payload: { kind: 'closed', surface: 'app-settings', requestId: 'req-original', windowLabel: 'surface-app-settings-1' } }) })
    expect(screen.getByTestId('state').textContent).toBe('closed')
  })

  it('closes the window when the opener dismisses the surface', async () => {
    setTauri(true)
    invoke.mockImplementation(async (_cmd: string, args: { requestId: string }) => ({ windowLabel: 'surface-app-settings-1', requestId: args.requestId, reused: false }))
    render(<Opener />)
    fireEvent.click(screen.getByText('Open settings'))
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByText('Dismiss'))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  })
})

describe('SurfaceWindowFrame: dialog as window content', () => {
  it('fills the window without scrim or size token; nested confirms stay modals', () => {
    render(
      <SurfaceWindowFrame>
        <Dialog open>
          <DialogContent size="workspace" movableResizable>
            <DialogHeader><DialogTitle>Settings</DialogTitle><DialogDescription>d</DialogDescription></DialogHeader>
            <ConfirmDialog open onOpenChange={() => {}} title="Remove?" description="Gone" confirmLabel="Remove" onConfirm={() => {}} />
          </DialogContent>
        </Dialog>
      </SurfaceWindowFrame>,
    )
    // The nested confirm hides the frame from the a11y tree, so query the DOM.
    const [frame, confirm] = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
    expect(frame.hasAttribute('data-surface-window')).toBe(true)
    expect(frame.className).toContain('inset-0')
    expect(frame.className).not.toContain('max-w-5xl')
    expect(frame.querySelector('[data-dialog-header]')?.hasAttribute('data-tauri-drag-region')).toBe(true)
    expect(frame.querySelectorAll('[data-resize-grip]').length).toBe(0)
    // The OS window controls close it: no in-page close button.
    expect(frame.querySelector('[data-dialog-header] button[aria-label]')).toBeNull()
    expect(confirm.hasAttribute('data-surface-window')).toBe(false)
    expect(confirm.getAttribute('data-dialog-size')).toBe('confirm')
  })
})

describe('SurfaceWindowFrame: no outside', () => {
  // WebKit sends a stray pointerdown aimed at <html> when a click in a native window hands focus to
  // another window; Radix took it for a click outside, so the live board closed whenever a card
  // opened something in the main window.
  it('[spec:native-surface-windows/stray-outside-event] a native window is never dismissed by an outside pointerdown or focus; a modal only by a press on its scrim', async () => {
    const framedClose = vi.fn()
    const { unmount } = render(
      <SurfaceWindowFrame>
        <Dialog open onOpenChange={(open) => { if (!open) framedClose() }}>
          <DialogContent size="fullscreen"><DialogHeader><DialogTitle>Board</DialogTitle><DialogDescription>d</DialogDescription></DialogHeader><button type="button">Open</button></DialogContent>
        </Dialog>
      </SurfaceWindowFrame>,
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    fireEvent.pointerDown(document.documentElement)
    fireEvent.focusIn(document.body)
    expect(framedClose).not.toHaveBeenCalled()
    unmount()

    const modalClose = vi.fn()
    render(
      <Dialog open onOpenChange={(open) => { if (!open) modalClose() }}>
        <DialogContent size="workspace"><DialogHeader><DialogTitle>Modal</DialogTitle><DialogDescription>d</DialogDescription></DialogHeader></DialogContent>
      </Dialog>,
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    // A press aimed at the document itself is stray for a modal too (it closed a run that had just
    // opened over the live board); a press on the scrim is a real press outside.
    fireEvent.pointerDown(document.documentElement)
    expect(modalClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.querySelector('[data-dialog-scrim]')!)
    expect(modalClose).toHaveBeenCalled()
  })
})

describe('SurfaceWindowFrame: remounted content', () => {
  // The window content can unmount and mount again while its project data refreshes. It used to
  // lose the frame (the first dialog's id stayed the owner), so the window fell back to the
  // in-page modal: scrim, centered `h-[82vh]` panel and a header without the title-bar inset.
  it('stays the window content after the dialog unmounts and mounts again', () => {
    function Probe({ show }: { show: boolean }) {
      return (
        <SurfaceWindowFrame>
          {show && (
            <Dialog open>
              <DialogContent size="workspace" movableResizable>
                <DialogHeader><DialogTitle>Settings</DialogTitle><DialogDescription>d</DialogDescription></DialogHeader>
              </DialogContent>
            </Dialog>
          )}
        </SurfaceWindowFrame>
      )
    }
    const { rerender } = render(<Probe show />)
    expect(screen.getByRole('dialog').hasAttribute('data-surface-window')).toBe(true)
    rerender(<Probe show={false} />)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    rerender(<Probe show />)
    const frame = screen.getByRole('dialog')
    expect(frame.hasAttribute('data-surface-window')).toBe(true)
    expect(frame.className).toContain('inset-0')
    expect(frame.querySelector('[data-dialog-header]')?.hasAttribute('data-tauri-drag-region')).toBe(true)
  })

  // Job detail and Project settings mount their dialog after the frame, once the project is
  // selected. When that first render is thrown away (something under it suspends, or a concurrent
  // render restarts), React mounts the dialog again with a new id. The thrown-away render used to
  // keep the frame, so the window showed the in-page modal (scrim, card) for good.
  it('[spec:native-surface-windows/discarded-first-render] stays the window content when its first render is thrown away', async () => {
    let resolve!: () => void
    const ready = new Promise<void>(done => { resolve = done })
    let loaded = false
    function LazySection() {
      if (!loaded) throw ready.then(() => { loaded = true })
      return <p>Section</p>
    }
    const tree = (show: boolean) => (
      <SurfaceWindowFrame>
        <Suspense fallback={null}>
          {show && (
            <>
              <Dialog open>
                <DialogContent size="workspace">
                  <DialogHeader><DialogTitle>Run</DialogTitle><DialogDescription>d</DialogDescription></DialogHeader>
                </DialogContent>
              </Dialog>
              <LazySection />
            </>
          )}
        </Suspense>
      </SurfaceWindowFrame>
    )
    const { rerender } = render(tree(false))
    rerender(tree(true))
    await act(async () => { resolve(); await ready })
    expect(screen.getByText('Section')).toBeTruthy()
    const frame = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(frame.hasAttribute('data-surface-window')).toBe(true)
    expect(frame.className).toContain('inset-0')
    expect(frame.querySelector('[data-dialog-header]')?.hasAttribute('data-tauri-drag-region')).toBe(true)
  })

  it('stays the window content when the dialog is replaced in a single update', () => {
    function Probe({ version }: { version: number }) {
      return (
        <SurfaceWindowFrame>
          <Dialog open key={version}>
            <DialogContent size="workspace">
              <DialogHeader><DialogTitle>Settings {version}</DialogTitle><DialogDescription>d</DialogDescription></DialogHeader>
            </DialogContent>
          </Dialog>
        </SurfaceWindowFrame>
      )
    }
    const { rerender } = render(<Probe version={1} />)
    expect(screen.getByRole('dialog').hasAttribute('data-surface-window')).toBe(true)
    rerender(<Probe version={2} />)
    const frame = screen.getByRole('dialog')
    expect(frame.textContent).toContain('Settings 2')
    expect(frame.hasAttribute('data-surface-window')).toBe(true)
  })

  it('frames only the first of two top-level dialogs', () => {
    render(
      <SurfaceWindowFrame>
        <Dialog open>
          <DialogContent size="workspace"><DialogHeader><DialogTitle>First</DialogTitle><DialogDescription>d</DialogDescription></DialogHeader></DialogContent>
        </Dialog>
        <Dialog open>
          <DialogContent size="confirm"><DialogHeader><DialogTitle>Second</DialogTitle><DialogDescription>d</DialogDescription></DialogHeader></DialogContent>
        </Dialog>
      </SurfaceWindowFrame>,
    )
    const framed = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(node => node.hasAttribute('data-surface-window'))
    expect(framed).toHaveLength(1)
    expect(framed[0].textContent).toContain('First')
  })
})

describe('native surface transport', () => {
  it('parses the surface window route', () => {
    expect(surfaceWindowRoute('?loopsWindow=1')).toBeNull()
    expect(surfaceWindowRoute('?surfaceWindow=evil')).toBeNull()
    expect(surfaceWindowRoute('?surfaceWindow=job-detail&requestId=r1&jobId=j1&projectId=p1')).toEqual({ id: 'job-detail', requestId: 'r1', params: { jobId: 'j1', projectId: 'p1' } })
  })

  it('round-trips geometry and ignores corrupt values', () => {
    saveSurfaceGeometry('job-detail', { width: 900, height: 700 })
    expect(loadSurfaceGeometry('job-detail')).toEqual({ width: 900, height: 700 })
    localStorage.setItem('specrails.surface.job-detail.geometry', '{bad')
    expect(loadSurfaceGeometry('job-detail')).toBeNull()
  })

  it('remembers only the size: a stored position (older builds) is ignored, so a new window centers on its opener', async () => {
    localStorage.setItem('specrails.surface.app-settings.geometry', JSON.stringify({ x: 4000, y: -900, width: 1000, height: 700 }))
    expect(loadSurfaceGeometry('app-settings')).toEqual({ width: 1000, height: 700 })
    localStorage.setItem('specrails.surface.app-settings.geometry', JSON.stringify({ x: 10, y: 20 }))
    expect(loadSurfaceGeometry('app-settings')).toBeNull()
    invoke.mockResolvedValueOnce({ windowLabel: 'w', requestId: 'r', reused: false })
    saveSurfaceGeometry('app-settings', { width: 1000, height: 700 })
    await openSurfaceWindow('app-settings', {}, 'req-1')
    const [command, args] = invoke.mock.calls.at(-1) as [string, { geometry: unknown }]
    expect(command).toBe('surface_window_open')
    expect(args.geometry).toEqual({ width: 1000, height: 700 })
    localStorage.removeItem('specrails.surface.app-settings.geometry')
  })
})

function Handoff({ openWindow, onOpened }: { openWindow: () => Promise<void>; onOpened: () => void }) {
  const [open, setOpen] = useState(true)
  const inWindow = useNativeWindowHandoff({ open, openWindow, onOpened: () => { onOpened(); setOpen(false) } })
  return <span data-testid="handoff">{open && !inWindow ? 'modal' : inWindow ? 'window' : 'closed'}</span>
}

describe('useNativeWindowHandoff (Loops, Plugins)', () => {
  it('keeps the modal in the browser and never opens a window', () => {
    const openWindow = vi.fn(async () => {})
    render(<Handoff openWindow={openWindow} onOpened={vi.fn()} />)
    expect(screen.getByTestId('handoff').textContent).toBe('modal')
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('hands off to the native window in Tauri and clears the open state', async () => {
    setTauri(true)
    const openWindow = vi.fn(async () => {})
    const onOpened = vi.fn()
    render(<Handoff openWindow={openWindow} onOpened={onOpened} />)
    await waitFor(() => expect(onOpened).toHaveBeenCalled())
    expect(openWindow).toHaveBeenCalled()
    expect(screen.getByTestId('handoff').textContent).toBe('window')
  })

  it('falls back to the modal when the window cannot open', async () => {
    setTauri(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onOpened = vi.fn()
    render(<Handoff openWindow={vi.fn(async () => { throw new Error('refused') })} onOpened={onOpened} />)
    await waitFor(() => expect(screen.getByTestId('handoff').textContent).toBe('modal'))
    expect(onOpened).not.toHaveBeenCalled()
  })
})
