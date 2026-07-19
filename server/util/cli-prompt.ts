// Centralized AI CLI spawn wrapper.
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
// equivalent), and call spawnCli. Kimi's required `-p <prompt>` has no stdin
// equivalent, so its Windows npm shim is unwrapped and its JavaScript entry is
// launched with Node directly. POSIX is unchanged byte-for-byte.

import type { ChildProcess, SpawnOptions, StdioOptions } from 'child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveWindowsBinary, spawnCli } from './win-spawn'
import {
  headroomRelayBaseUrlForBinary,
  registerHeadroomRoutedChild,
  withHeadroomSpawnEnv,
} from '../headroom-routing'
import { assertProcessAdmission } from '../process-admission'

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
      // The transformed prompt always travels on fd 0. `inherit`,
      // `overlapped`, numeric fds, and streams leave child.stdin null just as
      // `ignore` does, so every array form must be upgraded unconditionally.
      'pipe',
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
  assertProcessAdmission()
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
  assertProcessAdmission()
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
  assertProcessAdmission()
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), GEMINI_CLI_TRUST_WORKSPACE: 'true' }
  for (const key of GEMINI_AUTH_ENV_VARS) {
    if (process.env[key] && env[key] === undefined) env[key] = process.env[key]
  }
  return spawnCli('gemini', args, { ...options, env })
}

/**
 * Extract the JavaScript entry from a standard npm-generated Windows `.cmd`
 * launcher. npm writes the target as `%dp0%\<package path>.mjs %*`; resolving
 * that path lets us bypass cmd.exe while preserving the exact argv payload.
 */
export function parseNpmCmdShimEntry(shimPath: string, contents: string): string | null {
  const match = contents.match(
    /%dp0%[\\/]([^"\r\n]*?\.(?:mjs|cjs|js))["']?\s+%\*/i,
  )
  if (!match?.[1]) return null
  return path.win32.join(path.win32.dirname(shimPath), match[1])
}

/**
 * Spawn Kimi in daemon-free prompt mode.
 *
 * Kimi 0.27 requires `-p <prompt>` and cannot itself read that prompt from
 * stdin. On Windows, a native executable receives argv directly. For npm's
 * `.cmd` shim, launch a tiny Node bootstrap that reads the complete prompt from
 * stdin, restores it into process.argv at the `-p` value slot, then imports the
 * generated JavaScript entry. This bypasses both cmd.exe newline reparsing and
 * CreateProcess's ~32K command-line ceiling without changing Kimi semantics.
 * A non-standard or unreadable command shim fails closed.
 */
const KIMI_WINDOWS_ARGV_SAFE_CHARS = 30_000
const KIMI_WINDOWS_STDIN_BOOTSTRAP = [
  'const fs=require("node:fs");',
  'const {pathToFileURL}=require("node:url");',
  'const entry=process.argv[1];',
  'const slot=Number(process.argv[2]);',
  'const args=process.argv.slice(3);',
  'args[slot]=fs.readFileSync(0,"utf8");',
  'process.argv=[process.execPath,entry,...args];',
  'import(pathToFileURL(entry).href).catch((error)=>{console.error(error);process.exitCode=1;});',
].join('')

function kimiPromptValueIndex(args: readonly string[]): number {
  const flagIndex = args.indexOf('-p')
  return flagIndex >= 0 && flagIndex + 1 < args.length ? flagIndex + 1 : -1
}

function estimatedWindowsArgvChars(binary: string, args: readonly string[]): number {
  return binary.length + 1 + args.reduce((total, arg) => total + arg.length + 3, 0)
}

export function spawnKimi(args: string[], options: SpawnOptions = {}): ChildProcess {
  assertProcessAdmission()
  if (!isWin()) return spawnCli('kimi', args, options)

  /* c8 ignore start -- Windows-only branch; unit tests force process.platform */
  const resolved = resolveWindowsBinary('kimi')
  const extension = path.win32.extname(resolved).toLowerCase()
  if (extension !== '.cmd' && extension !== '.bat') {
    const promptIndex = kimiPromptValueIndex(args)
    if (
      promptIndex >= 0 &&
      estimatedWindowsArgvChars(resolved, args) > KIMI_WINDOWS_ARGV_SAFE_CHARS
    ) {
      throw new Error(
        `kimi_windows_native_prompt_too_large:${args[promptIndex].length}: ` +
        'the native Kimi executable cannot receive this prompt within the Windows ' +
        'CreateProcess limit; install the npm Kimi Code CLI shim or shorten the prompt.',
      )
    }
    return spawnCli(resolved, args, options)
  }

  let entry: string | null
  try {
    entry = parseNpmCmdShimEntry(resolved, readFileSync(resolved, 'utf8'))
  } catch (error) {
    throw new Error(
      `unsupported_kimi_windows_shim:${resolved}:` +
      (error instanceof Error ? error.message : String(error)),
    )
  }
  if (!entry) {
    throw new Error(`unsupported_kimi_windows_shim:${resolved}`)
  }
  const localNode = path.win32.join(path.win32.dirname(resolved), 'node.exe')
  const nodeBinary = existsSync(localNode) ? localNode : 'node'
  const promptIndex = kimiPromptValueIndex(args)
  if (promptIndex < 0) {
    return spawnCli(nodeBinary, [entry, ...args], options)
  }

  const prompt = args[promptIndex]
  const forwardedArgs = [...args]
  // Preserve the exact argv shape for Kimi; the bootstrap replaces only this
  // placeholder after reading stdin. The real prompt never reaches
  // CreateProcess, cmd.exe, environment variables, or a temporary file.
  forwardedArgs[promptIndex] = ''
  const spawnOptions = {
    ...options,
    stdio: ensureStdinPipe(options.stdio),
  }
  const child = spawnCli(nodeBinary, [
    '-e',
    KIMI_WINDOWS_STDIN_BOOTSTRAP,
    entry,
    String(promptIndex),
    ...forwardedArgs,
  ], spawnOptions)
  if (!child.stdin) {
    try { child.kill('SIGTERM') } catch { /* best-effort */ }
    throw new Error('kimi_windows_bootstrap_stdin_unavailable')
  }
  // A short-lived bootstrap can exit before the buffered write settles.
  // Without an error listener, the resulting EPIPE is an unhandled EventEmitter
  // error and can terminate Desktop itself. Broken pipes are already reflected
  // by the child's terminal status; log any different transport failure.
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') return
    console.error('[cli-prompt] Kimi Windows prompt transport failed:', error)
    // A failed transport must never leave the bootstrap free to invoke Kimi
    // with an empty or partial prompt. Managers will observe the terminated
    // child through their normal lifecycle/error path.
    try { child.kill('SIGTERM') } catch { /* best-effort */ }
  })
  try {
    child.stdin.end(prompt)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPIPE') throw error
  }
  return child
  /* c8 ignore stop */
}

/**
 * Convenience: dispatch on binary name. Use when callsite picks the
 * binary dynamically. Anything else routes through the underlying spawnCli.
 */
export function spawnAiCli(
  binary: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  assertProcessAdmission()
  if (binary === 'claude') return spawnClaude(args, options)
  if (binary === 'codex') return spawnCodex(args, options)
  if (binary === 'gemini') return spawnGemini(args, options)
  if (binary === 'kimi') return spawnKimi(args, options)
  return spawnCli(binary, args, options)
}
