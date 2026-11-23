import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MergePreviewLine, MergePreviewView } from '../MergePreviewLine'
import { __resetMergePreviewStore, nudgeMergePreviews } from '../../lib/merge-preview-store'
import { mergePreviewRunState, type DeliveryMergePreview } from '../../lib/merge-preview'
import { setActiveProjectId } from '../../../../lib/api'

const preview = (over: Partial<DeliveryMergePreview> = {}): DeliveryMergePreview => ({
  deliveryId: 'd1', railIndex: 0, baseRef: 'origin/main', baseSha: 'a'.repeat(40), status: 'clean',
  conflictFiles: [], conflictFileCount: 0, baseAdvancedBy: 0, siblings: [], reason: null, computedAt: '2026-11-18T00:00:00Z', ...over,
})

describe('MergePreviewView', () => {
  it('shows conflicts with the base in the blocked look, and the base lead', () => {
    render(<MergePreviewView preview={preview({ status: 'conflicts', conflictFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], conflictFileCount: 5, baseAdvancedBy: 9 })} />)
    const line = screen.getByTestId('merge-preview')
    expect(line).toHaveTextContent('Conflicts with main in 5 files: src/a.ts, src/b.ts, src/c.ts +2 more')
    expect(line.querySelector('[data-run-state="blocked"]')).not.toBeNull()
    expect(screen.getByTestId('merge-preview-base-moved')).toHaveTextContent('main moved 9 commits since this branch was cut')
  })

  it('names colliding sibling rails', () => {
    render(<MergePreviewView preview={preview({ siblings: [{ deliveryId: 'd2', railIndex: 2, files: ['api.ts'], fileCount: 1 }] })} />)
    expect(screen.getByTestId('merge-preview')).toHaveTextContent('Collides with Rail 3 in api.ts')
  })

  it('says nothing on a card when the merge is clean and the base did not move; the packet says it is clean', () => {
    expect(render(<MergePreviewView preview={preview()} />).container).toBeEmptyDOMElement()
    render(<MergePreviewView preview={preview()} detailed />)
    expect(screen.getByTestId('merge-preview')).toHaveTextContent('Merges cleanly into main as it stands now')
  })

  it('maps the preview onto the run-state vocabulary', () => {
    expect(mergePreviewRunState({ status: 'conflicts', siblingConflictCount: 0 })).toBe('blocked')
    expect(mergePreviewRunState({ status: 'clean', siblingConflictCount: 1 })).toBe('blocked')
    expect(mergePreviewRunState({ status: 'already_merged', siblingConflictCount: 0 })).toBe('done')
    expect(mergePreviewRunState({ status: 'unknown', siblingConflictCount: 0 })).toBeNull()
  })
})

describe('MergePreviewLine', () => {
  beforeEach(() => {
    __resetMergePreviewStore()
    setActiveProjectId('p1')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shares one request per project between strips and refetches on a merge-preview event', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ supported: true, previews: [preview({ status: 'conflicts', conflictFiles: ['x.ts'], conflictFileCount: 1 })] })))
    vi.stubGlobal('fetch', fetchMock)
    render(<><MergePreviewLine deliveryId="d1" /><MergePreviewLine deliveryId="d1" /></>)
    await waitFor(() => expect(screen.getAllByTestId('merge-preview')).toHaveLength(2))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/projects/p1/rails/merge-preview')

    vi.useFakeTimers()
    nudgeMergePreviews('p2', { type: 'rail.merge_preview', projectId: 'p2' }) // another project: ignored
    nudgeMergePreviews('p1', { type: 'rail.job_started', projectId: 'p1' }) // cannot change a merge
    nudgeMergePreviews('p1', { type: 'rail.merge_preview', projectId: 'p1' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
