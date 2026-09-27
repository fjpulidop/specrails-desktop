// Provider-free crash boundary; all orchestration, leases and accounting are real.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
const cli = process.argv[1] ?? ''
const root = process.env.SPECRAILS_CRASH_ROOT
// Isolate real settings/retention from the developer's home in every child.
if (root) { os.homedir = () => path.join(root, 'home'); syncBuiltinESMExports() }
if (root && cli.replaceAll('\\', '/').endsWith('/agent-runtime/cli.js')) {
  const { ExecutorRegistry } = await import(pathToFileURL(path.join(path.dirname(cli), 'executors.js')).href)
  const mode = process.env.SPECRAILS_CRASH_MODE
  const marker = path.join(root, 'provider-entered')
  if (mode === 'between') {
    const { RunLedger } = await import(pathToFileURL(path.join(path.dirname(cli), 'engine/checkpoint/ledger.js')).href)
    const enter = RunLedger.prototype.enter
    RunLedger.prototype.enter = function(input) {
      const cut = path.join(root, 'between-entered')
      if (input.nodePath === 'verify' && !fs.existsSync(cut)) {
        fs.writeFileSync(cut, 'previous node committed; next node not admitted')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      }
      return enter.call(this, input)
    }
  }
  const executor = {
    capabilities: () => ({ transport: 'fixture', continuation: 'unsupported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }),
    async execute(request) {
      fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ access: request.access, prompt: request.prompt }) + '\n')
      if (!fs.existsSync(marker)) {
        if (mode === 'write') fs.writeFileSync(path.join(request.cwd, 'value.txt'), 'partial')
        fs.writeFileSync(marker, mode)
        if (mode === 'pause') return { text: 'LOOP_BLOCKED: Confirm completion?', usage: { inputTokens: 10, outputTokens: 5, costUsd: null } }
        if (mode !== 'between') await new Promise(() => { setInterval(() => {}, 1000) })
      }
      if (mode === 'write') fs.writeFileSync(path.join(request.cwd, 'value.txt'), 'complete')
      return { text: 'Completed after recovery', usage: { inputTokens: 10, outputTokens: 5, costUsd: null } }
    },
  }
  ExecutorRegistry.prototype.get = function(id) { if (id !== 'claude') throw Error('Unexpected provider'); return executor }
}
