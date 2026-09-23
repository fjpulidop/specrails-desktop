import { afterEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { createProjectSettingsService } from '..'
import { createSqliteProjectSettingsRepository } from '../adapters/sqlite'

const databases: DbInstance[] = []
function setup() {
  const db = initDb(':memory:')
  databases.push(db)
  return { db, service: createProjectSettingsService(createSqliteProjectSettingsRepository(db)) }
}
afterEach(() => { for (const db of databases.splice(0)) db.close() })

describe('SQLite settings repository contract', () => {
  it('returns normalized persisted values and keeps projects isolated', () => {
    const first = setup(), second = setup()
    const updated = first.service.updateSettings({ integrationBranch: ' develop ', orchestratorModel: 'opus' })
    expect(updated.integrationBranch).toBe('develop')
    expect(updated.orchestratorModelExplicit).toBe(true)
    expect(first.service.getSettings()).toEqual(updated)
    expect(second.service.getSettings().integrationBranch).toBe('')
    expect(second.service.getSettings().orchestratorModel).toBe('sonnet')
  })

  it('rolls back the entire patch if a later write fails', () => {
    const { db, service } = setup()
    const before = service.getSettings()
    db.exec(`CREATE TRIGGER reject_model BEFORE INSERT ON queue_state
      WHEN NEW.key = 'config.orchestrator_model'
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`)
    expect(() => service.updateSettings({ pipelineTelemetryEnabled: false, orchestratorModel: 'opus' }))
      .toThrow('simulated storage failure')
    expect(service.getSettings()).toEqual(before)
  })
})
