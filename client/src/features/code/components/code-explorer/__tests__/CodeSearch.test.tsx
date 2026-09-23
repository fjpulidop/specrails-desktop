import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodeSearch } from '../CodeSearch'
import { CodeRepositoryContext } from '../CodeRepositoryContext'

function subject(onOpen = vi.fn()) {
  return <CodeRepositoryContext.Provider value={{ apiBase: '/api/projects/p/repositories/front', repositoryId: 'front', repositoryPath: '/front' }}>
    <CodeSearch projectId="p" repositoryName="Frontend" multipleRepositories onOpen={onOpen} />
  </CodeRepositoryContext.Provider>
}
const response = (data: unknown) => ({ ok: true, json: async () => data })

describe('CodeSearch', () => {
  it('uses project discovery and opens a result in its repository and exact line', async () => {
    const onOpen = vi.fn()
    global.fetch = vi.fn().mockResolvedValue(response({ matches: [{ repositoryId: 'back', repositoryName: 'Backend', path: 'src/index.ts', lineNumber: 42, snippet: 'export function findPet()' }] }))
    render(subject(onOpen))
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search query' }), { target: { value: 'findPet' } })
    fireEvent.click(await screen.findByRole('button', { name: /Backend.*src\/index.ts:42/ }))
    expect(onOpen).toHaveBeenCalledWith({ repositoryId: 'back', path: 'src/index.ts', line: 42 })
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('/api/projects/p/code/discover?')
    expect(url).toContain('kind=search')
  })

  it('never replaces a newer query with a delayed older result', async () => {
    let resolveOld!: (result: ReturnType<typeof response>) => void
    global.fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValue(response({ matches: [{ path: 'latest.ts' }] }))
    render(subject())
    const input = screen.getByRole('textbox', { name: 'Search query' })
    fireEvent.change(input, { target: { value: 'old' } })
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const oldSignal = vi.mocked(fetch).mock.calls[0][1]?.signal
    fireEvent.change(input, { target: { value: 'latest' } })
    expect(oldSignal?.aborted).toBe(true)
    await screen.findByText('latest.ts')
    resolveOld(response({ matches: [{ path: 'old.ts' }] }))
    await waitFor(() => expect(screen.queryByText('old.ts')).not.toBeInTheDocument())
    expect(screen.getByText('latest.ts')).toBeInTheDocument()
  })

  it('preserves partial-search and unavailable-repository explanations with zero matches', async () => {
    global.fetch = vi.fn().mockResolvedValue(response({ matches: [], truncated: true, repositories: [{ repositoryId: 'back', repositoryName: 'Backend', status: 'unavailable' }] }))
    render(subject())
    fireEvent.change(screen.getByRole('textbox', { name: 'Search query' }), { target: { value: 'missing' } })
    expect(await screen.findByText(/No matches in the portion searched/)).toBeInTheDocument()
    expect(screen.getByText('Backend could not be fully searched.')).toBeInTheDocument()
    expect(screen.queryByText('No matches found in the scanned files.')).not.toBeInTheDocument()
  })

  it('retries a failed request and sends selected-repository path/case constraints', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue(response({ matches: [] }))
    render(subject())
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Search scope' }), { target: { value: 'current' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search within path' }), { target: { value: 'src/lib' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Match case' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search query' }), { target: { value: 'Pet' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await screen.findByText('No matches found in the scanned files.')
    const url = String(vi.mocked(fetch).mock.calls.at(-1)![0])
    expect(url).toContain('/repositories/front/code/search?')
    expect(url).toContain('path=src%2Flib')
    expect(url).toContain('caseSensitive=true')
  })
})
