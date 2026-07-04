import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PrerequisitesPanel } from '../PrerequisitesPanel'
import type { SetupPrerequisitesStatus } from '../../hooks/usePrerequisites'

const okStatus: SetupPrerequisitesStatus = {
  ok: true,
  platform: 'darwin',
  prerequisites: [
    { key: 'node', label: 'Node.js', command: 'node', required: true, installed: true, version: 'v20.0.0', minVersion: '18.0.0', meetsMinimum: true, installUrl: '', installHint: '' },
    { key: 'npm', label: 'npm', command: 'npm', required: true, installed: true, version: '10.0.0', minVersion: '9.0.0', meetsMinimum: true, installUrl: '', installHint: '' },
    { key: 'npx', label: 'npx', command: 'npx', required: true, installed: true, version: '10.0.0', meetsMinimum: true, installUrl: '', installHint: '' },
    { key: 'git', label: 'Git', command: 'git', required: true, installed: true, version: 'git version 2.42.1', minVersion: '2.20.0', meetsMinimum: true, installUrl: '', installHint: '' },
  ],
  missingRequired: [],
}

const missingGitStatus: SetupPrerequisitesStatus = {
  ok: false,
  platform: 'darwin',
  prerequisites: [
    okStatus.prerequisites[0],
    okStatus.prerequisites[1],
    okStatus.prerequisites[2],
    { ...okStatus.prerequisites[3], installed: false, meetsMinimum: false, version: undefined },
  ],
  missingRequired: [{ ...okStatus.prerequisites[3], installed: false, meetsMinimum: false, version: undefined }],
}

const oldNodeStatus: SetupPrerequisitesStatus = {
  ok: false,
  platform: 'darwin',
  prerequisites: [
    { ...okStatus.prerequisites[0], version: 'v14.21.3', meetsMinimum: false },
    okStatus.prerequisites[1],
    okStatus.prerequisites[2],
    okStatus.prerequisites[3],
  ],
  missingRequired: [{ ...okStatus.prerequisites[0], version: 'v14.21.3', meetsMinimum: false }],
}

describe('PrerequisitesPanel', () => {
  it('shows loading skeleton when isLoading and no status', () => {
    render(<PrerequisitesPanel status={null} isLoading={true} error={null} />)
    expect(screen.getByTestId('prerequisites-panel')).toHaveAttribute('data-state', 'loading')
  })

  it('shows error notice when error and no status', () => {
    render(<PrerequisitesPanel status={null} isLoading={false} error={new Error('boom')} />)
    expect(screen.getByTestId('prerequisites-panel')).toHaveAttribute('data-state', 'error')
    expect(screen.getByText(/install will validate/i)).toBeInTheDocument()
  })

  it('renders the success line when all tools are healthy', () => {
    render(<PrerequisitesPanel status={okStatus} isLoading={false} error={null} />)
    expect(screen.getByTestId('prerequisites-panel')).toHaveAttribute('data-state', 'ok')
    expect(screen.getByText(/all required tools detected/i)).toBeInTheDocument()
    expect(screen.queryByTestId('prerequisites-more-info')).not.toBeInTheDocument()
  })

  it('renders missing rows + More info when a tool is missing', () => {
    const onMoreInfo = vi.fn()
    render(<PrerequisitesPanel status={missingGitStatus} isLoading={false} error={null} onMoreInfo={onMoreInfo} />)

    expect(screen.getByTestId('prerequisites-panel')).toHaveAttribute('data-state', 'missing')
    expect(screen.getByTestId('prereq-row-git')).toHaveAttribute('data-ok', 'false')
    expect(screen.getByTestId('prereq-row-node')).toHaveAttribute('data-ok', 'true')

    fireEvent.click(screen.getByTestId('prerequisites-more-info'))
    expect(onMoreInfo).toHaveBeenCalledTimes(1)
  })

  it('renders below-minimum tools as not-ok with the "needs X+" hint', () => {
    render(<PrerequisitesPanel status={oldNodeStatus} isLoading={false} error={null} />)
    const nodeRow = screen.getByTestId('prereq-row-node')
    expect(nodeRow).toHaveAttribute('data-ok', 'false')
    expect(nodeRow.textContent).toMatch(/needs 18\.0\.0\+/)
  })

  it('renders broken-symlink state (installed but not executable)', () => {
    const brokenNode: SetupPrerequisitesStatus = {
      ok: false,
      platform: 'darwin',
      prerequisites: [
        {
          ...okStatus.prerequisites[0],
          installed: true,
          executable: false,
          meetsMinimum: false,
          version: undefined,
          resolvedPath: '/usr/local/bin/node',
        },
        okStatus.prerequisites[1],
        okStatus.prerequisites[2],
        okStatus.prerequisites[3],
      ],
      missingRequired: [
        {
          ...okStatus.prerequisites[0],
          installed: true,
          executable: false,
          meetsMinimum: false,
          version: undefined,
          resolvedPath: '/usr/local/bin/node',
        },
      ],
    }
    render(<PrerequisitesPanel status={brokenNode} isLoading={false} error={null} />)
    const nodeRow = screen.getByTestId('prereq-row-node')
    expect(nodeRow).toHaveAttribute('data-ok', 'false')
    expect(nodeRow.textContent).toMatch(/failed to execute/)
    expect(nodeRow.textContent).toContain('/usr/local/bin/node')
  })

  it('calls onRefresh when the refresh button is clicked', () => {
    const onRefresh = vi.fn()
    render(<PrerequisitesPanel status={okStatus} isLoading={false} error={null} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})

describe('gh row (optional tool + auth badge)', () => {
  const ghInstalledNoAuth: SetupPrerequisitesStatus = {
    ok: false,
    platform: 'darwin',
    prerequisites: [
      { ...okStatus.prerequisites[3], installed: false, meetsMinimum: false, version: undefined },
      { key: 'gh', kind: 'tool', label: 'GitHub CLI', command: 'gh', required: false, installed: true, executable: true, version: 'gh version 2.63.2', meetsMinimum: true, installUrl: '', installHint: '', authenticated: false },
    ],
    missingRequired: [{ ...okStatus.prerequisites[3], installed: false, meetsMinimum: false, version: undefined }],
  }

  it('shows the not-signed-in badge when gh is executable but unauthenticated', () => {
    render(<PrerequisitesPanel status={ghInstalledNoAuth} isLoading={false} error={null} />)
    expect(screen.getByTestId('prereq-gh-noauth')).toBeInTheDocument()
    expect(screen.getByText('optional')).toBeInTheDocument()
  })

  it('a missing gh renders muted (optional), never alarm-red, and no auth badge', () => {
    const missingGh: SetupPrerequisitesStatus = {
      ...ghInstalledNoAuth,
      prerequisites: [
        ghInstalledNoAuth.prerequisites[0],
        { ...ghInstalledNoAuth.prerequisites[1], installed: false, executable: false, meetsMinimum: false, version: undefined, authenticated: undefined },
      ],
    }
    render(<PrerequisitesPanel status={missingGh} isLoading={false} error={null} />)
    const row = screen.getByTestId('prereq-row-gh')
    expect(row).toHaveAttribute('data-ok', 'false')
    expect(row.className).not.toContain('border-accent-primary')
    expect(screen.queryByTestId('prereq-gh-noauth')).toBeNull()
  })

  it('an authenticated gh shows no auth badge', () => {
    const authed: SetupPrerequisitesStatus = {
      ...ghInstalledNoAuth,
      prerequisites: [
        ghInstalledNoAuth.prerequisites[0],
        { ...ghInstalledNoAuth.prerequisites[1], authenticated: true },
      ],
    }
    render(<PrerequisitesPanel status={authed} isLoading={false} error={null} />)
    expect(screen.queryByTestId('prereq-gh-noauth')).toBeNull()
  })
})
