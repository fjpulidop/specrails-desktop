// Real agent clients, headless: Claude Code (`claude -p --mcp-config`) and Codex
// (`codex exec --json`). Two auth modes:
//   temp     (default) a fresh TEMP home per scenario, never the person's ~/.claude or ~/.codex;
//            a credential must come through the environment.
//   session  the person's own sign-in, with NO change to their configuration: Claude gets the real
//            HOME (its login lives in the keychain) but only the eval server (`--strict-mcp-config`),
//            no user settings (`--setting-sources project,local`) and a temp cwd; Codex reads auth from
//            the real CODEX_HOME but ignores its config.toml and rules (`--ignore-user-config
//            --ignore-rules`) and receives the eval server and every other setting through `-c` only.
// Builders and parsers are pure; `runTurn` spawns the client.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertClientHome, clientEnv, CREDENTIAL_KEYS } from './isolation.mjs'

export const CLIENTS = Object.freeze(['claude', 'codex', 'replay'])
/** Claude runs on haiku by default; Codex on its own configured default unless --model is given. */
export const DEFAULT_MODELS = Object.freeze({ claude: 'haiku', codex: null })
export const AUTH_MODES = Object.freeze(['temp', 'session'])
/**
 * Codex features turned off in session mode, so the run sees only the eval server and Codex's own
 * shell (as in temp mode): no ChatGPT apps connector, plugins, hooks, sub-agents, browser/computer use.
 */
export const CODEX_SESSION_DISABLED_FEATURES = Object.freeze(['apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'image_generation',
  'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'tool_suggest', 'skill_mcp_dependency_install', 'shell_snapshot', 'goals'])

const tomlString = s => JSON.stringify(String(s))

/**
 * Write the client's temp home and MCP registration; returns `{ home, cwd, configFile, auth }`.
 * In session mode only the cwd (and Claude's MCP config file) are created, inside the work dir; HOME is the person's.
 */
export function prepareClientHome({ client, dir, root, proxy, auth = 'temp', effort = 'low', userHome = os.homedir() }) {
  if (auth === 'session') {
    const scratch = assertClientHome(dir, root)
    const cwd = path.join(scratch, 'work')
    fs.mkdirSync(cwd, { recursive: true })
    if (client === 'claude') {
      const configFile = path.join(scratch, 'mcp.json')
      fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { specrails: { command: proxy.command, args: proxy.args } } }, null, 2))
      return { home: userHome, cwd, configFile, auth }
    }
    return { home: userHome, cwd, configFile: null, codexHome: path.join(userHome, '.codex'), codexOverrides: codexSessionOverrides(proxy, { effort }), auth }
  }
  const home = assertClientHome(dir, root)
  const cwd = path.join(home, 'work')
  fs.mkdirSync(cwd, { recursive: true })
  if (client === 'claude') {
    const configFile = path.join(home, 'mcp.json')
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { specrails: { command: proxy.command, args: proxy.args } } }, null, 2))
    return { home, cwd, configFile, auth }
  }
  const codexHome = path.join(home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  const configFile = path.join(codexHome, 'config.toml')
  fs.writeFileSync(configFile, codexConfig(proxy))
  return { home, cwd, configFile, codexHome, auth }
}

/** The temp CODEX_HOME config.toml: only the Specrails server (pure). */
export function codexConfig(proxy) {
  return [
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[mcp_servers.specrails]',
    `command = ${tomlString(proxy.command)}`,
    `args = [${proxy.args.map(tomlString).join(', ')}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 90',
    'default_tools_approval_mode = "approve"',
    '',
  ].join('\n')
}

/**
 * `-c` overrides that give a session-mode Codex the eval server and nothing else (pure): the real
 * config.toml is ignored (`--ignore-user-config`), so these are the whole configuration of the run.
 */
export function codexSessionOverrides(proxy, { effort = 'low' } = {}) {
  const c = [
    'approval_policy="never"', 'sandbox_mode="read-only"',
    `mcp_servers.specrails.command=${tomlString(proxy.command)}`,
    `mcp_servers.specrails.args=[${proxy.args.map(tomlString).join(', ')}]`,
    'mcp_servers.specrails.startup_timeout_sec=30', 'mcp_servers.specrails.tool_timeout_sec=90',
    'mcp_servers.specrails.default_tools_approval_mode="approve"',
    ...(effort ? [`model_reasoning_effort=${tomlString(effort)}`] : []),
  ]
  return [...c.flatMap(v => ['-c', v]), ...CODEX_SESSION_DISABLED_FEATURES.flatMap(f => ['--disable', f])]
}

/** argv of one turn (pure). `session` resumes the conversation. */
export function clientArgs({ client, model, prompt, session, configFile, maxTurns = 40, auth = 'temp', codexOverrides = null, budgetUsd = null }) {
  if (client === 'claude') return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model,
    '--mcp-config', configFile, '--strict-mcp-config', '--setting-sources', 'project,local',
    '--tools', 'ToolSearch', '--allowedTools', 'mcp__specrails,ToolSearch', '--permission-mode', 'dontAsk',
    '--max-turns', String(maxTurns), ...(budgetUsd ? ['--max-budget-usd', String(budgetUsd)] : []), ...(session ? ['--resume', session] : [])]
  if (auth === 'session') {
    if (!codexOverrides) throw new Error('session-mode Codex needs its -c overrides')
    const common = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', ...(model ? ['-m', model] : []), ...codexOverrides]
    return session ? ['exec', 'resume', ...common, session, prompt] : ['exec', ...common, prompt]
  }
  const common = ['--json', '--skip-git-repo-check', ...(model ? ['-m', model] : []), '-c', 'approval_policy="never"']
  return session ? ['exec', 'resume', ...common, session, prompt] : ['exec', ...common, '--sandbox', 'read-only', prompt]
}

/**
 * Parse a turn's stdout (pure): `{ session, text, tokens: { input, output, cacheRead, cacheWrite }, costUsd, turns, isError, toolUses }`.
 */
export function parseClientOutput(client, stdout) {
  const out = { session: null, text: '', tokens: { input: null, output: null, cacheRead: null, cacheWrite: null }, costUsd: null, turns: null, isError: false, toolUses: 0, error: null }
  for (const line of String(stdout ?? '').split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (client === 'claude') {
      if (e.type === 'system' && e.session_id) out.session = e.session_id
      if (e.type === 'assistant') for (const c of e.message?.content ?? []) { if (c.type === 'tool_use') out.toolUses++; if (c.type === 'text') out.text = c.text }
      if (e.type === 'result') {
        out.session = e.session_id ?? out.session
        out.text = typeof e.result === 'string' && e.result ? e.result : out.text
        out.isError = Boolean(e.is_error)
        if (e.is_error) out.error = String(e.result ?? e.subtype ?? 'error').slice(0, 300)
        out.costUsd = Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : null
        out.turns = e.num_turns ?? null
        const u = e.usage ?? {}
        out.tokens = { input: u.input_tokens ?? null, output: u.output_tokens ?? null, cacheRead: u.cache_read_input_tokens ?? null, cacheWrite: u.cache_creation_input_tokens ?? null }
      }
    } else {
      if (e.type === 'thread.started') out.session = e.thread_id
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') out.text = e.item.text ?? out.text
      if (e.type === 'item.completed' && e.item?.type === 'mcp_tool_call') out.toolUses++
      if (e.type === 'turn.completed') {
        const u = e.usage ?? {}
        const add = (a, b) => b === undefined || b === null ? a : (a ?? 0) + b
        out.tokens = { input: add(out.tokens.input, u.input_tokens), output: add(out.tokens.output, u.output_tokens), cacheRead: add(out.tokens.cacheRead, u.cached_input_tokens), cacheWrite: null }
        out.turns = (out.turns ?? 0) + 1
      }
      if (e.type === 'turn.failed' || e.type === 'error') { out.isError = true; out.error = String(e.error?.message ?? e.message ?? 'error').slice(0, 300) }
    }
  }
  return out
}

/**
 * Fold one more turn into a conversation's usage (pure). Claude reports each `-p` turn on its own, so turns add up.
 * Codex's `turn.completed` carries the THREAD's running total (a resumed turn includes the earlier ones, as its
 * rollout's token_count shows), so the latest turn replaces the sum.
 */
export function mergeUsage(client, a, b) {
  if (client !== 'codex') return addUsage(a, b)
  const later = (x, y) => y === null || y === undefined ? x : x === null || x === undefined ? y : Math.max(x, y)
  return { input: later(a.input, b.input), output: later(a.output, b.output), cacheRead: later(a.cacheRead, b.cacheRead), cacheWrite: later(a.cacheWrite, b.cacheWrite), costUsd: later(a.costUsd ?? null, b.costUsd ?? null) }
}

/** Sum two turns' client usage (pure). */
export function addUsage(a, b) {
  const sum = (x, y) => x === null && y === null ? null : (x ?? 0) + (y ?? 0)
  return {
    input: sum(a.input, b.input), output: sum(a.output, b.output), cacheRead: sum(a.cacheRead, b.cacheRead), cacheWrite: sum(a.cacheWrite, b.cacheWrite),
    costUsd: sum(a.costUsd ?? null, b.costUsd ?? null),
  }
}

/** Run one turn; resolves `{ code, stdout, stderr, ms, parsed }`. Never shows a window. */
export function runTurn({ client, binary, model, prompt, session, prepared, timeoutMs = 600_000, credentials = CREDENTIAL_KEYS, budgetUsd = null }) {
  // Session mode signs in with the person's own login: never forward credentials from the harness's environment.
  const env = clientEnv(process.env, { home: prepared.home, pass: prepared.auth === 'session' ? [] : credentials })
  if (client === 'codex') env.CODEX_HOME = prepared.codexHome
  const args = clientArgs({ client, model, prompt, session, configFile: prepared.configFile, auth: prepared.auth, codexOverrides: prepared.codexOverrides, budgetUsd })
  return new Promise(resolve => {
    const t0 = Date.now()
    const child = spawn(binary ?? client, args, { cwd: prepared.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr: stderr.slice(-4000), ms: Date.now() - t0, parsed: parseClientOutput(client, stdout) }) })
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error), ms: Date.now() - t0, parsed: parseClientOutput(client, stdout) }) })
  })
}

/** "Not logged in" and friends: the temp home has no credential (pure). */
export function authProblem(turn) {
  const text = `${turn.parsed?.error ?? ''}\n${turn.parsed?.text ?? ''}\n${turn.stderr ?? ''}`
  return /not logged in|please run \/login|invalid api key|401|unauthori[sz]ed|login required|codex login|OPENAI_API_KEY/i.test(text) ? text.trim().slice(0, 200) : null
}
