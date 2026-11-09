// Runs the development desktop build (`tauri dev`) as "Specrails Dev": a
// separate identifier (single-instance never focuses the installed window), its
// own server and Vite ports, and a DEV-marked icon.
//
//   npm run dev:desktop                 your projects: the installed app's ~/.specrails
//   npm run dev:desktop -- --isolated   an empty environment in ~/.specrails-dev
//
// The shared mode refuses to start while the installed app is running: one
// server per data home (server/data-home-lock.ts enforces it as well).
// SPECRAILS_REGISTRY_HOME chooses another data home; the ports can be moved
// with SPECRAILS_DEV_SERVER_PORT and SPECRAILS_DEV_CLIENT_PORT.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEV_SERVER_PORT = 4300
export const DEV_CLIENT_PORT = 4301
const RELEASE_SERVER_PORT = 4200

function port(value, fallback, name) {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`${name} must be a TCP port, got "${value}"`)
  return parsed
}

/** Ports for the development app; neither may be the installed app's 4200. */
export function devDesktopPorts(env = process.env) {
  const server = port(env.SPECRAILS_DEV_SERVER_PORT, DEV_SERVER_PORT, 'SPECRAILS_DEV_SERVER_PORT')
  const client = port(env.SPECRAILS_DEV_CLIENT_PORT, DEV_CLIENT_PORT, 'SPECRAILS_DEV_CLIENT_PORT')
  if (server === client) throw new Error('SPECRAILS_DEV_CLIENT_PORT must differ from SPECRAILS_DEV_SERVER_PORT')
  if (server === RELEASE_SERVER_PORT || client === RELEASE_SERVER_PORT) throw new Error(`Port ${RELEASE_SERVER_PORT} belongs to the installed Specrails; choose another development port`)
  return { server, client }
}

/**
 * Which data home the development app uses. Without a flag it shares the
 * installed app's (the user's home, containing `.specrails/`); `--isolated`
 * uses ~/.specrails-dev. An explicit SPECRAILS_REGISTRY_HOME wins over both.
 */
export function devDesktopMode(argv, env = process.env, home = os.homedir()) {
  const isolated = argv.includes('--isolated')
  const args = argv.filter(arg => arg !== '--isolated')
  const explicit = env.SPECRAILS_REGISTRY_HOME?.trim()
  const dataHome = explicit || (isolated ? path.join(home, '.specrails-dev') : home)
  return { isolated, shared: path.resolve(dataHome) === path.resolve(home), dataHome, args }
}

/** Whether a Specrails server answers on the installed app's port. */
export async function installedAppRunning(port = RELEASE_SERVER_PORT) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    return response.ok && (await response.json())?.status === 'ok'
  } catch {
    return false
  }
}

/**
 * Resource globs whose folder is staged only for a release build (core/,
 * openspec/, runtimes/ by the assemble scripts in CI). Tauri fails `tauri dev`
 * when a glob matches nothing, so the overlay leaves out the unstaged ones.
 * binaries/ is kept: beforeDevCommand builds it after this config is read.
 */
export function stagedResources(resources, exists) {
  const kept = []
  const missing = []
  for (const resource of resources) {
    const base = resource.split('*')[0]
    const staged = resource.includes('*') && !base.startsWith('binaries/') && !base.startsWith('../')
    if (staged && !exists(base)) missing.push(resource)
    else kept.push(resource)
  }
  return { kept, missing }
}

/** The `tauri dev --config` overlay: a separate app with the development ports. */
export function devDesktopConfig(baseConfig, ports, exists = () => true) {
  const csp = baseConfig.app?.security?.csp
  if (typeof csp !== 'string' || !csp.includes(`:${RELEASE_SERVER_PORT}`)) throw new Error('tauri.conf.json CSP no longer names the server port; update scripts/dev-desktop.mjs')
  const resources = stagedResources(baseConfig.bundle.resources ?? [], exists)
  return {
    identifier: `${baseConfig.identifier}.dev`,
    productName: `${baseConfig.productName} Dev`,
    build: { devUrl: `http://localhost:${ports.client}` },
    bundle: {
      // Same icon with an amber DEV band (icons/icon-dev.svg), so the Dock and
      // taskbar tell the development app from the installed one.
      icon: baseConfig.bundle.icon.map(icon => icon.replace(/^icons\//, 'icons/dev/')),
      ...(resources.missing.length > 0 ? { resources: resources.kept } : {}),
    },
    app: { security: { csp: csp.replaceAll(`:${RELEASE_SERVER_PORT}`, `:${ports.server}`) } },
  }
}

/** A staged folder counts when it holds more than its .gitkeep placeholder. */
function stagedFolderExists(srcTauri, base) {
  try {
    return fs.readdirSync(path.join(srcTauri, base)).some(entry => entry !== '.gitkeep')
  } catch {
    return false
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const ports = devDesktopPorts()
  const mode = devDesktopMode(process.argv.slice(2))
  if (mode.shared && await installedAppRunning()) {
    throw new Error('The installed Specrails is running and uses the same projects and data. Quit it first (tray icon > Exit), or start an empty environment with `npm run dev:desktop -- --isolated`.')
  }
  const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const srcTauri = path.join(root, 'src-tauri')
  const overlay = devDesktopConfig(baseConfig, ports, base => stagedFolderExists(srcTauri, base))
  const skipped = stagedResources(baseConfig.bundle.resources ?? [], base => stagedFolderExists(srcTauri, base)).missing
  if (skipped.length > 0) console.log(`[dev-desktop] Not staged, left out of the dev bundle: ${skipped.join(', ')}`)
  const tauri = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
  const data = mode.shared ? 'your projects (shared with the installed app)' : `isolated data in ${mode.dataHome}`
  console.log(`[dev-desktop] ${overlay.productName}: server ${ports.server}, client ${ports.client}, ${data}`)
  const child = spawn(process.execPath, [tauri, 'dev', '--config', JSON.stringify(overlay), ...mode.args], {
    cwd: root,
    stdio: 'inherit',
    // Vite (beforeDevCommand) and the sidecar read these ports; the debug host
    // profile passes SPECRAILS_REGISTRY_HOME on to the sidecar.
    env: { ...process.env, SPECRAILS_DEV_SERVER_PORT: String(ports.server), SPECRAILS_DEV_CLIENT_PORT: String(ports.client), SPECRAILS_REGISTRY_HOME: mode.dataHome },
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(`[dev-desktop] ${error.message}`); process.exit(1) })
}
