// Codex (OpenAI) adapter for codex CLI 0.128.0+.
//
// Stream format observed live (2026-05-17):
//   {"type":"thread.started","thread_id":"<UUID>"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
//   {"type":"item.completed","item":{"id":"item_1","type":"command_execution",
//     "command":"…","exit_code":0}}
//   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,
//     "output_tokens":N,"reasoning_output_tokens":N}}
//
// Failure path (codex 0.139.0+): a failing turn (usage limit, API 4xx, network,
// sandbox error) emits `{"type":"error","message":"…"}` then
// `{"type":"turn.failed","error":{"message":"…"}}` and the process exits 1 —
// there is NO `turn.completed`. Both must be surfaced as `kind:'error'` or the
// real reason is swallowed and the user sees an empty/failed turn with no cause.
//
// Tool/shell items were renamed across codex versions: 0.128 emitted
// `function_call` / `local_shell_call`; 0.139 emits `command_execution` /
// `mcp_tool_call`. The parser matches all four for forward/backward compat.
//
// Codex does not emit `total_cost_usd`; cost is estimated downstream via
// server/pricing.ts. Codex does not honour Claude's OTEL env vars; signals are
// synthesised by server/codex-otel-bridge.ts.
//
// Spec: openspec/specs/multi-provider-architecture/spec.md

import { execSync } from 'child_process'
import path from 'path'
import type {
  AdapterEvent,
  DetectionResult,
  NormalisedResult,
  ProviderAdapter,
  ReasoningEffort,
  SpawnAction,
  SpawnOptions,
} from './types'

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

const CODEX_MIN_VERSION = '0.128.0'

const CODEX_MODELS = [
  // Newest first. gpt-6-astra has no rate card in `server/pricing.ts` yet, so
  // its turns show cost as unavailable (honest-metrics: never fabricated).
  { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { value: 'gpt-5.5', label: 'GPT-5.5', default: true as const },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
] as const

// Model-specific CLI capabilities (models/list, reviewed 2026-09-05).
// Keep the provider-wide union for legacy models without current metadata.
const BASE_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
const CODEX_MODEL_EFFORTS: Record<string, readonly ReasoningEffort[]> = {
  'gpt-6-astra': [...BASE_EFFORTS, 'max', 'ultra'],
  'gpt-5.6-sol': [...BASE_EFFORTS, 'max', 'ultra'],
  'gpt-5.6-terra': [...BASE_EFFORTS, 'max', 'ultra'],
  'gpt-5.6-luna': [...BASE_EFFORTS, 'max'],
  'gpt-5.5': BASE_EFFORTS,
  'gpt-5.4-mini': BASE_EFFORTS,
}

const SANDBOX_FLAGS = ['--sandbox', 'workspace-write'] as const
const RAIL_SANDBOX_FLAGS = ['--sandbox', 'danger-full-access'] as const
// `codex exec resume` does NOT accept `--sandbox` (the flag only exists on
// `codex exec`); `resumeSandboxFlags` passes the selected policy as a `-c`
// config override instead, even when the per-project `.codex/config.toml`
// isn't on the spawn cwd (e.g. explore-cwd).
const SKIP_GIT_CHECK = '--skip-git-repo-check' as const

function sandboxFlags(opts: SpawnOptions, rail = false): string[] {
  if (opts.toolPolicy === 'read-only') return ['--sandbox', 'read-only']
  if (opts.scopedWorkingDirectories) return [...SANDBOX_FLAGS]
  return rail ? [...RAIL_SANDBOX_FLAGS] : [...SANDBOX_FLAGS]
}

function resumeSandboxFlags(opts: SpawnOptions): string[] {
  const mode = opts.toolPolicy === 'read-only' ? 'read-only' : 'workspace-write'
  return ['-c', `sandbox_mode="${mode}"`]
}

/** Fold system prompt into the user prompt for providers without --system-prompt. */
function fold(systemPrompt: string | undefined, prompt: string): string {
  if (!systemPrompt) return prompt
  return `${systemPrompt}\n\n---\n\n${prompt}`
}

/** Coerce any codex payload value to a string (objects → JSON) so `.slice` is safe. */
function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function buildCodexArgs(action: SpawnAction, opts: SpawnOptions): string[] {
  const args: string[] = []

  switch (action) {
    case 'chat-turn': {
      // chat-turn (Explore) spawns codex from the app-managed explore-cwd,
      // which already ships an AGENTS.md with the Explore stance. Folding the
      // app's system prompt into the positional argv would double-inject the
      // framing AND, because the user message in Explore is often very short
      // ("quiero hacer un tetris"), the long system text dominates the prompt
      // and codex responds to the system instructions instead of the user.
      // Trust AGENTS.md and pass only the user prompt.
      args.push('exec', '--json', ...sandboxFlags(opts), SKIP_GIT_CHECK)
      args.push(opts.prompt)
      args.push('--model', opts.model)
      // Native reasoning effort (codex 0.139+). String value is quoted to match
      // the `-c key="value"` override form used elsewhere in this adapter.
      if (opts.reasoning_effort) args.push('-c', `model_reasoning_effort="${opts.reasoning_effort}"`)
      // Native image input (codex 0.141+): one `--image <abs>` per file.
      if (opts.imagePaths) for (const p of opts.imagePaths) args.push('--image', p)
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'spec-gen':
    case 'agent-refine':
    case 'auto-title':
    case 'setup-enrich': {
      args.push('exec', '--json', ...sandboxFlags(opts), SKIP_GIT_CHECK)
      args.push(fold(opts.systemPrompt, opts.prompt))
      args.push('--model', opts.model)
      // Native reasoning effort (codex 0.139+). String value is quoted to match
      // the `-c key="value"` override form used elsewhere in this adapter.
      if (opts.reasoning_effort) args.push('-c', `model_reasoning_effort="${opts.reasoning_effort}"`)
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'chat-resume': {
      if (!opts.sessionId) {
        throw new Error(`${action} requires sessionId`)
      }
      // See chat-turn note: AGENTS.md in explore-cwd carries the Explore
      // framing; the per-turn argv must stay user-text-only so codex doesn't
      // mistake the system prompt for the user request.
      args.push('exec', 'resume', '--json', ...resumeSandboxFlags(opts), SKIP_GIT_CHECK)
      args.push(opts.sessionId)
      args.push(opts.prompt)
      args.push('--model', opts.model)
      // Native reasoning effort (codex 0.139+). String value is quoted to match
      // the `-c key="value"` override form used elsewhere in this adapter.
      if (opts.reasoning_effort) args.push('-c', `model_reasoning_effort="${opts.reasoning_effort}"`)
      // Native image input (codex 0.141+): one `--image <abs>` per file.
      if (opts.imagePaths) for (const p of opts.imagePaths) args.push('--image', p)
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'setup-enrich-resume': {
      if (!opts.sessionId) {
        throw new Error(`${action} requires sessionId`)
      }
      args.push('exec', 'resume', '--json', ...resumeSandboxFlags(opts), SKIP_GIT_CHECK)
      args.push(opts.sessionId)
      args.push(fold(opts.systemPrompt, opts.prompt))
      args.push('--model', opts.model)
      // Native reasoning effort (codex 0.139+). String value is quoted to match
      // the `-c key="value"` override form used elsewhere in this adapter.
      if (opts.reasoning_effort) args.push('-c', `model_reasoning_effort="${opts.reasoning_effort}"`)
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
    case 'chat-stream': {
      // Codex has no persistent stdin multi-turn transport; the Explore
      // fast-path gates on capabilities.persistentStdin, so this is never
      // reached. Throw defensively rather than emit a broken argv.
      throw new Error('codex does not support persistent stdin streaming (chat-stream)')
    }
    case 'rail-job': {
      // Rail jobs are headless implementation pipelines. They must run repo
      // inspection, edits, tests, and git probes without interactive approval.
      // On Windows, Codex's workspace-write sandbox can fail before the first
      // shell command with `windows sandbox: spawn setup refresh`; full access
      // matches the existing fully-autonomous rail contract.
      args.push('exec', '--json', ...sandboxFlags(opts, true), SKIP_GIT_CHECK)
      args.push(fold(opts.systemPrompt, opts.prompt))
      args.push('--model', opts.model)
      // Native reasoning effort (codex 0.139+). String value is quoted to match
      // the `-c key="value"` override form used elsewhere in this adapter.
      if (opts.reasoning_effort) args.push('-c', `model_reasoning_effort="${opts.reasoning_effort}"`)
      if (opts.extraArgs) args.push(...opts.extraArgs)
      return args
    }
  }
}

function parseCodexStreamLine(line: string): AdapterEvent | null {
  if (line.length === 0) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }

  const type = parsed.type as string | undefined
  if (!type) return { kind: 'other', type: '<missing>', raw: parsed }

  if (type === 'thread.started') {
    const sid = parsed.thread_id as string | undefined
    if (sid) return { kind: 'session-started', sessionId: sid }
    return { kind: 'other', type, raw: parsed }
  }

  if (type === 'turn.completed') {
    return { kind: 'result', payload: parsed }
  }

  // A failed turn (codex 0.139+) emits `error` then `turn.failed` and exits 1,
  // with no `turn.completed`. Surface the reason instead of dropping it.
  if (type === 'turn.failed') {
    const err = parsed.error as { message?: string } | undefined
    return { kind: 'error', message: err?.message ?? 'codex turn failed' }
  }
  if (type === 'error') {
    const msg = parsed.message as string | undefined
    return { kind: 'error', message: msg ?? 'codex error' }
  }

  if (type === 'item.completed') {
    const item = parsed.item as { type?: string; text?: string; name?: unknown; arguments?: unknown; command?: unknown } | undefined
    if (item?.type === 'agent_message') {
      const text = item.text ?? ''
      if (text) return { kind: 'text-delta', text }
      return { kind: 'other', type, raw: parsed }
    }
    // Tool/shell invocations. Names drifted across codex versions:
    //   0.128 → function_call / local_shell_call (name + arguments)
    //   0.139 → command_execution / mcp_tool_call (command)
    // `command`/`arguments` may be a NON-STRING (e.g. MCP tool calls carry a
    // structured `arguments` object) — coerce so `.slice` never throws (an
    // uncaught throw here previously crashed the whole server process).
    if (
      item?.type === 'command_execution' ||
      item?.type === 'mcp_tool_call' ||
      item?.type === 'function_call' ||
      item?.type === 'local_shell_call'
    ) {
      const nameRaw =
        item.name ??
        item.command ??
        (item.type === 'local_shell_call' || item.type === 'command_execution' ? 'shell' : '<unnamed>')
      const name = typeof nameRaw === 'string' ? nameRaw : asString(nameRaw)
      const inputPreview = asString(item.command ?? item.arguments ?? '').slice(0, 200)
      return { kind: 'tool-use', name, inputPreview }
    }
    return { kind: 'other', type, raw: parsed }
  }

  return { kind: 'other', type, raw: parsed }
}

function extractCodexResult(events: readonly AdapterEvent[]): NormalisedResult {
  let sessionId: string | undefined
  let resultPayload: Record<string, unknown> | null = null
  let turnCount = 0
  // First text-delta timestamp is unavailable from events (we'd need wall-clock
  // tracking). duration_ms is left undefined and the manager-level wrapper
  // synthesises it from the spawn-close timestamps if it wants to populate.
  for (const ev of events) {
    if (ev.kind === 'session-started') sessionId = ev.sessionId
    else if (ev.kind === 'result') {
      resultPayload = ev.payload
      turnCount += 1 // each turn.completed is one codex turn
    }
  }

  if (!resultPayload) {
    return { session_id: sessionId }
  }

  const usage = resultPayload.usage as Record<string, number> | undefined
  // OpenAI bills reasoning_output_tokens at the output rate, so we fold it
  // into tokens_out for cost-estimation correctness.
  const baseOut = usage?.output_tokens ?? 0
  const reasoning = usage?.reasoning_output_tokens ?? 0
  const tokensOut = baseOut + reasoning

  return {
    tokens_in: usage?.input_tokens,
    tokens_out: usage ? tokensOut : undefined,
    tokens_cache_read: usage?.cached_input_tokens,
    // Codex has no separate "cache creation" tier — left undefined.
    tokens_cache_create: undefined,
    // total_cost_usd intentionally absent — estimated via pricing.ts.
    // Derive from the number of turn.completed events rather than hardcoding 1
    // (a single `codex exec` normally emits exactly one, but don't assume it).
    num_turns: turnCount || 1,
    // Model on stream events is not present; manager-level wrapper passes
    // the requested model in via the spawn args and stamps it on the row.
    model: undefined,
    duration_ms: undefined,
    duration_api_ms: undefined,
    session_id: sessionId,
  }
}

function compareSemver(a: string, b: string): number {
  const aParts = a.split('.').map((n) => parseInt(n, 10))
  const bParts = b.split('.').map((n) => parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const av = aParts[i] ?? 0
    const bv = bParts[i] ?? 0
    if (av > bv) return 1
    if (av < bv) return -1
  }
  return 0
}

async function detectCodexInstalled(): Promise<DetectionResult> {
  try {
    execSync(`${WHICH_CMD} codex`, { stdio: 'ignore' })
  } catch {
    return { installed: false, executable: false }
  }

  try {
    const raw = execSync('codex --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim()
    const match = raw.match(/\d+\.\d+\.\d+/)
    const version = match ? match[0] : raw
    const meetsMinimum = match ? compareSemver(version, CODEX_MIN_VERSION) >= 0 : false
    const result: DetectionResult = {
      installed: true,
      executable: true,
      version,
      meetsMinimum,
    }
    if (!meetsMinimum) {
      result.error = `codex ${version} is older than required ${CODEX_MIN_VERSION}. Upgrade with: brew upgrade codex (or follow https://developers.openai.com/codex).`
    }
    return result
  } catch {
    return { installed: true, executable: false }
  }
}

export const codexAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  minCliVersion: CODEX_MIN_VERSION,
  projectDirName: '.codex',
  instructionsFilename: 'AGENTS.md',
  mcpRegistration: 'cli-add',
  capabilities: {
    liveInputTransport: 'codex-app-server',
    nativeResume: true,
    nativeStreamJson: true,
    nativeCostUsd: false,
    nativeOtelEnv: false,
    profileEnvSupport: true,
    systemPromptArg: false,
    supportsReasoningEffort: true,
    // codex model_reasoning_effort values. xhigh/max ship with GPT-5.6 (all
    // tiers); ultra is Sol-only upstream — codex validates the combo itself.
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    supportsImageInput: true, // codex-cli `-i/--image <FILE>...` (verified 0.141)
    structuredActions: false,
    // Codex has an enforced read-only sandbox, but no true "no tools" mode in
    // this adapter (workspace-write is not an output-only boundary).
    toolPolicies: ['read-only'],
    profiles: false,
    customRoles: false,
    freestyle: false,
    userMcp: false,
  },
  modelCatalog: () => CODEX_MODELS,
  reasoningEffortsForModel: (model: string) => CODEX_MODEL_EFFORTS[model]
    ?? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  defaultModel: () => 'gpt-5.5',
  buildArgs: buildCodexArgs,
  parseStreamLine: parseCodexStreamLine,
  extractResult: extractCodexResult,
  formatCoreCommand: (command: string) =>
    command.replace(/^\/(?:specrails|sr):([\w-]+)/, '$$$1'),
  buildRepoAccessArgs: (paths: readonly string[]) =>
    paths.length === 0
      ? []
      : [
          '-c',
          `sandbox_workspace_write.writable_roots=[${paths.map((repoPath) => JSON.stringify(repoPath)).join(', ')}]`,
        ],
  customRolePath: (root: string, roleId: string) =>
    path.join(root, '.codex', 'skills', 'rails', roleId, 'SKILL.md'),
  baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
  detectInstalled: detectCodexInstalled,
} satisfies ProviderAdapter

export { CODEX_MIN_VERSION as _CODEX_MIN_VERSION, compareSemver as _compareSemver }
