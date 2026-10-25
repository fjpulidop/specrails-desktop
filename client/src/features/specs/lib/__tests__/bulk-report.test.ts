import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { reportBulk } from '../bulk-report'

const t = (key: string, options?: Record<string, unknown>) => `${key}:${JSON.stringify(options)}`

describe('reportBulk', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stays quiet when everything worked and an Undo toast already says so', () => {
    reportBulk(t, 'deleted', { ok: 3, failed: 0, undoable: true })
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('confirms with one toast when there is nothing to undo', () => {
    reportBulk(t, 'moved', { ok: 2, failed: 0 })
    expect(toast.success).toHaveBeenCalledWith('bulk.result.moved:{"count":2}')
  })

  it('reports a partial failure once, with the counts', () => {
    reportBulk(t, 'moved', { ok: 4, failed: 2, undoable: true })
    expect(toast.warning).toHaveBeenCalledWith('bulk.partial:{"ok":4,"failed":2,"total":6}')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('reports a total failure as an error', () => {
    reportBulk(t, 'labeled', { ok: 0, failed: 3 })
    expect(toast.error).toHaveBeenCalledWith('bulk.failedAll:{"count":3}')
  })

  it('says nothing for an empty run', () => {
    reportBulk(t, 'moved', { ok: 0, failed: 0 })
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
