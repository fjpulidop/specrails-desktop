/**
 * Production wiring of the machine's run admission: default limits from this
 * machine (overridable through the environment), the CPU/memory sampler, the
 * provider quota store, and the app-level announcement of queue changes. Bound
 * once at startup; `runAdmission()` is what each project's loop engine reads.
 */
import os from 'node:os'
import { quotaView } from '../../provider-quota/runtime/quota-reports'
import { createRunAdmission, type QueueEvent, type RunAdmission } from '../admission'
import { admissionDisabled, defaultCapacityLimits, limitsFromEnv } from '../domain'
import { createMachineSampler } from './machine'

let bound: RunAdmission | null = null

/** The machine's admission queue; null when admission is off (or in tests that bind none). */
export function runAdmission(): RunAdmission | null { return bound }

export function bindRunAdmission(next: RunAdmission | null): void { bound?.dispose(); bound = next }

export interface RunQueueMessage { type: 'loop.run_queue'; event: QueueEvent['type']; projectId: string; loopRunId: string; waitingFor: string | null; position: number | null; timestamp: string }

export function createDesktopRunAdmission(options: { env?: NodeJS.ProcessEnv; announce?: (message: RunQueueMessage) => void } = {}): RunAdmission | null {
  const env = options.env ?? process.env
  if (admissionDisabled(env)) return null
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  const limits = limitsFromEnv(defaultCapacityLimits({ cores, totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024) }), env)
  const machine = createMachineSampler()
  const admission = createRunAdmission({
    limits: () => limits,
    machine: () => machine.read(),
    quota: (provider) => {
      const view = quotaView(provider)
      return { usedPercent: view?.usedPercent ?? null, rejected: view?.level === 'rejected' }
    },
    onChange: (event) => options.announce?.({ type: 'loop.run_queue', event: event.type, projectId: event.run.projectId, loopRunId: event.run.runId,
      waitingFor: event.type === 'queued' ? event.waitingFor : null, position: event.type === 'queued' ? event.position : null, timestamp: new Date().toISOString() }),
  })
  return { ...admission, dispose: () => { admission.dispose(); machine.dispose() } }
}
