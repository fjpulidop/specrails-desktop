// Bundles the specrails-mcp stdio↔HTTP bridge to a single CJS file and copies it
// into src-tauri/binaries so it ships inside the app bundle (Option A: run by the
// app's bundled Node — no separately code-signed binary). The esbuild hashbang
// of src/index.ts is preserved so the file is directly executable.
import { build } from 'esbuild'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'mcp-bridge', 'src', 'index.ts')
const outfile = path.join(root, 'mcp-bridge', 'dist', 'specrails-mcp.js')

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // @modelcontextprotocol/sdk is pure JS and bundles fine (do not externalize).
})

fs.chmodSync(outfile, 0o755)

const binDir = path.join(root, 'src-tauri', 'binaries')
fs.mkdirSync(binDir, { recursive: true })
const dest = path.join(binDir, 'specrails-mcp.js')
fs.copyFileSync(outfile, dest)

console.log(`[build-mcp-bridge] bundled → ${path.relative(root, outfile)} and ${path.relative(root, dest)}`)
