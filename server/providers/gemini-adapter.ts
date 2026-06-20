// Gemini CLI (Google) adapter for gemini-cli 0.11.0+.
//
// Stream format (gemini `-p "<prompt>" --output-format stream-json`), one minified
// JSON object per line — pinned to gemini-cli >= 0.11 and locked by the fixtures
// under __fixtures__/gemini-*.ndjson:
//   {"type":"init","session_id":"<UUID>","model":"gemini-3.5-flash"}
//   {"type":"message","role":"assistant","content":"...","delta":true}
//   {"type":"tool_use","tool_name":"read_file","tool_id":"t0","parameters":{...}}
//   {"type":"tool_result","tool_id":"t0","status":"ok","output":"..."}
//   {"type":"result","status":"success","stats":{"input_tokens":N,"output_tokens":N,
//     "cached":N,"total_tokens":N,"duration_ms":N}}
//
// Differences vs codex: Gemini reports tokens but NOT cost, so `nativeCostUsd`
// is false and cost is estimated downstream via server/pricing.ts. Gemini DOES
// emit OTLP natively via `GEMINI_TELEMETRY_*` env (set by QueueManager), so
// `nativeOtelEnv` is true — no synthetic bridge. There is no `--system-prompt`
// flag (the CLI uses the `GEMINI_SYSTEM_MD` env), so `systemPromptArg` is false
// and the system prompt is folded for non-Explore actions; Explore turns trust
// the app-managed GEMINI.md in explore-cwd, exactly like codex/AGENTS.md.
//
// NOTE (pre-1.0): gemini-cli changes weekly. The exact argv/event field names
// here follow the documented 0.11 contract; they are guarded by the beta flag
// (SPECRAILS_GEMINI_BETA) and MUST be re-validated against a real binary via the
// fixtures before the gate is removed. Parsing is tolerant of missing fields.
//
// Spec: openspec/specs/multi-provider-architecture/spec.md

import { execSync } from 'child_process'
import { windowsSpawnEnv } from '../util/win-spawn'
import { acknowledgeGeminiProjectAgents } from './gemini-agent-ack'
import type {
  AdapterEvent,
  DetectionResult,
  NormalisedResult,
  ProviderAdapter,
  SpawnAction,
  SpawnOptions,
} from './types'

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

// Floor where `--output-format stream-json` + headless `--resume` are available.
const GEMINI_MIN_VERSION = '0.11.0'

// Curated GA-id catalog (see docs/gemini-cli-provider-study.md §2). Preview ids
// rotate, so we pin concrete ids that pricing.ts has rows for.
const GEMINI_MODELS = [
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', default: true as const },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
] as const

const STREAM_JSON_FLAGS = ['--output-format', 'stream-json'] as const
// Auto-approve tool calls so headless turns never block on an approval prompt.
// Parity with codex's workspace-write/full-access sandbox; the non-destructive
// stance for Explore is carried by GEMINI.md + the system prompt, not a sandbox.
const YOLO_FLAG = '--yolo' as const

/** Fold system prompt into the user prompt for providers without --system-prompt. */
function fold(systemPrompt: string | undefined, prompt: string): string {
  if (!systemPrompt) return prompt
  return `${systemPrompt}\n\n---\n\n${prompt}`
}

function buildGeminiArgs(action: SpawnAction, opts: SpawnOptions): string[] {
  const model = ['--model', opts.model]

  switch (action) {
    case 'chat-turn': {
      // Explore turns spawn from the app-managed explore-cwd, which ships a
      // GEMINI.md with the Explore stance. Folding the long system prompt into a
      // short user message ("quiero hacer un tetris") makes the model answer the
      // system instructions instead of the user — so pass user text only and
      // trust GEMINI.md, exactly like the codex adapter trusts AGENTS.md.
      return ['-p', opts.prompt, ...model, ...STREAM_JSON_FLAGS, YOLO_FLAG, ...(opts.extraArgs ?? [])]
    }
    case 'chat-resume': {
      if (!opts.sessionId) throw new Error(`${action} requires sessionId`)
      return ['-p', opts.prompt, ...model, ...STREAM_JSON_FLAGS, '--resume', opts.sessionId, YOLO_FLAG, ...(opts.extraArgs ?? [])]
    }
    case 'chat-stream': {
      // Gemini has no persistent-stdin multi-turn transport; the Explore
      // fast-path gates on capabilities.persistentStdin (omitted), so this is
      // never reached. Throw defensively rather than emit a broken argv.
      throw new Error('gemini does not support persistent stdin streaming (chat-stream)')
    }
    case 'spec-gen':
    case 'agent-refine':
    case 'auto-title':
    case 'setup-enrich':
    case 'rail-job': {
      return ['-p', fold(opts.systemPrompt, opts.prompt), ...model, ...STREAM_JSON_FLAGS, YOLO_FLAG, ...(opts.extraArgs ?? [])]
    }
    case 'setup-enrich-resume': {
      if (!opts.sessionId) throw new Error(`${action} requires sessionId`)
      return ['-p', fold(opts.systemPrompt, opts.prompt), ...model, ...STREAM_JSON_FLAGS, '--resume', opts.sessionId, YOLO_FLAG, ...(opts.extraArgs ?? [])]
    }
  }
}

function parseGeminiStreamLine(line: string): AdapterEvent | null {
  if (line.length === 0) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }

  const type = parsed.type as string | undefined
  if (!type) return { kind: 'other', type: '<missing>', raw: parsed }

  if (type === 'init') {
    const sid = parsed.session_id as string | undefined
    if (sid) return { kind: 'session-started', sessionId: sid }
    return { kind: 'other', type, raw: parsed }
  }

  if (type === 'result') {
    return { kind: 'result', payload: parsed }
  }

  if (type === 'message') {
    // Only assistant text is a delta; the user echo (role 'user') is ignored.
    const role = parsed.role as string | undefined
    if (role === 'assistant') {
      const text = (parsed.content as string | undefined) ?? ''
      if (text) return { kind: 'text-delta', text }
    }
    return { kind: 'other', type, raw: parsed }
  }

  if (type === 'tool_use') {
    const name = (parsed.tool_name as string | undefined) ?? '<unnamed>'
    const params = parsed.parameters
    const inputPreview = params !== undefined ? JSON.stringify(params).slice(0, 200) : ''
    return { kind: 'tool-use', name, inputPreview }
  }

  // tool_result, error, and any unknown event type carry no normalised meaning.
  return { kind: 'other', type, raw: parsed }
}

function extractGeminiResult(events: readonly AdapterEvent[]): NormalisedResult {
  let sessionId: string | undefined
  let resultPayload: Record<string, unknown> | null = null
  let turnCount = 0
  for (const ev of events) {
    if (ev.kind === 'session-started') sessionId = ev.sessionId
    else if (ev.kind === 'result') {
      resultPayload = ev.payload
      turnCount += 1
    }
  }

  if (!resultPayload) {
    return { session_id: sessionId }
  }

  const stats = resultPayload.stats as Record<string, number> | undefined

  return {
    tokens_in: stats?.input_tokens,
    tokens_out: stats?.output_tokens,
    // Gemini reports a single `cached` read tier; map it to cache_read. No
    // separate cache-creation tier — `cached` is counted as a subset of
    // input_tokens (consistent with codex `cached_input_tokens`), so pricing.ts
    // must not double-count.
    tokens_cache_read: stats?.cached,
    tokens_cache_create: undefined,
    // total_cost_usd intentionally absent — estimated via pricing.ts.
    num_turns: turnCount || 1,
    // Stream events do not carry the model; the manager wrapper stamps the
    // requested model on the row.
    model: undefined,
    duration_ms: typeof stats?.duration_ms === 'number' ? stats.duration_ms : undefined,
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

async function detectGeminiInstalled(): Promise<DetectionResult> {
  try {
    execSync(`${WHICH_CMD} gemini`, { stdio: 'ignore', env: windowsSpawnEnv() })
  } catch {
    return { installed: false, executable: false }
  }

  try {
    // gemini is a Node CLI; its cold `--version` (cmd.exe → node → load bundle,
    // Defender scanning) can exceed a few seconds on Windows. Give it a generous
    // budget + SystemRoot env so it isn't wrongly reported not-executable.
    const raw = execSync('gemini --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: process.platform === 'win32' ? 20_000 : 8_000,
      env: windowsSpawnEnv(),
    }).trim()
    const match = raw.match(/\d+\.\d+\.\d+/)
    const version = match ? match[0] : raw
    const meetsMinimum = match ? compareSemver(version, GEMINI_MIN_VERSION) >= 0 : false
    const result: DetectionResult = {
      installed: true,
      executable: true,
      version,
      meetsMinimum,
    }
    if (!meetsMinimum) {
      result.error = `gemini ${version} is older than required ${GEMINI_MIN_VERSION}. Upgrade with: npm i -g @google/gemini-cli (or see https://github.com/google-gemini/gemini-cli).`
    }
    return result
  } catch {
    return { installed: true, executable: false }
  }
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  binary: 'gemini',
  minCliVersion: GEMINI_MIN_VERSION,
  projectDirName: '.gemini',
  instructionsFilename: 'GEMINI.md',
  mcpRegistration: 'project-json',
  capabilities: {
    nativeResume: true,
    nativeStreamJson: true,
    nativeCostUsd: false,
    nativeOtelEnv: true,
    profileEnvSupport: true,
    systemPromptArg: false,
  },
  modelCatalog: () => GEMINI_MODELS,
  defaultModel: () => 'gemini-3.5-flash',
  buildArgs: buildGeminiArgs,
  parseStreamLine: parseGeminiStreamLine,
  extractResult: extractGeminiResult,
  baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
  detectInstalled: detectGeminiInstalled,
  // Pre-acknowledge the project's custom subagents so they load in headless
  // `gemini -p` rail spawns (else invoke_agent reports "Subagent not found").
  prepareHeadlessSpawn: acknowledgeGeminiProjectAgents,
}

export { GEMINI_MIN_VERSION as _GEMINI_MIN_VERSION, compareSemver as _compareSemver }
