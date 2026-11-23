import type { DbInstance } from '../../db/types'
import { createSqliteJournalStore } from './adapters/sqlite'
import { createEventJournal, type BusLike, type EventJournal } from './application'

/**
 * One journal per app database, fed by the in-process bus that mirrors every
 * WebSocket broadcast (`getMobileEventBus()`). The composition root starts it at
 * boot so rows exist before the first MCP call; readers get the same instance
 * through `eventJournalFor`.
 */
const journals = new WeakMap<DbInstance, EventJournal>()

export function eventJournalFor(db: DbInstance, bus?: BusLike): EventJournal {
  let journal = journals.get(db)
  if (!journal) {
    journal = createEventJournal({ store: createSqliteJournalStore(db) })
    journals.set(db, journal)
  }
  if (bus) journal.attach(bus)
  return journal
}

/** Boot: create the journal on the app database and attach it to the broadcast bus. Never throws. */
export function startEventJournal(db: DbInstance, bus: BusLike): EventJournal | null {
  try {
    return eventJournalFor(db, bus)
  } catch {
    return null
  }
}

/** Shutdown / tests. */
export function stopEventJournal(db: DbInstance): void {
  journals.get(db)?.close()
  journals.delete(db)
}
