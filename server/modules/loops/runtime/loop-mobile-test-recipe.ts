import { defaultLoopAgents } from './loop-agents'
import type { CoreNodeKind, LoopGraph, LoopNode } from './loop-graph'

/**
 * Test in Mobile Device (`factory:mobile-test`): build the app the person is developing for the iOS
 * Simulator or an Android emulator and run it on a Tapflow device. Deterministic and autonomous: two
 * Desktop host tasks (server/modules/tapflow), no AI turn, no question; a failure ends the run with its
 * reason (the build command and its log tail, or what to turn on).
 *
 *   start → build (mobile.build) ─built→ deliver (tapflow.deliver) ─launched→ done
 *                                │none → no-app                   │unavailable → tapflow-unavailable
 *                                └error → build-failed            └error → delivery-failed
 *   (`failed`, implicit on every host task, is the dispatcher failing to run it → failed)
 *
 * The run's target (working copy, platforms) is recorded by the host before launch: Core's host-task
 * interrupt carries only the run id. Requires Core `hostTasks: 1`.
 */
export const MOBILE_TEST_LOOP_ID = 'factory:mobile-test'
export const MOBILE_TEST_HOST_TASKS = ['mobile.build', 'tapflow.deliver'] as const
/** A clean iOS build of a real app takes minutes; Gradle's first run downloads its distribution. */
export const MOBILE_BUILD_TIMEOUT_MS = 60 * 60_000
export const MOBILE_DELIVER_TIMEOUT_MS = 15 * 60_000

export const MOBILE_TEST_ENDS = {
  launched: 'done',
  noApp: 'no-app',
  buildFailed: 'build-failed',
  unavailable: 'tapflow-unavailable',
  deliveryFailed: 'delivery-failed',
  failed: 'failed',
} as const

export function mobileTestGraph(): LoopGraph {
  const nodes: LoopNode[] = [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }]
  const edges: LoopGraph['edges'] = [{ id: 'e-start', source: 'start', target: 'build' }]
  const node = (id: string, label: string, kind: CoreNodeKind, params: Record<string, unknown>, outcomes: Record<string, string>) => {
    nodes.push({ id, type: 'core', position: { x: 0, y: nodes.length * 140 }, data: { kind, label, params } })
    for (const [outcome, target] of Object.entries(outcomes)) edges.push({ id: `e-${id}-${outcome}`, source: id, target, label: outcome })
  }
  const E = MOBILE_TEST_ENDS
  // `write`: the build writes its output under .specrails/mobile-build/ in the working copy.
  node('build', 'Build for the simulator', 'host-task', { task: 'mobile.build', input: {}, outcomes: ['built', 'none', 'error'], effect: 'write', timeoutMs: MOBILE_BUILD_TIMEOUT_MS },
    { built: 'deliver', none: E.noApp, error: E.buildFailed, failed: E.failed })
  node('deliver', 'Install and launch on the device', 'host-task', { task: 'tapflow.deliver', input: {}, outcomes: ['launched', 'unavailable', 'error'], effect: 'read', timeoutMs: MOBILE_DELIVER_TIMEOUT_MS },
    { launched: E.launched, unavailable: E.unavailable, error: E.deliveryFailed, failed: E.failed })
  const end = (id: string, outcome: 'success' | 'failure', reason: string, x: number) =>
    nodes.push({ id, type: 'end', position: { x, y: nodes.length * 140 }, data: { outcome, reason, ...(outcome === 'success' ? { requiresVerified: false } : {}) } })
  end(E.launched, 'success', 'The app is running: {{outputs.deliver.result.summary}}', 0)
  end(E.noApp, 'failure', '{{outputs.build.result.detail}}', 360)
  end(E.buildFailed, 'failure', 'The build failed: {{outputs.build.result.detail}}', 720)
  end(E.unavailable, 'failure', '{{outputs.deliver.result.detail}}', 1080)
  end(E.deliveryFailed, 'failure', '{{outputs.deliver.result.detail}}', 1440)
  end(E.failed, 'failure', 'The mobile test stopped on an unexpected error; the run log has the details.', 1800)
  return {
    nodes,
    edges,
    config: {
      maxIterations: 1,
      maxTransitions: 20,
      timeoutMinutes: 0,
      aiStepTimeoutMinutes: 0,
      change: 'none',
      journal: 'ledger-only',
      ticketScope: 'all',
      agents: defaultLoopAgents(),
      deliveryRequiresVerified: false,
    },
  }
}
