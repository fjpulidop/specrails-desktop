// Deterministic local provider for real Core compatibility acceptance.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const core = process.env.SPECRAILS_COMPAT_CORE
if (core && path.resolve(process.argv[1] ?? '') === path.join(core, 'dist/agent-runtime/cli.js')) {
  const { ExecutorRegistry } = await import(pathToFileURL(path.join(core, 'dist/agent-runtime/executors.js')).href)
  const plan = JSON.parse(fs.readFileSync(process.env.SPECRAILS_COMPAT_PLAN, 'utf8'))
  const file = process.env.SPECRAILS_COMPAT_CALLS
  const executor = {
    capabilities: () => ({ transport: 'fixture', continuation: 'unsupported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }),
    async execute(request) {
      const calls = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0
      const response = plan[calls]
      if (!response || response.role !== request.role) throw Error(`Unexpected invocation ${calls}: ${request.role}`)
      fs.appendFileSync(file, JSON.stringify({ role: request.role, model: request.model, prompt: request.prompt }) + '\n')
      if (response.error) throw Error(response.error)
      if (response.createChange) {
        const { resolveOpenSpecCli, runOpenSpec } = await import(pathToFileURL(path.join(core, 'dist/agent-runtime/openspec.js')).href)
        await runOpenSpec(resolveOpenSpecCli(), request.cwd, ['new', 'change', response.createChange, '--json'])
      }
      for (const [relative, content] of Object.entries(response.files ?? {})) {
        const target = path.resolve(request.cwd, relative)
        if (!target.startsWith(path.resolve(request.cwd) + path.sep)) throw Error('Fixture file escapes repository')
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content)
      }
      return { text: response.text, usage: { inputTokens: 3, outputTokens: 2, costUsd: null } }
    },
  }
  ExecutorRegistry.prototype.get = function(id) { if (id !== 'claude') throw Error('Unexpected provider'); return executor }
}
