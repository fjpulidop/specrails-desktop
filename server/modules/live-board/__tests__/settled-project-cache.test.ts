import { describe, expect, it, vi } from 'vitest'
import { initDb } from '../../../db'
import type { LiveRunFacts } from '../domain'
import { readSettledOrFresh } from '../adapters/settled-project-cache'

const day = { from: '2026-11-21T00:00:00.000Z', to: '2026-11-22T00:00:00.000Z' }
const facts = (title: string) => [{ sourceId: 'r1', title } as unknown as LiveRunFacts]

function project() {
  const db = initDb(':memory:')
  const insertRun = (id: string, status: string) => db.prepare(`INSERT INTO loop_runs (id, project_id, loop_id, status, started_at) VALUES (?, 'p1', 'l', ?, ?)`).run(id, status, day.from)
  return { db, insertRun }
}

describe('live board: settled-project reuse', () => {
  it('reuses the read of a project with nothing live until its database changes', () => {
    const { db, insertRun } = project()
    insertRun('r1', 'completed')
    const read = vi.fn(() => facts('first'))
    expect(readSettledOrFresh({ db, hasLiveMemory: false }, day, read)).toEqual(facts('first'))
    expect(readSettledOrFresh({ db, hasLiveMemory: false }, day, read)).toEqual(facts('first'))
    expect(read).toHaveBeenCalledTimes(1)
    insertRun('r2', 'completed')
    read.mockReturnValue(facts('second'))
    expect(readSettledOrFresh({ db, hasLiveMemory: false }, day, read)).toEqual(facts('second'))
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reads every time while a run is running or paused', () => {
    const { db, insertRun } = project()
    insertRun('r1', 'paused')
    const read = vi.fn(() => facts('live'))
    readSettledOrFresh({ db, hasLiveMemory: false }, day, read)
    readSettledOrFresh({ db, hasLiveMemory: false }, day, read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reads every time while the project holds in-memory run state', () => {
    const { db } = project()
    const read = vi.fn(() => facts('rail'))
    readSettledOrFresh({ db, hasLiveMemory: true }, day, read)
    readSettledOrFresh({ db, hasLiveMemory: true }, day, read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reads again on a new local day', () => {
    const { db } = project()
    const read = vi.fn(() => facts('today'))
    readSettledOrFresh({ db, hasLiveMemory: false }, day, read)
    readSettledOrFresh({ db, hasLiveMemory: false }, { from: day.to, to: '2026-11-23T00:00:00.000Z' }, read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('hands out copies, never the cached rows', () => {
    const { db } = project()
    const first = readSettledOrFresh({ db, hasLiveMemory: false }, day, () => facts('copy'))
    ;(first[0] as { title: string }).title = 'mutated'
    expect(readSettledOrFresh({ db, hasLiveMemory: false }, day, () => facts('unused'))[0].title).toBe('copy')
  })

  it('sees a commit by another connection to the same database', async () => {
    const fs = await import('fs'); const os = await import('os'); const path = await import('path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-settled-'))
    try {
      const file = path.join(dir, 'jobs.sqlite')
      const db = initDb(file)
      const other = initDb(file)
      const read = vi.fn(() => facts('x'))
      readSettledOrFresh({ db, hasLiveMemory: false }, day, read)
      other.prepare(`INSERT INTO loop_runs (id, project_id, loop_id, status, started_at) VALUES ('ext', 'p1', 'l', 'completed', ?)`).run(day.from)
      readSettledOrFresh({ db, hasLiveMemory: false }, day, read)
      expect(read).toHaveBeenCalledTimes(2)
      other.close(); db.close()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
