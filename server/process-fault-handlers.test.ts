import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeFault, installProcessFaultHandlers } from './process-fault-handlers'

function setup(shutdown: (code: number) => Promise<void> | void = vi.fn(async () => undefined)) {
  const target = new EventEmitter()
  const log = vi.fn()
  const exit = vi.fn()
  installProcessFaultHandlers({ shutdown, log, exit, target: target as unknown as NodeJS.Process, fatalExitDeadlineMs: 50 })
  return { target, log, exit, shutdown }
}

afterEach(() => { vi.useRealTimers() })

describe('process fault policy', () => {
  it('logs an unhandled rejection with context and keeps running', () => {
    const { target, log, exit, shutdown } = setup()
    const err = Object.assign(new Error('db closed'), { code: 'SQLITE_MISUSE' })
    target.emit('unhandledRejection', err)
    target.emit('unhandledRejection', 'plain reason')
    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[0][1]).toMatchObject({ name: 'Error', message: 'db closed', code: 'SQLITE_MISUSE', occurrence: 1 })
    expect(log.mock.calls[1][1]).toMatchObject({ message: 'plain reason', occurrence: 2 })
    expect(exit).not.toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('an uncaught exception logs, then shuts down gracefully with exit code 1 (once)', () => {
    const { target, log, shutdown } = setup()
    target.emit('uncaughtException', new TypeError('boom'), 'uncaughtException')
    target.emit('uncaughtException', new TypeError('again'), 'uncaughtException')
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledWith(1)
    expect(log.mock.calls[0][1]).toMatchObject({ name: 'TypeError', message: 'boom', alreadyFatal: false })
    expect(log.mock.calls[1][1]).toMatchObject({ message: 'again', alreadyFatal: true })
  })

  it('forces exit(1) when graceful shutdown hangs past the deadline', () => {
    vi.useFakeTimers()
    const { target, exit } = setup(() => new Promise<void>(() => { /* never settles */ }))
    target.emit('uncaughtException', new Error('wedged'))
    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits(1) immediately when graceful shutdown itself fails', async () => {
    const { target, exit, log } = setup(async () => { throw new Error('teardown failed') })
    target.emit('uncaughtException', new Error('first'))
    await new Promise((r) => setImmediate(r))
    expect(exit).toHaveBeenCalledWith(1)
    expect(log).toHaveBeenCalledWith('graceful shutdown after uncaught exception failed', expect.objectContaining({ message: 'teardown failed' }))
  })

  it('describeFault renders errors, causes and non-serializable values', () => {
    expect(describeFault(new Error('outer', { cause: new Error('inner') }))).toMatchObject({ message: 'outer', cause: 'inner' })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(describeFault(circular)).toMatchObject({ name: 'object', message: '[object Object]' })
  })
})

describe('logRejection', () => {
  it('logs a fire-and-forget failure with its scope instead of leaving it unhandled', async () => {
    const { logRejection } = await import('./util/log-rejection')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await Promise.reject(new Error('nope')).catch(logRejection('milestone chain advance'))
      expect(spy).toHaveBeenCalledWith('[background] milestone chain advance failed:', expect.objectContaining({ message: 'nope' }))
    } finally { spy.mockRestore() }
  })
})
