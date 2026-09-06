import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RecordedDiff } from '../RecordedDiff'
import { CodeRepositoryContext } from '../CodeRepositoryContext'

vi.mock('../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'p1' }) }))
const reply = (patch: string, truncated = false) => ({ ok: true, json: async () => ({ patch, truncated }) }) as Response

describe('RecordedDiff', () => {
  it('renders stored evidence as text with old/new line numbers and an explicit historical boundary', async () => {
    global.fetch = vi.fn().mockResolvedValue(reply('@@ -7,1 +9,1 @@\n-old\n+<img src=x onerror=alert(1)>'))
    const { container } = render(<RecordedDiff path="src/a.ts" jobId="run-a" />)
    await screen.findByText('+<img src=x onerror=alert(1)>')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-kind="removed"]')).toHaveTextContent('7-old')
    expect(container.querySelector('[data-kind="added"]')).toHaveTextContent('9+<img')
    expect(screen.getByText(/may differ from the current registered checkout/)).toBeInTheDocument()
  })

  it('distinguishes missing evidence from transient failure and allows retry', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce({ ok: false, status: 404 })
    render(<RecordedDiff path="removed.ts" jobId="run-a" />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText(/Diff unavailable/)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('aborts stale scope requests and cannot leak a patch across repositories', async () => {
    let completeOld!: (response: Response) => void
    let oldSignal: AbortSignal | undefined
    global.fetch = vi.fn((url: RequestInfo | URL, opts?: RequestInit) => {
      if (String(url).includes('/old/')) { oldSignal = opts?.signal as AbortSignal; return new Promise<Response>((resolve) => { completeOld = resolve }) }
      return Promise.resolve(reply('@@ -1 +1 @@\n+current repo'))
    })
    const tree = (id: string) => <CodeRepositoryContext.Provider value={{ apiBase: '/api/projects/p1/repositories/' + id, repositoryId: id, isPrimary: false }}><RecordedDiff path="same.ts" jobId="same-run" /></CodeRepositoryContext.Provider>
    const { rerender } = render(tree('old'))
    rerender(tree('new'))
    await screen.findByText('+current repo')
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => completeOld(reply('@@ -1 +1 @@\n+old repo')))
    expect(screen.queryByText('+old repo')).not.toBeInTheDocument()
    expect(screen.getByText('+current repo')).toBeInTheDocument()
  })

  it('bounds rendered patch lines and explains server-side and display truncation', async () => {
    global.fetch = vi.fn().mockResolvedValue(reply('@@ -0,0 +1,2500 @@\n' + Array.from({ length: 2500 }, (_, index) => '+line-' + index).join('\n'), true))
    const { container } = render(<RecordedDiff path="large.ts" jobId="run-a" />)
    await screen.findByText(/stored patch is incomplete/)
    expect(screen.getByText(/Preview limited to 2000 lines/)).toBeInTheDocument()
    expect(container.querySelectorAll('[data-kind]')).toHaveLength(2000)
    expect(screen.queryByText('+line-2499')).not.toBeInTheDocument()
  })
  it('bounds a single pathological line without presenting it as complete', async () => {
    global.fetch = vi.fn().mockResolvedValue(reply('@@ -0,0 +1 @@\n+' + 'x'.repeat(300_000)))
    const { container } = render(<RecordedDiff path="minified.js" jobId="run-a" />)
    await screen.findByText(/Preview limited/)
    const text = [...container.querySelectorAll('code')].map((element) => element.textContent).join('\n')
    expect(text.length).toBeLessThanOrEqual(256_000)
    expect(container.querySelectorAll('[data-kind]')).toHaveLength(2)
  })

})
