import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// TypeScript emits JavaScript and imported JSON, but filesystem-based lookups
// also need these resources in server/dist (including npm installations).
export const SERVER_ASSETS = [
  'shell-integration',
  'schemas',
  'plugins/serena/templates',
  'openspec-runtime-plugin-commands.json',
  'chromium-archive.cjs',
]

export function copyServerAssets(root) {
  for (const entry of SERVER_ASSETS) {
    const source = path.join(root, 'server', entry)
    const destination = path.join(root, 'server', 'dist', entry)
    if (!fs.existsSync(source)) throw new Error(`Required server resource missing: ${entry}`)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    // These are owned build outputs. Replace each tree so stale resources are
    // removed and Node's broken native Unicode overwrite path is never used.
    fs.rmSync(destination, { recursive: true, force: true })
    // A filter also avoids Node's native recursive Unicode copy path.
    fs.cpSync(source, destination, { filter: () => true, mode: fs.constants.COPYFILE_FICLONE, recursive: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyServerAssets(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
  console.log('Copied server runtime assets into server/dist')
}
