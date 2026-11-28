/** `mobile_test_runs` (project database, migrations 98-99): the target and outcome of each Test in Mobile Device run. */
import type { DbInstance } from '../../../db'
import type { MobilePlatform } from '../mobile-project'

export interface MobileTestRun {
  runId: string
  projectId: string
  platforms: MobilePlatform[]
  targetPath: string
  /** `branch`: a temporary worktree of a branch, removed when the run ends. */
  targetKind: 'review' | 'checkout' | 'branch'
  deliveryId: string | null
  conversationId: string | null
  state: 'running' | 'launched' | 'failed'
  artifacts: Array<{ platform: MobilePlatform; path: string }>
  result: Record<string, unknown> | null
  /** The device chosen per platform (Tapflow device id); absent = Tapflow picks. */
  devices: Partial<Record<MobilePlatform, string>>
  createdAt: string
}

interface Row {
  run_id: string; project_id: string; platforms: string; target_path: string; target_kind: MobileTestRun['targetKind']
  delivery_id: string | null; conversation_id: string | null; state: MobileTestRun['state']; artifacts: string; result: string | null
  devices: string | null; created_at: string
}

const toRun = (row: Row): MobileTestRun => ({
  runId: row.run_id, projectId: row.project_id, platforms: JSON.parse(row.platforms), targetPath: row.target_path, targetKind: row.target_kind,
  deliveryId: row.delivery_id, conversationId: row.conversation_id, state: row.state, artifacts: JSON.parse(row.artifacts), result: row.result ? JSON.parse(row.result) : null,
  devices: row.devices ? JSON.parse(row.devices) : {}, createdAt: row.created_at,
})

export function createMobileRunsStore(db: DbInstance) {
  const now = () => new Date().toISOString()
  return {
    create(run: Pick<MobileTestRun, 'runId' | 'projectId' | 'platforms' | 'targetPath' | 'targetKind' | 'deliveryId' | 'conversationId'> & { devices?: MobileTestRun['devices'] }): void {
      const devices = run.devices && Object.keys(run.devices).length ? JSON.stringify(run.devices) : null
      db.prepare(`INSERT INTO mobile_test_runs (run_id, project_id, platforms, target_path, target_kind, delivery_id, conversation_id, devices, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(run.runId, run.projectId, JSON.stringify(run.platforms), run.targetPath, run.targetKind, run.deliveryId, run.conversationId, devices, now(), now())
    },
    get(runId: string): MobileTestRun | null {
      const row = db.prepare('SELECT * FROM mobile_test_runs WHERE run_id = ?').get(runId) as Row | undefined
      return row ? toRun(row) : null
    },
    latestForDelivery(deliveryId: string): MobileTestRun | null {
      const row = db.prepare('SELECT * FROM mobile_test_runs WHERE delivery_id = ? ORDER BY created_at DESC LIMIT 1').get(deliveryId) as Row | undefined
      return row ? toRun(row) : null
    },
    setArtifacts(runId: string, artifacts: MobileTestRun['artifacts']): void {
      db.prepare('UPDATE mobile_test_runs SET artifacts = ?, updated_at = ? WHERE run_id = ?').run(JSON.stringify(artifacts), now(), runId)
    },
    finish(runId: string, state: 'launched' | 'failed', result: Record<string, unknown>): void {
      db.prepare('UPDATE mobile_test_runs SET state = ?, result = ?, updated_at = ? WHERE run_id = ?').run(state, JSON.stringify(result), now(), runId)
    },
  }
}
export type MobileRunsStore = ReturnType<typeof createMobileRunsStore>
