export const FEATURE_CHAT_ENABLED = false

export const FEATURE_TERMINAL_PANEL = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const override = env?.VITE_FEATURE_TERMINAL_PANEL
  // Default ON. Opt-out by setting VITE_FEATURE_TERMINAL_PANEL=false.
  if (typeof override === 'string') return override !== 'false'
  return true
})()

/** Gates the Agents section (sidebar entry + /agents route). Default ON. */
export const FEATURE_AGENTS_SECTION = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const override = env?.VITE_FEATURE_AGENTS_SECTION
  if (typeof override === 'string') return override !== 'false'
  return true
})()

export const FEATURE_CODE_EXPLORER = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const override = env?.VITE_FEATURE_CODE_EXPLORER
  if (typeof override === 'string') return override !== 'false'
  return true
})()

/** Gates the Jira integration UI (settings section + spec badges). Default ON. */
export const FEATURE_JIRA = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const override = env?.VITE_FEATURE_JIRA
  if (typeof override === 'string') return override !== 'false'
  return true
})()

/** Gates the MCP onboarding UI (Settings ▸ MCP panel + welcome hint). Default ON.
 *  The server still gates the actual MCP server behind the persisted `mcp_enabled`
 *  setting, so this flag only hides the explainer/toggle UI. */
export const FEATURE_MCP = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const override = env?.VITE_FEATURE_MCP
  if (typeof override === 'string') return override !== 'false'
  return true
})()

/** Gates the global Agent Chat (floating Bot trigger + Cmd/Ctrl+K panel that
 *  operates the whole app via the Specrails MCP). Default ON; mirrors server
 *  SPECRAILS_AGENT_CHAT. Opt-out by setting VITE_FEATURE_AGENT_CHAT=false. */
export const FEATURE_AGENT_CHAT = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const override = env?.VITE_FEATURE_AGENT_CHAT
  if (typeof override === 'string') return override !== 'false'
  return true
})()

/** Gates the full-screen Agent Mode (persisted uiMode: kanban|agent). When off,
 *  uiMode is pinned to 'kanban' and Kanban stays byte-identical. Default ON;
 *  kill path = VITE_FEATURE_AGENT_MODE=false. Requires FEATURE_AGENT_CHAT —
 *  Agent Mode rides the same conversation machinery (agent_* WS events), so
 *  killing agent chat also pins uiMode to 'kanban'. */
export const FEATURE_AGENT_MODE = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const override = env?.VITE_FEATURE_AGENT_MODE
  const own = typeof override === 'string' ? override !== 'false' : true
  return FEATURE_AGENT_CHAT && own
})()

/** Gates interactive freestyle jobs UI (rail "Interactive" toggle + in-job chat
 *  + Finalize button). Default ON; mirrors server SPECRAILS_INTERACTIVE_JOBS. */
export const FEATURE_INTERACTIVE_JOBS = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const override = env?.VITE_FEATURE_INTERACTIVE_JOBS
  if (typeof override === 'string') return override !== 'false'
  return true
})()

/** Gates the global Loops section (sidebar entry above the project list + the
 *  /loops route + the rail "loop" mode). Default ON; mirrors server
 *  SPECRAILS_LOOPS_SECTION. Opt-out by setting VITE_FEATURE_LOOPS_SECTION=false. */
export const FEATURE_LOOPS_SECTION = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const override = env?.VITE_FEATURE_LOOPS_SECTION
  if (typeof override === 'string') return override !== 'false'
  return true
})()
