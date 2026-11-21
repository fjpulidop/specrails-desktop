/**
 * Installing the policy hook: the script file under
 * `<specrails home>/.specrails/agent-policy/` and its entry in a Specrails-owned
 * directory's `.claude/settings.local.json` (Claude runs launch with
 * `--setting-sources project,local`, so that file is read for every run).
 *
 * Only ever called for directories Specrails owns: the app-owned mission cwd
 * and isolated run worktrees (through the worktree overlay). Never a person's
 * own checkout. Effectful; every entry point is best-effort and never throws.
 */
import fs from 'fs'
import path from 'path'
import { resolveBundledNodeExe } from '../../../path-resolver'
import { resolveSpecrailsHome } from '../../../util/specrails-home'
import { isAgentPolicyHookEnabled } from '../../../feature-flags'
import { POLICY_HOOK_SOURCE, POLICY_HOOK_VERSION } from '../hook/policy-hook-bundle.generated'
import {
  mergePolicyHook, policyHookCommand, stripPolicyHook, POLICY_HOOK_SCRIPT_NAME, type ClaudeSettings,
} from '../domain/settings'

/** Keep superseded scripts this long: runs started before an update still reference them. */
const OLD_SCRIPT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

export function policyHookDir(specrailsHome: string = resolveSpecrailsHome()): string {
  return path.join(specrailsHome, '.specrails', 'agent-policy')
}

/** The hook is POSIX-only (its rules reason about `/` paths and sh syntax). */
export function policyHookSupported(platform: string = process.platform): boolean {
  return platform !== 'win32'
}

function writeAtomic(file: string, body: string, mode: number): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, body, { mode })
  fs.renameSync(tmp, file)
}

/**
 * Write the current hook script if missing or different; prune superseded
 * versions older than two weeks. Returns its path, or null when it cannot be
 * written.
 */
export function ensurePolicyHookScript(specrailsHome: string = resolveSpecrailsHome()): string | null {
  try {
    const dir = policyHookDir(specrailsHome)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `${POLICY_HOOK_SCRIPT_NAME}-${POLICY_HOOK_VERSION}.cjs`)
    let current: string | null = null
    try { current = fs.readFileSync(file, 'utf8') } catch { /* absent */ }
    if (current !== POLICY_HOOK_SOURCE) writeAtomic(file, POLICY_HOOK_SOURCE, 0o600)
    const now = Date.now()
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${POLICY_HOOK_SCRIPT_NAME}-`) || path.join(dir, name) === file) continue
      try {
        if (now - fs.statSync(path.join(dir, name)).mtimeMs > OLD_SCRIPT_RETENTION_MS) fs.unlinkSync(path.join(dir, name))
      } catch { /* best-effort */ }
    }
    return file
  } catch (error) {
    console.warn(`[agent-policy] could not write the policy hook: ${(error as Error).message}`)
    return null
  }
}

/** The command line Claude runs, or null when the hook is off/unsupported/unwritable. */
export function currentPolicyHookCommand(specrailsHome: string = resolveSpecrailsHome()): string | null {
  if (!isAgentPolicyHookEnabled() || !policyHookSupported()) return null
  const script = ensurePolicyHookScript(specrailsHome)
  if (!script) return null
  return policyHookCommand({ node: resolveBundledNodeExe() ?? 'node', script, specrailsHome })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read-modify-write `<dir>/.claude/settings.local.json`, keeping every key
 * `mutate` does not change. An empty result removes the file. A symlinked file
 * is replaced, never written through. Synchronous on purpose: mission turns
 * call it right before their spawn. Throws on IO failure (callers decide).
 */
export function updateClaudeLocalSettings(dir: string, mutate: (current: ClaudeSettings) => ClaudeSettings): void {
  const claudeDir = path.join(dir, '.claude')
  const file = path.join(claudeDir, 'settings.local.json')
  let current: ClaudeSettings = {}
  let raw: string | null = null
  let isLink = false
  try { isLink = fs.lstatSync(file).isSymbolicLink() } catch { /* absent */ }
  try { raw = fs.readFileSync(file, 'utf-8') } catch { /* absent */ }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isRecord(parsed)) current = parsed
    } catch { /* unreadable: replaced below */ }
  }
  const next = mutate(current)
  if (Object.keys(next).length === 0) {
    if (raw !== null || isLink) { try { fs.unlinkSync(file) } catch { /* absent */ } }
    return
  }
  const body = `${JSON.stringify(next, null, 2)}\n`
  if (body === raw && !isLink) return
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 })
  if (isLink) fs.unlinkSync(file)
  writeAtomic(file, body, 0o600)
}

/**
 * Install (or remove, when the hook is off) the policy hook in an app-owned
 * directory's local settings. Never throws; returns whether it is installed.
 */
export function installPolicyHookIn(dir: string, specrailsHome: string = resolveSpecrailsHome()): boolean {
  try {
    const command = currentPolicyHookCommand(specrailsHome)
    updateClaudeLocalSettings(dir, (settings) => (command ? mergePolicyHook(settings, command) : stripPolicyHook(settings)))
    return command !== null
  } catch (error) {
    console.warn(`[agent-policy] policy hook not installed in ${dir}: ${(error as Error).message}`)
    return false
  }
}
