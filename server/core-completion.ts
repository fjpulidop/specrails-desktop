import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveCoreNodeRuntime } from './core-node-runtime'
import { findCoreAgentRuntimeCli } from './agent-runtime-loader'

export interface CoreCompletion {
  implementation: 'complete' | 'incomplete'
  validation: 'verified' | 'with-exceptions' | 'pending' | 'blocked'
  archive: 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'skipped'
  delivery: 'pending-host' | 'complete' | 'pending'
  reasons: string[]
}
export interface CoreCompletionSnapshot {
  completion: CoreCompletion
  recordedAt: string
  change: string
  exceptions: Array<{ requirement: string; reason: string; impact: string; acceptedBy: string; approvalEvidence: string }>
  checks: Array<{ name: string; status: string; required: boolean; scope: string; limitations: string; evidence: string[] }>
  findings: string[]
  phases: Array<{ name: string; status: string; durationMs: number | null; attempts: number | null }>
}
const obj = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** Parse only runtime-owned status, never the model's prose or stdout JSON. */
export function parseCoreCompletion(value: unknown, runId: string): CoreCompletionSnapshot | null {
  const status = obj(value), completion = obj(status?.completion)
  if (status?.schemaVersion !== 1 || status.runId !== runId || typeof status.change !== 'string' || !completion) return null
  const enums = { implementation: ['complete', 'incomplete'], validation: ['verified', 'with-exceptions', 'pending', 'blocked'], archive: ['pending', 'running', 'done', 'blocked', 'failed', 'skipped'], delivery: ['pending-host', 'complete', 'pending'] }
  if (Object.entries(enums).some(([key, values]) => !values.includes(String(completion[key]))) || !strings(completion.reasons)) return null
  const acceptance = obj(status.acceptance), receipt = obj(acceptance?.receipt)
  // Even a well-shaped summary cannot claim verified with invalid backing evidence.
  if (['verified', 'with-exceptions'].includes(String(completion.validation)) && (acceptance?.valid !== true || obj(status.verification)?.valid !== true || obj(obj(status.phases)?.reviewer)?.status !== 'done')) return null
  const exceptions: CoreCompletionSnapshot['exceptions'] = []
  for (const raw of Array.isArray(receipt?.criteria) ? receipt.criteria : []) {
    const row = obj(raw), exception = obj(row?.exception)
    if (row?.status === 'exception' && typeof row.requirement === 'string' && exception && ['reason', 'impact', 'acceptedBy', 'approvalEvidence'].every(key => typeof exception[key] === 'string')) {
      exceptions.push({ requirement: row.requirement, reason: exception.reason as string, impact: exception.impact as string, acceptedBy: exception.acceptedBy as string, approvalEvidence: exception.approvalEvidence as string })
    }
  }
  const checks: CoreCompletionSnapshot['checks'] = []
  for (const raw of Array.isArray(receipt?.checks) ? receipt.checks : []) {
    const check = obj(raw)
    if (check && ['name', 'status', 'scope', 'limitations'].every(key => typeof check[key] === 'string') && typeof check.required === 'boolean' && strings(check.evidence)) checks.push(check as unknown as CoreCompletionSnapshot['checks'][number])
  }
  return { completion: completion as unknown as CoreCompletion, recordedAt: new Date().toISOString(), change: status.change,
    exceptions, checks, findings: strings(receipt?.findings) ? receipt.findings : [],
    phases: Object.entries(obj(status.phases) ?? {}).flatMap(([name, raw]) => {
      const phase = obj(raw)
      return phase && typeof phase.status === 'string' ? [{ name, status: phase.status, durationMs: count(phase.durationMs), attempts: count(phase.attempts) }] : []
    }),
  }
}

export async function readCoreCompletion(input: { contextPath: string; cwd: string; env: NodeJS.ProcessEnv; runId: string }): Promise<CoreCompletionSnapshot | null> {
  const programmatic = existsSync(join(dirname(input.contextPath), 'agent-runtime-request.json'))
  const runtime = programmatic ? findCoreAgentRuntimeCli() : join(input.cwd, '.specrails', 'runtime', 'pipeline.mjs')
  if (!runtime || !existsSync(runtime)) return null
  try {
    const { stdout } = await promisify(execFile)(resolveCoreNodeRuntime(), [runtime, 'status', '--context', input.contextPath], {
      cwd: input.cwd, env: input.env, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    })
    const payload = JSON.parse(stdout)
    return parseCoreCompletion(programmatic ? payload.pipeline : payload, input.runId)
  } catch { return null }
}
