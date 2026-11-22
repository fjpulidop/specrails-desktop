#!/usr/bin/env node
// MCP v2 evaluation harness: `npm run eval:mcp -- --client claude|codex|replay --scenario <id>|all [--repeat n]`.
// See eval/mcp/README.md. Refuses Windows (it relies on the benchmark's POSIX lifecycle).
import { parseArgs, ArgsError, USAGE } from './lib/args.mjs'
import { runEval } from './lib/run.mjs'
import { IsolationError } from './lib/isolation.mjs'

if (process.platform === 'win32') { console.error('eval:mcp runs on macOS and Linux only'); process.exit(2) }
let options
try { options = parseArgs(process.argv.slice(2)) } catch (error) {
  if (error instanceof ArgsError) { console.error(`${error.message}\n\n${USAGE}`); process.exit(2) }
  throw error
}
if (options.help) { console.log(USAGE); process.exit(0) }
try {
  const { report } = await runEval(options, { log: line => console.log(`[eval:mcp] ${line}`) })
  const ran = report.rows.filter(r => ['pass', 'fail', 'error'].includes(r.status))
  process.exitCode = ran.some(r => r.status !== 'pass') ? 1 : 0
} catch (error) {
  console.error(error instanceof IsolationError ? `Isolation: ${error.message}` : error)
  process.exitCode = 2
}
