import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import type { ProjectContext } from '../../../project-registry'
import { createLoopRun } from '../../loops/runtime/loop-runs-store'
import { createPrDelivery, transitionDecision } from './rail-pr-store'
import { getRail, setRailTickets } from './rails-store'
import { resolveRailRelaunch, restoreRelaunchRail } from './rail-relaunch'

describe('rail relaunch source and assignment ownership', () => {
  let db: DbInstance, ctx: ProjectContext
  beforeEach(() => {
    db = initDb(':memory:')
    ctx = { db, project: { id: 'p1', path: '/repo' } } as ProjectContext
  })
  afterEach(() => db.close())
  const failed = () => {
    const row = createPrDelivery(db, { railIndex: 0, railKey: '0-implement', loopId: 'factory:implement',
      loopName: 'Implement', ticketIds: [4], baseBranch: 'main', originSurface: 'dashboard' })
    transitionDecision(db, row.id, 'building', 'implementation_failed', { implementationOutcome: 'failed', deliveryOutcome: 'blocked' })
    return row
  }
  const shared = (id = 'shared', projectId = 'p1', ticketId = 4) => {
    createLoopRun(db, { id, projectId, railIndex: 0, loopId: 'factory:implement', ticketIds: [ticketId], ticketId,
      provider: 'claude', model: 'sonnet', iterationLimit: 1, startedAt: '2026-10-03T08:00:00Z' })
    db.prepare("UPDATE loop_runs SET status='completed' WHERE id=?").run(id)
  }

  it('rechecks assignment edits after preflight before restoring released specs', () => {
    const row = failed()
    const source = resolveRailRelaunch(ctx, 0, row.id)
    setRailTickets(db, 0, [99], 'freestyle')
    expect(() => restoreRelaunchRail(ctx, 0, source)).toThrow('different specs')
    expect(getRail(db, 0).ticketIds).toEqual([99])
  })

  it('rechecks dismissal and a newer shared generation after preflight', () => {
    const row = failed()
    const source = resolveRailRelaunch(ctx, 0, row.id)
    transitionDecision(db, row.id, 'implementation_failed', 'discarded')
    expect(() => restoreRelaunchRail(ctx, 0, source)).toThrow('changed')
    shared('first')
    const sharedSource = resolveRailRelaunch(ctx, 0, 'run:first')
    shared('second')
    expect(() => restoreRelaunchRail(ctx, 0, sharedSource)).toThrow('changed')
    expect(getRail(db, 0).ticketIds).toEqual([])
  })

  it('rejects active, cross-project and wrong-rail shared sources', () => {
    shared()
    expect(() => resolveRailRelaunch(ctx, 1, 'run:shared')).toThrow('unavailable')
    db.prepare("UPDATE loop_runs SET status='paused' WHERE id='shared'").run()
    expect(() => resolveRailRelaunch(ctx, 0, 'run:shared')).toThrow('active or paused')
    shared('foreign', 'other-project')
    expect(() => resolveRailRelaunch(ctx, 0, 'run:foreign')).toThrow('unavailable')
  })

  it('allows an earlier per-ticket sibling but rejects a later run over the same specs', () => {
    shared('first', 'p1', 4)
    shared('sibling', 'p1', 5)
    const source = resolveRailRelaunch(ctx, 0, 'run:first')
    expect(source.ticketIds).toEqual([4])
    expect(restoreRelaunchRail(ctx, 0, source)).toBe(true)
    expect(getRail(db, 0).ticketIds).toEqual([4])
    shared('replacement', 'p1', 4)
    expect(() => resolveRailRelaunch(ctx, 0, 'run:first')).toThrow('replaced')
  })

  it('reconstructs the complete historical repository scope instead of the first repository request', () => {
    const row = failed()
    shared('recorded-run')
    db.prepare('UPDATE loop_runs SET run_request_json=? WHERE id=?').run(JSON.stringify({ repositoryId: 'backend', workspacePaths: ['api'], profileName: null, cwd: '/old/checkout', runId: 'recorded-run' }), 'recorded-run')
    transitionDecision(db, row.id, 'implementation_failed', 'implementation_failed', {
      runIds: ['recorded-run'], executionManifest: { version: 1, groupId: row.id, projectId: 'p1', primaryRepositoryId: 'backend', artifactRepositoryId: 'backend', selectedRepositoryIds: ['backend', 'frontend'],
        repositories: ['backend', 'frontend'].map(repositoryId => ({ repositoryId, name: repositoryId, sourcePath: `/repos/${repositoryId}`, gitCommonDir: '/git', baseBranch: 'main', baseSha: 'a'.repeat(40), worktreePath: `/old/${repositoryId}`, branch: 'fix/old', worktreeId: repositoryId, selectedWorkspacePaths: [repositoryId === 'backend' ? 'api' : 'app'] })) },
    })
    const source = resolveRailRelaunch(ctx, 0, row.id)
    expect(source.config.repositoryIds).toEqual(['backend', 'frontend'])
    expect(source.config.workspaceSelection).toEqual({ backend: ['api'], frontend: ['app'] })
    expect(source.config.profileName).toBeNull()
    expect(source.config).not.toHaveProperty('cwd'); expect(source.config).not.toHaveProperty('runId')
  })

  it.each([false, true])('omits default workspace scope reconstructed from a manifest (saved config: %s)', saved => {
    const row = failed()
    if (saved) db.prepare('UPDATE rail_pr_deliveries SET launch_config_json=? WHERE id=?').run(JSON.stringify({ mode: 'loop', loopId: 'factory:implement' }), row.id)
    transitionDecision(db, row.id, 'implementation_failed', 'implementation_failed', {
      executionManifest: { version: 1, groupId: row.id, projectId: 'p1', primaryRepositoryId: 'backend', artifactRepositoryId: 'backend', selectedRepositoryIds: ['backend', 'frontend'],
        repositories: ['backend', 'frontend'].map(repositoryId => ({ repositoryId, name: repositoryId, sourcePath: `/repos/${repositoryId}`, gitCommonDir: '/git', baseBranch: 'main', baseSha: 'a'.repeat(40), worktreePath: `/old/${repositoryId}`, branch: 'fix/old', worktreeId: repositoryId })) },
    })
    const source = resolveRailRelaunch(ctx, 0, row.id)
    expect(source.config.repositoryIds).toEqual(['backend', 'frontend'])
    expect(source.config).not.toHaveProperty('workspaceSelection')
  })

  it.each([undefined, { backend: ['other-api'] }, { backend: [] }, {}, null])('preserves partial narrowing and saved explicit scope %j', savedSelection => {
    const row = failed()
    if (savedSelection !== undefined) db.prepare('UPDATE rail_pr_deliveries SET launch_config_json=? WHERE id=?').run(JSON.stringify({ mode: 'loop', loopId: 'factory:implement', workspaceSelection: savedSelection }), row.id)
    transitionDecision(db, row.id, 'implementation_failed', 'implementation_failed', {
      executionManifest: { version: 1, groupId: row.id, projectId: 'p1', primaryRepositoryId: 'backend', artifactRepositoryId: 'backend', selectedRepositoryIds: ['backend', 'frontend'],
        repositories: ['backend', 'frontend'].map(repositoryId => ({ repositoryId, name: repositoryId, sourcePath: `/repos/${repositoryId}`, gitCommonDir: '/git', baseBranch: 'main', baseSha: 'a'.repeat(40), worktreePath: `/old/${repositoryId}`, branch: 'fix/old', worktreeId: repositoryId,
          ...(repositoryId === 'backend' ? { selectedWorkspacePaths: ['api'] } : {}),
        })) },
    })
    const source = resolveRailRelaunch(ctx, 0, row.id)
    expect(source.config.repositoryIds).toEqual(['backend', 'frontend'])
    expect(source.config.workspaceSelection).toEqual(savedSelection !== undefined ? savedSelection : { backend: ['api'] })
  })

  it('refuses corrupt saved options and missing dynamic rails without changing assignments', () => {
    const row = failed()
    db.prepare('UPDATE rail_pr_deliveries SET launch_config_json=? WHERE id=?').run('[]', row.id)
    expect(() => resolveRailRelaunch(ctx, 0, row.id)).toThrow('Invalid saved launch configuration')
    db.prepare('UPDATE rail_pr_deliveries SET launch_config_json=NULL, rail_index=5 WHERE id=?').run(row.id)
    expect(() => resolveRailRelaunch(ctx, 5, row.id)).toThrow('rail was removed')
    expect(getRail(db, 0).ticketIds).toEqual([])
  })
})
