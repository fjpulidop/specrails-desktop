// Public API of the event journal. The SQLite store is wired by `runtime.ts`.
export {
  ATTENTION_KINDS,
  JOURNAL_REF_KINDS,
  JOURNAL_RETENTION,
  classifyMessage,
  compactQuestion,
  refKey,
  signatureOf,
  type Attention,
  type JournalData,
  type JournalDraft,
  type JournalEvent,
  type JournalQuestion,
  type JournalRefKind,
  type RetentionPolicy,
} from './domain'
export type { JournalFilter, JournalStore } from './ports'
export { createEventJournal, matchesFilter, type BusLike, type EventJournal, type EventJournalDeps, type WaitOutcome, type WaitReason, type WaitRequest } from './application'
export { eventJournalFor, startEventJournal, stopEventJournal } from './runtime'
