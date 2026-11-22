// The ISOLATED Specrails instance an eval run drives: its own data home and
// port, headless, the scripted engine and the fake installers first on PATH,
// and the MCP v2 flag on (or off for the v1 baseline). Reuses the benchmark's
// server lifecycle (it signals only a listener started with this home).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, stopServer, ownedListener, listenerPid } from '../../../scripts/benchmark/lib/server.mjs'
import { createApi } from '../../../scripts/benchmark/lib/api.mjs'

export const EVAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DESKTOP_DIR = path.resolve(EVAL_DIR, '..', '..')
export const ENGINE_DIR = path.join(EVAL_DIR, 'engine')
export const FAKE_INSTALLERS = path.join(DESKTOP_DIR, 'scripts', 'benchmark', 'fake-installers')

/** Core under test: explicit option, else the sibling checkout the dev server would use (pure). */
export function coreSelection({ coreDir } = {}, exists = fs.existsSync) {
  const candidates = [coreDir, process.env.SPECRAILS_CORE_SOURCE_DIR, path.resolve(DESKTOP_DIR, '..', '..', 'specrails-core'), path.resolve(DESKTOP_DIR, '..', 'specrails-core')].filter(Boolean)
  const dir = candidates.find(d => exists(path.join(d, 'dist', 'agent-runtime', 'index.js')))
  return dir ? { dir, runtime: path.join(dir, 'dist', 'agent-runtime', 'index.js'), bin: path.join(dir, 'bin', 'specrails-core.mjs') } : null
}

/** Environment overrides of the isolated server (pure). */
export function instanceEnv({ v2 = true, core, engineLog, engineMode, installedDir }) {
  return {
    SPECRAILS_MCP_V2: v2 ? 'true' : 'false',
    SPECRAILS_HEADLESS: '1',
    ...(core ? { SPECRAILS_CORE_RUNTIME_PATH: core.runtime, SPECRAILS_CORE_BIN: core.bin } : {}),
    ...(engineLog ? { EVAL_ENGINE_LOG: engineLog } : {}),
    ...(engineMode ? { EVAL_ENGINE_MODE: engineMode } : {}),
    ...(installedDir ? { BENCH_INSTALLED_DIR: installedDir } : {}),
  }
}

/**
 * Boot the instance. Returns `{ api, port, home, pid, readyMs, stop() }`.
 * `fresh` wipes the isolated home first (only a harness-owned directory).
 */
export async function bootInstance({ home, port, clientPort, workDir, v2 = true, coreDir, engineMode, fresh = false, log = () => {} }) {
  if (fresh && fs.existsSync(home)) {
    if (listenerPid(port)) throw new Error(`Port ${port} is busy; stop that instance before a fresh boot`)
    if (!fs.existsSync(path.join(home, '.eval-mcp-home'))) throw new Error(`Refusing to wipe ${home}: it was not created by the eval harness`)
    fs.rmSync(home, { recursive: true, force: true })
  }
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, '.eval-mcp-home'), 'Created by eval/mcp. Safe to delete.\n')
  const logs = path.join(workDir, 'logs')
  fs.mkdirSync(logs, { recursive: true })
  const installedDir = path.join(workDir, 'installed')
  fs.mkdirSync(installedDir, { recursive: true })
  const core = coreSelection({ coreDir })
  if (!core) log('warning: no built specrails-core found; runs will fail to start (pass --core-dir)')
  const engineLog = path.join(logs, 'engine.jsonl')
  const opts = {
    desktopDir: DESKTOP_DIR, home, port, clientPort,
    logFile: path.join(logs, 'server.log'),
    pathPrepend: [ENGINE_DIR, FAKE_INSTALLERS, installedDir].join(path.delimiter),
    extraEnv: instanceEnv({ v2, core, engineLog, engineMode, installedDir }),
  }
  const existing = ownedListener(port, home)
  let pid = existing
  let readyMs = 0
  if (!existing) ({ pid, readyMs } = await startServer(opts))
  else log(`reusing the instance already serving ${home} on ${port}`)
  const api = createApi(port)
  const flag = await api.get('/mcp-admin/status').catch(() => null)
  log(`instance up on ${port} (pid ${pid}, ${readyMs} ms, mcp ${flag?.data?.enabled === false ? 'off' : 'on'})`)
  return {
    api, port, home, pid, readyMs, engineLog, core, reused: Boolean(existing),
    mcpToken: () => fs.readFileSync(path.join(home, '.specrails', 'mcp.token'), 'utf8').trim(),
    stop: () => stopServer({ port, home, graceful: true }),
  }
}
