// Test-only: runs after factory-executor-preload.mjs. Codex refuses every turn on its
// usage limit (Core's typed refusal); Claude runs the factory's deterministic executor.
// Every physical call records the provider it reached. No provider CLI or network is used.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const core = process.env.SPECRAILS_FACTORY_CORE
if (core && path.resolve(process.argv[1] ?? '') === path.join(core, 'dist/agent-runtime/cli.js')) {
  const { ExecutorRegistry } = await import(pathToFileURL(path.join(core, 'dist/agent-runtime/executors.js')).href)
  const { AgentExecutionError } = await import(pathToFileURL(path.join(core, 'dist/agent-runtime/executor-types.js')).href)
  const factory = ExecutorRegistry.prototype.get
  const record = (provider, request) => fs.appendFileSync(process.env.SPECRAILS_SWITCH_CALLS, JSON.stringify({ provider, role: request.role, model: request.model ?? null, effort: request.effort ?? null }) + '\n')
  const limited = {
    capabilities: () => ({ transport: 'fixture-codex', continuation: 'unsupported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }),
    async execute(request) {
      record('codex', request)
      throw new AgentExecutionError('codex usage limit reached (five_hour window, resets 2099-01-01T00:00:00.000Z).', 'provider_limit', { inputTokens: 0, outputTokens: 0, costUsd: 0 })
    },
  }
  ExecutorRegistry.prototype.get = function (id) {
    if (id === 'codex') return limited
    const executor = factory.call(this, id)
    return { ...executor, capabilities: executor.capabilities, async execute(request) { record(id, request); return executor.execute(request) } }
  }
}
