// Centralized claude/codex spawn wrapper.
//
// Why this exists:
//
//   On Windows, cross-spawn invokes claude.cmd / codex.cmd through
//   `cmd.exe /d /s /c "..."`. cmd.exe does NOT preserve newlines
//   inside argv values: any `\n` in `--system-prompt`,
//   `--append-system-prompt`, `-p`, or codex's positional prompt
//   truncates the arg there and the rest of the command line gets
//   reparsed as orphan tokens. Visible symptoms include
//   "Input must be provided either through stdin or as a prompt
//   argument when using --print" and assistant messages that look
//   like "your message got cut off — you wrote 'are' but I'm not
//   sure what you were asking".
//
//   On POSIX argv passes through cleanly, so we keep that path.
//
// The helpers below detect multi-line argv values on Windows,
// reroute them through child stdin (claude reads stdin when
// `-p`/`--print` has no positional argument; codex `exec -` does the
// equivalent), and call spawnCli. POSIX is unchanged byte-for-byte.

import type { ChildProcess, SpawnOptions, StdioOptions } from 'child_process'
import { spawnCli } from './win-spawn'
import {
  headroomRelayBaseUrlForBinary,
  registerHeadroomRoutedChild,
  withHeadroomSpawnEnv,
} from '../headroom-routing'

// Per-call (not a frozen module const) so a test can flip the platform with a
// `process.platform` spy without re-importing this module — which removes a
// flaky vi.doMock + resetModules + dynamic-import dance in the spawn tests.
const isWin = (): boolean => process.platform === 'win32'

const CLAUDE_PROMPT_FLAGS = new Set([
  '--system-prompt',
  '--append-system-prompt',
  '-p',
  '--print',
])

interface WindowsTransform {
  args: string[]
  stdinPayload: string | null
}

/**
 * Codex's configured `model_provider` owns the request URL. Overriding only
 * `openai_base_url` is therefore insufficient: a user-level custom provider can
 * keep its own `model_providers.<name>.base_url` and bypass the trusted relay.
 * Pin the built-in OpenAI provider AND its base URL as the final config values
 * (later `-c` values win). Callers retain their original args.
 */
export function appendCodexHeadroomRelayOverride(args: string[], relayBaseUrl: string): string[] {
  const value = `openai_base_url=${JSON.stringify(`${relayBaseUrl}/v1`)}`
  return [...args, '-c', 'model_provider="openai"', '-c', value]
}

export function transformClaudeArgsForWindows(args: string[]): WindowsTransform {
  const collected: string[] = []
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    // A prompt flag only carries an inline value when the next token exists
    // AND is not itself a flag. The `chat-stream` action emits a VALUELESS
    // `-p` immediately followed by `--input-format stream-json` (the prompt
    // arrives over stdin); without the flag guard we would wrongly consume
    // `--input-format` as the prompt, drop it from argv, and pipe the literal
    // string `--input-format` to stdin. A bare trailing `-p` (stdin mode)
    // likewise has no value to collect. Mirror the codex transform's
    // `a.startsWith('-')` guard so both transports stay byte-correct.
    if (CLAUDE_PROMPT_FLAGS.has(a)) {
      const next = i + 1 < args.length ? args[i + 1] : undefined
      if (next !== undefined && !next.startsWith('-')) {
        collected.push(next)
        i++ // skip the value
        continue
      }
    }
    out.push(a)
  }
  if (collected.length === 0) {
    return { args: out, stdinPayload: null }
  }
  // Re-add `-p` so claude knows to read stdin (--print mode) — unless a bare
  // `-p`/`--print` already survived in `out` (chat-stream emits its own
  // valueless `-p`), in which case re-adding would duplicate the flag.
  if (!out.some((t) => t === '-p' || t === '--print')) {
    out.push('-p')
  }
  return { args: out, stdinPayload: collected.join('\n\n---\n\n') }
}

// Codex `exec` flags we currently use that take a value (rest are
// boolean). Update if we ever pass new value-bearing flags.
const CODEX_EXEC_VALUE_FLAGS = new Set(['--model', '--sandbox', '-c'])

export function transformCodexArgsForWindows(args: string[]): WindowsTransform {
  // Expected shapes:
  //   exec [...flags] <prompt> [...flags]
  //   exec resume [...flags] <sessionId> <prompt> [...flags]
  if (args.length === 0 || args[0] !== 'exec') {
    return { args, stdinPayload: null }
  }
  const out: string[] = ['exec']
  const isResume = args[1] === 'resume'
  if (isResume) out.push('resume')
  let stdin: string | null = null
  let promptReplacedIdx = -1
  let positionalCount = 0
  let i = isResume ? 2 : 1
  while (i < args.length) {
    const a = args[i]
    if (a.startsWith('-') && a !== '-') {
      out.push(a)
      if (CODEX_EXEC_VALUE_FLAGS.has(a) && i + 1 < args.length) {
        out.push(args[i + 1])
        i += 2
        continue
      }
      i += 1
      continue
    }
    positionalCount += 1
    const isPrompt = isResume ? positionalCount === 2 : positionalCount === 1
    if (isPrompt && stdin === null) {
      stdin = a
      promptReplacedIdx = out.length
      out.push('-')
    } else {
      out.push(a)
    }
    i += 1
  }
  if (stdin === null || !stdin.includes('\n')) {
    // Single-line prompts pass through cmd.exe fine — keep argv to
    // dodge any codex versions that don't recognise `-` as stdin.
    if (stdin !== null && promptReplacedIdx >= 0) {
      out[promptReplacedIdx] = stdin
    }
    return { args: out, stdinPayload: null }
  }
  return { args: out, stdinPayload: stdin }
}

export function ensureStdinPipe(stdio: StdioOptions | undefined): StdioOptions {
  const fallback: StdioOptions = ['pipe', 'pipe', 'pipe']
  if (stdio === undefined) return fallback
  if (typeof stdio === 'string') {
    // 'pipe' | 'inherit' | 'ignore' | 'overlapped'
    return ['pipe', stdio, stdio]
  }
  if (Array.isArray(stdio)) {
    return [
      stdio[0] === 'ignore' ? 'pipe' : (stdio[0] ?? 'pipe'),
      stdio[1] ?? 'pipe',
      stdio[2] ?? 'pipe',
    ] as StdioOptions
  }
  return fallback
}

/**
 * Spawn `claude` with arg-rewrite on Windows so multi-line prompts
 * survive. POSIX call is identical to `spawnCli('claude', args, options)`.
 */
export function spawnClaude(args: string[], options: SpawnOptions = {}): ChildProcess {
  options = withHeadroomSpawnEnv('claude', options)
  let child: ChildProcess
  if (!isWin()) {
    child = spawnCli('claude', args, options)
    registerHeadroomRoutedChild('claude', options.env, child)
    return child
  }
  /* c8 ignore start -- Windows-only branch; coverage runs on Linux/macOS */
  const { args: winArgs, stdinPayload } = transformClaudeArgsForWindows(args)
  if (stdinPayload === null) {
    child = spawnCli('claude', winArgs, options)
    registerHeadroomRoutedChild('claude', options.env, child)
    return child
  }
  const spawnOptions = {
    ...options,
    stdio: ensureStdinPipe(options.stdio),
  }
  child = spawnCli('claude', winArgs, spawnOptions)
  registerHeadroomRoutedChild('claude', spawnOptions.env, child)
  if (child.stdin) child.stdin.end(stdinPayload)
  return child
  /* c8 ignore stop */
}

/**
 * Spawn `codex` with arg-rewrite on Windows so multi-line prompts
 * survive. POSIX call is identical to `spawnCli('codex', args, options)`.
 */
export function spawnCodex(args: string[], options: SpawnOptions = {}): ChildProcess {
  options = withHeadroomSpawnEnv('codex', options)
  const relayBaseUrl = headroomRelayBaseUrlForBinary('codex', options.env)
  if (relayBaseUrl) args = appendCodexHeadroomRelayOverride(args, relayBaseUrl)
  let child: ChildProcess
  if (!isWin()) {
    child = spawnCli('codex', args, options)
    registerHeadroomRoutedChild('codex', options.env, child)
    return child
  }
  /* c8 ignore start -- Windows-only branch; coverage runs on Linux/macOS */
  const { args: winArgs, stdinPayload } = transformCodexArgsForWindows(args)
  if (stdinPayload === null) {
    child = spawnCli('codex', winArgs, options)
    registerHeadroomRoutedChild('codex', options.env, child)
    return child
  }
  const spawnOptions = {
    ...options,
    stdio: ensureStdinPipe(options.stdio),
  }
  child = spawnCli('codex', winArgs, spawnOptions)
  registerHeadroomRoutedChild('codex', spawnOptions.env, child)
  if (child.stdin) child.stdin.end(stdinPayload)
  return child
  /* c8 ignore stop */
}

/**
 * Spawn `gemini` headless. Injects `GEMINI_CLI_TRUST_WORKSPACE=true` so the CLI
 * does not silently override `--yolo` back to "default" (which blocks EVERY tool
 * call) when the project dir is not a "trusted folder" — the documented escape
 * hatch for headless/automated environments. Validated empirically: without it,
 * a headless `gemini -p` run executes zero tool calls and the rail does nothing.
 * No multi-line argv quirk (the prompt rides on a single `-p` value), so the
 * Windows path is identical to POSIX.
 */
// Gemini auth env vars. Forwarded from `process.env` into the spawn env when
// present so a caller that narrows the env (or a relocated spawn) still carries
// the API key — without it gemini-cli falls back to OAuth, which on macOS
// re-prompts for Keychain access on every spawn. `process.env` is itself
// backfilled from the login shell at startup (see augmentAuthEnvFromLoginShell).
const GEMINI_AUTH_ENV_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const

export function spawnGemini(args: string[], options: SpawnOptions = {}): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), GEMINI_CLI_TRUST_WORKSPACE: 'true' }
  for (const key of GEMINI_AUTH_ENV_VARS) {
    if (process.env[key] && env[key] === undefined) env[key] = process.env[key]
  }
  return spawnCli('gemini', args, { ...options, env })
}

/**
 * Convenience: dispatch on binary name. Use when callsite picks the
 * binary dynamically (claude vs codex vs gemini). Anything else routes through
 * the underlying spawnCli unchanged.
 */
export function spawnAiCli(
  binary: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  if (binary === 'claude') return spawnClaude(args, options)
  if (binary === 'codex') return spawnCodex(args, options)
  if (binary === 'gemini') return spawnGemini(args, options)
  return spawnCli(binary, args, options)
}
