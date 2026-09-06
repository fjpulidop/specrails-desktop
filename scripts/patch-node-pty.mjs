/**
 * patch-node-pty.mjs
 *
 * node-pty 1.x on macOS uses `posix_spawn` with the `POSIX_SPAWN_CLOEXEC_DEFAULT`
 * flag. This flag fails inside pkg-bundled Node (as used by the Tauri sidecar)
 * because pkg keeps internal file descriptors open without CLOEXEC, and with
 * CLOEXEC_DEFAULT set, the spawn aborts.
 *
 * This script patches node-pty's `src/unix/pty.cc` to omit that flag, then
 * rebuilds the native addon (`pty.node`) via node-gyp and copies the output
 * into `prebuilds/darwin-arm64/`. The patch is idempotent.
 *
 * Runs as part of `npm run build:sidecar` via a step injected into the
 * pipeline — see build-sidecar.mjs.
 */

import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const NODE_PTY_DIR = path.join(ROOT, 'node_modules', 'node-pty')
const PTY_CC = path.join(NODE_PTY_DIR, 'src', 'unix', 'pty.cc')

const ORIGINAL_LINE = 'int flags = POSIX_SPAWN_CLOEXEC_DEFAULT |'
const PATCHED_LINE = 'int flags = 0 | /* pkg-patch: removed POSIX_SPAWN_CLOEXEC_DEFAULT — see scripts/patch-node-pty.mjs */'

/** Recognize only the original statement or our exact replacement. The flag
 * name remains in the replacement comment, so its presence alone is not a
 * reliable indication that the source still needs patching. */
export function patchNodePtySource(source) {
  const originals = source.split(ORIGINAL_LINE).length - 1
  const patched = source.split(PATCHED_LINE).length - 1
  if (originals === 0 && patched === 1) return { source, changed: false }
  if (originals === 1 && patched === 0) return { source: source.replace(ORIGINAL_LINE, PATCHED_LINE), changed: true }
  throw new Error('Unexpected node-pty source layout: expected exactly one original flags statement or the exact pkg patch. Inspect src/unix/pty.cc and update scripts/patch-node-pty.mjs.')
}

function log(msg) { console.log(`[patch-node-pty] ${msg}`) }

function run(cmd, opts = {}) {
  log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: NODE_PTY_DIR, ...opts })
}

function main() {
  if (process.platform !== 'darwin') {
    log(`skip: not macOS (platform=${process.platform})`)
    return
  }
  if (!fs.existsSync(PTY_CC)) {
    log(`skip: ${PTY_CC} not found (was node-pty installed?)`)
    return
  }
  const src = fs.readFileSync(PTY_CC, 'utf8')

  let patch
  try { patch = patchNodePtySource(src) }
  catch (error) {
    log(`ERROR: ${error.message}`)
    process.exitCode = 1
    return
  }
  if (patch.changed) {
    fs.writeFileSync(PTY_CC, patch.source)
    log('patched src/unix/pty.cc')
  } else {
    log('source already patched — ensuring native addon is rebuilt')
  }

  // Rebuild native addon via node-gyp
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const prebuildsDir = path.join(NODE_PTY_DIR, 'prebuilds', `darwin-${arch}`)
  const finalPty = path.join(prebuildsDir, 'pty.node')
  const buildDir = path.join(NODE_PTY_DIR, 'build', 'Release')
  const ptyNode = path.join(buildDir, 'pty.node')
  const spawnHelper = path.join(buildDir, 'spawn-helper')

  // Skip rebuild if already up-to-date (prebuilds/pty.node newer than src/pty.cc)
  const ptyCcStat = fs.statSync(PTY_CC)
  const finalStat = fs.existsSync(finalPty) ? fs.statSync(finalPty) : null
  if (finalStat && finalStat.mtime >= ptyCcStat.mtime && fs.existsSync(ptyNode)) {
    log(`skip rebuild: ${finalPty} is newer than src`)
    return
  }

  run('npx --yes node-gyp rebuild')

  if (!fs.existsSync(ptyNode)) {
    log(`ERROR: ${ptyNode} not produced by rebuild`)
    process.exit(1)
  }
  fs.mkdirSync(prebuildsDir, { recursive: true })
  fs.copyFileSync(ptyNode, finalPty)
  if (fs.existsSync(spawnHelper)) {
    fs.copyFileSync(spawnHelper, path.join(prebuildsDir, 'spawn-helper'))
    fs.chmodSync(path.join(prebuildsDir, 'spawn-helper'), 0o755)
  }
  log(`rebuilt artifacts → ${prebuildsDir}`)
}

// Importing the pure transform for fixture tests must never rebuild node-pty.
// Resolve argv as a filesystem path so relative and symlinked entrypoints work.
const isDirectRun = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) }
  catch { return false }
})()
if (isDirectRun) main()
