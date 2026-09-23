import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import { ExportDropdown } from '../ExportDropdown'

// URL.createObjectURL / URL.revokeObjectURL are not available in jsdom
const mockCreateObjectURL = vi.fn(() => 'blob:mock-url')
const mockRevokeObjectURL = vi.fn()
Object.defineProperty(URL, 'createObjectURL', { value: mockCreateObjectURL, writable: true })
Object.defineProperty(URL, 'revokeObjectURL', { value: mockRevokeObjectURL, writable: true })

// Mock sonner toast.error so we don't need a real Toaster mounted in tests.
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    custom: vi.fn(),
    dismiss: vi.fn(),
  },
}))

function blobResponse(data = '{}') {
  const blob = new Blob([data], { type: 'application/json' })
  return {
    ok: true,
    headers: { get: () => null },
    blob: async () => blob,
  }
}

describe('ExportDropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateObjectURL.mockReturnValue('blob:mock-url')
  })

  it('renders the default Export label', () => {
    render(<ExportDropdown baseUrl="/api/x/export" />)
    expect(screen.getByRole('button', { name: /Export/i })).toBeInTheDocument()
  })

  it('disables the button when disabled prop is true', () => {
    render(<ExportDropdown baseUrl="/api/x/export" disabled />)
    const btn = screen.getByRole('button', { name: /Export/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'No data for current filters')
  })

  it('opens menu with four entries (Summary CSV/JSON, Raw CSV/JSON)', async () => {
    const user = userEvent.setup()
    render(<ExportDropdown baseUrl="/api/x/export" />)
    await user.click(screen.getByRole('button', { name: /Export/i }))
    expect(screen.getByRole('menuitem', { name: /Summary CSV/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Raw CSV/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Summary JSON/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Raw JSON/i })).toBeInTheDocument()
  })

  it('CSV download uses fetch + blob (not window.open)', async () => {
    global.fetch = vi.fn().mockResolvedValue(blobResponse('a,b,c'))
    const user = userEvent.setup()
    render(<ExportDropdown baseUrl="/api/x/export" />)
    await user.click(screen.getByRole('button', { name: /Export/i }))
    await user.click(screen.getByRole('menuitem', { name: /Summary CSV/i }))
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled()
      const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(url).toContain('format=csv')
      expect(url).toContain('mode=summary')
      expect(mockCreateObjectURL).toHaveBeenCalled()
    })
  })

  it('forwards page-level params to URL', async () => {
    global.fetch = vi.fn().mockResolvedValue(blobResponse())
    const user = userEvent.setup()
    render(<ExportDropdown baseUrl="/api/x/export" params={{ period: '7d', surface: 'job,quick-spec' }} />)
    await user.click(screen.getByRole('button', { name: /Export/i }))
    await user.click(screen.getByRole('menuitem', { name: /Raw JSON/i }))
    await waitFor(() => {
      const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(url).toContain('period=7d')
      expect(url).toContain('mode=raw')
      expect(url).toContain('format=json')
    })
  })

  it('shows toast on fetch error and clears downloading state', async () => {
    const { toast } = await import('sonner')
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const user = userEvent.setup()
    render(<ExportDropdown baseUrl="/api/x/export" />)
    await user.click(screen.getByRole('button', { name: /Export/i }))
    await user.click(screen.getByRole('menuitem', { name: /Summary CSV/i }))
    await waitFor(() => {
      expect((toast as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalledWith('Export failed')
      expect(screen.queryByRole('button', { name: /Downloading/i })).not.toBeInTheDocument()
    })
  })

  it('closes the menu when clicking outside', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <ExportDropdown baseUrl="/api/x/export" />
        <div data-testid="outside">outside</div>
      </div>
    )
    await user.click(screen.getByRole('button', { name: /Export/i }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByTestId('outside'))
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('uses Content-Disposition filename when present', async () => {
    const blob = new Blob(['x'], { type: 'text/csv' })
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => h.toLowerCase() === 'content-disposition' ? 'attachment; filename="acme-analytics-30d-2026-05-06.csv"' : null },
      blob: async () => blob,
    })
    const appendSpy = vi.spyOn(document.body, 'appendChild')
    const user = userEvent.setup()
    render(<ExportDropdown baseUrl="/api/x/export" />)
    await user.click(screen.getByRole('button', { name: /Export/i }))
    await user.click(screen.getByRole('menuitem', { name: /Summary CSV/i }))
    await waitFor(() => {
      const anchor = appendSpy.mock.calls
        .map(([n]) => n)
        .find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement)
      expect(anchor?.download).toBe('acme-analytics-30d-2026-05-06.csv')
    })
  })
})
