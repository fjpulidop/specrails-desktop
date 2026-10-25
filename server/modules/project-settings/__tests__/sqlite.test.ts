import { afterEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { createProjectSettingsService } from '..'
import { createSqliteProjectSettingsRepository, getAgentAuditRetentionDays } from '../adapters/sqlite'

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
  it('defaults to on, persists per project and records an explicit opt-out', () => {
    const first = setup(), second = setup()
    expect(first.service.getSettings().allowSubagents).toBe(true)
    expect(first.service.updateSettings({ allowSubagents: false }).allowSubagents).toBe(false)
    expect(second.service.getSettings().allowSubagents).toBe(true)
    expect(first.db.prepare("SELECT value FROM queue_state WHERE key = 'config.allow_subagents'").get()).toEqual({ value: 'false' })
    expect(first.service.updateSettings({ allowSubagents: true }).allowSubagents).toBe(true)
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


describe('reviewerFamilySuggestionDismissed persistence', () => {
  it('defaults to shown, persists the dismissal per project and clears its row when reset', () => {
    const first = setup(), second = setup()
    expect(first.service.getSettings().reviewerFamilySuggestionDismissed).toBe(false)
    expect(first.service.updateSettings({ reviewerFamilySuggestionDismissed: true }).reviewerFamilySuggestionDismissed).toBe(true)
    expect(first.service.getSettings().reviewerFamilySuggestionDismissed).toBe(true)
    expect(second.service.getSettings().reviewerFamilySuggestionDismissed).toBe(false)
    first.service.updateSettings({ reviewerFamilySuggestionDismissed: false })
    expect(first.db.prepare("SELECT 1 FROM queue_state WHERE key = 'config.reviewer_family_suggestion_dismissed'").get()).toBeUndefined()
  })
})

describe('reviewWipLimit persistence', () => {
  it('defaults to no limit, persists per project, clears with null and reads a corrupt value as no limit', () => {
    const first = setup(), second = setup()
    expect(first.service.getSettings().reviewWipLimit).toBeNull()
    expect(first.service.updateSettings({ reviewWipLimit: 5 }).reviewWipLimit).toBe(5)
    expect(first.service.getSettings().reviewWipLimit).toBe(5)
    expect(second.service.getSettings().reviewWipLimit).toBeNull()
    first.service.updateSettings({ reviewWipLimit: null })
    expect(first.db.prepare("SELECT 1 FROM queue_state WHERE key = 'config.review_wip_limit'").get()).toBeUndefined()
    first.db.prepare("INSERT INTO queue_state (key, value) VALUES ('config.review_wip_limit', '0')").run()
    expect(first.service.getSettings().reviewWipLimit).toBeNull()
  })
})

describe('agentEnvMode persistence', () => {
  it('defaults to inherit, stores only the minimal opt-in and reads unknown values as inherit', () => {
    const { db, service } = setup()
    expect(service.getSettings().agentEnvMode).toBe('inherit')
    expect(service.updateSettings({ agentEnvMode: 'minimal' }).agentEnvMode).toBe('minimal')
    service.updateSettings({ agentEnvMode: 'inherit' })
    expect(db.prepare("SELECT 1 FROM queue_state WHERE key = 'config.agent_env_mode'").get()).toBeUndefined()
    db.prepare("INSERT INTO queue_state (key, value) VALUES ('config.agent_env_mode', 'bogus')").run()
    expect(service.getSettings().agentEnvMode).toBe('inherit')
  })
})

describe('agentAuditRetentionDays persistence', () => {
  it('defaults to 30 days, persists per project and clears its row at the default', () => {
    const first = setup(), second = setup()
    expect(first.service.getSettings().agentAuditRetentionDays).toBe(30)
    expect(first.service.updateSettings({ agentAuditRetentionDays: 7 }).agentAuditRetentionDays).toBe(7)
    expect(getAgentAuditRetentionDays(first.db)).toBe(7)
    expect(second.service.getSettings().agentAuditRetentionDays).toBe(30)
    first.service.updateSettings({ agentAuditRetentionDays: 30 })
    expect(first.db.prepare("SELECT 1 FROM queue_state WHERE key = 'config.agent_audit_retention_days'").get()).toBeUndefined()
  })

  it('reads a corrupt stored value as the default', () => {
    const { db, service } = setup()
    db.prepare("INSERT INTO queue_state (key, value) VALUES ('config.agent_audit_retention_days', 'forever')").run()
    expect(service.getSettings().agentAuditRetentionDays).toBe(30)
  })
})

describe('phase-3 switch persistence', () => {
  let db: DbInstance | undefined
  afterEach(() => { db?.close(); db = undefined })
  it('stores each switch only while it is on, default off', () => {
    db = initDb(':memory:')
    const service = createProjectSettingsService(createSqliteProjectSettingsRepository(db))
    expect(service.getSettings()).toMatchObject({ jiraPostClarifications: false, baselineOnTouch: false })
    expect(service.updateSettings({ jiraPostClarifications: true, baselineOnTouch: true })).toMatchObject({ jiraPostClarifications: true, baselineOnTouch: true })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM queue_state WHERE key IN ('config.jira_post_clarifications','config.baseline_on_touch')`).get()).toEqual({ n: 2 })
    service.updateSettings({ jiraPostClarifications: false, baselineOnTouch: false })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM queue_state WHERE key IN ('config.jira_post_clarifications','config.baseline_on_touch')`).get()).toEqual({ n: 0 })
  })
})
