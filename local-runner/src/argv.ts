import type { RunnerOptions, ToolPolicy } from './types'

export class ArgvError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message)
  }
}

const VALUE_FLAGS = new Set([
  '-p',
  '--model',
  '--base-url',
  '--api-key-env',
  '--resume',
  '--system-prompt',
  '--append-system-prompt',
  '--tools',
  '--disallowedTools',
  '--max-turns',
  '--mcp-config',
  '--add-dir',
  '--output-format',
  '--input-format',
  '--reasoning-effort',
])

function parseCsv(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Parses the claude-style argv the desktop adapter builds. Every unknown flag
 * is a fail-fast `ArgvError` (exit 2) BEFORE any network activity — the
 * adapter's argv contract is the only thing this process trusts.
 */
export function parseArgv(argv: string[], env: Record<string, string | undefined>): RunnerOptions {
  const opts: RunnerOptions = {
    prompt: null,
    model: env.SPECRAILS_LOCAL_RUNNER_MODEL ?? 'default',
    baseUrl: env.SPECRAILS_LOCAL_RUNNER_BASE_URL ?? 'http://127.0.0.1:8080/v1',
    apiKeyEnv: null,
    resume: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    toolPolicy: { kind: 'default' },
    maxTurns: null,
    mcpConfig: null,
    addDirs: [],
    outputFormat: 'stream-json',
    inputFormat: 'text',
    reasoningEffort: null,
  }
  let allow: string[] | null = null
  let disallow: string[] | null = null

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!VALUE_FLAGS.has(flag)) throw new ArgvError(`unknown flag: ${flag}`)
    const value = argv[i + 1]
    if (value === undefined) throw new ArgvError(`missing value for ${flag}`)
    i++
    switch (flag) {
      case '-p':
        opts.prompt = value
        break
      case '--model':
        opts.model = value
        break
      case '--base-url':
        opts.baseUrl = value.replace(/\/+$/, '')
        break
      case '--api-key-env':
        opts.apiKeyEnv = value
        break
      case '--resume':
        opts.resume = value
        break
      case '--system-prompt':
        opts.systemPrompt = value
        break
      case '--append-system-prompt':
        opts.appendSystemPrompt = value
        break
      case '--tools':
        allow = value.trim() === '__none__' ? [] : parseCsv(value)
        break
      case '--disallowedTools':
        disallow = parseCsv(value)
        break
      case '--max-turns': {
        const n = Number.parseInt(value, 10)
        if (!Number.isFinite(n) || n <= 0) throw new ArgvError(`invalid --max-turns: ${value}`)
        opts.maxTurns = n
        break
      }
      case '--mcp-config':
        opts.mcpConfig = value
        break
      case '--add-dir':
        opts.addDirs.push(value)
        break
      case '--output-format':
        if (value !== 'stream-json') throw new ArgvError(`unsupported --output-format: ${value}`)
        break
      case '--input-format':
        if (value !== 'stream-json' && value !== 'text') throw new ArgvError(`unsupported --input-format: ${value}`)
        opts.inputFormat = value
        break
      case '--reasoning-effort':
        opts.reasoningEffort = value
        break
    }
  }

  opts.toolPolicy = resolvePolicy(allow, disallow)
  if (opts.prompt === null && opts.inputFormat !== 'stream-json') {
    throw new ArgvError('missing prompt: pass -p <prompt> or --input-format stream-json')
  }
  return opts
}

function resolvePolicy(allow: string[] | null, disallow: string[] | null): ToolPolicy {
  if (allow !== null) {
    if (allow.length === 0) return { kind: 'none' }
    // An explicit allow-list that ALSO carries a deny-list keeps the intersection.
    const names = disallow ? allow.filter((n) => !disallow.includes(n)) : allow
    return names.length === 0 ? { kind: 'none' } : { kind: 'allow', names }
  }
  if (disallow !== null && disallow.length > 0) return { kind: 'disallow', names: disallow }
  return { kind: 'default' }
}
