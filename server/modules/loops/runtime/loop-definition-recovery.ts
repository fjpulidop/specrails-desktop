import { execFile } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DbInstance } from '../../../db'
import { resolveCoreNodeRuntime } from '../../../core-node-runtime'
import { windowsSpawnEnv } from '../../../util/win-spawn'
import { readFrozenRuntimeHost } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { resolveRetainedAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-package'
import { readDefinitionRun, type DefinitionCheckpoint } from './loop-runs-store'
import type { DefinitionCompletion, DefinitionInterrupt } from './loop-definition-run'

export interface DefinitionRunProbe {
  runId: string
  engineVersion: 2
  status: 'paused' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unavailable'
  resumable: boolean
  /** Epoch milliseconds from Core, never inferred from Desktop's updated_at. */
  lease: { owner: string; epoch: number; expiresAt: number; active: boolean } | null
  recoverableSteps: Array<{ attemptId: string; nodePath: string; scopeId: string }>
  pendingInterrupts: DefinitionInterrupt[]
  completion: DefinitionCompletion | null
  /** Full inspection only; exact scope/attempt identities prevent branch conflation. */
  scopes?: Array<{ nodePath: string; scopeId: string; kind: string; status: string; attemptId: string | null; output?: unknown }>
  coreRevision: number | null
  eventCursor: number | null
  probedAt: string
  error?: { code: string; message: string }
}
export interface DefinitionProbeContext { db: DbInstance; cwd: string; env: NodeJS.ProcessEnv }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Read only through the retained CLI. Failed inspection preserves ownership for a later explicit decision. */
export async function probeDefinitionRun(ctx: DefinitionProbeContext, runId: string, includeOutputs = false): Promise<DefinitionRunProbe> {
  const unavailable = (message: string): DefinitionRunProbe => ({ runId, engineVersion: 2, status: 'unavailable', resumable: false,
    lease: null, recoverableSteps: [], pendingInterrupts: [], completion: null, coreRevision: null, eventCursor: null,
    probedAt: new Date().toISOString(), error: { code: 'runtime_status_unavailable', message: message.slice(0, 2000) } })
  try {
    const frozen = readDefinitionRun(ctx.db, runId), contextPath = frozen?.metadata.contextPath
    if (!frozen || !contextPath || !path.isAbsolute(contextPath)) return unavailable('Frozen Core context is unavailable')
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as { runId?: string; backlogRoot?: string }
    if (context.runId !== runId || typeof context.backlogRoot !== 'string' || realpathSync(contextPath) !== path.join(realpathSync(context.backlogRoot), '.specrails', 'pipeline', runId, 'desktop-context.json')) return unavailable('Frozen Core context belongs to another run or path')
    const host = readFrozenRuntimeHost(contextPath, ctx.env, runId)
    const cli = resolveRetainedAgentRuntime(contextPath)
    const { stdout } = await promisify(execFile)(resolveCoreNodeRuntime(), [cli, 'status', '--context', contextPath, ...(includeOutputs ? [] : ['--compact'])], {
      cwd: host.cwd, env: windowsSpawnEnv(host.env), windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    })
    const result: unknown = JSON.parse(stdout)
    if (!record(result) || result.type !== 'runtime-status' || result.engineVersion !== 2 || !record(result.state)) return unavailable('Retained Core returned an incompatible status')
    const state = result.state
    if (state.runId !== runId || !['paused', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'].includes(String(state.status)) || !integer(result.revision) || !integer(result.eventCursor)) return unavailable('Retained Core returned an invalid run identity or cursor')
    const lease = state.lease
    if (lease !== null && (!record(lease) || typeof lease.owner !== 'string' || !integer(lease.epoch) || !integer(lease.expiresAt) || typeof lease.active !== 'boolean')) return unavailable('Retained Core returned an invalid lease')
    if (!Array.isArray(state.recoverableSteps) || state.recoverableSteps.length > 10_000 || state.recoverableSteps.some(value => !record(value) || typeof value.attemptId !== 'string' || !value.attemptId || typeof value.nodePath !== 'string' || typeof value.scopeId !== 'string')) return unavailable('Retained Core returned invalid recovery attempts')
    if (!Array.isArray(state.pendingInterrupts) || state.pendingInterrupts.length > 10_000 || state.pendingInterrupts.some(value => !record(value) || typeof value.id !== 'string' || typeof value.nodePath !== 'string' || !['question', 'approval', 'gate'].includes(String(value.kind)))) return unavailable('Retained Core returned invalid interrupts')
    if (includeOutputs && (!Array.isArray(state.scopes) || state.scopes.length > 10_000 || state.scopes.some(value =>
      !record(value) || typeof value.nodePath !== 'string' || typeof value.scopeId !== 'string' || typeof value.kind !== 'string' || typeof value.status !== 'string' || (value.attemptId !== null && typeof value.attemptId !== 'string')))) return unavailable('Retained Core returned invalid scoped evidence')
    const completion = result.completion
    if (completion !== null && (!record(completion) || typeof completion.ok !== 'boolean' || typeof completion.verified !== 'boolean' || !Array.isArray(completion.reasons) || completion.reasons.some(reason => typeof reason !== 'string'))) return unavailable('Retained Core returned invalid completion evidence')
    return { runId, engineVersion: 2, status: state.status as DefinitionRunProbe['status'], lease: lease as DefinitionRunProbe['lease'],
      resumable: !(lease as DefinitionRunProbe['lease'])?.active && completion === null && !['succeeded', 'cancelled'].includes(String(state.status)),
      recoverableSteps: state.recoverableSteps.map(value => ({ attemptId: value.attemptId as string, nodePath: value.nodePath as string, scopeId: value.scopeId as string })),
      pendingInterrupts: state.pendingInterrupts as DefinitionInterrupt[], completion: completion as DefinitionCompletion | null,
      ...(includeOutputs ? { scopes: state.scopes as DefinitionRunProbe['scopes'] } : {}),
      coreRevision: result.revision, eventCursor: result.eventCursor, probedAt: new Date().toISOString() }
  } catch (error) { return unavailable(error instanceof Error ? error.message : 'Retained runtime inspection failed') }
}

/** Bound subprocess fan-out independently of the number of historical runs. */
export async function probeDefinitionRuns(ctx: DefinitionProbeContext, runIds: string[], includeOutputs = false): Promise<Map<string, DefinitionRunProbe>> {
  const results = new Map<string, DefinitionRunProbe>(), ids = [...new Set(runIds)]
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    for (;;) { const id = ids[cursor++]; if (id === undefined) return; results.set(id, await probeDefinitionRun(ctx, id, includeOutputs)) }
  }))
  return results
}

export function toDefinitionStates(probes: ReadonlyMap<string, DefinitionRunProbe>): Map<string, DefinitionCheckpoint> {
  return new Map([...probes].map(([id, probe]) => [id, {
    // Preserve even unavailable/terminal Core rows until Desktop explicitly
    // settles their original delivery. A failed probe is not failed work.
    status: probe.status === 'paused' ? 'paused' : 'interrupted', coreStatus: probe.status,
    ...(probe.coreRevision === null ? {} : { revision: probe.coreRevision }), ...(probe.eventCursor === null ? {} : { eventCursor: probe.eventCursor }),
    lease: probe.lease, completion: probe.completion, pendingInterrupts: probe.pendingInterrupts, recoverableSteps: probe.recoverableSteps,
    ...(probe.error ? { error: probe.error } : {}),
  }]))
}
