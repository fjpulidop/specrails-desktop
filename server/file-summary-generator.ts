import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import { spawnAiCli } from './util/cli-prompt'
import { finaliseInvocationResult } from './result-event'
import type { ProviderAdapter, AdapterEvent } from './providers/types'
import type { GenerateInput, GenerateOutput } from './file-summary-manager'

const GENERATE_TIMEOUT_MS = 60_000

const SYSTEM_PROMPT_EN =
  'You are explaining code to a non-developer. Output 2 to 4 sentences in plain language about what the file does. ' +
  'No code, no jargon, no bullet lists. Output only the explanation, nothing else.'

const SYSTEM_PROMPT_ES =
  'Estás explicando código a una persona no desarrolladora. Escribe entre 2 y 4 frases en lenguaje llano sobre qué hace el archivo. ' +
  'Sin código, sin jerga, sin listas. Devuelve solo la explicación, nada más.'

export function buildSystemPrompt(language: 'en' | 'es'): string {
  return language === 'es' ? SYSTEM_PROMPT_ES : SYSTEM_PROMPT_EN
}

/** Compose the single user-message body that goes to the model. The provider
 *  adapter decides whether the system prompt rides along via a flag or gets
 *  folded into this string (see `adapter.capabilities.systemPromptArg`). */
function buildUserPrompt(
  input: GenerateInput,
  adapter: ProviderAdapter,
  systemPromptFor: (language: 'en' | 'es') => string,
): string {
  const body = `${input.relPath}\n${input.contents}`
  if (adapter.capabilities.systemPromptArg) return body
  // Provider does not accept a system-prompt flag; fold the instruction inline.
  return `${systemPromptFor(input.language)}\n\n${body}`
}

export interface GeneratorOpts {
  adapter: ProviderAdapter
  cwd: string
  /** Override the model. Defaults to env `SPECRAILS_FILE_SUMMARY_MODEL`, then
   *  to a haiku-class id when adapter.id === 'claude', else adapter default. */
  model?: string
  spawn?: typeof spawnAiCli
  timeoutMs?: number
  /** Override the per-language system prompt. Used by the construction-story
   *  contribution generator (file-story-manager.ts) to reuse this whole
   *  spawn/parse/settle skeleton with a different instruction. Defaults to the
   *  file-summary prompt (buildSystemPrompt). */
  systemPrompt?: (language: 'en' | 'es') => string
}

/** Cheapest model per provider for summary generation. Codex MUST run
 *  `gpt-5.4-mini` (product decision: file summaries are non-critical and the
 *  mini tier is the right cost target). Claude uses `haiku`. The per-provider
 *  env overrides exist for ops escape hatches; the generic
 *  `SPECRAILS_FILE_SUMMARY_MODEL` is honoured only when no provider-specific
 *  override is set. */
function defaultModelFor(adapter: ProviderAdapter): string {
  if (adapter.id === 'claude') {
    return process.env.SPECRAILS_FILE_SUMMARY_MODEL_CLAUDE
      ?? process.env.SPECRAILS_FILE_SUMMARY_MODEL
      ?? 'haiku'
  }
  if (adapter.id === 'codex') {
    return process.env.SPECRAILS_FILE_SUMMARY_MODEL_CODEX ?? 'gpt-5.4-mini'
  }
  return process.env.SPECRAILS_FILE_SUMMARY_MODEL ?? adapter.defaultModel()
}

export function createFileSummaryGenerator(opts: GeneratorOpts): (input: GenerateInput) => Promise<GenerateOutput> {
  const adapter = opts.adapter
  const model = opts.model ?? defaultModelFor(adapter)
  const timeoutMs = opts.timeoutMs ?? GENERATE_TIMEOUT_MS
  const spawn = opts.spawn ?? spawnAiCli
  const systemPromptFor = opts.systemPrompt ?? buildSystemPrompt

  return async function generate(input: GenerateInput, signal?: AbortSignal): Promise<GenerateOutput> {
    const startedAt = Date.now()
    if (signal?.aborted) throw new Error('file-summary generator aborted before start')
    const args = adapter.buildArgs('spec-gen', {
      prompt: buildUserPrompt(input, adapter, systemPromptFor),
      systemPrompt: adapter.capabilities.systemPromptArg ? systemPromptFor(input.language) : undefined,
      model,
      maxTurns: 1,
    })

    const child = spawn(adapter.binary, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
    })

    return await new Promise<GenerateOutput>((resolve, reject) => {
      const events: AdapterEvent[] = []
      let fullText = ''
      let stderrBuf = ''
      let settled = false

      // Best-effort partial usage so a timeout/abort that killed the child AFTER
      // the provider billed tokens still reports real spend (the manager stamps
      // it onto the failed ai_invocations row instead of $0).
      const buildPartial = (): Partial<GenerateOutput> | undefined => {
        if (events.length === 0) return undefined
        try {
          const { result, estimated } = finaliseInvocationResult(adapter, events, { fallbackModel: model })
          return {
            model: result.model ?? model,
            provider: adapter.id,
            costUsd: result.total_cost_usd ?? 0,
            costEstimated: estimated,
            tokensIn: result.tokens_in ?? 0,
            tokensOut: result.tokens_out ?? 0,
            tokensCacheRead: result.tokens_cache_read,
            tokensCacheCreate: result.tokens_cache_create,
            durationMs: result.duration_ms ?? (Date.now() - startedAt),
          }
        } catch { return undefined }
      }
      const rejectWithPartial = (message: string) => {
        const err = new Error(message) as Error & { partial?: Partial<GenerateOutput> }
        const partial = buildPartial()
        if (partial) err.partial = partial
        reject(err)
      }

      let killGrace: ReturnType<typeof setTimeout> | null = null
      const killTree = () => {
        const pid = child.pid
        if (pid) {
          try { treeKill(pid, 'SIGTERM') } catch { /* best effort */ }
          killGrace = setTimeout(() => {
            try { treeKill(pid, 'SIGKILL', () => { /* ignore */ }) } catch { /* best effort */ }
          }, 2000)
          if (typeof killGrace.unref === 'function') killGrace.unref()
        } else {
          try { child.kill('SIGTERM') } catch { /* best effort */ }
        }
      }

      const onAbort = () => {
        if (settled) return
        settled = true
        // treeKill (not child.kill) so the whole process tree dies — on Windows
        // the CLI is wrapped in cmd.exe; on POSIX the CLI may have grandchildren.
        killTree()
        rejectWithPartial('file-summary generator aborted')
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        killTree()
        rejectWithPartial(`file-summary generator timeout after ${timeoutMs}ms`)
      }, timeoutMs)

      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
          if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192)
        })
      }

      if (!child.stdout) {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(new Error('file-summary generator: child has no stdout'))
        return
      }

      const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
      reader.on('line', (line: string) => {
        const ev = adapter.parseStreamLine(line)
        if (!ev) return
        events.push(ev)
        if (ev.kind === 'text-delta') fullText += ev.text
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (killGrace) { clearTimeout(killGrace); killGrace = null }
        if (settled) return
        settled = true
        reject(err)
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        // A child that exits after a timeout-triggered SIGTERM clears the
        // escalation so no stray SIGKILL lands on a recycled pid.
        if (killGrace) { clearTimeout(killGrace); killGrace = null }
        if (settled) return
        settled = true
        if (code !== 0) {
          const tail = stderrBuf.slice(-500)
          // Carry any captured usage (the provider may have billed tokens before
          // exiting non-zero) so the manager records the real cost on the failed
          // row instead of $0, and the monthly budget gate counts it (MED-13).
          rejectWithPartial(`${adapter.binary} exit code=${code}; ${tail ? `stderr=${tail}` : 'no stderr'}`)
          return
        }
        const summary = fullText.trim()
        if (!summary) {
          // Empty-summary rejection also carries captured usage — a clean exit
          // with no text still billed tokens (MED-13).
          rejectWithPartial(`${adapter.binary} returned empty summary text`)
          return
        }
        const { result, estimated } = finaliseInvocationResult(adapter, events, { fallbackModel: model })
        const durationMs = result.duration_ms ?? (Date.now() - startedAt)
        resolve({
          summary,
          model: result.model ?? model,
          provider: adapter.id,
          costUsd: result.total_cost_usd ?? 0,
          costEstimated: estimated,
          tokensIn: result.tokens_in ?? 0,
          tokensOut: result.tokens_out ?? 0,
          tokensCacheRead: result.tokens_cache_read,
          tokensCacheCreate: result.tokens_cache_create,
          durationMs,
        })
      })
    })
  }
}
