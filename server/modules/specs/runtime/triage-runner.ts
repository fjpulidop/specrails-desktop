// Spec triage — the one provider call (launch-triage).
//
// A single pure-output turn on the triage engine: no tools, no repository
// access, one JSON answer. Usage is finalised from the provider's own events so
// the caller records the REAL cost (or null) on the `triage` accounting surface;
// a failure after the provider billed tokens carries that partial usage too.

import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import { getAdapter } from '../../../providers'
import { buildProviderEnv, parseStreamEvents, pureOutputToolPolicy } from '../../../providers/runtime'
import type { AdapterEvent, SpawnOptions } from '../../../providers/types'
import { spawnAiCli } from '../../../util/cli-prompt'
import { trackTransientChild } from '../../../transient-children'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { finaliseInvocationResult } from '../../accounting/runtime/result-event'

export const TRIAGE_TIMEOUT_MS = 90_000
const MAX_OUTPUT_CHARS = 32_000

export interface TriageModelRequest {
  projectId: string
  project: { slug: string; path: string }
  provider: string
  model: string
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
}

export interface TriageModelUsage {
  model: string
  provider: string
  costUsd: number | null
  costEstimated: boolean
  tokensIn: number | null
  tokensOut: number | null
  tokensCacheRead?: number
  tokensCacheCreate?: number
  durationMs: number
}

export interface TriageModelResult extends TriageModelUsage {
  text: string
}

/** Error raised by the runner; `partial` carries usage billed before failing. */
export class TriageModelError extends Error {
  constructor(message: string, readonly partial?: TriageModelUsage) {
    super(message)
    this.name = 'TriageModelError'
  }
}

export type TriageModelRunner = (request: TriageModelRequest) => Promise<TriageModelResult>

export const runTriageModel: TriageModelRunner = (request) => {
  const adapter = getAdapter(request.provider)
  const toolPolicy = pureOutputToolPolicy(adapter)
  if (!toolPolicy) return Promise.reject(new TriageModelError(`provider_tool_policy_unsupported:${adapter.id}:pure-output`))
  const startedAt = Date.now()
  const options: SpawnOptions = {
    prompt: adapter.capabilities.systemPromptArg ? request.userPrompt : `${request.systemPrompt}\n\n${request.userPrompt}`,
    systemPrompt: adapter.capabilities.systemPromptArg ? request.systemPrompt : undefined,
    model: request.model,
    maxTurns: 1,
    toolPolicy,
  }
  const args = adapter.buildArgs('spec-gen', options)
  // Same cwd/env contract as spec generation (relocated ⇒ workspace).
  const exec = resolveProjectExecution({ slug: request.project.slug, path: request.project.path })
  let env: NodeJS.ProcessEnv = process.env
  if (exec.relocated) {
    env = { ...process.env, ...exec.env }
    if (adapter.id === 'gemini') env = { ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
  }
  const child = spawnAiCli(adapter.binary, args, {
    env: buildProviderEnv(adapter, options, env),
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: exec.cwd,
  })
  trackTransientChild(request.projectId, child)

  return new Promise<TriageModelResult>((resolve, reject) => {
    const events: AdapterEvent[] = []
    let text = ''
    let stderr = ''
    let providerError: string | null = null
    let settled = false

    const usage = (): TriageModelUsage | undefined => {
      if (events.length === 0) return undefined
      try {
        const { result, estimated } = finaliseInvocationResult(adapter, events, { fallbackModel: request.model })
        return {
          model: result.model ?? request.model,
          provider: adapter.id,
          costUsd: result.total_cost_usd ?? null,
          costEstimated: estimated,
          tokensIn: result.tokens_in ?? null,
          tokensOut: result.tokens_out ?? null,
          tokensCacheRead: result.tokens_cache_read,
          tokensCacheCreate: result.tokens_cache_create,
          durationMs: result.duration_ms ?? (Date.now() - startedAt),
        }
      } catch { return undefined }
    }
    const kill = (): void => {
      if (child.pid) {
        try { treeKill(child.pid, 'SIGTERM') } catch { /* best effort */ }
      } else {
        try { child.kill('SIGTERM') } catch { /* best effort */ }
      }
    }
    const fail = (message: string, killChild = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      if (killChild) kill()
      reject(new TriageModelError(message, usage()))
    }
    const onAbort = (): void => fail('triage aborted', true)
    const timer = setTimeout(() => fail(`triage timeout after ${TRIAGE_TIMEOUT_MS}ms`, true), TRIAGE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    request.signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-4096)
    })
    if (!child.stdout) { fail('triage: child has no stdout', true); return }
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    reader.on('line', (line: string) => {
      if (settled) return
      for (const ev of parseStreamEvents(adapter, line)) {
        events.push(ev)
        if (events.length > 1000) events.shift()
        if (ev.kind === 'error') providerError = ev.message
        if (ev.kind === 'result' && ev.isError) providerError = String(ev.payload.result ?? 'Provider returned an error result')
        if (ev.kind === 'text-delta') text += ev.text
      }
      if (text.length > MAX_OUTPUT_CHARS) fail('triage output exceeded the limit', true)
    })
    child.on('error', (err) => fail(err.message))
    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) { fail(`${adapter.binary} exit code=${code}${stderr ? `; stderr=${stderr.slice(-300)}` : ''}`); return }
      if (providerError) { fail(providerError.slice(0, 500)); return }
      if (!text.trim()) { fail('triage returned no text'); return }
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      const final = usage() ?? {
        model: request.model, provider: adapter.id, costUsd: null, costEstimated: false,
        tokensIn: null, tokensOut: null, durationMs: Date.now() - startedAt,
      }
      resolve({ ...final, text })
    })
    if (request.signal?.aborted) onAbort()
  })
}
