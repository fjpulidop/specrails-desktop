import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import { CloneRepositoryDialog } from '../CloneRepositoryDialog'

afterEach(() => vi.unstubAllGlobals())

async function fill() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Clone from GitHub' }))
  await user.type(screen.getByRole('textbox', { name: 'GitHub repository' }), 'owner/repo')
  await user.type(screen.getByRole('textbox', { name: 'Destination (new folder)' }), '/projects/repo')
  return user
}

describe('CloneRepositoryDialog', () => {
  it('[spec:github-repository-clone/clone-a-github-repository-to-a-chosen-destination] shows the final destination and returns the completed path to the caller', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ path: '/projects/repo' }) })
    vi.stubGlobal('fetch', fetch)
    const onCloned = vi.fn()
    render(<CloneRepositoryDialog onCloned={onCloned} />)
    const user = await fill()
    expect(screen.getByText('Clone into: /projects/repo')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clone repository' }))
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith('/projects/repo'))
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/repositories/clone'), expect.objectContaining({ body: JSON.stringify({ url: 'owner/repo', destination: '/projects/repo' }) }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps input on failure and does not return an incomplete checkout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Destination already exists' }) }))
    const onCloned = vi.fn()
    render(<CloneRepositoryDialog onCloned={onCloned} />)
    const user = await fill()
    await user.click(screen.getByRole('button', { name: 'Clone repository' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Destination already exists')
    expect(screen.getByRole('textbox', { name: 'Destination (new folder)' })).toHaveValue('/projects/repo')
    expect(onCloned).not.toHaveBeenCalled()
  })

  it('prevents duplicate clones and closing while the operation is pending', async () => {
    let finish!: (value: unknown) => void
    const fetch = vi.fn(() => new Promise(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetch)
    render(<CloneRepositoryDialog onCloned={vi.fn()} />)
    const user = await fill()
    await user.click(screen.getByRole('button', { name: 'Clone repository' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
    finish({ ok: true, json: async () => ({ path: '/projects/repo' }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
