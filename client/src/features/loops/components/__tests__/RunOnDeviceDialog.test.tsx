import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RunOnDeviceDialog } from '../RunOnDeviceDialog'

const openDeviceWindow = vi.fn(async () => {})
vi.mock('../../../missions/lib/device-windows', () => ({ openDeviceWindow: (...args: unknown[]) => openDeviceWindow(...(args as [])) }))

const OPTIONS = {
  ready: true, hostTasks: true,
  checkout: { branch: 'main', platforms: ['ios', 'android'], recommended: 'android' },
  remembered: null,
  deliveries: [],
  branches: ['main', 'feat/login'],
  devices: [{ id: 'avd:tapflow-phone', name: 'tapflow-phone', platform: 'android', booted: false }],
}

type Route = (url: string, init?: RequestInit) => Response | undefined
let routes: Route[] = []
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  for (const route of routes) { const res = route(url, init); if (res) return res }
  return new Response('{}', { status: 404 })
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => { routes = []; openDeviceWindow.mockClear(); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

const renderDialog = () => render(<RunOnDeviceDialog projects={[{ id: 'p1', name: 'Shop' }]} initialProjectId="p1" onClose={() => {}} />)
const startBody = () => JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).endsWith('/mobile-test/start'))?.[1]?.body))

describe('RunOnDeviceDialog', () => {
  it('[spec:mobile-device-testing/run-from-loops] runs the checkout on the recommended platform, follows the run and opens the device', async () => {
    let state = 'running'
    routes.push((url) => (url.endsWith('/api/projects/p1/mobile-test/options') ? json(OPTIONS) : undefined))
    routes.push((url, init) => (url.endsWith('/mobile-test/start') && init?.method === 'POST' ? json({ runId: 'r1' }, 202) : undefined))
    routes.push((url) => (url.endsWith('/mobile-test/runs/r1') ? json(state === 'running'
      ? { runId: 'r1', state, devices: [] }
      : { runId: 'r1', state, summary: 'Android on tapflow-phone', devices: [{ platform: 'android', name: 'tapflow-phone', id: 'avd:tapflow-phone', sessionId: 's1', buildId: 6 }] }) : undefined))
    renderDialog()
    const dialog = await screen.findByTestId('run-on-device-dialog')
    await waitFor(() => expect(within(dialog).getByTestId('run-on-device-platform-android')).toHaveAttribute('aria-pressed', 'true'))
    fireEvent.click(within(dialog).getByTestId('run-on-device-submit'))
    await waitFor(() => expect(startBody()).toEqual({ target: { kind: 'checkout' }, platforms: ['android'], devices: {} }))
    expect(await within(dialog).findByTestId('run-on-device-progress')).toHaveAttribute('data-state', 'running')
    state = 'launched'
    const open = await within(dialog).findByTestId('run-on-device-open', {}, { timeout: 4_000 })
    expect(within(dialog).getByText('Running: Android on tapflow-phone')).toBeInTheDocument()
    fireEvent.click(open)
    await waitFor(() => expect(openDeviceWindow).toHaveBeenCalledWith({ deviceId: 'avd:tapflow-phone', sessionId: 's1', buildId: 6, platform: 'android', name: 'tapflow-phone' }))
  })

  it('runs a branch on both platforms, and explains a refusal without leaving the form', async () => {
    routes.push((url) => (url.endsWith('/mobile-test/options') ? json(OPTIONS) : undefined))
    routes.push((url) => (url.endsWith('/mobile-test/start') ? json({ error: 'There is no branch', code: 'branch_not_found' }, 404) : undefined))
    renderDialog()
    const dialog = await screen.findByTestId('run-on-device-dialog')
    fireEvent.click(await within(dialog).findByTestId('run-on-device-target-branch'))
    fireEvent.click(within(dialog).getByTestId('run-on-device-platform-both'))
    fireEvent.click(within(dialog).getByTestId('run-on-device-submit'))
    expect(await within(dialog).findByTestId('run-on-device-error')).toHaveTextContent('That branch does not exist in this project.')
    expect(startBody()).toEqual({ target: { kind: 'branch', branch: 'main' }, platforms: ['ios', 'android'], devices: {} })
    expect(within(dialog).queryByTestId('run-on-device-progress')).not.toBeInTheDocument()
  })

  it('does not start while Tapflow is off or missing', async () => {
    routes.push((url) => (url.endsWith('/mobile-test/options') ? json({ ...OPTIONS, devices: null }) : undefined))
    renderDialog()
    const dialog = await screen.findByTestId('run-on-device-dialog')
    expect(await within(dialog).findByTestId('run-on-device-error')).toHaveTextContent(/Tapflow is off/)
    expect(within(dialog).getByTestId('run-on-device-submit')).toBeDisabled()
  })
})
