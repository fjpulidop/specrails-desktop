import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const files = fs.readdirSync(directory).filter(file => file.endsWith('.test.mjs')).sort().map(file => path.join(directory, file))
if (!files.length) throw new Error('No script regression tests found')
// Windows cmd.exe does not expand shell globs. Pass explicit filenames so
// Node's test runner behaves identically on every supported platform.
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
