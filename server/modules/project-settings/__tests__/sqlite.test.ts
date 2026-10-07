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

describe('allowSubagents persistence', () => {
  it('defaults to off, persists per project and clears its row when turned off', () => {
    const first = setup(), second = setup()
    expect(first.service.getSettings().allowSubagents).toBe(false)
    expect(first.service.updateSettings({ allowSubagents: true }).allowSubagents).toBe(true)
    expect(second.service.getSettings().allowSubagents).toBe(false)
    first.service.updateSettings({ allowSubagents: false })
    expect(first.db.prepare("SELECT 1 FROM queue_state WHERE key = 'config.allow_subagents'").get()).toBeUndefined()
    expect(first.service.getSettings().allowSubagents).toBe(false)
  })
})

describe('subagentRuntime persistence', () => {
  it('stores the choice, clears it with null and reads a corrupt value as unset', () => {
    const { db, service } = setup()
    expect(service.getSettings().subagentRuntime).toBeNull()
    expect(service.updateSettings({ subagentRuntime: { provider: 'codex', model: 'gpt-5.6-terra', effort: 'low' } }).subagentRuntime).toEqual({ provider: 'codex', model: 'gpt-5.6-terra', effort: 'low' })
    service.updateSettings({ subagentRuntime: null })
    expect(db.prepare("SELECT 1 FROM queue_state WHERE key = 'config.subagent_runtime'").get()).toBeUndefined()
    db.prepare("INSERT INTO queue_state (key, value) VALUES ('config.subagent_runtime', '{bad')").run()
    expect(service.getSettings().subagentRuntime).toBeNull()
  })
})

