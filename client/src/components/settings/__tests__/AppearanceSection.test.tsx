import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '../../../context/ThemeContext'
import { AppearanceSection } from '../AppearanceSection'
import { THEME_IDS } from '../../../lib/themes'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body } as unknown as Response)
const fail = (status: number): Response =>
  ({ ok: false, status, json: async () => ({}) } as unknown as Response)

describe('AppearanceSection', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders all theme cards', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(ok({ theme: 'dracula' }))
    render(<ThemeProvider><AppearanceSection /></ThemeProvider>)
    for (const id of THEME_IDS) {
      expect(screen.getByTestId(`theme-card-${id}`)).toBeInTheDocument()
    }
  })

  it('matrix card is selectable and updates the active theme', async () => {
    const user = userEvent.setup()
    vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') return ok({ theme: 'matrix' })
      return ok({ theme: 'dracula' })
    })
    render(<ThemeProvider><AppearanceSection /></ThemeProvider>)
    await user.click(screen.getByTestId('theme-card-matrix'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-card-matrix')).toHaveAttribute('data-selected', 'true')
    })
    expect(document.documentElement.dataset.theme).toBe('matrix')
  })

  it('marks the active theme', () => {
    document.documentElement.dataset.theme = 'aurora-light'
    vi.spyOn(global, 'fetch').mockResolvedValue(ok({ theme: 'aurora-light' }))
    render(<ThemeProvider><AppearanceSection /></ThemeProvider>)
    expect(screen.getByTestId('theme-card-aurora-light')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('theme-card-dracula')).toHaveAttribute('data-selected', 'false')
  })

  it('clicking a card switches theme', async () => {
    const user = userEvent.setup()
    vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') return ok({ theme: 'obsidian-dark' })
      return ok({ theme: 'dracula' })
    })
    render(<ThemeProvider><AppearanceSection /></ThemeProvider>)
    await user.click(screen.getByTestId('theme-card-obsidian-dark'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-card-obsidian-dark')).toHaveAttribute('data-selected', 'true')
    })
    expect(document.documentElement.dataset.theme).toBe('obsidian-dark')
  })

  it('reverts visual selection when server rejects', async () => {
    const user = userEvent.setup()
    document.documentElement.dataset.theme = 'dracula'
    vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') return fail(400)
      return ok({ theme: 'dracula' })
    })
    const { toast } = await import('sonner')
    render(<ThemeProvider><AppearanceSection /></ThemeProvider>)
    await user.click(screen.getByTestId('theme-card-aurora-light'))
    await waitFor(() => {
      expect(screen.getByTestId('theme-card-dracula')).toHaveAttribute('data-selected', 'true')
    })
    expect(toast.error).toHaveBeenCalled()
  })

  it('clicking the active card does nothing', async () => {
    const user = userEvent.setup()
    document.documentElement.dataset.theme = 'dracula'
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(ok({ theme: 'dracula' }))
    render(<ThemeProvider><AppearanceSection /></ThemeProvider>)
    fetchSpy.mockClear()
    await user.click(screen.getByTestId('theme-card-dracula'))
    const patchCount = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH').length
    expect(patchCount).toBe(0)
  })

  it('cards use radiogroup semantics', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(ok({ theme: 'dracula' }))
    render(<ThemeProvider><AppearanceSection /></ThemeProvider>)
    const group = screen.getByRole('radiogroup', { name: /theme/i })
    expect(group).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(THEME_IDS.length)
  })
})
