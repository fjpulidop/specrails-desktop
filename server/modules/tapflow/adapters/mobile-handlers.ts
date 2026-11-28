/**
 * Host-task handlers of Test in Mobile Device (`factory:mobile-test`), registered per project with the
 * Core host-task dispatcher. Both read the run's target from `mobile_test_runs` (the interrupt carries only
 * the run id) and record what happened there, so the offer card can show it. Idempotent: a restart that
 * re-runs a handler rebuilds (incremental) or redelivers (a new build id) without harm.
 */
import type { HostTaskHandler } from '../../agent-runtime/runtime/host-task-dispatcher'
import type { MobilePlatform } from '../mobile-project'
import type { BuildOutcome } from './mobile-build'
import type { DeliveryOutcome } from './delivery'
import type { MobileRunsStore } from './mobile-runs-store'

export interface MobileTestHandlerDeps {
  store: MobileRunsStore
  build: (targetPath: string, platforms: readonly MobilePlatform[], log: (line: string) => void) => Promise<BuildOutcome>
  deliver: (request: { artifactPath: string; platform: MobilePlatform; deviceId?: string; log: (line: string) => void; signal?: AbortSignal }) => Promise<DeliveryOutcome>
  /** Called after a run ends in a handler (the offer card follows it). */
  onFinished?: (runId: string) => void
}

const platformName = (platform: MobilePlatform) => (platform === 'ios' ? 'iOS' : 'Android')

export function createMobileTestHandlers(deps: MobileTestHandlerDeps): Record<'mobile.build' | 'tapflow.deliver', HostTaskHandler> {
  const { store } = deps
  const finish = (runId: string, state: 'launched' | 'failed', result: Record<string, unknown>) => {
    store.finish(runId, state, result)
    try { deps.onFinished?.(runId) } catch { /* the card is advisory */ }
  }

  return {
    'mobile.build': async ({ runId, log }) => {
      const run = store.get(runId)
      if (!run) return { outcome: 'error', output: { detail: 'This run has no mobile test target; start it from the Test in Mobile Device offer or Loops.' } }
      const outcome = await deps.build(run.targetPath, run.platforms, log)
      if (outcome.outcome === 'built') {
        store.setArtifacts(runId, outcome.artifacts)
        return { outcome: 'built', output: { artifacts: outcome.artifacts.map((artifact) => ({ platform: artifact.platform, file: artifact.path.split('/').pop() })) } }
      }
      if (outcome.outcome === 'none') {
        finish(runId, 'failed', { detail: outcome.detail })
        return { outcome: 'none', output: { detail: outcome.detail } }
      }
      const output = { detail: outcome.detail, ...(outcome.command ? { command: outcome.command } : {}), ...(outcome.tail ? { tail: outcome.tail.slice(-8_000) } : {}) }
      finish(runId, 'failed', output)
      return { outcome: 'error', output }
    },

    'tapflow.deliver': async ({ runId, log, signal }) => {
      const run = store.get(runId)
      if (!run || !run.artifacts.length) return { outcome: 'error', output: { detail: 'Nothing was built for this run.' } }
      const devices: Array<{ platform: MobilePlatform; name: string; id: string; buildId: number; sessionId: string; watchUrl: string | null }> = []
      for (const artifact of run.artifacts) {
        let outcome: DeliveryOutcome
        try {
          outcome = await deps.deliver({ artifactPath: artifact.path, platform: artifact.platform, ...(run.devices[artifact.platform] ? { deviceId: run.devices[artifact.platform] } : {}), log, signal })
        } catch (err) {
          outcome = { outcome: 'failed', detail: (err as Error).message }
        }
        if (outcome.outcome !== 'launched') {
          const output = { detail: `${platformName(artifact.platform)}: ${outcome.detail}`, devices }
          finish(runId, 'failed', output)
          return { outcome: outcome.outcome === 'unavailable' ? 'unavailable' : 'error', output }
        }
        devices.push({ platform: artifact.platform, name: outcome.device.name, id: outcome.device.id, buildId: outcome.buildId, sessionId: outcome.sessionId, watchUrl: outcome.watchUrl })
        log(`Running on ${outcome.device.name}.`)
      }
      const summary = devices.map((device) => `${platformName(device.platform)} on ${device.name}`).join(', ')
      finish(runId, 'launched', { summary, devices })
      return { outcome: 'launched', output: { summary, devices } }
    },
  }
}
