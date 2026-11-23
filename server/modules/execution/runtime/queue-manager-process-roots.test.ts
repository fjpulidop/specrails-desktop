import { describe, expect, it, vi } from 'vitest'
import { initDb } from '../../../db'
import { QueueManager } from './queue-manager'

describe('QueueManager.listProcessRoots', () => {
  it('lists the active job, resident interactive sessions and force-failed survivors once each', () => {
    const qm = new QueueManager(vi.fn(), initDb(':memory:'), [], undefined, { projectId: 'p1' })
    const internals = qm as unknown as {
      _jobs: Map<string, { command: string }>
      _activeJobId: string | null
      _activeProcess: { pid?: number } | null
      _interactiveSessions: Map<string, { processPid(): number | null }>
      _forceFailedProcesses: Map<string, { pid?: number }>
    }
    internals._jobs.set('j1', { command: '/specrails:implement #12' })
    internals._jobs.set('j2', { command: '/opsx:apply' })
    internals._activeJobId = 'j1'
    internals._activeProcess = { pid: 700 }
    internals._interactiveSessions.set('j2', { processPid: () => 701 })
    internals._interactiveSessions.set('j3', { processPid: () => null })
    internals._forceFailedProcesses.set('j1', { pid: 700 })
    internals._forceFailedProcesses.set('j4', { pid: 702 })
    expect(qm.listProcessRoots()).toEqual([
      { jobId: 'j1', pid: 700, label: '/specrails:implement #12' },
      { jobId: 'j2', pid: 701, label: '/opsx:apply' },
      { jobId: 'j4', pid: 702, label: 'j4' },
    ])
    internals._activeProcess = null
    internals._activeJobId = null
    internals._interactiveSessions.clear()
    internals._forceFailedProcesses.clear()
  })
})
