/**
 * Tapflow effects on this machine: where the managed install lives, which Node runs it, the installer
 * terminal, and the supervised `tapflow start` service (loopback preload, SIGTERM stop).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  installerScript, nodeMajor, serviceEnvironment, tapflowConfig, TAPFLOW_MIN_NODE_MAJOR,
  type TapflowIssue,
} from '../domain'
import type { InstallerTerminal, TapflowInstallation, TapflowService } from '../application'
import { findAndroidSdk } from './android-toolchain'
import { TAPFLOW_PINNED_FILES } from './pinned'
import { resolveSpecrailsHome } from '../../../util/specrails-home'

/** `<SPECRAILS_REGISTRY_HOME or ~>/.specrails/tools/tapflow`, beside Headroom's tools. */
export function tapflowToolsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSpecrailsHome(env.SPECRAILS_REGISTRY_HOME || undefined), '.specrails', 'tools', 'tapflow')
}

export interface TapflowPaths {
  toolsDir: string
  home: string
  secretsDir: string
  preload: string
  tapflowCli: string
  serviceLog: string
}

export function tapflowPaths(toolsDir = tapflowToolsDir()): TapflowPaths {
  return {
    toolsDir,
    home: path.join(toolsDir, 'home'),
    secretsDir: path.join(toolsDir, 'secrets'),
    preload: path.join(toolsDir, 'specrails-loopback.cjs'),
    tapflowCli: path.join(toolsDir, 'node_modules', 'tapflow', 'bin', 'tapflow.js'),
    serviceLog: path.join(toolsDir, 'service.log'),
  }
}

/**
 * Preloaded into the Tapflow process only. Tapflow hard-codes `listen({ host: '::' })` (every interface,
 * and its relay trusts loopback without credentials); this keeps every wildcard listen on 127.0.0.1.
 * Drop it once Tapflow accepts a bind host.
 */
export const LOOPBACK_PRELOAD = `'use strict'
// Written by Specrails: keeps Tapflow's servers on loopback (Tapflow binds '::' with no option).
const net = require('node:net')
const listen = net.Server.prototype.listen
const LOOPBACK = '127.0.0.1'
const wide = (host) => host == null || host === '::' || host === '0.0.0.0' || host === ''
net.Server.prototype.listen = function (...args) {
  const first = args[0]
  if (first && typeof first === 'object' && !Array.isArray(first) && first.path == null && first.fd == null && first.handle == null && wide(first.host)) {
    const { ipv6Only, ...rest } = first
    args[0] = { ...rest, host: LOOPBACK }
  } else if (typeof first === 'number' && (typeof args[1] !== 'string' || wide(args[1]))) {
    args = [{ port: first, host: LOOPBACK }, ...args.slice(1).filter((arg) => typeof arg === 'function')]
  }
  return listen.apply(this, args)
}
`

function readVersion(file: string): string | null {
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }).version ?? null } catch { return null }
}

function onPath(name: string, envPath = process.env.PATH ?? ''): string | null {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch { /* next */ }
  }
  return null
}

/**
 * npm that ships with this Node: `<prefix>/lib/node_modules/npm`, where the prefix is the one of the path as
 * given (Homebrew: `/opt/homebrew/bin/node` → `/opt/homebrew/lib/node_modules/npm`, while the real binary
 * sits in `Cellar/` with no npm beside it) or of the resolved binary (official tarballs, nvm, the bundle).
 */
export function npmCliFor(nodePath: string): string | null {
  let real = nodePath
  try { real = fs.realpathSync(nodePath) } catch { /* keep as given */ }
  for (const binary of [nodePath, real]) {
    const cli = path.join(path.dirname(path.dirname(binary)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (fs.existsSync(cli)) return cli
  }
  return null
}

export function createInstallation(deps: { paths: TapflowPaths; bundledNode: () => string | null; home?: string }): TapflowInstallation {
  const { paths } = deps
  return {
    present: (version) =>
      readVersion(path.join(paths.toolsDir, 'node_modules', 'tapflow', 'package.json')) === version &&
      readVersion(path.join(paths.toolsDir, 'node_modules', '@tapflowio', 'mcp-server', 'package.json')) === version,
    externalPresent: () => onPath('tapflow') !== null || fs.existsSync(path.join(deps.home ?? os.homedir(), '.tapflow', 'tapflow.config.json')),
    resolveNode: () => {
      const candidates = [deps.bundledNode(), onPath('node')].filter((value): value is string => Boolean(value))
      for (const nodePath of candidates) {
        const out = spawnSync(nodePath, ['--version'], { encoding: 'utf8', timeout: 5_000 })
        const major = out.status === 0 ? nodeMajor(out.stdout) : null
        if (major !== null && major >= TAPFLOW_MIN_NODE_MAJOR && npmCliFor(nodePath)) return { nodePath }
      }
      const issue: TapflowIssue = { code: 'node-missing', detail: `Tapflow needs Node ${TAPFLOW_MIN_NODE_MAJOR} or later with npm; Specrails found none.` }
      return { issue }
    },
    remove: async () => { await fs.promises.rm(paths.toolsDir, { recursive: true, force: true }) },
  }
}

/** The installer terminal: a scope-less (`__app__`) PTY running the install script, then `tapflow setup`. */
export const APP_TERMINAL_SCOPE = '__app__'

export interface TerminalHost {
  create(scope: string, opts: { cwd: string; name?: string; cols?: number; rows?: number; command: { file: string; args: readonly string[]; env?: Record<string, string> }; onExit: (exit: { code: number | null; signal: number | null }) => void }): { id: string }
}

export function createInstallerTerminal(deps: { paths: TapflowPaths; terminals: () => TerminalHost }): InstallerTerminal {
  const { paths } = deps
  return {
    open: (nodePath, onExit) => {
      const npmCli = npmCliFor(nodePath)
      if (!npmCli) throw new Error(`No npm next to ${nodePath}`)
      fs.mkdirSync(paths.toolsDir, { recursive: true })
      // The pinned tree `npm ci` installs (replaces whatever manifest an older install left).
      for (const [name, content] of Object.entries(TAPFLOW_PINNED_FILES)) fs.writeFileSync(path.join(paths.toolsDir, name), JSON.stringify(content, null, 2) + '\n')
      const script = installerScript({ nodePath, npmCli, toolsDir: paths.toolsDir, tapflowCli: paths.tapflowCli, home: paths.home })
      const nodeBin = path.dirname(nodePath)
      const session = deps.terminals().create(APP_TERMINAL_SCOPE, {
        cwd: paths.toolsDir,
        name: 'Tapflow setup',
        cols: 100,
        rows: 30,
        // macOS only (the plugin refuses other platforms): zsh is always there and gives Tapflow's prompts a real TTY.
        command: { file: '/bin/zsh', args: ['-lc', script], env: { PATH: `${nodeBin}:${process.env.PATH ?? '/usr/bin:/bin'}` } },
        onExit: ({ code }) => onExit(code),
      })
      return { sessionId: session.id }
    },
  }
}

const STOP_GRACE_MS = 10_000

export function createTapflowService(deps: { paths: TapflowPaths; spawnImpl?: typeof spawn; stopGraceMs?: number }): TapflowService {
  const { paths } = deps
  const spawnImpl = deps.spawnImpl ?? spawn
  let child: ChildProcess | null = null
  let exited: Promise<void> | null = null

  return {
    start: ({ nodePath, port }, onExit) => {
      if (child) return
      fs.mkdirSync(paths.home, { recursive: true })
      fs.writeFileSync(paths.preload, LOOPBACK_PRELOAD)
      fs.writeFileSync(path.join(paths.home, 'tapflow.config.json'), JSON.stringify(tapflowConfig(port), null, 2) + '\n')
      const log = fs.openSync(paths.serviceLog, 'w')
      const base = { ...process.env }
      delete base.NODE_OPTIONS
      const androidSdk = findAndroidSdk()
      const env = { ...base, ...serviceEnvironment({ home: paths.home, port, preloadPath: paths.preload, nodeBinDir: path.dirname(nodePath), basePath: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin', androidSdk }) }
      const proc = spawnImpl(nodePath, [paths.tapflowCli, 'start'], { cwd: paths.home, env, stdio: ['ignore', log, log] })
      fs.closeSync(log)
      child = proc
      exited = new Promise((resolve) => {
        proc.once('exit', (code, signal) => {
          if (child === proc) child = null
          onExit(signal ? `Tapflow stopped (${signal}).` : `Tapflow exited with code ${code}. See ${paths.serviceLog}.`)
          resolve()
        })
        proc.once('error', (err) => {
          if (child === proc) child = null
          onExit(`Tapflow could not start: ${err.message}`)
          resolve()
        })
      })
    },
    stop: async () => {
      const proc = child
      if (!proc || !exited) return
      // SIGTERM lets Tapflow disconnect its agents and end their XCUITest runners; SIGKILL would orphan
      // them (~650 MB each), so it is only the last resort after the grace period.
      proc.kill('SIGTERM')
      const done = exited
      const killed = await Promise.race([done.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), deps.stopGraceMs ?? STOP_GRACE_MS))])
      if (killed) { proc.kill('SIGKILL'); await done }
    },
    state: () => (child ? 'alive' : 'none'),
    pid: () => child?.pid ?? null,
  }
}
