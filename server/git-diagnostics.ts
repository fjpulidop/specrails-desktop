import { execFile } from 'child_process'
import { GIT_EXEC_ENV } from './file-provenance'
import { windowsSpawnEnv } from './util/win-spawn'

/**
 * READ-ONLY git / gh diagnostics for a project's repo — the backing for the
 * `specrails_git` MCP tool. Lets the in-app operator agent answer questions like
 * "is this repo connected to GitHub?", "what's the remote?", "is gh
 * authenticated?", "what changed?" through the app's OWN bundled git/gh, instead
 * of refusing or asking the user to run terminal commands.
 *
 * SAFETY: the command list is a FIXED ALLOWLIST — the caller only picks an
 * action name, never arguments, so no flag/ref/path can be smuggled in. Every
 * command is read-only (no push/commit/checkout/pr-create). git runs with the
 * hardened `GIT_EXEC_ENV` (hostile-repo config stripped, prompts disabled); gh
 * runs with the normal env so it finds the user's `~/.config/gh` auth and the
 * bundled `gh` on PATH.
 */
export const GIT_DIAGNOSTIC_ACTIONS = [
  'remote', 'status', 'log', 'diff', 'branch',
  'gh_repo', 'gh_auth', 'gh_pr_list', 'gh_pr_view',
] as const
export type GitDiagnosticAction = (typeof GIT_DIAGNOSTIC_ACTIONS)[number]

export function isGitDiagnosticAction(v: unknown): v is GitDiagnosticAction {
  return typeof v === 'string' && (GIT_DIAGNOSTIC_ACTIONS as readonly string[]).includes(v)
}

interface CommandSpec { cmd: 'git' | 'gh'; args: string[]; help: string }

const SPECS: Record<GitDiagnosticAction, CommandSpec> = {
  remote:     { cmd: 'git', args: ['remote', '-v'], help: 'List configured remotes (is the repo linked to GitHub, and where).' },
  status:     { cmd: 'git', args: ['status', '--short', '--branch'], help: 'Branch + short working-tree status.' },
  log:        { cmd: 'git', args: ['log', '--oneline', '--decorate', '-20'], help: 'The last 20 commits.' },
  diff:       { cmd: 'git', args: ['diff', '--stat'], help: 'Uncommitted change summary (diffstat).' },
  branch:     { cmd: 'git', args: ['branch', '-vv'], help: 'Local branches with upstream tracking.' },
  gh_repo:    { cmd: 'gh', args: ['repo', 'view'], help: 'The GitHub repo this checkout is linked to (fails if none / gh unauth).' },
  gh_auth:    { cmd: 'gh', args: ['auth', 'status'], help: 'Whether gh is authenticated, and for which host/account.' },
  gh_pr_list: { cmd: 'gh', args: ['pr', 'list', '--limit', '30'], help: 'Open pull requests for the repo.' },
  gh_pr_view: { cmd: 'gh', args: ['pr', 'view'], help: "The current branch's pull request (if any)." },
}

export interface GitDiagnosticResult {
  action: GitDiagnosticAction
  /** The exact command that ran (for transparency in the agent's reply). */
  command: string
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

/** Injectable spawn (tests). Resolves { code, stdout, stderr } — never rejects. */
export type DiagnosticExec = (cmd: 'git' | 'gh', args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>

const OUTPUT_CAP = 8_000

const defaultExec: DiagnosticExec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    // git: hardened, cwd-pinned env. gh: user env (needs ~/.config/gh auth) with
    // the Windows shell-critical vars guaranteed present.
    const env = cmd === 'gh' ? windowsSpawnEnv() : GIT_EXEC_ENV
    execFile(
      cmd, args,
      { cwd, env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err ? 1 : 0
        resolve({ code, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() })
      },
    )
  })

const cap = (s: string): string => (s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n…(truncated)` : s)

/**
 * Run one allow-listed read-only diagnostic in `repoDir`. Throws only on an
 * UNKNOWN action (defence-in-depth; the route validates too); a non-zero exit
 * (e.g. `gh repo view` with no remote) is a normal result with `ok: false`.
 */
export async function runGitDiagnostic(
  action: string,
  repoDir: string,
  exec: DiagnosticExec = defaultExec,
): Promise<GitDiagnosticResult> {
  if (!isGitDiagnosticAction(action)) {
    throw new Error(`Unknown diagnostic action: ${action}. Allowed: ${GIT_DIAGNOSTIC_ACTIONS.join(', ')}`)
  }
  const spec = SPECS[action]
  const r = await exec(spec.cmd, spec.args, repoDir)
  return {
    action,
    command: `${spec.cmd} ${spec.args.join(' ')}`,
    ok: r.code === 0,
    exitCode: r.code,
    stdout: cap(r.stdout),
    stderr: cap(r.stderr),
  }
}

/** The action → human help map, for the MCP tool description / discoverability. */
export function gitDiagnosticHelp(): Record<GitDiagnosticAction, string> {
  return Object.fromEntries(
    (Object.keys(SPECS) as GitDiagnosticAction[]).map((a) => [a, SPECS[a].help]),
  ) as Record<GitDiagnosticAction, string>
}
