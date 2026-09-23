import type { JobInvocation } from './domain/job-accounting'

/** Writes run in the caller's existing settlement/replay transaction. */
export interface JobAccountingPorts {
  newId(): string
  write(invocation: JobInvocation): void
}
