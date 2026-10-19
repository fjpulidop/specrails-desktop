import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BackgroundProcessAppLinks, primaryAppUrl } from '../BackgroundProcessAppLinks'
import { BackgroundProcessChip } from '../BackgroundProcessChip'
import { openExternalUrl } from '../../../../lib/tauri-shell'
import type { BackgroundProcess } from '../../../../types'

vi.mock('../../../../lib/tauri-shell', () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }))

const process: BackgroundProcess = { processId: 'process-a', projectId: 'project-a', chatId: 'chat-a', pid: 42, command: 'npm run dev -- --host', cwd: '/repos/web', startedAt: 1_700_000_000_000, status: 'running' }
const exposed: BackgroundProcess = { ...process, appUrls: { local: ['http://localhost:5173/'], network: ['http://192.168.1.20:5173/'] } }

afterEach(() => { cleanup(); vi.mocked(openExternalUrl).mockClear() })

describe('BackgroundProcessAppLinks', () => {
  it('opens local and network addresses in the system browser and copies them', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<BackgroundProcessAppLinks process={exposed} />)
    expect(screen.getByText('This computer')).toBeInTheDocument()
    expect(screen.getByText('Your network')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Open http://192.168.1.20:5173/ in the browser'))
    expect(openExternalUrl).toHaveBeenCalledWith('http://192.168.1.20:5173/')
    fireEvent.click(screen.getByRole('button', { name: 'Copy http://192.168.1.20:5173/' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://192.168.1.20:5173/'))
    expect(screen.queryByText(/Only reachable from this computer/)).toBeNull()
  })

  it('explains how to reach a local-only app from a phone', () => {
    render(<BackgroundProcessAppLinks process={{ ...process, appUrls: { local: ['http://localhost:5173/'], network: [] } }} />)
    expect(screen.getByText(/Only reachable from this computer/)).toBeInTheDocument()
  })

  it('renders nothing before the app announces an address', () => {
    const { container } = render(<BackgroundProcessAppLinks process={process} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('prefers the local address for one-click opening on this computer', () => {
    expect(primaryAppUrl(exposed)).toBe('http://localhost:5173/')
    expect(primaryAppUrl({ ...process, appUrls: { local: [], network: ['http://192.168.1.20:5173/'] } })).toBe('http://192.168.1.20:5173/')
    expect(primaryAppUrl(process)).toBeNull()
  })
})

describe('BackgroundProcessChip app link', () => {
  it('opens the app without opening the logs, and hides the link once the process ends', () => {
    const onOpen = vi.fn()
    const view = render(<BackgroundProcessChip process={exposed} accentVariant="accent-info" onKill={vi.fn()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open http://localhost:5173/ in the browser' }))
    expect(openExternalUrl).toHaveBeenCalledWith('http://localhost:5173/')
    expect(onOpen).not.toHaveBeenCalled()
    view.rerender(<BackgroundProcessChip process={{ ...exposed, status: 'exited' }} accentVariant="accent-info" onKill={vi.fn()} onOpen={onOpen} />)
    expect(screen.queryByRole('button', { name: /in the browser/ })).toBeNull()
  })
})
