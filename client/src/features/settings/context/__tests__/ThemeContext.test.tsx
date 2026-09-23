import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, useTheme } from '../ThemeContext'
import { THEME_LOCAL_STORAGE_KEY } from '../../lib/themes'

function Probe() {
  const { themeId, setTheme, isUpdating } = useTheme()
  // Swallow rejections so they don't surface as unhandled in Vitest. The
  // tests below assert on observable state (DOM attribute, localStorage)
  // not on the rejection itself.
  const handle = (id: 'aurora-light' | 'obsidian-dark' | 'dracula') => {
    setTheme(id).catch(() => { /* asserted via state */ })
  }
  return (
    <div>
      <span data-testid="current">{themeId}</span>
      <span data-testid="updating">{isUpdating ? 'yes' : 'no'}</span>
      <button onClick={() => handle('aurora-light')} data-testid="to-aurora">aurora</button>
      <button onClick={() => handle('obsidian-dark')} data-testid="to-obsidian">obsidian</button>
      <button onClick={() => handle('dracula')} data-testid="to-dracula">dracula</button>
    </div>
  )
}

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body } as unknown as Response)
const errorJson = (status: number): Response =>
  ({ ok: false, status, json: async () => ({}) } as unknown as Response)

describe('ThemeContext', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads boot theme from data-theme attribute', () => {
    document.documentElement.dataset.theme = 'aurora-light'
    vi.spyOn(global, 'fetch').mockResolvedValue(okJson({ theme: 'aurora-light' }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('current').textContent).toBe('aurora-light')
  })

  it('falls back to localStorage when data-theme is missing', () => {
    localStorage.setItem(THEME_LOCAL_STORAGE_KEY, 'obsidian-dark')
    vi.spyOn(global, 'fetch').mockResolvedValue(okJson({ theme: 'obsidian-dark' }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('current').textContent).toBe('obsidian-dark')
  })

  it.each([
    ['star-wars', 'galaxy'],
    ['matrix', 'code-rain'],
  ])('migrates localStorage legacy theme %s to %s during boot read', (legacy, current) => {
    localStorage.setItem(THEME_LOCAL_STORAGE_KEY, legacy)
    vi.spyOn(global, 'fetch').mockResolvedValue(okJson({ theme: current }))
    render(<ThemeProvider><Probe /></ThemeProvider>)

    expect(screen.getByTestId('current').textContent).toBe(current)
    expect(document.documentElement.dataset.theme).toBe(current)
    expect(localStorage.getItem(THEME_LOCAL_STORAGE_KEY)).toBe(current)
  })

  it('migrates a legacy data-theme attribute before localStorage fallback', () => {
    document.documentElement.dataset.theme = 'star-wars'
    localStorage.setItem(THEME_LOCAL_STORAGE_KEY, 'dracula')
    vi.spyOn(global, 'fetch').mockResolvedValue(okJson({ theme: 'galaxy' }))
    render(<ThemeProvider><Probe /></ThemeProvider>)

    expect(screen.getByTestId('current').textContent).toBe('galaxy')
    expect(document.documentElement.dataset.theme).toBe('galaxy')
    expect(localStorage.getItem(THEME_LOCAL_STORAGE_KEY)).toBe('galaxy')
  })

  it('falls back to specrails (DEFAULT_THEME) when both attribute and storage are absent', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(okJson({ theme: 'specrails' }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('current').textContent).toBe('specrails')
  })

  it('reconciles to server value when it differs from boot', async () => {
    document.documentElement.dataset.theme = 'dracula'
    vi.spyOn(global, 'fetch').mockResolvedValue(okJson({ theme: 'aurora-light' }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    await waitFor(() => {
      expect(screen.getByTestId('current').textContent).toBe('aurora-light')
    })
    expect(document.documentElement.dataset.theme).toBe('aurora-light')
    expect(localStorage.getItem(THEME_LOCAL_STORAGE_KEY)).toBe('aurora-light')
  })

  it('normalizes a legacy server value during reconcile', async () => {
    document.documentElement.dataset.theme = 'dracula'
    vi.spyOn(global, 'fetch').mockResolvedValue(okJson({ theme: 'matrix' }))
    render(<ThemeProvider><Probe /></ThemeProvider>)

    await waitFor(() => {
      expect(screen.getByTestId('current').textContent).toBe('code-rain')
    })
    expect(document.documentElement.dataset.theme).toBe('code-rain')
    expect(localStorage.getItem(THEME_LOCAL_STORAGE_KEY)).toBe('code-rain')
  })

  it('ignores server reconcile when value matches boot', async () => {
    document.documentElement.dataset.theme = 'dracula'
    vi.spyOn(global, 'fetch').mockResolvedValue(okJson({ theme: 'dracula' }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    // tick to allow effect microtask
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('current').textContent).toBe('dracula')
  })

  it('ignores server reconcile when fetch fails (keeps boot)', async () => {
    document.documentElement.dataset.theme = 'aurora-light'
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network'))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('current').textContent).toBe('aurora-light')
  })

  it('setTheme writes localStorage + data-theme + PATCH (optimistic)', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') return okJson({ theme: 'aurora-light' })
      return okJson({ theme: 'dracula' })
    })
    render(<ThemeProvider><Probe /></ThemeProvider>)
    await user.click(screen.getByTestId('to-aurora'))
    await waitFor(() => {
      expect(screen.getByTestId('current').textContent).toBe('aurora-light')
    })
    expect(document.documentElement.dataset.theme).toBe('aurora-light')
    expect(localStorage.getItem(THEME_LOCAL_STORAGE_KEY)).toBe('aurora-light')
    const patchCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    expect(patchCall).toBeDefined()
  })

  it('reverts on PATCH failure', async () => {
    const user = userEvent.setup()
    document.documentElement.dataset.theme = 'dracula'
    vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') return errorJson(400)
      return okJson({ theme: 'dracula' })
    })
    render(<ThemeProvider><Probe /></ThemeProvider>)
    await user.click(screen.getByTestId('to-aurora'))
    await waitFor(() => {
      expect(screen.getByTestId('current').textContent).toBe('dracula')
    })
    expect(document.documentElement.dataset.theme).toBe('dracula')
    expect(localStorage.getItem(THEME_LOCAL_STORAGE_KEY)).toBe('dracula')
  })

  it('useTheme outside provider throws', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* silence */ })
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/)
    errSpy.mockRestore()
  })

  it('setTheme is a no-op when target equals current', async () => {
    const user = userEvent.setup()
    document.documentElement.dataset.theme = 'dracula'
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(okJson({ theme: 'dracula' }))
    render(<ThemeProvider><Probe /></ThemeProvider>)
    fetchSpy.mockClear()
    await user.click(screen.getByTestId('to-dracula'))
    // No PATCH should have been fired
    const patchCount = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH').length
    expect(patchCount).toBe(0)
  })
})
