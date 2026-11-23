import type { JournalDraft, JournalEvent, RetentionPolicy } from './domain'

/** Which rows a reader wants. Every clause is optional; an empty filter matches every row. */
export interface JournalFilter {
  /** Only these entities (`refKind` + `refId`). */
  refs?: ReadonlyArray<{ kind: string; id: string }>
  /** Only this project's rows. */
  projectId?: string
  /** `settled`: terminal rows or rows that need the person; `attention`: rows that need the person. */
  match?: 'all' | 'settled' | 'attention'
  /** Also every row that needs the person, outside `refs` (within `projectId`). */
  alsoAttention?: boolean
}

export interface AppendRow extends JournalDraft {
  at: string
  prevStatus: string | null
}

/** Outbound persistence contract of the journal (one app-level database). */
export interface JournalStore {
  /** Appends rows atomically, in order; returns them with their `seq`. */
  append(rows: readonly AppendRow[]): JournalEvent[]
  /** Rows after `afterSeq` that match, oldest first. */
  read(afterSeq: number, filter: JournalFilter, limit: number): JournalEvent[]
  /** The most recent `limit` matching rows (oldest first). */
  tail(filter: JournalFilter, limit: number): JournalEvent[]
  /** The latest row of each ref (absent refs are missing from the map). */
  latest(refs: ReadonlyArray<{ kind: string; id: string }>): Map<string, JournalEvent>
  /** Highest and lowest retained seq (0 when empty). */
  bounds(): { head: number; oldest: number }
  /** A random id minted once per database: cursors from another database are recognized. */
  epoch(): string
  /** Applies retention and compaction; returns the rows deleted. */
  compact(policy: RetentionPolicy, nowMs: number): number
}
