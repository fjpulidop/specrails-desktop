import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
// Top-level script tests plus the benchmark harness's own (scripts/benchmark).
// The harness is a macOS/Linux developer tool (lsof, ps, vm_stat, POSIX signals,
// a shell brew shim, POSIX path fixtures) that refuses to start on Windows, so its
// tests run where it runs.
const files = [directory, ...(process.platform === 'win32' ? [] : [path.join(directory, 'benchmark')])]
  .flatMap(dir => fs.readdirSync(dir).filter(file => file.endsWith('.test.mjs')).sort().map(file => path.join(dir, file)))
if (!files.length) throw new Error('No script regression tests found')
// Windows cmd.exe does not expand shell globs. Pass explicit filenames so
// Node's test runner behaves identically on every supported platform.
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
