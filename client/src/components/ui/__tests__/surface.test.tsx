import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, SurfaceWindowFrame } from '../dialog'
import { ConfirmDialog } from '../confirm-dialog'
import { Surface } from '../surface'
import {
  NATIVE_SURFACES_PREF_KEY,
  loadSurfaceGeometry,
  nativeSurfaceEnabled,
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
  it('opens a window with serializable params instead of the modal, and closes on the closed event', async () => {
    setTauri(true)
    invoke.mockImplementation(async (_cmd: string, args: { requestId: string }) => ({ windowLabel: 'surface-app-settings-1', requestId: args.requestId, reused: false }))
    const onResult = vi.fn()
    render(<Opener onResult={onResult} />)
    fireEvent.click(screen.getByText('Open settings'))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const [command, args] = invoke.mock.calls[0] as [string, { surface: string; params: Record<string, string>; requestId: string }]
    expect(command).toBe('surface_window_open')
    expect(args.surface).toBe('app-settings')
    expect(args.params).toEqual({ section: 'appearance' })
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
    expect(confirm.hasAttribute('data-surface-window')).toBe(false)
    expect(confirm.getAttribute('data-dialog-size')).toBe('confirm')
  })
})

describe('native surface transport', () => {
  it('parses the surface window route', () => {
    expect(surfaceWindowRoute('?loopsWindow=1')).toBeNull()
    expect(surfaceWindowRoute('?surfaceWindow=evil')).toBeNull()
    expect(surfaceWindowRoute('?surfaceWindow=job-detail&requestId=r1&jobId=j1&projectId=p1')).toEqual({ id: 'job-detail', requestId: 'r1', params: { jobId: 'j1', projectId: 'p1' } })
  })

  it('round-trips geometry and ignores corrupt values', () => {
    saveSurfaceGeometry('job-detail', { x: 10, y: 20, width: 900, height: 700 })
    expect(loadSurfaceGeometry('job-detail')).toEqual({ x: 10, y: 20, width: 900, height: 700 })
    localStorage.setItem('specrails.surface.job-detail.geometry', '{bad')
    expect(loadSurfaceGeometry('job-detail')).toBeNull()
  })
})
