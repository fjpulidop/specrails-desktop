// Real agent clients, headless, each in a fresh TEMP home (never the person's
// ~/.claude or ~/.codex): Claude Code (`claude -p --mcp-config`) and Codex
// (`codex exec --json` with a temp CODEX_HOME). Builders and parsers are pure;
// `runTurn` spawns the client.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertClientHome, clientEnv, CREDENTIAL_KEYS } from './isolation.mjs'

export const CLIENTS = Object.freeze(['claude', 'codex', 'replay'])
/** Claude runs on haiku by default; Codex on its own configured default unless --model is given. */
export const DEFAULT_MODELS = Object.freeze({ claude: 'haiku', codex: null })

const tomlString = s => JSON.stringify(String(s))

/** Write the client's temp home and MCP registration; returns `{ home, cwd, configFile }`. */
export function prepareClientHome({ client, dir, root, proxy }) {
  const home = assertClientHome(dir, root)
  const cwd = path.join(home, 'work')
  fs.mkdirSync(cwd, { recursive: true })
  if (client === 'claude') {
    const configFile = path.join(home, 'mcp.json')
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { specrails: { command: proxy.command, args: proxy.args } } }, null, 2))
    return { home, cwd, configFile }
  }
  const codexHome = path.join(home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  const configFile = path.join(codexHome, 'config.toml')
  fs.writeFileSync(configFile, codexConfig(proxy))
  return { home, cwd, configFile, codexHome }
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

/** argv of one turn (pure). `session` resumes the conversation. */
export function clientArgs({ client, model, prompt, session, configFile, maxTurns = 40 }) {
  if (client === 'claude') return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model,
    '--mcp-config', configFile, '--strict-mcp-config', '--setting-sources', 'project,local',
    '--tools', 'ToolSearch', '--allowedTools', 'mcp__specrails,ToolSearch', '--permission-mode', 'dontAsk',
    '--max-turns', String(maxTurns), ...(session ? ['--resume', session] : [])]
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

/** Sum two turns' client usage (pure). */
export function addUsage(a, b) {
  const sum = (x, y) => x === null && y === null ? null : (x ?? 0) + (y ?? 0)
  return {
    input: sum(a.input, b.input), output: sum(a.output, b.output), cacheRead: sum(a.cacheRead, b.cacheRead), cacheWrite: sum(a.cacheWrite, b.cacheWrite),
    costUsd: sum(a.costUsd ?? null, b.costUsd ?? null),
  }
}

/** Run one turn; resolves `{ code, stdout, stderr, ms, parsed }`. Never shows a window. */
export function runTurn({ client, binary, model, prompt, session, prepared, timeoutMs = 600_000, credentials = CREDENTIAL_KEYS }) {
  const env = clientEnv(process.env, { home: prepared.home, pass: credentials })
  if (client === 'codex') env.CODEX_HOME = prepared.codexHome
  const args = clientArgs({ client, model, prompt, session, configFile: prepared.configFile })
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
