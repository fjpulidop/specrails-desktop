/** Exercise the installed pkg sidecar and resources, with an isolated Windows profile. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { WebSocket } from 'ws'

if (process.platform !== 'win32') throw new Error('This smoke must execute on Windows')
const install = path.resolve(process.argv[2] ?? '')
assert.ok(fs.existsSync(path.join(install, 'specrails-server.exe')), 'Installed sidecar is missing')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails installed ñ '))
const profile = path.join(fixture, 'profile')
const repository = path.join(fixture, 'repository with spaces')
fs.mkdirSync(profile)
fs.mkdirSync(repository)
const runtimes = path.join(install, 'runtimes')
const node = path.join(runtimes, 'node', 'node.exe')
const git = path.join(runtimes, 'git', 'cmd', 'git.exe')
for (const file of [node, git, path.join(install, 'binaries', 'better_sqlite3.node'), path.join(install, 'binaries', 'specrails-mcp.js')]) assert.ok(fs.existsSync(file), `Missing installed resource ${file}`)
const probe = net.createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const base = `http://127.0.0.1:${port}`
const controlToken = randomUUID()
// Only the child gets this throwaway profile. The invoking user's environment is unchanged.
const env = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
  HOMEDRIVE: path.parse(profile).root.replace(/\\$/, ''), HOMEPATH: profile.slice(path.parse(profile).root.length - 1),
  SPECRAILS_IS_DESKTOP: '1', SPECRAILS_BUNDLED_RUNTIMES_PATH: runtimes,
  SPECRAILS_BUNDLED_CORE_PATH: path.join(install, 'core'), SPECRAILS_BUNDLED_OPENSPEC_PATH: path.join(install, 'openspec'),
  SPECRAILS_BUNDLED_MCP_BRIDGE_PATH: path.join(install, 'binaries', 'specrails-mcp.js'),
  SPECRAILS_HOST_CONTROL_TOKEN: controlToken, SPECRAILS_REGISTRY_HOME: profile,
  SPECRAILS_FRAMEWORK_AUTOSWAP: 'false', SPECRAILS_LEGACY_MIGRATION: 'false', SPECRAILS_DEV_SERVER_PORT: String(port),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(profile, 'absent.gitconfig') }
delete env.NODE_OPTIONS
for (const directory of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(directory, { recursive: true })
// Exclude development toolchains; app startup must supply its own Node/Git.
env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot};${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`
delete env.Path
execFileSync(git, ['init', '-q', repository], { env, windowsHide: true })
fs.writeFileSync(path.join(repository, 'hello.txt'), 'Windows smoke content\n')
execFileSync(git, ['-C', repository, 'add', '.'], { env, windowsHide: true })
execFileSync(git, ['-C', repository, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-qm', 'smoke'], { env, windowsHide: true })
let server
let logs = ''
let token
let terminalSocket
let helperPid
let backgroundHelperPid
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, message, timeout = 30_000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value } catch (error) { last = error }
    await delay(150)
  }
  throw new Error(`${message}: ${last?.message ?? 'timeout'}\n${logs.slice(-8000)}`)
}
async function api(route, options = {}) {
  const response = await fetch(`${base}/api${route}`, { ...options, signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', 'x-desktop-token': token ?? '', ...options.headers } })
  assert.ok(response.ok, `${route} returned ${response.status}: ${await response.clone().text()}`)
  return response.json()
}
async function start() {
  server = spawn(path.join(install, 'specrails-server.exe'), ['--port', String(port)], { env, cwd: install, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  server.stdout.on('data', data => { logs = (logs + data).slice(-200_000) })
  server.stderr.on('data', data => { logs = (logs + data).slice(-200_000) })
  server.on('error', error => { logs += error.message })
  await until(async () => {
    if (server.exitCode !== null) throw new Error(`Sidecar exited: ${server.exitCode}`)
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })
    return response.ok && (await response.json()).status === 'ok'
  }, 'Installed sidecar failed to start', 60_000)
  token = (await api('/token')).token
  assert.ok(token)
}
async function stop() {
  await api('/host/shutdown', { method: 'POST', headers: { 'x-specrails-host-token': controlToken } })
  await until(() => server.exitCode !== null, 'Sidecar did not shut down gracefully', 15_000)
  assert.equal(server.exitCode, 0)
}
function running(pid) { try { process.kill(pid, 0); return true } catch { return false } }
try {
  await start()
  const added = await api('/projects', { method: 'POST', body: JSON.stringify({ path: repository, name: 'Windows smoke', provider: 'claude' }) })
  const id = added.project.id
  assert.ok(id)
  assert.ok((await api('/projects')).projects.some(project => project.id === id))
  const frameworkMarker = path.join(profile, '.specrails', 'projects', added.project.slug, 'workspace', '.specrails', 'specrails-version')
  await until(() => fs.existsSync(frameworkMarker), 'Bundled Core did not assemble the project offline', 60_000)
  const file = await api(`/projects/${id}/code/file?path=hello.txt`)
  assert.equal(file.content, 'Windows smoke content\n')
  const { session } = await api(`/projects/${id}/terminals`, { method: 'POST', body: JSON.stringify({ cols: 120, rows: 30 }) })
  assert.ok(session.id)
  const helper = path.join(fixture, 'terminal helper.cjs')
  const receipt = path.join(fixture, 'terminal receipt.json')
  fs.writeFileSync(helper, "require('fs').writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, cwd: process.cwd() })); console.log('SPECRAILS_NATIVE_PTY_OK'); setInterval(() => {}, 1000)")
  terminalSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${session.id}?projectId=${id}`, [`desktop-token.${token}`])
  let output = ''
  terminalSocket.on('message', (data, binary) => { if (binary) output += data.toString() })
  await once(terminalSocket, 'open', { signal: AbortSignal.timeout(15_000) })
  const isPowerShell = /(?:pwsh|powershell)(?:\.exe)?$/i.test(session.shell)
  const quote = value => isPowerShell ? `'${value.replaceAll("'", "''")}'` : `"${value}"`
  terminalSocket.send(JSON.stringify({ type: 'write', data: `${isPowerShell ? '& ' : ''}${[node, helper, receipt].map(quote).join(' ')}\r` }))
  const started = await until(() => fs.existsSync(receipt) && JSON.parse(fs.readFileSync(receipt, 'utf8')), 'Installed PTY did not execute input')
  helperPid = started.pid
  assert.equal(path.resolve(started.cwd).toLowerCase(), repository.toLowerCase())
  await until(() => output.includes('SPECRAILS_NATIVE_PTY_OK'), 'PTY output was not delivered')
  await api(`/projects/${id}/terminals/${session.id}`, { method: 'DELETE' })
  await until(() => !running(helperPid), 'Closing terminal left its Node process alive', 15_000)
  terminalSocket.close()
  // A launcher can exit before any process-tree snapshot observes its child.
  // The installed background controller must retain kernel ownership anyway.
  const backgroundHelper = path.join(fixture, 'background helper.cjs')
  const backgroundWrapper = path.join(fixture, 'fast background wrapper.cjs')
  const backgroundReceipt = path.join(fixture, 'background receipt.json')
  const wrapperReceipt = path.join(fixture, 'wrapper receipt.json')
  fs.writeFileSync(backgroundHelper, `require('fs').writeFileSync(${JSON.stringify(backgroundReceipt)}, JSON.stringify({ pid: process.pid })); setTimeout(() => process.exit(99), 60000);`)
  fs.writeFileSync(backgroundWrapper, `const child = require('child_process').spawn(process.execPath, [${JSON.stringify(backgroundHelper)}], { detached: false, stdio: 'ignore' }); child.once('spawn', () => { require('fs').writeFileSync(${JSON.stringify(wrapperReceipt)}, JSON.stringify({ pid: process.pid, shellPid: process.ppid, childPid: child.pid })); process.exit(0); }); child.once('error', () => process.exit(7));`)
  const chatId = 'installed-background-smoke'
  const { process: background } = await api(`/projects/${id}/background-processes`, {
    method: 'POST', body: JSON.stringify({ command: `"${node}" "${backgroundWrapper}"`, chatId, confirmed: true }),
  })
  assert.ok(background.pid)
  assert.ok(background.processId)
  const wrapper = await until(() => fs.existsSync(wrapperReceipt) && JSON.parse(fs.readFileSync(wrapperReceipt, 'utf8')), 'Installed background wrapper did not execute')
  backgroundHelperPid = wrapper.childPid
  await until(() => fs.existsSync(backgroundReceipt), 'Background descendant did not become ready')
  await until(() => !running(wrapper.pid) && !running(wrapper.shellPid), 'Background launchers did not exit')
  assert.ok(running(backgroundHelperPid), 'Background child exited before Stop could be tested')
  const backgroundState = async () => (await api(`/projects/${id}/background-processes?chatId=${chatId}&includeFinished=true`)).processes.find(item => item.processId === background.processId)
  assert.equal((await backgroundState())?.status, 'running', 'Exited launcher hid its running child')
  await api(`/projects/${id}/background-processes/${background.pid}?chatId=${chatId}&processId=${background.processId}`, { method: 'DELETE' })
  await until(() => !running(backgroundHelperPid), 'Background Stop left an orphaned descendant alive', 15_000)
  await until(async () => (await backgroundState())?.status === 'killed', 'Background Stop did not confirm completion')
  await stop()
  // Read the existing project after restart: proves the installed SQLite path and migration are stable.
  await start()
  assert.ok((await api('/projects')).projects.some(project => project.id === id))
  await stop()
  console.log(`Installed Windows ${process.arch}: database, repository/files, native PTY input/output/kill, background orphan containment, graceful shutdown and restart PASS`)
} finally {
  terminalSocket?.terminate()
  if (server && server.exitCode === null) {
    try { execFileSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }
  if (helperPid && running(helperPid)) { try { process.kill(helperPid) } catch {} }
  if (backgroundHelperPid && running(backgroundHelperPid)) { try { process.kill(backgroundHelperPid) } catch {} }
  if (process.env.SPECRAILS_SMOKE_LOG_PATH) fs.writeFileSync(process.env.SPECRAILS_SMOKE_LOG_PATH, logs)
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
