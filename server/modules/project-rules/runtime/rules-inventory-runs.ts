/**
 * One place that runs Core's rules inventory for a project (task 4.4): the
 * settings panel's **Re-run** and the automatic run after project setup share
 * it, so two runs never overlap for a project and the panel can show how the
 * last run went (an automatic run has nobody watching a toast).
 *
 * State is per project id and in memory: whether a run is in flight, the last
 * run's outcome, and whether the after-setup run already happened in this
 * process. Nothing here outlives a restart; the inventory file itself is the
 * durable record.
 */
import { readProjectRules, runRulesInventory, type RulesInventoryRunResult, type RulesProject } from './rules-store'

export type RulesInventoryTrigger = 'setup' | 'manual'

/** How the latest run of a project ended (the panel shows it; output is bounded). */
export interface RulesInventoryLastRun {
  trigger: RulesInventoryTrigger
  ok: boolean
  exitCode: number | null
  /** The tail of Core's output when the run failed (null on success). */
  output: string | null
  at: string
}

export type RulesProjectRef = RulesProject & { id: string }

/** Why the after-setup run did not run (or that it ran). */
export type AfterSetupOutcome = 'ran' | 'failed' | 'unsupported' | 'already_ran' | 'running' | 'up_to_date'

/** Classifications that already reflect the project's rules: an after-setup run adds nothing. */
const SETTLED_CLASSIFICATIONS = new Set(['classified', 'cached', 'empty'])

const OUTPUT_CAP = 2000

export interface RulesInventoryRunsDeps {
  run?: (project: RulesProject) => Promise<RulesInventoryRunResult>
  read?: typeof readProjectRules
  now?: () => string
  log?: Pick<Console, 'warn'>
}

export function createRulesInventoryRuns(deps: RulesInventoryRunsDeps = {}) {
  const running = new Set<string>()
  const lastRuns = new Map<string, RulesInventoryLastRun>()
  const afterSetup = new Set<string>()
  const now = deps.now ?? (() => new Date().toISOString())
  const log = deps.log ?? console

  /** Run now unless a run is already in flight (null). Never throws. */
  async function run(project: RulesProjectRef, trigger: RulesInventoryTrigger, runner?: (project: RulesProject) => Promise<RulesInventoryRunResult>): Promise<RulesInventoryRunResult | null> {
    if (running.has(project.id)) return null
    running.add(project.id)
    try {
      let result: RulesInventoryRunResult
      try {
        result = await (runner ?? deps.run ?? runRulesInventory)(project)
      } catch (error) {
        result = { ok: false, exitCode: null, output: error instanceof Error ? error.message : String(error) }
      }
      lastRuns.set(project.id, {
        trigger, ok: result.ok, exitCode: result.exitCode,
        output: result.ok ? null : (result.output || '').slice(-OUTPUT_CAP) || null,
        at: now(),
      })
      return result
    } finally {
      running.delete(project.id)
    }
  }

  /**
   * After a project's setup succeeded: run the inventory once, in the
   * background of the caller (await it only in tests). Idempotent: at most one
   * after-setup run per project per process, never while another run is in
   * flight, and never when the stored inventory is already classified. Gated
   * on Core's `rulesInventory` capability. A failure is logged and kept as the
   * last run, which the rules panel shows.
   */
  async function runAfterSetup(project: RulesProjectRef, supported: () => Promise<boolean>): Promise<AfterSetupOutcome> {
    try {
      if (afterSetup.has(project.id)) return 'already_ran'
      if (running.has(project.id)) return 'running'
      if (!(await supported())) return 'unsupported'
      const current = (deps.read ?? readProjectRules)(project)
      if (current.state === 'ok' && SETTLED_CLASSIFICATIONS.has(current.inventory.classification?.status ?? '')) {
        afterSetup.add(project.id)
        return 'up_to_date'
      }
      afterSetup.add(project.id)
      const result = await run(project, 'setup')
      if (!result) return 'running'
      if (!result.ok) log.warn(`[project-rules] the rules inventory after setup failed for ${project.id} (exit ${result.exitCode ?? 'none'}): ${result.output.slice(-300)}`)
      return result.ok ? 'ran' : 'failed'
    } catch (error) {
      log.warn(`[project-rules] the rules inventory after setup could not start for ${project.id}: ${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    }
  }

  return {
    run,
    runAfterSetup,
    isRunning: (projectId: string) => running.has(projectId),
    lastRun: (projectId: string): RulesInventoryLastRun | null => lastRuns.get(projectId) ?? null,
    /** A removed project leaves nothing behind. */
    forget(projectId: string): void {
      lastRuns.delete(projectId)
      afterSetup.delete(projectId)
    },
  }
}

export type RulesInventoryRuns = ReturnType<typeof createRulesInventoryRuns>

/** The process's coordinator (production wiring: settings routes and setup completion). */
export const rulesInventoryRuns: RulesInventoryRuns = createRulesInventoryRuns()
