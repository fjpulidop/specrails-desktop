// Exercise Core's actual CLI permission adapter without invoking a provider.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const core = process.env.SPECRAILS_STUDIO_CORE
if (core && path.resolve(process.argv[1] ?? '') === path.join(core, 'dist/agent-runtime/cli.js')) {
  const load = relative => import(pathToFileURL(path.join(core, 'dist/agent-runtime', relative)).href)
  const { ExecutorRegistry } = await load('executors.js')
  const { CliExecutor } = await load('cli-executor.js')
  ExecutorRegistry.prototype.get = function(id) {
    if (id !== 'claude') throw new Error('Unexpected fixture provider')
    return new CliExecutor('claude', { runProcess: async invocation => {
      fs.appendFileSync(process.env.SPECRAILS_STUDIO_CALLS, JSON.stringify(invocation) + '\n')
      return { stdout: JSON.stringify({ type: 'result', subtype: 'success', result: 'Read-only audit completed.', usage: { input_tokens: 3, output_tokens: 2 } }) + '\n', stderr: '', exitCode: 0 }
    } })
  }
}
