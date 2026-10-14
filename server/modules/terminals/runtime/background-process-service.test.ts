import { describe, expect, it, vi } from 'vitest'
import type { BackgroundProcess, BackgroundProcessOutputEvent } from '../../../transient-children'
import { backgroundProcessHooks } from './background-process-service'

const output = (line: string): BackgroundProcessOutputEvent => ({
  sequence: 1, at: 0, source: 'stdout', line, processId: 'proc', pid: 9, chatId: 'c1', projectId: 'p1',
})
const proc = { processId: 'proc', pid: 9, command: 'npm run dev', cwd: '/r', startedAt: 0, status: 'exited', chatId: 'c1', projectId: 'p1' } as BackgroundProcess

describe('backgroundProcessHooks preview announcements', () => {
  it('broadcasts once per newly announced local origin', () => {
    const broadcast = vi.fn()
    const hooks = backgroundProcessHooks(broadcast)
    hooks.onOutput!(output('compiling…'))
    hooks.onOutput!(output('  ➜  Local:   http://localhost:5173/'))
    hooks.onOutput!(output('  ➜  Local:   http://127.0.0.1:5173/')) // same origin
    hooks.onOutput!(output('api ready on http://localhost:8787'))
    expect(broadcast.mock.calls.map(([msg]) => msg.type)).toEqual([
      'background_process.preview_targets', 'background_process.preview_targets',
    ])
    expect(broadcast.mock.calls[0][0]).toMatchObject({ processId: 'proc', chatId: 'c1', projectId: 'p1' })
  })

  it('forgets announced origins when the process exits', () => {
    const broadcast = vi.fn()
    const hooks = backgroundProcessHooks(broadcast)
    hooks.onOutput!(output('Local: http://localhost:3000'))
    hooks.onExited!(proc)
    hooks.onOutput!(output('Local: http://localhost:3000'))
    expect(broadcast.mock.calls.map(([msg]) => msg.type)).toEqual([
      'background_process.preview_targets', 'background_process.exited', 'background_process.preview_targets',
    ])
  })
})
