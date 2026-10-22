// Agent process environment policy (pure). Decides which variables of the
// Desktop server environment reach an agent process. `inherit` keeps today's
// behavior; `minimal` forwards only an allowlist, the project's passthrough
// names, Specrails' own variables and the provider's declared auth/config
// names. Values are never logged or persisted by this module.

export type AgentEnvMode = 'inherit' | 'minimal'

/** Names every agent process needs to start, find tools, reach a proxy and
 *  format text. `*` at the end of an entry matches a name prefix. */
export const AGENT_ENV_BASE_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'LC_*',
  'TMPDIR', 'TMP', 'TEMP',
  'TERM', 'COLORTERM', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]

/** Windows names without which `cmd.exe`, npm/npx and most CLIs fail. Matched
 *  case-insensitively on Windows; absent elsewhere. `windowsSpawnEnv` still
 *  backfills the canonical values at spawn time. */
export const AGENT_ENV_WINDOWS_ALLOWLIST: readonly string[] = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'OS', 'COMPUTERNAME',
]

/** Specrails' own control-plane and bundled-runtime variables. */
export const AGENT_ENV_SPECRAILS_ALLOWLIST: readonly string[] = ['SPECRAILS_*']

export interface AgentEnvInput {
  mode: AgentEnvMode
  /** The environment the agent would inherit today (normally process.env). */
  sourceEnv: NodeJS.ProcessEnv
  /** Resolved project passthrough values (names configured by the user). */
  passthrough: NodeJS.ProcessEnv
  /** Provider auth/config names (patterns) declared by the adapters involved. */
  providerAllowlist?: readonly string[]
  /** Defaults to the current platform; Windows matches names case-insensitively. */
  platform?: NodeJS.Platform
}

/** True when `name` matches `pattern` (`FOO` exact, `FOO_*` prefix). */
export function matchesEnvPattern(name: string, pattern: string, caseInsensitive = false): boolean {
  const n = caseInsensitive ? name.toUpperCase() : name
  const p = caseInsensitive ? pattern.toUpperCase() : pattern
  return p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p
}

/** Every allowlist pattern that applies to one spawn, in a stable order. */
export function agentEnvAllowlist(providerAllowlist: readonly string[] = []): string[] {
  return [...new Set([
    ...AGENT_ENV_BASE_ALLOWLIST,
    ...AGENT_ENV_WINDOWS_ALLOWLIST,
    ...AGENT_ENV_SPECRAILS_ALLOWLIST,
    ...providerAllowlist,
  ])]
}

/** Names of `sourceEnv` (plus passthrough names) the minimal mode would pass. */
export function minimalAgentEnvNames(input: Omit<AgentEnvInput, 'mode'>): string[] {
  const caseInsensitive = (input.platform ?? process.platform) === 'win32'
  const patterns = agentEnvAllowlist(input.providerAllowlist)
  const names = new Set<string>()
  for (const [name, value] of Object.entries(input.sourceEnv)) {
    if (value === undefined) continue
    if (patterns.some(pattern => matchesEnvPattern(name, pattern, caseInsensitive))) names.add(name)
  }
  for (const [name, value] of Object.entries(input.passthrough)) {
    if (value !== undefined) names.add(name)
  }
  return [...names].sort()
}

/**
 * Build the base environment of an agent process. Specrails' per-spawn
 * overlays (telemetry, profile, repo map, relocation, provider overrides) are
 * applied by callers on top of this result.
 *
 * - `inherit`: byte-identical to today: the source, with the passthrough overlay
 *   only when it carries values (same object when it does not).
 * - `minimal`: a fresh object with allowlisted names from the source, then the
 *   passthrough values.
 */
export function buildAgentEnv(input: AgentEnvInput): NodeJS.ProcessEnv {
  if (input.mode !== 'minimal') {
    return Object.keys(input.passthrough).length === 0
      ? input.sourceEnv
      : { ...input.sourceEnv, ...input.passthrough }
  }
  const allowed = new Set(minimalAgentEnvNames(input))
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(input.sourceEnv)) {
    if (value !== undefined && allowed.has(name)) out[name] = value
  }
  for (const [name, value] of Object.entries(input.passthrough)) {
    if (value !== undefined) out[name] = value
  }
  return out
}
