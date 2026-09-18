#!/usr/bin/env node
import { runCli } from './runner'

// specrails-local-runner: an agentic runner for OpenAI-compatible endpoints,
// spawned by Specrails Desktop exactly like a CLI provider (claude-style argv
// in, claude-shaped stream-json out). Bundled and run by the app's Node
// runtime — see scripts/build-local-runner.mjs.

runCli(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
})
  .then((code) => {
    // Flush stdout before exiting: pipe writes are async on some platforms and
    // the parent must never lose the terminal `result` frame.
    process.exitCode = code
    process.stdout.write('', () => process.exit(code))
  })
  .catch((err) => {
    process.stderr.write(`[local-runner] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  })
