import type { JobInvocation } from './domain/job-accounting'

/** Writes run in the caller's existing settlement/replay transaction. */
export interface JobAccountingPorts {
  newId(): string
  write(invocation: JobInvocation): void
}

export interface DurableUsageRow { seq: number; event_type: string; payload: string }
export interface NormalizedRecoveryUsage {
  result: import('./domain/usage').JobUsage
  estimated: boolean
}

/** Reads stay lazy and ordered; provider interpretation is supplied by an adapter. */
export interface UsageRecoveryPorts<Event extends { kind: string }> {
  events(mode: 'all' | 'results' | 'tail', afterSeq?: number): Iterable<DurableUsageRow>
  parse(payload: string): readonly Event[]
  normalize(event: Event, fallbackModel?: string): NormalizedRecoveryUsage
  messageId(event: Event): string | undefined
  malformedEvent(error: unknown): void
}
