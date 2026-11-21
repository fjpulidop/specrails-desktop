/**
 * Rejection handler for fire-and-forget work (`void task().catch(logRejection('scope'))`).
 *
 * A background promise that rejects without a handler is logged by the
 * process-level policy (server/process-fault-handlers.ts) but without the
 * caller's context. Attaching this keeps the failure contained AND says which
 * subsystem/entity it belonged to.
 */
export function logRejection(scope: string): (error: unknown) => void {
  return (error: unknown) => {
    console.error(`[background] ${scope} failed:`, error)
  }
}
