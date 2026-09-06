import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '../../test-utils'
import { RepositoryScopeSelector } from '../RepositoryScopeSelector'
import type { ProjectRepository } from '../../lib/project-repositories'

const desktop = vi.hoisted(() => ({ activeProjectId: 'p', projects: [] as unknown[] }))
vi.mock('../../hooks/useDesktop', () => ({ useDesktop: () => desktop }))
const primary: ProjectRepository = { id: 'primary-p', projectId: 'p', name: 'App', path: '/app', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' }
const api: ProjectRepository = { ...primary, id: 'api', name: 'API', path: '/api', isPrimary: false }
const docs: ProjectRepository = { ...api, id: 'docs', name: 'Docs', path: '/docs', kind: 'folder' }
function Controlled({ initial, repositories = [primary, api, docs] }: { initial?: string[]; repositories?: ProjectRepository[] }) {
  const [value, setValue] = useState(initial)
  return <><RepositoryScopeSelector value={value} onChange={setValue} repositories={repositories} /><output data-testid="scope">{JSON.stringify(value)}</output></>
}
beforeEach(() => { desktop.projects = [{ id: 'p', name: 'Legacy', path: '/app', added_at: '' }]; desktop.activeProjectId = 'p' })

describe('RepositoryScopeSelector', () => {
  it('preserves historical single-root forms without adding controls', () => {
    const onChange = vi.fn()
    const { container } = render(<RepositoryScopeSelector onChange={onChange} />)
    expect(container.querySelector('fieldset')).toBeNull(); expect(onChange).not.toHaveBeenCalled()
  })

  it('defaults visually to primary, supports shared scope and prevents empty selections', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    expect(screen.getByRole('checkbox', { name: 'App' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'App' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Docs/ })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'API' }))
    expect(screen.getByTestId('scope')).toHaveTextContent('["primary-p","api"]')
    await user.click(screen.getByRole('checkbox', { name: 'App' }))
    expect(screen.getByTestId('scope')).toHaveTextContent('["api"]')
    expect(screen.getByRole('checkbox', { name: 'API' })).toBeDisabled()
  })

  it('keeps missing scope visible and lets the user repair it even after only primary remains', async () => {
    const user = userEvent.setup()
    render(<Controlled initial={['removed-repo']} repositories={[primary]} />)
    expect(screen.getByRole('alert')).toHaveTextContent('no longer registered')
    expect(screen.getByRole('checkbox', { name: 'Unavailable: removed-repo' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'App' }))
    await user.click(screen.getByRole('checkbox', { name: 'Unavailable: removed-repo' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('scope')).toHaveTextContent('["primary-p"]')
  })

  it('allows removing a formerly-selected context-only folder but does not offer it as a new target', async () => {
    const user = userEvent.setup()
    render(<Controlled initial={['primary-p', 'docs']} />)
    expect(screen.getByRole('checkbox', { name: /Docs/ })).toBeEnabled()
    await user.click(screen.getByRole('checkbox', { name: /Docs/ }))
    expect(screen.getByTestId('scope')).toHaveTextContent('["primary-p"]')
    expect(screen.getByRole('checkbox', { name: /Docs/ })).toBeDisabled()
  })

  it('disables every choice during save without changing the selection', () => {
    const onChange = vi.fn()
    render(<RepositoryScopeSelector value={['api']} repositories={[primary, api]} onChange={onChange} disabled />)
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeDisabled()
    expect(onChange).not.toHaveBeenCalled()
  })
})
