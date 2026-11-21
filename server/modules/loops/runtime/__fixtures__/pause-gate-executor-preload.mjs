// Test-only: runs after factory-executor-preload.mjs. The FIRST provider turn of the run
// says it started (`<gate>.entered`) and then waits until the test opens the gate
// (`<gate>.open`), so a pause request lands while a step is in progress. Every later
// turn runs the factory's deterministic executor at once. No provider CLI or network.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const core = process.env.SPECRAILS_FACTORY_CORE
const gate = process.env.SPECRAILS_PAUSE_GATE
if (core && gate && path.resolve(process.argv[1] ?? '') === path.join(core, 'dist/agent-runtime/cli.js')) {
  const { ExecutorRegistry } = await import(pathToFileURL(path.join(core, 'dist/agent-runtime/executors.js')).href)
  const factory = ExecutorRegistry.prototype.get
  ExecutorRegistry.prototype.get = function (id) {
    const executor = factory.call(this, id)
    return { ...executor, capabilities: executor.capabilities, async execute(request) {
      if (!fs.existsSync(gate + '.entered')) {
        fs.writeFileSync(gate + '.entered', request.role ?? '')
        while (!fs.existsSync(gate + '.open')) await new Promise(resolve => setTimeout(resolve, 50))
      }
      return executor.execute(request)
    } }
  }
}
