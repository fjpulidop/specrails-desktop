/**
 * Merging the policy hook into a Claude settings object without touching
 * anything else in it.
 *
 * A hook entry is OURS when its command names the hook script
 * (`specrails-policy-hook`). Merge removes every entry of ours (from any event,
 * so an older install under another event is cleaned up) and appends the
 * current one; strip only removes ours. Every other key — the mission
 * connectors' `deniedMcpServers`, a project's own hooks, permissions — is kept
 * byte-for-byte in value. Pure.
 */

export const POLICY_HOOK_SCRIPT_NAME = 'specrails-policy-hook'
/** Seconds Claude waits for the hook before treating it as a non-blocking error (the tool then runs). */
export const POLICY_HOOK_TIMEOUT_SECONDS = 10

export type ClaudeSettings = Record<string, unknown>

interface HookCommand { type?: unknown; command?: unknown; [key: string]: unknown }
interface HookGroup { matcher?: unknown; hooks?: unknown; [key: string]: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPolicyHookCommand(command: unknown): boolean {
  return typeof command === 'string' && command.includes(POLICY_HOOK_SCRIPT_NAME)
}

/** The hook group this module owns, for a fully quoted command line. */
export function policyHookGroup(command: string): HookGroup {
  return { matcher: '*', hooks: [{ type: 'command', command, timeout: POLICY_HOOK_TIMEOUT_SECONDS }] }
}

/** Remove our hook entries; returns a new object (input untouched). */
export function stripPolicyHook(settings: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...settings }
  if (!isRecord(settings.hooks)) return next
  const hooks: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue }
    const kept: unknown[] = []
    for (const group of groups as unknown[]) {
      if (!isRecord(group) || !Array.isArray((group as HookGroup).hooks)) { kept.push(group); continue }
      const commands = ((group as HookGroup).hooks as unknown[]).filter((hook) => !(isRecord(hook) && isPolicyHookCommand((hook as HookCommand).command)))
      if (commands.length === ((group as HookGroup).hooks as unknown[]).length) kept.push(group)
      else if (commands.length > 0) kept.push({ ...group, hooks: commands })
    }
    if (kept.length > 0) hooks[event] = kept
  }
  if (Object.keys(hooks).length > 0) next.hooks = hooks
  else delete next.hooks
  return next
}

/** Install (or refresh) our PreToolUse hook; returns a new object. */
export function mergePolicyHook(settings: ClaudeSettings, command: string): ClaudeSettings {
  const next = stripPolicyHook(settings)
  const hooks = isRecord(next.hooks) ? { ...next.hooks } : {}
  const pre = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse as unknown[]] : []
  pre.push(policyHookGroup(command))
  hooks.PreToolUse = pre
  return { ...next, hooks }
}

/** True when `settings` carries our hook with exactly `command`. */
export function hasPolicyHook(settings: ClaudeSettings, command: string): boolean {
  if (!isRecord(settings.hooks) || !Array.isArray(settings.hooks.PreToolUse)) return false
  return (settings.hooks.PreToolUse as unknown[]).some((group) =>
    isRecord(group) && Array.isArray(group.hooks) && (group.hooks as unknown[]).some((hook) => isRecord(hook) && hook.command === command))
}

/** POSIX single-quote (or Windows double-quote) one argument for a hook command line. */
export function quoteHookArg(value: string, platform: string = process.platform): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The hook command line: `<node> <script> --specrails-home <dir>`. */
export function policyHookCommand(input: { node: string; script: string; specrailsHome: string; platform?: string }): string {
  const q = (value: string) => quoteHookArg(value, input.platform)
  return [q(input.node), q(input.script), '--specrails-home', q(input.specrailsHome)].join(' ')
}

/** True when `settings` carries any hook entry of ours (whatever its exact command). */
export function hasAnyPolicyHook(settings: ClaudeSettings): boolean {
  if (!isRecord(settings.hooks)) return false
  return Object.values(settings.hooks).some((groups) => Array.isArray(groups) && (groups as unknown[]).some((group) =>
    isRecord(group) && Array.isArray(group.hooks) && (group.hooks as unknown[]).some((hook) => isRecord(hook) && isPolicyHookCommand(hook.command))))
}
