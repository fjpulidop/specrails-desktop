/**
 * Command classification for narrated progress (nontech-review-experience).
 *
 * Measured on real runs in this project (≈900 shell invocations): about 80% were
 * `grep`, `cd`, `find`, `sed`, `ls`, `jq`, `cat` and friends. Listing those tells
 * a non-technical reader nothing — they are HOW an agent looks around, the same
 * category of non-event as "thinking". Only ~170 invocations carried meaning:
 * `npm`, `npx`, `git`, `openspec`, `cargo`, `python3`, `node`.
 *
 * So commands are sorted into three buckets:
 *
 *  · **plumbing** — collapsed into one "looking through the code" milestone with
 *    a count, never one line each.
 *  · **intent** — translated to what it accomplishes, but ONLY from an explicit
 *    allowlist of (tool, subcommand) pairs. `npm test` → "running the tests" is
 *    a faithful translation; guessing at `npm run whatever` would be invention,
 *    so anything unrecognised falls back to the tool name.
 *  · **named** — meaningful but unmapped: reported as the tool itself.
 *
 * Read-only git (`status`, `diff`, `log`, `show`) counts as plumbing on purpose:
 * inspecting the tree is looking around, not doing work.
 */

export type CommandClass =
  | { kind: 'plumbing' }
  | { kind: 'intent'; code: string }
  | { kind: 'named'; tool: string }

/** Shell utilities and navigation: real work never shows up as one of these. */
const PLUMBING = new Set([
  // reading / searching
  'grep', 'rg', 'ag', 'ack', 'find', 'fd', 'ls', 'cat', 'head', 'tail', 'sed', 'awk',
  'cut', 'sort', 'uniq', 'wc', 'jq', 'yq', 'tr', 'xargs', 'tee', 'column', 'less', 'more',
  // navigating / inspecting
  'cd', 'pwd', 'echo', 'printf', 'which', 'type', 'test', 'true', 'false', 'env',
  'export', 'set', 'source', 'date', 'basename', 'dirname', 'realpath', 'readlink',
  'stat', 'file', 'tree', 'diff', 'sleep', 'seq', 'hostname', 'whoami', 'uname',
  // moving bytes around: real work shows up as the write itself, not as the mkdir
  'mkdir', 'rmdir', 'cp', 'mv', 'rm', 'touch', 'ln', 'chmod', 'chown', 'install',
  // shell syntax that arrives looking like a command
  '[[', '[', ']]', ']', 'for', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi',
  'do', 'done', 'case', 'esac', 'exec', 'eval', 'trap', 'read', 'shift', 'wait',
])

/** Read-only git subcommands — inspection, not change. */
const GIT_READONLY = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'describe'])

/** Every git subcommand we recognise. Scanning for one of THESE is what makes
 *  `git -C /repo commit` work: a flag's value (`/repo`) is not a subcommand, and
 *  guessing flag arity would be fragile. */
const GIT_SUBCOMMANDS = new Set([
  ...GIT_READONLY, 'commit', 'add', 'stage', 'push', 'pull', 'fetch', 'checkout', 'switch',
  'merge', 'rebase', 'reset', 'stash', 'tag', 'clone', 'worktree', 'cherry-pick', 'restore',
  'apply', 'init', 'remote', 'config', 'update-ref', 'for-each-ref',
])

/** Package-manager verbs, scanned the same way (`npm --silent run build`). */
const PM_VERBS = new Set(['run', 'run-script', 'test', 'install', 'ci', 'i', 'add', 'exec', 'start', 'dlx'])

/** npm/yarn/pnpm script names that map to a known intent. */
const SCRIPT_INTENT: Array<[RegExp, string]> = [
  [/^(test|tests|test:.*|vitest|jest|spec)$/, 'activity.testing'],
  [/^(build|compile|bundle|dist)$/, 'activity.building'],
  [/^(typecheck|tsc|types?)$/, 'activity.typechecking'],
  [/^(lint|lint:.*|eslint|format|fmt|prettier)$/, 'activity.linting'],
]

const TEST_BINARIES = new Set(['vitest', 'jest', 'pytest', 'mocha', 'ava', 'rspec', 'phpunit'])

function scriptIntent(script: string): string | null {
  for (const [pattern, code] of SCRIPT_INTENT) {
    if (pattern.test(script)) return code
  }
  return null
}

/**
 * Meaningful positional tokens (flags carry no intent). An unwrapped command
 * arrives quoted (`zsh -lc 'npm run build'`), so BOTH ends of every token are
 * stripped — a trailing quote on the last token silently broke script matching.
 */
function words(command: string): string[] {
  return command
    .split(/\s+/)
    .map((token) => token.replace(/^['"`]+/, '').replace(/['"`]+$/, ''))
    .filter((token) => token.length > 0 && !token.startsWith('-'))
}

/**
 * Classify a full (shell-unwrapped) command. Deliberately conservative: an
 * unrecognised shape is reported by its tool name rather than guessed at.
 */
export function classifyCommand(command: string): CommandClass {
  const tokens = words(command)
  if (tokens.length === 0) return { kind: 'plumbing' }

  const tool = tokens[0].split('/').pop() ?? tokens[0]
  const rest = tokens.slice(1)

  if (PLUMBING.has(tool)) return { kind: 'plumbing' }

  // Test binaries, directly or via a runner (`npx vitest`, `pnpm dlx jest`).
  if (TEST_BINARIES.has(tool)) return { kind: 'intent', code: 'activity.testing' }
  if ((tool === 'npx' || tool === 'pnpm' || tool === 'yarn' || tool === 'bunx') && rest.length > 0) {
    const target = rest[0] === 'dlx' || rest[0] === 'exec' ? rest[1] ?? '' : rest[0]
    if (TEST_BINARIES.has(target)) return { kind: 'intent', code: 'activity.testing' }
    const viaScript = target === 'run' ? scriptIntent(rest[rest.indexOf('run') + 1] ?? '') : scriptIntent(target)
    if (viaScript) return { kind: 'intent', code: viaScript }
    if (target === 'tsc') return { kind: 'intent', code: 'activity.typechecking' }
  }

  if (tool === 'npm' || tool === 'yarn' || tool === 'pnpm' || tool === 'bun') {
    const verbIndex = rest.findIndex((token) => PM_VERBS.has(token))
    const verb = verbIndex === -1 ? '' : rest[verbIndex]
    if (verb === 'install' || verb === 'ci' || verb === 'i' || verb === 'add') {
      return { kind: 'intent', code: 'activity.installing' }
    }
    // `npm test` and `npm run <script>` both resolve through the script names.
    const script = verb === 'run' || verb === 'run-script'
      ? rest[verbIndex + 1] ?? ''
      : verb
    const code = scriptIntent(script)
    if (code) return { kind: 'intent', code }
    return { kind: 'named', tool }
  }

  if (tool === 'git') {
    const sub = rest.find((token) => GIT_SUBCOMMANDS.has(token)) ?? ''
    if (GIT_READONLY.has(sub)) return { kind: 'plumbing' }
    if (sub === 'commit' || sub === 'add' || sub === 'stage') return { kind: 'intent', code: 'activity.savingWork' }
    return { kind: 'named', tool }
  }

  if (tool === 'cargo' || tool === 'go' || tool === 'dotnet' || tool === 'mvn' || tool === 'gradle') {
    const sub = rest.find((token) => token === 'test' || token === 'build' || token === 'compile') ?? ''
    if (sub === 'test') return { kind: 'intent', code: 'activity.testing' }
    if (sub === 'build' || sub === 'compile') return { kind: 'intent', code: 'activity.building' }
    return { kind: 'named', tool }
  }

  if (tool === 'tsc') return { kind: 'intent', code: 'activity.typechecking' }
  if (tool === 'openspec') return { kind: 'intent', code: 'activity.checkingSpec' }

  return { kind: 'named', tool }
}
