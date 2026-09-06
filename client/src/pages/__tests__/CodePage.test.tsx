import React, { useEffect, useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import CodePage from '../CodePage'
import type { CopyPathAction, SummaryAction } from '../../components/code-explorer/FileViewer'
import { useCodeRepository } from '../../components/code-explorer/CodeRepositoryContext'
import type { DesktopProject } from '../../hooks/useDesktop'

const desktop = vi.hoisted(() => ({ activeProjectId: 'project-1', projects: [] as DesktopProject[] }))

vi.mock('../../hooks/useSharedWebSocket', () => ({ useSharedWebSocket: () => ({ registerHandler: vi.fn(), unregisterHandler: vi.fn() }) }))

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api',
}))

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => desktop,
}))

vi.mock('../../components/code-explorer/FileTree', () => ({
  FileTree: ({
    selectedPath,
    filterJobId,
    filterTicketId,
    onOpenFile,
  }: {
    selectedPath: string | null
    filterJobId?: string | null
    filterTicketId?: number | null
    onOpenFile: (path: string) => void
  }) => {
    const scope = useCodeRepository()
    return <div data-testid="file-tree" data-selected={selectedPath ?? ''} data-job={filterJobId ?? ''} data-ticket={filterTicketId ?? ''} data-api={scope.apiBase} data-repository={scope.repositoryId}>
      <button type="button" onClick={() => onOpenFile('src/a.ts')}>Open A</button>
    </div>
  },
}))

vi.mock('../../components/code-explorer/FileViewer', async () => {
  const actual = await vi.importActual<typeof import('../../components/code-explorer/FileViewer')>('../../components/code-explorer/FileViewer')
  return {
    ...actual,
    FileViewer: ({
      relPath,
      initialLine,
      initialJobId,
      onSummaryActionChange,
      onCopyPathActionChange,
      onFilterJob,
    }: {
      relPath: string
      initialLine?: number
      initialJobId?: string | null
      onSummaryActionChange?: (action: SummaryAction | null) => void
      onCopyPathActionChange?: (action: CopyPathAction | null) => void
      onFilterJob?: (jobId: string) => void
    }) => {
      const [draft, setDraft] = useState('')
      useEffect(() => {
        onSummaryActionChange?.({
          hasSummary: relPath.includes('summary'),
          regenerating: false,
          disabledReason: null,
          onClick: vi.fn(),
        })
        onCopyPathActionChange?.({ onClick: vi.fn() })
        return () => {
          onSummaryActionChange?.(null)
          onCopyPathActionChange?.(null)
        }
      }, [onCopyPathActionChange, onSummaryActionChange, relPath])
      return (
        <div data-testid="file-viewer" data-path={relPath} data-line={initialLine} data-change-job={initialJobId ?? undefined}>
          <input aria-label="Unsaved draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <button type="button" onClick={() => onFilterJob?.('job-1')}>Filter job</button>
        </div>
      )
    },
  }
})

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  desktop.activeProjectId = 'project-1'
  desktop.projects = []
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ entries: [
      { id: 1, repositoryId: 'primary-project-1', repositoryName: 'App', path: 'src/new.ts', kind: 'created', jobId: 'job-1', ticketId: 29, at: 1 },
      { id: 2, repositoryId: 'primary-project-1', repositoryName: 'App', path: 'src/changed.ts', kind: 'modified', jobId: 'job-1', ticketId: 29, at: 2 },
      { id: 3, repositoryId: 'primary-project-1', repositoryName: 'App', path: 'src/gone.ts', kind: 'deleted', jobId: 'job-1', ticketId: 29, at: 3 },
    ], nextCursor: null, truncated: false }),
  })
})

describe('CodePage', () => {
  function installRepositories() {
    desktop.projects = [{ id: 'project-1', name: 'Shared product', slug: 'shared', path: '/app', added_at: '', last_seen_at: '', db_path: '', provider: 'claude', providers: ['claude'], repositories: [
      { id: 'primary-project-1', projectId: 'project-1', name: 'App', path: '/app', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' },
      { id: 'api', projectId: 'project-1', name: 'API', path: '/api', isPrimary: false, kind: 'git', integrationBranch: 'develop', addedAt: '' },
    ] }]
  }

  it('opens a repository-qualified link and clears the selected file when changing repositories', async () => {
    installRepositories()
    render(<CodePage />, { route: '/code?repositoryId=api&path=src/a.ts' })
    expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('api')
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-api', '/api/projects/project-1/repositories/api')
    expect(screen.getByTestId('file-viewer')).toHaveAttribute('data-path', 'src/a.ts')
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), { target: { value: 'primary-project-1' } })
    await waitFor(() => expect(screen.queryByTestId('file-viewer')).not.toBeInTheDocument())
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-selected', '')
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-api', '/api/projects/project-1/repositories/primary-project-1')
    fireEvent.click(screen.getByText('Open A'))
    expect(screen.getByTestId('file-viewer')).toHaveAttribute('data-path', 'src/a.ts')
  })

  it('fails visibly for unknown repository IDs without loading the primary by mistake', () => {
    installRepositories()
    render(<CodePage />, { route: '/code?repositoryId=other-project-api&path=src/a.ts' })
    expect(screen.getByRole('alert')).toHaveTextContent('no longer registered')
    expect(screen.queryByTestId('file-tree')).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not carry an unsaved file draft into a relocated membership with the same ID', () => {
    installRepositories()
    const view = render(<CodePage />, { route: '/code?repositoryId=api&path=src/a.ts' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Unsaved draft' }), { target: { value: 'Only for the old API checkout' } })
    const project = desktop.projects[0]
    desktop.projects = [{ ...project, repositories: project.repositories!.map((repository) => repository.id === 'api' ? { ...repository, path: '/new-api' } : repository) }]
    view.rerender(<CodePage />)
    expect(screen.getByRole('textbox', { name: 'Unsaved draft' })).toHaveValue('')
    expect(screen.getByText('/new-api')).toBeInTheDocument()
  })

  it('keeps embedded selection local, reports repository identity and forgets a file from the old repository', () => {
    installRepositories()
    const onRepositoryChange = vi.fn(), onSelectedPathChange = vi.fn()
    render(<CodePage embedded initialRepositoryId="api" initialPath="src/a.ts" onRepositoryChange={onRepositoryChange} onSelectedPathChange={onSelectedPathChange} />, { route: '/missions?conversationId=conversation' })
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-repository', 'api')
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), { target: { value: 'primary-project-1' } })
    expect(onRepositoryChange).toHaveBeenCalledWith('primary-project-1')
    expect(onSelectedPathChange).toHaveBeenCalledWith(null)
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-selected', '')
  })

  it('renders scope toolbar and applies a spec filter', async () => {
    render(<CodePage />, { route: '/code' })
    expect(screen.getByTestId('code-provenance-toolbar')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('id'), { target: { value: '29' } })
    fireEvent.click(screen.getByText('Spec'))

    await waitFor(() => {
      expect(screen.getByTestId('provenance-result-panel')).toBeInTheDocument()
    })
    expect(screen.getByText('Spec #29')).toBeInTheDocument()
    expect(screen.getByText('added')).toBeInTheDocument()
    expect(screen.getByText('changed')).toBeInTheDocument()
    expect(screen.getByText('deleted')).toBeInTheDocument()
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-ticket', '29')
  })

  it('opens a file and surfaces the summary action in the top toolbar', async () => {
    render(<CodePage />, { route: '/code' })
    fireEvent.click(screen.getByText('Open A'))
    await waitFor(() => {
      expect(screen.getByTestId('file-viewer')).toHaveAttribute('data-path', 'src/a.ts')
    })
    expect(screen.getByText('Copy file path')).toBeInTheDocument()
    expect(screen.getByText('Generate summary')).toBeInTheDocument()
  })

  it('can filter by job from the file viewer context while keeping job input hidden', async () => {
    render(<CodePage />, { route: '/code?path=src/summary.ts' })
    await waitFor(() => {
      expect(screen.getByText('Regenerate summary')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Filter job'))
    await waitFor(() => {
      expect(screen.getByTestId('file-tree')).toHaveAttribute('data-job', 'job-1')
    })
    expect(screen.queryByPlaceholderText('job id')).not.toBeInTheDocument()
    expect(screen.getByText('Job context')).toBeInTheDocument()
  })

  it('persists tree width when the splitter is double-clicked', () => {
    localStorage.setItem('specrails-desktop:code-tree-width:project-1', '500')
    render(<CodePage />, { route: '/code' })
    fireEvent.doubleClick(screen.getByTestId('code-tree-resizer'))
    expect(localStorage.getItem('specrails-desktop:code-tree-width:project-1')).toBe('320')
  })
  it('preserves repository, line and recorded change identity in a deep link', () => {
    installRepositories()
    render(<CodePage />, { route: '/code?repositoryId=api&path=src/deleted.ts&line=21&changeJobId=run-4' })
    expect(screen.getByTestId('file-viewer')).toHaveAttribute('data-line', '21')
    expect(screen.getByTestId('file-viewer')).toHaveAttribute('data-change-job', 'run-4')
    expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('api')
  })

  it('uses browser history for file selection instead of replacing the previous location', async () => {
    render(<CodePage />, { route: '/code?path=original.ts' })
    fireEvent.click(screen.getByText('Open A'))
    expect(screen.getByTestId('file-viewer')).toHaveAttribute('data-path', 'src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(screen.getByTestId('file-viewer')).toHaveAttribute('data-path', 'original.ts'))
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await waitFor(() => expect(screen.getByTestId('file-viewer')).toHaveAttribute('data-path', 'src/a.ts'))
  })

  it('restores the implicit primary repository when going back in a mission', () => {
    installRepositories()
    const onRepositoryChange = vi.fn(), onSelectedPathChange = vi.fn()
    render(<CodePage embedded initialPath="original.ts" onRepositoryChange={onRepositoryChange} onSelectedPathChange={onSelectedPathChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), { target: { value: 'api' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onRepositoryChange).toHaveBeenLastCalledWith('primary-project-1')
    expect(onSelectedPathChange).toHaveBeenLastCalledWith('original.ts')
    expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('primary-project-1')
    expect(screen.getByTestId('file-viewer')).toHaveAttribute('data-path', 'original.ts')
  })

  it('gives the compact mission reader its own space and keeps navigation available', () => {
    render(<CodePage embedded initialPath="original.ts" />)
    expect(screen.getByTestId('code-page')).toHaveAttribute('data-compact', 'true')
    expect(screen.getByTestId('file-viewer')).toBeVisible()
    expect(screen.getByTestId('file-tree')).not.toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Show navigation' }))
    expect(screen.getByTestId('file-tree')).toBeVisible()
    expect(screen.getByTestId('file-viewer')).not.toBeVisible()
    fireEvent.click(screen.getByText('Open A'))
    expect(screen.getByTestId('file-viewer')).toBeVisible()
    expect(screen.getByTestId('file-tree')).not.toBeVisible()
  })

})
