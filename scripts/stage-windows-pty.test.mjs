import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { patchWindowsPtyAgent } from './stage-windows-pty.mjs'

function patchedHelper(fork, env = {}, pkg = true) {
  const source = patchWindowsPtyAgent(fs.readFileSync(new URL('../node_modules/node-pty/lib/windowsPtyAgent.js', import.meta.url), 'utf8'))
  const a = source.indexOf('    WindowsPtyAgent.prototype._getConsoleProcessList')
  const b = source.indexOf('    Object.defineProperty(WindowsPtyAgent.prototype, "exitCode"', a)
  const WindowsPtyAgent = function () { this._innerPid = 123 }
  vm.runInNewContext(source.slice(a, b), { WindowsPtyAgent, child_process_1: { fork }, path: path.win32,
    __dirname: 'C:\\Program Files\\Specrails\\binaries\\node-pty\\lib', fs: { existsSync: () => true },
    process: { pkg, execPath: 'C:\\Specrails\\specrails-server.exe', env }, setTimeout, clearTimeout })
  return new WindowsPtyAgent()._getConsoleProcessList()
}

test('packaged ConPTY uses bundled Node with spaced path and forwards descendant PIDs', async () => {
  let call
  const result = await patchedHelper((...args) => {
    call = args
    const child = new EventEmitter()
    child.connected = true
    child.disconnect = () => { child.connected = false }
    child.kill = () => {}
    queueMicrotask(() => child.emit('message', { consoleProcessList: [123, 124] }))
    return child
  }, { SPECRAILS_BUNDLED_RUNTIMES_PATH: 'C:\\Program Files\\Specrails\\runtimes', NODE_OPTIONS: '--require bad.js' })
  assert.deepEqual(Array.from(result), [123, 124])
  assert.equal(call[2].execPath, 'C:\\Program Files\\Specrails\\runtimes\\node\\node.exe')
  assert.equal(call[2].env.NODE_OPTIONS, undefined)
  assert.equal(call[2].windowsHide, true)
})

test('fork error is handled and resolves shell fallback without an unhandled rejection', async () => {
  const result = await patchedHelper(() => {
    const child = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(() => child.emit('error', new Error('failed')))
    return child
  }, { SPECRAILS_BUNDLED_RUNTIMES_PATH: 'C:\\Specrails\\runtimes' })
  assert.deepEqual(Array.from(result), [123])
})

test('missing runtime never recursively launches a second server', async () => {
  assert.deepEqual(Array.from(await patchedHelper(() => { throw new Error('must not fork') })), [123])
})

test('dependency drift fails explicitly instead of silently missing the patch', () => {
  assert.throws(() => patchWindowsPtyAgent('changed dependency source'), /changed/)
})
