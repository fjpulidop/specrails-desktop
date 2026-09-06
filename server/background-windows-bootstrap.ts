import { spawn, type ChildProcess } from 'child_process'
import { createServer, type Socket } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveBundledNodeExe } from './path-resolver'
import { windowsSpawnEnv } from './util/win-spawn'
import type { BackgroundProcessControl } from './background-process-control'
import { WINDOWS_JOB_SUPERVISOR } from './windows-job-supervisor'

// Keep the owned Windows root alive until its creation identity is captured.
// User commands never enter argv and cannot start before the parent opens stdin.
export const WINDOWS_BACKGROUND_BOOTSTRAP = String.raw`
const {spawn}=require('node:child_process');
let launched=false, input='';
const timer=setTimeout(()=>{console.error('Background startup identity handshake timed out.');process.exit(125)},10000);
process.stdin.setEncoding('utf8');
process.stdin.on('error',()=>process.exit(125));
process.stdin.on('end',()=>{if(!launched)process.exit(125)});
process.stdin.on('data',chunk=>{
  if(launched)return;
  input+=chunk;
  if(input.length>524288){process.exit(125);return;}
  const newline=input.indexOf('\n');if(newline<0)return;
  let payload;try{payload=JSON.parse(input.slice(0,newline))}catch{process.exit(125);return;}
  const command=typeof payload.command==='string'?payload.command:typeof payload.commandBase64==='string'?Buffer.from(payload.commandBase64,'base64').toString('utf8'):null;
  if(command===null){process.exit(125);return;}
  for(const key of ['NODE_OPTIONS','NODE_PATH']) {
    const saved='SPECRAILS_JOB_'+key+'_B64';
    if(process.env[saved]!==undefined){process.env[key]=Buffer.from(process.env[saved],'base64').toString('utf8');delete process.env[saved]}
  }
  launched=true;clearTimeout(timer);
  let child;try{child=spawn(command,{shell:process.env.ComSpec||true,windowsHide:true,stdio:['ignore','inherit','inherit']})}
  catch(error){console.error(error.message);process.exit(125);return;}
  child.on('error',error=>{console.error(error.message);process.exitCode=125});
  child.on('close',code=>process.exit(code===null?1:code));
});
`

export interface WindowsBackgroundBootstrap {
  child: ChildProcess
  control?: BackgroundProcessControl
  hasLaunched(): boolean
  start(): void
  cancel(): void
}

export function spawnWindowsBackgroundBootstrap(command: string, cwd: string): WindowsBackgroundBootstrap {
  const node = resolveBundledNodeExe() ?? (!(process as NodeJS.Process & { pkg?: unknown }).pkg ? process.execPath : null)
  if (!node) throw new Error('The bundled Node runtime is required to start a Windows background application.')
  if (Buffer.byteLength(command, 'utf8') > 250_000) throw new Error('The background command exceeds the startup transport limit.')
  const directory = mkdtempSync(path.join(tmpdir(), 'specrails-job-'))
  const script = path.join(directory, 'supervisor.ps1'), bootstrap = path.join(directory, 'bootstrap.cjs')
  const pipeName = `specrails-background-${randomUUID()}`
  let socket: Socket | undefined, child: ChildProcess
  let launched = false, cancelled = false, assigned = false, empty = false, supervisorClosed = false, nextId = 0
  let failure: Error | undefined
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  const pending = new Map<number, { resolve: (active: number) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const fail = (error: Error) => {
    failure ??= error
    rejectReady(error)
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
  }
  const server = createServer(connection => {
    if (socket) { connection.destroy(); return }
    socket = connection
    server.close()
    connection.setEncoding('utf8')
    let buffer = ''
    connection.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 16_384) { fail(new Error('Invalid background job control frame.')); connection.destroy(); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const parts = buffer.slice(0, newline).replace(/\r$/, '').split('\t'); buffer = buffer.slice(newline + 1)
        if (parts[0] === 'ready') {
          assigned = true; clearTimeout(startupTimer); resolveReady()
        } else if (parts[0] === 'empty') {
          empty = true
          for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(0) }
          pending.clear()
        } else if (parts[0] === 'state' && /^\d+$/.test(parts[1] ?? '') && /^\d+$/.test(parts[2] ?? '')) {
          const item = pending.get(Number(parts[1]))
          if (item) {
            const active = Number(parts[2])
            if (active === 0) empty = true
            clearTimeout(item.timer); pending.delete(Number(parts[1])); item.resolve(active)
          }
        } else if (parts[0] === 'error') {
          fail(new Error(`Windows job containment failed: ${Buffer.from(parts[1] ?? '', 'base64').toString('utf8')}`))
        } else { fail(new Error('Invalid background job control response.')); connection.destroy(); return }
      }
    })
    connection.on('error', fail)
    connection.on('close', () => { if (!empty) fail(new Error('The Windows job supervisor disconnected before confirming an empty job.')) })
  })
  server.on('error', error => { fail(error); try { child?.kill() } catch { /* no child */ } })
  const startupTimer = setTimeout(() => {
    fail(new Error('Windows job containment preparation timed out; no application was admitted.'))
    try { child?.kill() } catch { /* already gone */ }
  }, 15_000)
  startupTimer.unref?.()
  const cleanup = () => {
    clearTimeout(startupTimer)
    try { server.close() } catch { /* listener may have failed before binding */ }
    socket?.destroy()
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* temporary files can be reclaimed on next OS cleanup */ }
  }
  try {
    writeFileSync(script, WINDOWS_JOB_SUPERVISOR, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(bootstrap, WINDOWS_BACKGROUND_BOOTSTRAP, { encoding: 'utf8', mode: 0o600 })
    // Preserve Windows' default pipe ACL; never enable cross-user write access.
    // No command is sent until the duplex client confirms job assignment.
    server.listen({ path: `\\\\.\\pipe\\${pipeName}`, readableAll: false, writableAll: false })
    const env = windowsSpawnEnv()
    const powershell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-NodePath', node, '-BootstrapPath', bootstrap, '-PipeName', pipeName], {
      cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.once('error', error => { fail(error); cleanup() })
    child.once('close', () => {
      supervisorClosed = true
      if (!empty) fail(new Error('The Windows job supervisor exited without confirming process cleanup.'))
      cleanup()
    })
  } catch (error) { cleanup(); fail(error as Error); throw error }
  const request = async (operation: 'poll' | 'stop'): Promise<number> => {
    if (empty) return 0
    await ready
    if (empty) return 0
    if (failure || !socket || socket.destroyed) throw failure ?? new Error('Windows job control is unavailable.')
    const id = ++nextId
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Windows job control request timed out.')) }, 5000)
      timer.unref?.(); pending.set(id, { resolve, reject, timer })
      try { socket!.write(`${operation}\t${id}\n`) }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
    })
  }
  return {
    child,
    control: {
      ready,
      async isAlive() {
        // The supervisor is the sole owner of a non-inheritable job handle.
        // Its process close releases that handle and the kernel kills the job.
        // Missing a clean empty receipt is reported as failed, never success.
        if (supervisorClosed && assigned) return false
        return (await request('poll')) > 0
      },
      async terminate() { await request('stop') },
      terminalFailure: () => supervisorClosed && assigned && launched && !empty
        ? 'The Windows job supervisor stopped unexpectedly; its job was force-terminated by Windows.' : undefined,
    },
    hasLaunched: () => launched,
    start() {
      if (cancelled) throw new Error('Background startup was cancelled.')
      if (!assigned || empty || failure || !socket || socket.destroyed) throw failure ?? new Error('Background job was not assigned before startup.')
      launched = true
      socket.write(`start\t${Buffer.from(command, 'utf8').toString('base64')}\n`)
    },
    cancel() {
      cancelled = true
      if (launched) return // The identified controller owns the complete tree now.
      // Before command admission there is no application work to preserve.
      // Killing the supervisor closes its job handle; an unassigned bootstrap
      // sees stdin EOF and cannot launch the command either.
      try { child.kill() } catch { /* child handle already closed */ }
    },
  }
}
