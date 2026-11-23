// Process-level fault policy for the server (one event loop serving every
// project, its queues, chats and rail children).
//
// unhandledRejection — LOG, KEEP RUNNING. Since Node 15 an unhandled rejection
//   is fatal by default, so one forgotten `.catch` on a fire-and-forget promise
//   (a broadcast, a best-effort cleanup) took the whole app down mid-run and
//   orphaned rail children. A rejection is a contained, already-settled async
//   failure: the work that failed is gone, nothing is half-mutated by the
//   rejection itself, so it is logged with context and the server continues.
//
// uncaughtException — LOG, THEN EXIT (non-zero) AS BEFORE. A synchronous throw
//   that escaped to the event loop can leave in-memory state (queues, spawn
//   reservations, open transactions) inconsistent; continuing is unsafe. The
//   pre-existing semantics (process exits with code 1) are kept, but the exit
//   now goes through the graceful shutdown so rail/chat children are
//   tree-killed, the PID file and data-home lock are released and the port is
//   freed for a relaunch. A hard deadline guarantees the exit even if shutdown
//   itself hangs or throws again.

export type FaultLogger = (message: string, detail: Record<string, unknown>) => void

export interface ProcessFaultHandlerOptions {
  /** Graceful shutdown with the given exit code. Must eventually exit. */
  shutdown: (exitCode: number) => Promise<void> | void
  /** Hard exit after an uncaught exception if shutdown has not exited by then. */
  fatalExitDeadlineMs?: number
  log?: FaultLogger
  exit?: (code: number) => never | void
  target?: Pick<NodeJS.Process, 'on'>
}

export function describeFault(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    const detail: Record<string, unknown> = { name: reason.name, message: reason.message, stack: reason.stack }
    const code = (reason as NodeJS.ErrnoException).code
    if (code !== undefined) detail.code = code
    if (reason.cause !== undefined) detail.cause = reason.cause instanceof Error ? reason.cause.message : String(reason.cause)
    return detail
  }
  let rendered: string
  try { rendered = typeof reason === 'string' ? reason : JSON.stringify(reason) ?? String(reason) } catch { rendered = String(reason) }
  return { name: typeof reason, message: rendered }
}

const defaultLog: FaultLogger = (message, detail) => {
  const { stack, ...rest } = detail
  console.error(`[process] ${message}`, rest)
  if (typeof stack === 'string') console.error(stack)
}

export function installProcessFaultHandlers(opts: ProcessFaultHandlerOptions): void {
  const log = opts.log ?? defaultLog
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const target = opts.target ?? process
  const deadline = opts.fatalExitDeadlineMs ?? 10_000
  let unhandledCount = 0
  let fatal = false

  target.on('unhandledRejection', (reason: unknown) => {
    unhandledCount += 1
    log('unhandled promise rejection (logged; server keeps running)', {
      ...describeFault(reason),
      occurrence: unhandledCount,
    })
  })

  target.on('uncaughtException', (error: Error, origin?: string) => {
    log('uncaught exception — shutting down', { ...describeFault(error), origin: origin ?? 'uncaughtException', alreadyFatal: fatal })
    if (fatal) return
    fatal = true
    const timer = setTimeout(() => exit(1), deadline)
    timer.unref?.()
    try {
      void Promise.resolve(opts.shutdown(1)).catch((shutdownError: unknown) => {
        log('graceful shutdown after uncaught exception failed', describeFault(shutdownError))
        exit(1)
      })
    } catch (shutdownError) {
      log('graceful shutdown after uncaught exception failed', describeFault(shutdownError))
      exit(1)
    }
  })
}
