/**
 * The PreToolUse policy hook Claude runs before every tool call of a
 * Specrails run or mission (installed through the run's
 * `.claude/settings.local.json`; Claude runs hooks in bypassPermissions mode
 * too). Bundled with its rules into one dependency-free CommonJS file
 * (`scripts/build-policy-hook.mjs` → `policy-hook-bundle.generated.ts`), which
 * Specrails writes under `~/.specrails/agent-policy/`.
 *
 * Contract with Claude (exit code always 0):
 * - deny  → `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}`
 * - other → `{}` — NO decision. The hook never answers "allow": that would
 *   skip Claude's own permission checks (plan mode, disallowed tools).
 *
 * Failure policy — closed only for the explicit deny list, open otherwise:
 * - malformed or empty input, an unknown event → `{}` (a broken payload must
 *   not wedge every tool call of every run);
 * - an exception while evaluating → deny (`policy-error`) only when the raw
 *   tool input matches a deny-list shape (`DENY_LIST_HINT`), else `{}`;
 * - no answer within 3 s (stdin never closed) → `{}`;
 * - the hook cannot start (Node missing, file deleted) → Claude reports a
 *   non-blocking hook error and the tool runs. That is deliberate: an app
 *   update or a moved runtime must not stop every agent; the server rewrites
 *   the hook on the next turn or launch.
 */
import { DENY_LIST_HINT, evaluateToolCall, type GitFacts, type PolicyDecision, type PolicyFacts } from '../domain/rules'
import { formatDenialReason } from '../domain/denial'
import type { DenialReport } from '../domain/report'

export interface HookFs {
  readFile(path: string): string | null
  realpath(path: string): string | null
  isDir(path: string): boolean
  exists(path: string): boolean
}

export interface HookEnvironment {
  argv: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  home: string
  tmpdir: string
  fs: HookFs
}

function argValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name)
  return index !== -1 && typeof argv[index + 1] === 'string' && argv[index + 1] ? argv[index + 1]! : null
}

function parent(p: string): string {
  const index = p.lastIndexOf('/')
  return index <= 0 ? '/' : p.slice(0, index)
}

/** Resolve symlinks of the longest existing prefix; keep the rest. */
function makeRealpath(fs: HookFs): (p: string) => string {
  const cache = new Map<string, string>()
  const resolve = (p: string, depth: number): string => {
    if (p === '/' || depth > 64) return p
    const cached = cache.get(p)
    if (cached !== undefined) return cached
    const real = fs.realpath(p)
    const out = real ?? (() => {
      const base = p.slice(p.lastIndexOf('/') + 1)
      const up = resolve(parent(p), depth + 1)
      return up === '/' ? `/${base}` : `${up}/${base}`
    })()
    cache.set(p, out)
    return out
  }
  return (p) => resolve(p, 0)
}

/** Git facts read from files only (no `git` process: the hook must stay fast). */
function makeGit(fs: HookFs): (dir: string) => GitFacts {
  const cache = new Map<string, GitFacts>()
  return (dir) => {
    const cached = cache.get(dir)
    if (cached) return cached
    let facts: GitFacts = { branch: null, defaultBranch: null }
    let cursor = dir
    for (let guard = 0; guard < 64; guard++) {
      const dotGit = `${cursor === '/' ? '' : cursor}/.git`
      if (fs.exists(dotGit)) {
        let gitDir = dotGit
        if (!fs.isDir(dotGit)) {
          const pointer = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFile(dotGit) ?? '')
          if (!pointer) break
          const target = pointer[1]!.trim()
          gitDir = target.startsWith('/') ? target : `${cursor}/${target}`
        }
        const head = (fs.readFile(`${gitDir}/HEAD`) ?? '').trim()
        const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null
        const common = (fs.readFile(`${gitDir}/commondir`) ?? '').trim()
        const commonDir = common ? (common.startsWith('/') ? common : `${gitDir}/${common}`) : gitDir
        const originHead = (fs.readFile(`${commonDir}/refs/remotes/origin/HEAD`) ?? '').trim()
        const defaultBranch = /^ref:\s*refs\/remotes\/origin\/(.+)$/.exec(originHead)?.[1] ?? null
        facts = { branch, defaultBranch }
        break
      }
      if (cursor === '/') break
      cursor = parent(cursor)
    }
    cache.set(dir, facts)
    return facts
  }
}

export function policyFacts(input: { cwd?: unknown }, environment: HookEnvironment): PolicyFacts {
  const specrailsHome = argValue(environment.argv, '--specrails-home') ?? environment.env.SPECRAILS_REGISTRY_HOME ?? environment.home
  const cwd = typeof input.cwd === 'string' && input.cwd.startsWith('/') ? input.cwd : null
  const projectDir = environment.env.CLAUDE_PROJECT_DIR && environment.env.CLAUDE_PROJECT_DIR.startsWith('/')
    ? environment.env.CLAUDE_PROJECT_DIR
    : cwd ?? '/'
  const realpath = makeRealpath(environment.fs)
  return {
    home: environment.home,
    specrailsHome,
    projectDir,
    cwd: cwd ?? projectDir,
    tempDirs: [...new Set([environment.tmpdir, '/tmp', '/private/tmp'].filter((dir) => dir && dir !== '/'))],
    git: makeGit(environment.fs),
    realpath,
  }
}

export function denyOutput(decision: PolicyDecision, toolName: string): string {
  return JSON.stringify({
    systemMessage: `Specrails policy blocked ${toolName}: ${decision.reason}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: formatDenialReason(decision.rule, decision.reason),
    },
  })
}

export const NO_DECISION = '{}'

export interface HookResult {
  /** What the hook prints. */
  output: string
  /** A denial to spool for the audit (see `spoolDenial`), or null. */
  report: DenialReport | null
}

function summarise(toolName: string, input: unknown): string {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const value = toolName.toLowerCase() === 'bash' ? record.command : record.file_path ?? record.path ?? record.notebook_path ?? record.pattern
  return typeof value === 'string' ? value.slice(0, 2000) : toolName
}

function denied(decision: PolicyDecision, toolName: string, payload: Record<string, unknown>, facts: { projectDir: string; cwd: string }): HookResult {
  return {
    output: denyOutput(decision, toolName),
    report: {
      v: 1,
      at: new Date().toISOString(),
      rule: decision.rule,
      reason: decision.reason,
      tool: toolName,
      target: summarise(toolName, payload.tool_input),
      toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
      projectDir: facts.projectDir,
      cwd: facts.cwd,
    },
  }
}

/**
 * The hook's whole job, minus process IO: stdin text in, stdout text out.
 * Never throws.
 */
export function runPolicyHook(stdin: string, environment: HookEnvironment): HookResult {
  const none: HookResult = { output: NO_DECISION, report: null }
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(stdin) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none
    payload = parsed as Record<string, unknown>
  } catch {
    return none
  }
  if (payload.hook_event_name !== undefined && payload.hook_event_name !== 'PreToolUse') return none
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  if (!toolName) return none
  let facts: PolicyFacts | null = null
  try {
    facts = policyFacts(payload, environment)
    const decision = evaluateToolCall(toolName, payload.tool_input, facts)
    return decision ? denied(decision, toolName, payload, facts) : none
  } catch {
    let raw = ''
    try { raw = JSON.stringify(payload.tool_input ?? '') } catch { /* unserialisable */ }
    if (DENY_LIST_HINT.test(raw)) {
      const decision: PolicyDecision = { rule: 'policy-error', reason: 'This call matches the Specrails deny list and could not be checked safely.' }
      const where = facts ?? { projectDir: typeof payload.cwd === 'string' ? payload.cwd : '', cwd: typeof payload.cwd === 'string' ? payload.cwd : '' }
      return denied(decision, toolName, payload, where)
    }
    return none
  }
}
