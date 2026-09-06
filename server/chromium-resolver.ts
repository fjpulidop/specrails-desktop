import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { validateChromiumArchive, validateChromiumTree } from './chromium-archive.cjs'

/**
 * Discover bundled Chromium, extracting its distribution archive when necessary.
 *
 * A transparent chromium.tar.gz preserves the versioned framework symlinks that
 * Tauri resource copying would otherwise dereference. Release assembly signs and
 * notarizes Chromium before packing it; extraction preserves that signed layout.
 * The writable cache is an installation location, not a signing bypass.
 *
 * Older bundles used an XOR-encoded chromium.pak. Decode that format only for
 * compatibility, preferring transparent archives whenever both are present.
 * Unpacked development bundles and Playwright-managed browsers remain fallbacks.
 * The executable is discovered because Playwright's platform layout can change.
 */

const MAX_DEPTH = 6

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/** Depth-bounded search for the first file whose basename satisfies `match`. */
function findFirstFile(root: string, match: (name: string) => boolean, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return null }
  // Files first (cheap), then recurse into dirs.
  for (const e of entries) {
    if (e.isFile() && match(e.name)) return path.join(root, e.name)
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findFirstFile(path.join(root, e.name), match, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/** On macOS: locate the main executable inside the first `*.app` under `root`. */
function findMacAppExecutable(root: string, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (e.isDirectory() && e.name.endsWith('.app')) {
      const macosDir = path.join(root, e.name, 'Contents', 'MacOS')
      // The main binary is conventionally named like the app (sans ".app");
      // fall back to the first regular file in MacOS/.
      const preferred = path.join(macosDir, e.name.slice(0, -'.app'.length))
      if (isFile(preferred)) return preferred
      try {
        for (const inner of fs.readdirSync(macosDir, { withFileTypes: true })) {
          if (inner.isFile()) return path.join(macosDir, inner.name)
        }
      } catch { /* keep searching */ }
    }
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.endsWith('.app')) {
      const hit = findMacAppExecutable(path.join(root, e.name), depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/** Find the bundled Chromium executable under `<chromiumRoot>`, or null. */
export function discoverChromiumExecutable(chromiumRoot: string): string | null {
  if (!fs.existsSync(chromiumRoot)) return null
  if (process.platform === 'win32') {
    return findFirstFile(chromiumRoot, (n) => n === 'chrome.exe' || n === 'chromium.exe')
  }
  if (process.platform === 'darwin') {
    return (
      findMacAppExecutable(chromiumRoot) ??
      findFirstFile(chromiumRoot, (n) => n === 'Chromium' || n === 'chromium' || n === 'chrome')
    )
  }
  // linux
  return findFirstFile(chromiumRoot, (n) => n === 'chrome' || n === 'chromium' || n === 'chrome-wrapper')
}

/**
 * Returns the absolute path to an UNPACKED bundled Chromium binary, or `null`.
 *
 * This is the synchronous, no-extraction path: it only inspects a chromium tree that
 * already exists on disk under `<runtimes>/chromium`. Prefer the async
 * `resolveBundledChromiumExecutable()` for the launch path — it additionally extracts
 * the shipped `chromium.tar.gz` archive. Kept for the unpacked fallback (local builds)
 * and never throws.
 */
export function resolveBundledChromiumPath(): string | null {
  if (process.env.SPECRAILS_IS_DESKTOP !== '1') return null
  const runtimesPath = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
  if (!runtimesPath) return null
  try {
    return discoverChromiumExecutable(path.join(runtimesPath, 'chromium'))
  } catch {
    return null
  }
}

/** Candidate archive names under `<runtimes>/chromium`, in preference order. */
const ARCHIVE_NAMES = ['chromium.tar.gz', 'chromium.tar', 'chromium.pak']

// Legacy archive decoding only. The bytes must remain compatible with previously
// shipped chromium.pak files; new release assembly produces transparent archives.
const OBFUSCATION_KEY = Buffer.from('specrails-desktop-chromium-pack-v1', 'utf8')

/** Streaming XOR transform (symmetric: packs and unpacks). */
function xorStream(): Transform {
  let offset = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const out = Buffer.allocUnsafe(chunk.length)
      for (let i = 0; i < chunk.length; i++) {
        out[i] = chunk[i] ^ OBFUSCATION_KEY[(offset + i) % OBFUSCATION_KEY.length]
      }
      offset += chunk.length
      cb(null, out)
    },
  })
}

/** De-obfuscate a `.pak` blob into a real `.tar.gz` at `outPath`. */
async function deobfuscate(pakPath: string, outPath: string): Promise<void> {
  await pipeline(fs.createReadStream(pakPath), xorStream(), fs.createWriteStream(outPath))
}

/** Writable extraction destination (overridable for tests via env). */
function chromiumCacheDir(): string {
  return (
    process.env.SPECRAILS_CHROMIUM_CACHE_DIR ||
    path.join(os.homedir(), '.specrails', 'runtimes', 'chromium')
  )
}

/** Bind the extraction to the selected archive and its precise filesystem revision. */
function archiveIdentity(archivePath: string): string {
  const st = fs.statSync(archivePath)
  return JSON.stringify({ version: 2, path: fs.realpathSync(archivePath), size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, dev: st.dev, ino: st.ino })
}

/** Resolve the platform `tar` binary. macOS/Linux ship `/usr/bin/tar`; Windows 10+ ships `tar` (bsdtar) on PATH. */
function tarBinary(): string {
  if (process.platform !== 'win32' && isFile('/usr/bin/tar')) return '/usr/bin/tar'
  return 'tar'
}

/** Extract a preflight-validated archive using the system tar (auto-detects gzip). */
function runTarExtract(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Apple tar must restore the metadata carrying the stapled ticket. These
    // caller overrides are appropriate for source copies, not signed bundles.
    const env = { ...process.env }
    delete env.TAR_OPTIONS
    delete env.COPYFILE_DISABLE
    delete env.COPY_EXTENDED_ATTRIBUTES_DISABLE
    const child = spawn(tarBinary(), ['-xf', archivePath, '-C', destDir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env })
    let stderr = ''
    child.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4096) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar exited ${code}: ${stderr.trim().slice(0, 500)}`))
    })
  })
}

// Share pending work and serialize replacement of the same cache directory.
// Completed promises are removed so deleted or changed cache files are rechecked.
const extractInflight = new Map<string, { identity: string; promise: Promise<string | null> }>()

/** First archive that exists under `<runtimes>/chromium`, or null. */
function findBundledArchive(runtimesPath: string): string | null {
  for (const name of ARCHIVE_NAMES) {
    const p = path.join(runtimesPath, 'chromium', name)
    if (isFile(p)) return p
  }
  return null
}

async function extractAndDiscover(archivePath: string, identity: string, destRoot: string): Promise<string | null> {
  const marker = path.join(destRoot, '.source')

  // Fast path: already extracted from this exact archive.
  try {
    if (fs.readFileSync(marker, 'utf8') === identity) {
      const exe = discoverChromiumExecutable(destRoot)
      if (exe) return exe
    }
  } catch { /* not yet extracted / stale → fall through */ }

  // Validate a complete extraction before publishing; retain the prior cache if
  // publication fails (for example, while a running browser locks it on Windows).
  fs.mkdirSync(path.dirname(destRoot), { recursive: true })
  const tmpDir = fs.mkdtempSync(`${destRoot}.tmp-`)
  // An obfuscated `.pak` is XOR-decoded to a real `.tar.gz` first; plain archives
  // are fed straight to tar.
  const isPak = archivePath.endsWith('.pak')
  const decodedTar = isPak ? `${tmpDir}.tar.gz` : null
  try {
    let tarSource = archivePath
    if (decodedTar) {
      await deobfuscate(archivePath, decodedTar)
      tarSource = decodedTar
    }
    // Windows tar can follow an archive-created link before a post-extraction
    // check runs. Validate the complete archive before allowing any writes.
    await validateChromiumArchive(tarSource)
    await runTarExtract(tarSource, tmpDir)
    validateChromiumTree(tmpDir)
    const exeInTmp = discoverChromiumExecutable(tmpDir)
    if (!exeInTmp) throw new Error('no chromium executable found after extraction')
    try { fs.chmodSync(exeInTmp, 0o755) } catch { /* perms best-effort */ }

    if (archiveIdentity(archivePath) !== identity) throw new Error('Chromium archive changed during extraction; retry with the current bundle')
    fs.writeFileSync(path.join(tmpDir, '.source'), identity)
    const previous = `${tmpDir}.previous`
    let movedPrevious = false
    if (fs.existsSync(destRoot)) {
      fs.renameSync(destRoot, previous)
      movedPrevious = true
    }
    try {
      fs.renameSync(tmpDir, destRoot)
    } catch (error) {
      if (movedPrevious) fs.renameSync(previous, destRoot)
      throw error
    }
    if (movedPrevious) {
      try { fs.rmSync(previous, { recursive: true, force: true }) } catch { /* a locked prior version can be cleaned up later */ }
    }
    return discoverChromiumExecutable(destRoot)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (decodedTar) fs.rmSync(decodedTar, { force: true })
  }
}

/**
 * Resolve the bundled Chromium executable for the launch path, extracting the
 * shipped archive on first use. Returns `null` (never throws) when not in desktop
 * mode, when no bundle is present, or when extraction fails. The caller may then
 * try an installed Playwright-managed browser; this resolver does not download one.
 */
export async function resolveBundledChromiumExecutable(): Promise<string | null> {
  if (process.env.SPECRAILS_IS_DESKTOP !== '1') return null
  const runtimesPath = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
  if (!runtimesPath) return null

  let archivePath: string | null = null
  try { archivePath = findBundledArchive(runtimesPath) } catch { archivePath = null }

  // No archive shipped → fall back to an unpacked tree (local/dev builds).
  if (!archivePath) return resolveBundledChromiumPath()

  let identity: string
  try { identity = archiveIdentity(archivePath) } catch { return resolveBundledChromiumPath() }

  const destRoot = path.resolve(chromiumCacheDir())
  const pending = extractInflight.get(destRoot)
  if (pending?.identity === identity) return pending.promise
  const extract = () => extractAndDiscover(archivePath, identity, destRoot)
  const promise = (pending ? pending.promise.then(extract) : extract()).catch((err) => {
    console.error('[chromium-resolver] extraction failed:', err instanceof Error ? err.message : err)
    return discoverChromiumExecutable(path.join(runtimesPath, 'chromium'))
  }).finally(() => {
    if (extractInflight.get(destRoot)?.promise === promise) extractInflight.delete(destRoot)
  })
  extractInflight.set(destRoot, { identity, promise })
  return promise
}
