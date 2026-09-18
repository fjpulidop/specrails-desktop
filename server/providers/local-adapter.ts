// Local (OpenAI-compatible) engine adapter.
//
// One adapter instance PER CONNECTION (`~/.specrails/runtime-providers.json`,
// `kind: 'openai-compatible'`), registered dynamically by
// `local-adapter-registry.ts`. The engine is the bundled local agent runner
// (`local-runner/` → `src-tauri/binaries/specrails-local-runner.js`) executed
// by the bundled Node — spawned exactly like a CLI so every manager's
// spawn/stream/settle path is reused unchanged (design D1).
//
// The runner speaks a claude-shaped `stream-json` dialect (design D2). This
// adapter owns its OWN frame parser — deliberately NOT an import of the claude
// parser — so claude-specific heuristics (notification frames, alias pinning,
// background tasks) never leak in and a claude parser change can't silently
// break local engines. `total_cost_usd` is never present.
//
// Spec: openspec/changes/local-ai-engines/specs/local-ai-engines/spec.md

import fs from 'fs'
import path from 'path'
import { resolveBundledNodeExe } from '../path-resolver'
import { stripWindowsVerbatimPrefix } from '../util/win-spawn'
import { getCachedModels, probeConnection } from '../local-engine-detection'
import type {
  AdapterEvent,
  AdapterEventParseResult,
  DetectionResult,
  NormalisedResult,
  ProviderAdapter,
  ReasoningEffort,
  SpawnAction,
  SpawnOptions,
} from './types'

export interface LocalConnectionRates {
  /** USD per 1 000 000 input tokens. */
  inputPer1M: number
  /** USD per 1 000 000 output tokens. */
  outputPer1M: number
}

export interface LocalConnection {
  id: string
  kind: 'openai-compatible'
  baseUrl: string
  apiKeyEnv?: string
  label?: string
  defaultModel?: string
  rates?: LocalConnectionRates
  supportsReasoningEffort?: boolean
}

/** A registered local adapter carries its connection for accounting/env. */
export type LocalProviderAdapter = ProviderAdapter & { readonly localConnection: LocalConnection }

export function isLocalAdapter(adapter: ProviderAdapter): adapter is LocalProviderAdapter {
  return typeof (adapter as { localConnection?: unknown }).localConnection === 'object'
    && (adapter as { localConnection?: unknown }).localConnection !== null
}

export const LOCAL_PROJECT_DIR = '.specrails-local'
export const LOCAL_REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high']

function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

const RUNNER_RELS = [
  path.join('src-tauri', 'binaries', 'specrails-local-runner.js'),
  path.join('local-runner', 'dist', 'specrails-local-runner.js'),
]

/**
 * Absolute path to the bundled runner script (mirrors the MCP bridge resolution
 * in agent-mcp-config.ts): `SPECRAILS_BUNDLED_LOCAL_RUNNER_PATH`, then the
 * staged `src-tauri/binaries/` copy, then the `local-runner/dist/` build
 * output. Returns null when none exists.
 */
export function resolveLocalRunnerScript(): string | null {
  const fromEnv = process.env.SPECRAILS_BUNDLED_LOCAL_RUNNER_PATH
  if (fromEnv) {
    const cleaned = stripWindowsVerbatimPrefix(fromEnv)
    if (fileExists(cleaned)) return cleaned
  }
  const roots = [
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
    process.cwd(),
  ]
  for (const root of roots) {
    for (const rel of RUNNER_RELS) {
      const candidate = path.join(root, rel)
      if (fileExists(candidate)) return candidate
    }
  }
  return null
}

/** Deterministic argv[0] even when the build output is absent (spawn then
 *  fails with a clear "no such file" instead of an undefined argument). */
function runnerScriptOrDefault(): string {
  return resolveLocalRunnerScript() ?? path.resolve(__dirname, '..', '..', RUNNER_RELS[0])
}

/** The node executable that runs the runner (bundled in the packaged app, else PATH `node`). */
export function resolveLocalRunnerNode(): string {
  return resolveBundledNodeExe() ?? 'node'
}

// ─── extraArgs allowlist ─────────────────────────────────────────────────────
//
// Managers forward provider-shaped extras through `extraArgs` (context-scope
// tool flags, `--mcp-config`, repo access, codex plugin `-c` pairs, the claude
// openspec `--plugin-dir`…). The runner fails fast on unknown flags, so only
// the flags it understands pass; everything else is dropped WITH its value.

const RUNNER_VALUE_FLAGS = new Set([
  '--tools', '--disallowedTools', '--mcp-config', '--add-dir', '--max-turns',
  '--model', '--resume', '--system-prompt', '--append-system-prompt',
  '--reasoning-effort', '--base-url', '--api-key-env',
])
/** Flags foreign to the runner that carry a value (drop flag + value). */
const FOREIGN_VALUE_FLAGS = new Set([
  '--setting-sources', '--permission-mode', '--effort', '--plugin-dir', '-c',
  '--allowedTools', '--output-format', '--input-format', '--approval-mode',
  '--sandbox', '-i', '--image', '-m', '-S', '--session',
])

export function filterLocalExtraArgs(extra: readonly string[] | undefined): string[] {
  if (!extra || extra.length === 0) return []
  const out: string[] = []
  for (let i = 0; i < extra.length; i++) {
    const token = extra[i]
    if (RUNNER_VALUE_FLAGS.has(token)) {
      if (i + 1 < extra.length) { out.push(token, extra[i + 1]); i++ }
      continue
    }
    if (FOREIGN_VALUE_FLAGS.has(token)) {
      if (i + 1 < extra.length && !extra[i + 1].startsWith('-')) i++
      continue
    }
    // Any other flag (`--dangerously-skip-permissions`, `--safe-mode`,
    // `--verbose`, `--yolo`, …) or stray positional token is dropped.
  }
  return out
}

// ─── argv ────────────────────────────────────────────────────────────────────

function toolPolicyArgs(policy: SpawnOptions['toolPolicy']): string[] {
  if (policy === 'none') return ['--tools', '__none__']
  if (policy === 'read-only') return ['--tools', 'Read,Grep,Glob']
  return []
}

function buildLocalArgs(connection: LocalConnection, action: SpawnAction, opts: SpawnOptions): string[] {
  const script = runnerScriptOrDefault()
  const args: string[] = [script]
  const effectiveOpts = action === 'auto-title' ? { ...opts, toolPolicy: 'none' as const } : opts
  const common = (): string[] => [
    '--model', effectiveOpts.model || connection.defaultModel || 'default',
    '--base-url', connection.baseUrl,
    ...(connection.apiKeyEnv ? ['--api-key-env', connection.apiKeyEnv] : []),
    ...toolPolicyArgs(effectiveOpts.toolPolicy),
    ...(connection.supportsReasoningEffort && effectiveOpts.reasoning_effort
      ? ['--reasoning-effort', effectiveOpts.reasoning_effort]
      : []),
    '--output-format', 'stream-json',
  ]
  const extras = filterLocalExtraArgs(effectiveOpts.extraArgs)
  const maxTurns = effectiveOpts.maxTurns != null ? ['--max-turns', String(effectiveOpts.maxTurns)] : []

  switch (action) {
    case 'chat-turn':
      args.push(...common())
      if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)
      args.push(...maxTurns, '-p', opts.prompt, ...extras)
      return args
    case 'chat-resume':
      if (!opts.sessionId) throw new Error('chat-resume requires sessionId')
      args.push(...common())
      if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)
      args.push('--resume', opts.sessionId, ...maxTurns, '-p', opts.prompt, ...extras)
      return args
    case 'chat-stream':
      // Persistent multi-turn: the prompt arrives over stdin, one line per turn.
      // `--max-turns` omitted on purpose (it would end the whole session).
      args.push(...common())
      if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)
      if (opts.sessionId) args.push('--resume', opts.sessionId)
      args.push('--input-format', 'stream-json', ...extras)
      return args
    case 'rail-job':
      // The slash command carries its own framing; ADD to it, never overwrite.
      args.push(...common())
      if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)
      args.push('-p', opts.prompt, ...extras)
      return args
    case 'spec-gen':
      args.push(...common(), ...maxTurns)
      if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)
      args.push('-p', opts.prompt, ...extras)
      return args
    case 'agent-refine':
      args.push(...common())
      if (opts.sessionId) args.push('--resume', opts.sessionId)
      args.push('-p', opts.prompt, ...extras)
      return args
    case 'setup-enrich':
      args.push('-p', opts.prompt, ...common(), ...extras)
      return args
    case 'setup-enrich-resume':
      if (!opts.sessionId) throw new Error('setup-enrich-resume requires sessionId')
      args.push('--resume', opts.sessionId, ...common(), '-p', opts.prompt, ...extras)
      return args
    case 'auto-title':
      args.push(...common(), '-p', opts.prompt)
      return args
  }
}

// ─── stream-json parsing ─────────────────────────────────────────────────────

interface AssistantUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type LocalUsageEvent = AdapterEvent & { usage?: AssistantUsage; messageId?: string; model?: string }

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function withUsage(ev: AdapterEvent, msg: { id?: unknown; model?: unknown; usage?: unknown } | undefined): AdapterEvent {
  const usage = msg?.usage
  if (!usage || typeof usage !== 'object') return ev
  const carrier = ev as LocalUsageEvent
  carrier.usage = usage as AssistantUsage
  if (typeof msg?.id === 'string') carrier.messageId = msg.id
  if (typeof msg?.model === 'string') carrier.model = msg.model
  return ev
}

export function parseLocalStreamLine(line: string): AdapterEventParseResult {
  if (line.length === 0) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const type = parsed.type as string | undefined
  if (!type) return { kind: 'other', type: '<missing>', raw: parsed }

  if (type === 'system' || type === 'init') {
    const sid = parsed.session_id as string | undefined
    if (sid) return { kind: 'session-started', sessionId: sid }
    return { kind: 'other', type, raw: parsed }
  }

  if (type === 'result') {
    const result: AdapterEvent = { kind: 'result', payload: parsed, ...(parsed.is_error === true ? { isError: true } : {}) }
    // The runner puts the endpoint/loop failure text in `result` when
    // `is_error` is set (HTTP 4xx/5xx body, connection refused, max_turns…).
    // Surface it as an explicit error event too, so every manager reports the
    // real reason instead of a generic "returned no output".
    const message = parsed.is_error === true && typeof parsed.result === 'string' && parsed.result.trim()
      ? parsed.result.trim().slice(0, 600)
      : null
    return message ? [{ kind: 'error', message }, result] : result
  }

  if (type === 'error') {
    const message = typeof parsed.message === 'string' ? parsed.message
      : typeof parsed.error === 'string' ? parsed.error : 'local runner error'
    return { kind: 'error', message }
  }

  if (type === 'assistant') {
    const msg = parsed.message as
      | { id?: unknown; model?: unknown; usage?: unknown; content?: Array<Record<string, unknown>> }
      | undefined
    const blocks = Array.isArray(msg?.content) ? msg.content : []
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('')
    if (text) return withUsage({ kind: 'text-delta', text }, msg)
    const tool = blocks.find((b) => b.type === 'tool_use')
    if (tool && typeof tool.name === 'string') {
      const input = JSON.stringify(tool.input ?? {})
      return withUsage(
        {
          kind: 'tool-use',
          name: tool.name,
          inputPreview: input.slice(0, 200),
          ...(typeof tool.id === 'string' ? { toolUseId: tool.id } : {}),
        },
        msg,
      )
    }
    return withUsage({ kind: 'other', type, raw: parsed }, msg)
  }

  if (type === 'user') {
    const msg = (parsed as { message?: { content?: unknown } }).message
    const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : []
    const resultBlock = blocks.find((b) => b.type === 'tool_result')
    if (resultBlock) {
      const content = resultBlock.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as Array<{ type?: string; text?: string }>)
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text as string)
              .join('\n')
          : ''
      return {
        kind: 'tool-result',
        outputPreview: text.slice(0, 600),
        ...(typeof resultBlock.tool_use_id === 'string' ? { toolUseId: resultBlock.tool_use_id } : {}),
        ...(resultBlock.is_error === true ? { isError: true } : {}),
      }
    }
  }

  return { kind: 'other', type, raw: parsed }
}

export function extractLocalResult(events: readonly AdapterEvent[]): NormalisedResult {
  let resultPayload: Record<string, unknown> | null = null
  let sessionId: string | undefined
  for (const ev of events) {
    if (ev.kind === 'result') resultPayload = ev.payload
    else if (ev.kind === 'session-started') sessionId = ev.sessionId
  }
  const usageFromAssistant = (): NormalisedResult => {
    // No terminal `result` (killed/aborted). Reconstruct per message id,
    // last snapshot wins; each distinct message is a separate API call.
    const perMessage = new Map<string, AssistantUsage>()
    let model: string | undefined
    let anonymous = 0
    for (const ev of events) {
      const carrier = ev as LocalUsageEvent
      if (!carrier.usage) continue
      perMessage.set(carrier.messageId ?? `__anon-${anonymous++}`, carrier.usage)
      if (carrier.model) model = carrier.model
    }
    if (perMessage.size === 0) return { session_id: sessionId }
    let tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheCreate = 0
    for (const u of perMessage.values()) {
      tokensIn += readNumber(u.input_tokens)
      tokensOut += readNumber(u.output_tokens)
      cacheRead += readNumber(u.cache_read_input_tokens)
      cacheCreate += readNumber(u.cache_creation_input_tokens)
    }
    return { tokens_in: tokensIn, tokens_out: tokensOut, tokens_cache_read: cacheRead, tokens_cache_create: cacheCreate, model, session_id: sessionId }
  }
  if (!resultPayload) return usageFromAssistant()

  const usage = resultPayload.usage as Record<string, unknown> | undefined
  const finalSessionId = (typeof resultPayload.session_id === 'string' ? resultPayload.session_id : undefined) ?? sessionId
  const tokens = usage && typeof usage === 'object'
    ? {
        tokens_in: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        tokens_out: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        tokens_cache_read: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
        tokens_cache_create: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
      }
    : (() => { const r = usageFromAssistant(); return { tokens_in: r.tokens_in, tokens_out: r.tokens_out, tokens_cache_read: r.tokens_cache_read, tokens_cache_create: r.tokens_cache_create } })()
  return {
    ...tokens,
    // NEVER total_cost_usd: local engines report no cost (design D9).
    num_turns: typeof resultPayload.num_turns === 'number' ? resultPayload.num_turns : undefined,
    model: typeof resultPayload.model === 'string' ? resultPayload.model : undefined,
    duration_ms: typeof resultPayload.duration_ms === 'number' ? resultPayload.duration_ms : undefined,
    duration_api_ms: typeof resultPayload.duration_api_ms === 'number' ? resultPayload.duration_api_ms : undefined,
    session_id: finalSessionId,
  }
}

// ─── factory ─────────────────────────────────────────────────────────────────

export function createLocalAdapter(connection: LocalConnection): LocalProviderAdapter {
  const supportsEffort = connection.supportsReasoningEffort === true
  const displayName = connection.label?.trim() || connection.id
  const adapter = {
    id: connection.id,
    displayName,
    binary: resolveLocalRunnerNode(),
    minCliVersion: null,
    projectDirName: LOCAL_PROJECT_DIR,
    instructionsFilename: 'AGENTS.md',
    mcpRegistration: 'project-json',
    localConnection: connection,
    capabilities: {
      nativeResume: true,
      nativeStreamJson: true,
      nativeCostUsd: false,
      reportsUsage: true,
      nativeOtelEnv: false,
      profileEnvSupport: false,
      systemPromptArg: true,
      persistentStdin: true,
      supportsReasoningEffort: supportsEffort,
      ...(supportsEffort ? { reasoningEfforts: LOCAL_REASONING_EFFORTS } : {}),
      supportsImageInput: false,
      structuredActions: false,
      toolPolicies: ['none', 'read-only'],
      profiles: false,
      customModelAliases: true,
      customRoles: false,
      freestyle: true,
      userMcp: false,
    },
    modelCatalog: () => {
      const cached = getCachedModels(connection.id)
      if (cached.length === 0) {
        const value = connection.defaultModel ?? 'default'
        return [{ value, label: value, default: true }]
      }
      const stored = connection.defaultModel && cached.includes(connection.defaultModel) ? connection.defaultModel : cached[0]
      return cached.map((value) => ({ value, label: value, ...(value === stored ? { default: true } : {}) }))
    },
    defaultModel: () => connection.defaultModel ?? getCachedModels(connection.id)[0] ?? 'default',
    buildArgs: (action: SpawnAction, opts: SpawnOptions) => buildLocalArgs(connection, action, opts),
    parseStreamLine: parseLocalStreamLine,
    extractResult: extractLocalResult,
    formatCoreCommand: (command: string) => command,
    buildRepoAccessArgs: (paths: readonly string[]) => paths.flatMap((p) => ['--add-dir', p]),
    projectMcpPath: (root: string) => path.join(root, LOCAL_PROJECT_DIR, 'mcp.json'),
    baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
    detectInstalled: async (): Promise<DetectionResult> => {
      const probe = await probeConnection({ baseUrl: connection.baseUrl, apiKeyEnv: connection.apiKeyEnv })
      return {
        installed: probe.installed,
        executable: probe.executable,
        ...(probe.error ? { error: probe.error } : {}),
      }
    },
  } satisfies LocalProviderAdapter
  return adapter
}

/** Rates of a registered local adapter (null for CLI/unknown ids or no rates). */
export function localConnectionRates(adapter: ProviderAdapter): LocalConnectionRates | null {
  return isLocalAdapter(adapter) ? adapter.localConnection.rates ?? null : null
}
