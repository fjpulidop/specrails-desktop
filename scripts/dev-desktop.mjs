// Runs the development desktop build (`tauri dev`) as its own app, next to an
// installed Specrails. It gets a separate identifier (so single-instance never
// focuses the installed window), its own server and Vite ports, and, through
// the debug host profile in src-tauri/src/host_profile.rs, its own data home
// (~/.specrails-dev unless SPECRAILS_REGISTRY_HOME is set).
//
//   npm run dev:desktop
//   SPECRAILS_DEV_SERVER_PORT=4400 SPECRAILS_DEV_CLIENT_PORT=4401 npm run dev:desktop
import { spawn } from 'node:child_process'
import fs from 'node:fs'
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

/** The `tauri dev --config` overlay: a separate app with the development ports. */
export function devDesktopConfig(baseConfig, ports) {
  const csp = baseConfig.app?.security?.csp
  if (typeof csp !== 'string' || !csp.includes(`:${RELEASE_SERVER_PORT}`)) throw new Error('tauri.conf.json CSP no longer names the server port; update scripts/dev-desktop.mjs')
  return {
    identifier: `${baseConfig.identifier}.dev`,
    productName: `${baseConfig.productName} Dev`,
    build: { devUrl: `http://localhost:${ports.client}` },
    // Same icon with an amber DEV band (icons/icon-dev.svg), so the Dock and
    // taskbar tell the development app from the installed one.
    bundle: { icon: baseConfig.bundle.icon.map(icon => icon.replace(/^icons\//, 'icons/dev/')) },
    app: { security: { csp: csp.replaceAll(`:${RELEASE_SERVER_PORT}`, `:${ports.server}`) } },
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const ports = devDesktopPorts()
  const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const overlay = devDesktopConfig(baseConfig, ports)
  const tauri = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
  console.log(`[dev-desktop] ${overlay.productName}: server ${ports.server}, client ${ports.client}`)
  const child = spawn(process.execPath, [tauri, 'dev', '--config', JSON.stringify(overlay), ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    // Vite (beforeDevCommand) and the sidecar read these ports.
    env: { ...process.env, SPECRAILS_DEV_SERVER_PORT: String(ports.server), SPECRAILS_DEV_CLIENT_PORT: String(ports.client) },
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(`[dev-desktop] ${error.message}`); process.exit(1) })
}
