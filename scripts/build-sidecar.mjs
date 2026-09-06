/**
 * build-sidecar.mjs
 *
 * Builds the specrails-desktop Express server as a self-contained native binary
 * and places it in src-tauri/binaries/ following Tauri's sidecar naming:
 *   specrails-server-<rustc-target-triple>
 *
 * Steps:
 *   1. Bundle server/index.ts → build/server-bundle.js  (via esbuild, CJS)
 *   2. Package with @yao-pkg/pkg → native binary (downloads pre-patched Node)
 *   3. Copy better-sqlite3 .node prebuilt addon alongside the binary
 *
 * Environment variables:
 *   TARGET_TRIPLE — override the Rust target triple (default: auto-detect via rustc)
 */

import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { stageWindowsPty } from './stage-windows-pty.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BUILD_DIR = path.join(ROOT, 'build')
const BINARIES_DIR = path.join(ROOT, 'src-tauri', 'binaries')
const BUNDLE_PATH = path.join(BUILD_DIR, 'server-bundle.js')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts })
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function getTargetTriple() {
  if (process.env.TARGET_TRIPLE) return process.env.TARGET_TRIPLE
  try {
    const output = execSync('rustc -vV', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] })
    const match = output.match(/^host:\s+(.+)$/m)
    if (match) return match[1].trim()
  } catch {}
  const p = process.platform, a = process.arch
  if (p === 'darwin' && a === 'arm64') return 'aarch64-apple-darwin'
  if (p === 'darwin' && a === 'x64')   return 'x86_64-apple-darwin'
  if (p === 'win32'  && a === 'x64')   return 'x86_64-pc-windows-msvc'
  if (p === 'win32'  && a === 'arm64') return 'aarch64-pc-windows-msvc'
  if (p === 'linux'  && a === 'x64')   return 'x86_64-unknown-linux-gnu'
  if (p === 'linux'  && a === 'arm64') return 'aarch64-unknown-linux-gnu'
  throw new Error(`Cannot determine Rust target triple for platform=${p} arch=${a}`)
}

// Map Rust target triple → @yao-pkg/pkg target
function getPkgTarget(triple) {
  const map = {
    'aarch64-apple-darwin':       'node22-macos-arm64',
    'x86_64-apple-darwin':        'node22-macos-x64',
    'x86_64-pc-windows-msvc':     'node22-win-x64',
    'aarch64-pc-windows-msvc':    'node22-win-arm64',
    'x86_64-unknown-linux-gnu':   'node22-linux-x64',
    'aarch64-unknown-linux-gnu':  'node22-linux-arm64',
  }
  const target = map[triple]
  if (!target) throw new Error(`No pkg target mapping for triple: ${triple}`)
  return target
}

// ─── pkg runtime patches (prepended as esbuild banner) ──────────────────────
// Pure-JS source that runs BEFORE any bundled `require()` call. Handles:
//   • better_sqlite3.node — redirected to external path
//   • node-pty — loaded from external package via createRequire (so spawn-helper
//     resolves on real fs, not inside pkg snapshot)
//   • pty.node — redirected for dlopen
// Under Tauri `.app` the externals live in Contents/Resources/; otherwise they
// sit alongside the standalone sidecar binary.

const PKG_RUNTIME_PATCHES = `/* BEGIN pkg native-addon hijack (injected by build-sidecar.mjs) */
if (typeof process !== "undefined" && process.pkg !== undefined) {
  (function () {
    var _p = require("path");
    var _Fs = require("fs");
    var _Module = require("module");
    var _execDir = _p.dirname(process.execPath);
    // Tauri v2 array-form resources preserve directory structure relative to
    // the project root, so artifacts land under a "binaries/" subfolder:
    //   - macOS .app:    <app>.app/Contents/Resources/binaries/
    //   - Windows NSIS:  <install>\binaries\
    //   - Linux/other:   <install>/binaries/
    // Standalone dev runs (sidecar executed from src-tauri/binaries/) keep
    // artifacts alongside the binary, no "binaries/" subfolder.
    // Probe each candidate for an anchor file (better_sqlite3.node) and pick
    // the first that exists; fall back to the exec dir so the original error
    // path is reported if nothing matches.
    var _candidateDirs = [
      _p.resolve(_execDir, "binaries"),                     // Windows/Linux install
      _p.resolve(_execDir, "..", "Resources", "binaries"),  // macOS .app bundle
      _execDir,                                              // dev standalone
    ];
    var _resourcesDir = _execDir;
    for (var _i = 0; _i < _candidateDirs.length; _i++) {
      try {
        if (_Fs.existsSync(_p.join(_candidateDirs[_i], "better_sqlite3.node"))) {
          _resourcesDir = _candidateDirs[_i];
          break;
        }
      } catch (_e) { /* keep probing */ }
    }
    var _sqliteReal = _p.resolve(_resourcesDir, "better_sqlite3.node");
    var _ptyReal = _p.resolve(_resourcesDir, "pty.node");
    var _ptyDirReal = _p.resolve(_resourcesDir, "node-pty");
    var _ptyModuleCached = null;
    function _loadRealNodePty() {
      if (_ptyModuleCached) return _ptyModuleCached;
      var pkgPath = _p.join(_ptyDirReal, "package.json");
      var realReq = _Module.createRequire(pkgPath);
      _ptyModuleCached = realReq(_ptyDirReal);
      return _ptyModuleCached;
    }
    // Playwright (browser-capture feature) is externalized + copied to
    // binaries/node_modules/. Load it from the real fs via createRequire anchored
    // at that node_modules so its own internal require('playwright-core') and its
    // fs reads (browsers.json / package.json relative to __dirname) resolve
    // outside the pkg snapshot.
    var _pwAnchor = _p.join(_resourcesDir, "node_modules", "playwright", "package.json");
    var _hasPlaywright = false;
    try { _hasPlaywright = _Fs.existsSync(_pwAnchor); } catch (_e) { _hasPlaywright = false; }
    var _pwCache = {};
    // Re-entrancy guard: createRequire() routes through the patched _Module._load,
    // so without this the redirect would re-intercept the same "playwright" require
    // and recurse infinitely ("Maximum call stack size exceeded"). While loading
    // the real package, nested requires (playwright-core, submodules) fall through
    // to the original loader, which resolves them relative to the real module dir.
    var _pwLoading = false;
    function _loadRealPlaywright(req) {
      if (_pwCache[req]) return _pwCache[req];
      var realReq = _Module.createRequire(_pwAnchor);
      _pwLoading = true;
      try {
        var mod = realReq(req);
        _pwCache[req] = mod;
        return mod;
      } finally {
        _pwLoading = false;
      }
    }
    var _origResolve = _Module._resolveFilename.bind(_Module);
    _Module._resolveFilename = function () {
      var req = arguments[0];
      if (typeof req === "string") {
        // Redirect better-sqlite3's addon lookups to the extracted copy.
        if (req.indexOf("better_sqlite3") !== -1) return _sqliteReal;
        // NOTE: intentionally NOT intercepting pty.node lookups here.
        // node-pty's loadNativeModule probes build/Release, build/Debug, then
        // prebuilds/<plat>-<arch> and relies on MODULE_NOT_FOUND to advance
        // through the list. Forcing a redirect made it stop at build/Release
        // even after that dir was stripped from the bundle (notarization fix),
        // so spawn-helper resolution went to a non-existent path. The
        // process.dlopen hook below still redirects the actual pty.node
        // binary load to _ptyReal, which is all we need.
      }
      return _origResolve.apply(_Module, arguments);
    };
    var _origLoad = _Module._load.bind(_Module);
    _Module._load = function () {
      var req = arguments[0];
      if (typeof req === "string" && (req === "node-pty" || req.indexOf("node-pty/") === 0)) {
        return _loadRealNodePty();
      }
      if (!_pwLoading && _hasPlaywright && typeof req === "string" && (req === "playwright" || req === "playwright-core" || req.indexOf("playwright/") === 0 || req.indexOf("playwright-core/") === 0)) {
        return _loadRealPlaywright(req);
      }
      return _origLoad.apply(_Module, arguments);
    };
    var _origDlopen = process.dlopen.bind(process);
    process.dlopen = function (mod, filename, flags) {
      if (filename && filename.indexOf("better_sqlite3") !== -1) {
        return _origDlopen(mod, _sqliteReal, flags == null ? 1 : flags);
      }
      // Windows: pty.node has co-located DLL deps (winpty.dll, conpty.node, ...)
      // that only exist inside prebuilds/win32-<arch>/. Redirecting to the root
      // copy makes LoadLibrary fail to find those deps → terminal never opens.
      // Let node-gyp-build resolve to the prebuilds path on Windows.
      if (filename && filename.slice(-8) === "pty.node" && process.platform !== "win32") {
        return _origDlopen(mod, _ptyReal, flags == null ? 1 : flags);
      }
      return _origDlopen(mod, filename, flags == null ? 1 : flags);
    };
    try {
      process.stderr.write("[pkg-patches] native-addon hijacks installed (resources=" + _resourcesDir + ")\\n");
    } catch (_e) {}
  })();
}
/* END pkg native-addon hijack */
`

// ─── node-pty helpers ────────────────────────────────────────────────────────

function copyDirSync(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  // Avoid Node native traversal/overwrite bugs on Windows Unicode paths.
  // FICLONE falls back to a normal copy when cloning is unavailable.
  fs.cpSync(src, dest, { filter: () => true, mode: fs.constants.COPYFILE_FICLONE, recursive: true, dereference: false })
}

/** Recursively delete every directory named `name` under `root`. */
function removeDirsByName(root, name) {
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = path.join(root, e.name)
    if (e.name === name) fs.rmSync(p, { recursive: true, force: true })
    else removeDirsByName(p, name)
  }
}

/** Collect every `*.node` file under `root` (transitive native addons). */
function findNodeAddons(root) {
  const out = []
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) out.push(...findNodeAddons(p))
    else if (e.name.endsWith('.node')) out.push(p)
  }
  return out
}

function ensureSpawnHelperExecutable(nodePtyDir) {
  if (process.platform === 'win32') return
  const prebuildsDir = path.join(nodePtyDir, 'prebuilds')
  if (!fs.existsSync(prebuildsDir)) return
  for (const entry of fs.readdirSync(prebuildsDir)) {
    const helper = path.join(prebuildsDir, entry, 'spawn-helper')
    if (fs.existsSync(helper)) {
      try { fs.chmodSync(helper, 0o755) } catch {}
    }
  }
}

function resolvePtyAddonForTriple(triple, nodePtySrc) {
  const sub = prebuildPlatformArch(triple)
  if (!sub) return null
  const p = path.join(nodePtySrc, 'prebuilds', sub, 'pty.node')
  if (!fs.existsSync(p)) return null
  return p
}

/** Rust target triple → the `<platform>-<arch>` directory name used by
 *  node-pty's `prebuilds/` layout (and by node-gyp-build at runtime). */
function prebuildPlatformArch(triple) {
  switch (triple) {
    case 'aarch64-apple-darwin':      return 'darwin-arm64'
    case 'x86_64-apple-darwin':       return 'darwin-x64'
    case 'x86_64-pc-windows-msvc':    return 'win32-x64'
    case 'aarch64-pc-windows-msvc':   return 'win32-arm64'
    case 'x86_64-unknown-linux-gnu':  return 'linux-x64'
    case 'aarch64-unknown-linux-gnu': return 'linux-arm64'
    default:                          return null
  }
}

// ─── Download better-sqlite3 Node 22 compatible prebuild ─────────────────────
// pkg uses Node 22 (MODULE_VERSION 127). The locally compiled .node may target
// a different Node version. Always download the matching prebuild from GitHub.

async function downloadSqliteAddonForNode22(triple) {
  // Map Rust triple → better-sqlite3 prebuild platform-arch
  const platformMap = {
    'aarch64-apple-darwin':       { platform: 'darwin', arch: 'arm64' },
    'x86_64-apple-darwin':        { platform: 'darwin', arch: 'x64' },
    'x86_64-pc-windows-msvc':     { platform: 'win32',  arch: 'x64' },
    'aarch64-pc-windows-msvc':    { platform: 'win32',  arch: 'arm64' },
    'x86_64-unknown-linux-gnu':   { platform: 'linux',  arch: 'x64' },
    'aarch64-unknown-linux-gnu':  { platform: 'linux',  arch: 'arm64' },
  }
  const plat = platformMap[triple]
  if (!plat) throw new Error(`No platform mapping for triple: ${triple}`)

  // better-sqlite3 version from package.json
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8'))
  const bsVersion = pkgJson.version  // e.g. "12.8.0"
  // Node 22 MODULE_VERSION = 127
  const nodeModuleVersion = 127
  const fileName = `better-sqlite3-v${bsVersion}-node-v${nodeModuleVersion}-${plat.platform}-${plat.arch}.tar.gz`
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsVersion}/${fileName}`

  const destDir = path.join(BUILD_DIR, 'sqlite-prebuild')
  const tarPath = path.join(destDir, fileName)
  const addonPath = path.join(destDir, 'better_sqlite3.node')

  // Return cached download if present
  if (fs.existsSync(addonPath)) {
    console.log(`  Cached prebuild: ${addonPath}`)
    return addonPath
  }

  fs.mkdirSync(destDir, { recursive: true })

  console.log(`  Downloading ${url}`)
  // Use curl (available on all target platforms in CI)
  execSync(`curl -fsSL "${url}" -o "${tarPath}"`, { stdio: 'inherit' })

  // Extract: the .node file is at build/Release/better_sqlite3.node inside the tarball
  // --strip-components=2 removes "build/Release/" prefix → file lands as better_sqlite3.node
  //
  // cwd=destDir with a relative tar filename sidesteps a GNU-tar-on-Windows
  // quirk where a Windows absolute path like "D:\a\..." is interpreted as a
  // remote-host spec ("host:path") and fails with "Cannot connect to D:".
  execSync(`tar -xzf "${fileName}" --strip-components=2 build/Release/better_sqlite3.node`, {
    stdio: 'inherit',
    cwd: destDir,
  })

  if (!fs.existsSync(addonPath)) {
    throw new Error(`Extraction failed — ${addonPath} not found after tar`)
  }
  console.log(`  Extracted to ${addonPath}`)
  return addonPath
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Specrails Sidecar Build ===\n')

  const triple = getTargetTriple()
  const pkgTarget = getPkgTarget(triple)
  console.log(`Rust target:  ${triple}`)
  console.log(`pkg target:   ${pkgTarget}`)
  console.log(`Node:         ${process.version}`)

  ensureDir(BUILD_DIR)
  ensureDir(BINARIES_DIR)

  // Step 0: Patch node-pty to remove POSIX_SPAWN_CLOEXEC_DEFAULT (pkg-Node
  // incompatibility) and rebuild its native addon. Idempotent — no-op if already patched.
  console.log('\n[0] Patching node-pty for pkg-Node compatibility...')
  const { execSync: _execSync } = await import('node:child_process')
  _execSync(`node "${path.join(ROOT, 'scripts', 'patch-node-pty.mjs')}"`, { stdio: 'inherit' })

  // Step 1: Bundle with esbuild
  // CRITICAL: the pkg-native-addon hijacks must run BEFORE the bundle's hoisted
  // `require('node-pty')` statement. We inject them as a raw-JS banner so they
  // execute before any other bundle code.
  console.log('\n[1/3] Bundling server with esbuild...')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [path.join(ROOT, 'server', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: BUNDLE_PATH,
    external: ['better-sqlite3', 'fsevents', 'node-pty', '@aws-sdk/client-s3', 'read-excel-file/node', 'pdf-parse', 'playwright', 'playwright-core'],
    banner: { js: PKG_RUNTIME_PATCHES },
    minify: false,
    sourcemap: false,
    target: 'node22',
    logLevel: 'info',
  })
  console.log(`  Bundled to ${BUNDLE_PATH}`)

  // Step 2: Package with @yao-pkg/pkg
  console.log('\n[2/3] Packaging with @yao-pkg/pkg...')
  console.log('  (First run downloads a pre-patched Node binary — may take a moment)')

  const isWindows = process.platform === 'win32'
  const binaryExt = isWindows ? '.exe' : ''
  const outputName = `specrails-server-${triple}${binaryExt}`
  const outputPath = path.join(BINARIES_DIR, outputName)

  // Download Node 22 compatible better-sqlite3 prebuild (MODULE_VERSION 127)
  // pkg bundles Node 22 — we must use a .node compiled for that ABI, not the
  // locally installed one which may target a different Node version.
  const sqliteAddon = await downloadSqliteAddonForNode22(triple)

  // Write a pkg config so the .node addon lands at the virtual path
  // that node-gyp-build expects: /snapshot/node_modules/better-sqlite3/build/Release/
  const pkgConfigPath = path.join(ROOT, 'pkg.config.json')
  const pkgConfig = {
    assets: [
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'docs/**/*',
    ],
  }
  fs.writeFileSync(pkgConfigPath, JSON.stringify(pkgConfig, null, 2))
  console.log(`  pkg config: ${pkgConfigPath}`)

  run(
    `npx --yes @yao-pkg/pkg "${BUNDLE_PATH}" --targets ${pkgTarget} --output "${outputPath}" --no-bytecode --public --config "${pkgConfigPath}"`.trim()
  )
  console.log(`  Binary: ${outputPath}`)

  // Step 3: Copy better-sqlite3 .node addon alongside binary (runtime fallback)
  console.log('\n[3/3] Copying better-sqlite3 native addon (Node 22 compatible)...')
  const addonDest = path.join(BINARIES_DIR, 'better_sqlite3.node')
  fs.copyFileSync(sqliteAddon, addonDest)
  console.log(`  ${sqliteAddon} → ${addonDest}`)

  // Step 3a: Copy shell-integration shims so the packaged sidecar can locate
  // them at runtime via path.resolve(process.execPath, '..', 'shell-integration', name).
  const shellSrc = path.join(ROOT, 'server', 'shell-integration')
  const shellDest = path.join(BINARIES_DIR, 'shell-integration')
  if (fs.existsSync(shellSrc)) {
    copyDirSync(shellSrc, shellDest)
    console.log(`  ${shellSrc} → ${shellDest}`)
  }

  // Step 3b: Copy node-pty package externally so its spawn-helper resolves on real fs.
  // We load node-pty via createRequire from this location at runtime (see server/index.ts).
  console.log('\n[3b] Copying node-pty package and native addon...')
  const nodePtySrc = path.join(ROOT, 'node_modules', 'node-pty')
  const nodePtyDest = path.join(BINARIES_DIR, 'node-pty')
  copyDirSync(nodePtySrc, nodePtyDest)
  // Purge node-gyp intermediate outputs — they contain unsigned duplicates of
  // pty.node + spawn-helper under build/Release/ that Apple notarization
  // rejects with "binary is not signed with a valid Developer ID certificate"
  // and "signature does not include a secure timestamp". The signed copies
  // live under prebuilds/<platform>-<arch>/ and are what node-pty actually
  // resolves at runtime via node-gyp-build.
  fs.rmSync(path.join(nodePtyDest, 'build'), { recursive: true, force: true })

  // Trim ~60 MB of dead weight from the .app bundle: other platforms'
  // prebuilds (win32-arm64 + win32-x64 alone are 58 MB), Windows-only
  // runtime deps (deps/winpty, third_party/conpty), and dev-only files
  // (C++ sources, install scripts, node-addon-api headers, typings).
  // node-pty only needs `lib/`, `package.json`, and the prebuild matching
  // the current Rust target triple.
  const prebuildsDir = path.join(nodePtyDest, 'prebuilds')
  const keepPrebuild = prebuildPlatformArch(triple)
  if (fs.existsSync(prebuildsDir)) {
    for (const entry of fs.readdirSync(prebuildsDir)) {
      if (entry !== keepPrebuild) {
        fs.rmSync(path.join(prebuildsDir, entry), { recursive: true, force: true })
      }
    }
  }
  for (const junk of ['src', 'deps', 'third_party', 'scripts', 'node-addon-api', 'typings', 'binding.gyp', 'tsconfig.json', '.github', '.vscode', '.drone.yml']) {
    fs.rmSync(path.join(nodePtyDest, junk), { recursive: true, force: true })
  }
  // node-pty's prebuilds occasionally lose the +x bit during extraction — restore it
  // for spawn-helper so posix_spawnp succeeds at runtime.
  ensureSpawnHelperExecutable(nodePtyDest)
  if (keepPrebuild?.startsWith('win32-')) {
    stageWindowsPty(nodePtyDest, keepPrebuild.slice('win32-'.length))
  }
  // Also copy pty.node to BINARIES_DIR root for the Module._resolveFilename redirect path.
  const ptyAddonSrc = resolvePtyAddonForTriple(triple, nodePtySrc)
  const ptyAddonDest = path.join(BINARIES_DIR, 'pty.node')
  if (ptyAddonSrc) {
    fs.copyFileSync(ptyAddonSrc, ptyAddonDest)
    console.log(`  ${ptyAddonSrc} → ${ptyAddonDest}`)
  } else {
    console.warn(`  WARN: no pty.node prebuild found for ${triple} — terminal panel will be unavailable in this sidecar`)
  }

  // Step 3c: Copy Playwright (browser-capture feature) externally so require()
  // resolves on the real fs inside the packaged sidecar (mirrors node-pty). The
  // Chromium *browser binary* is shipped separately under runtimes/chromium (when
  // BUNDLE_CHROMIUM=true) or downloaded by Playwright on first use; this only
  // ships the JS driver.
  console.log('\n[3c] Copying Playwright packages...')
  const pwNodeModulesDest = path.join(BINARIES_DIR, 'node_modules')
  ensureDir(pwNodeModulesDest)
  for (const pkg of ['playwright', 'playwright-core']) {
    const src = path.join(ROOT, 'node_modules', pkg)
    if (!fs.existsSync(src)) {
      console.warn(`  WARN: ${pkg} not found in node_modules — browser-capture will be unavailable in this sidecar`)
      continue
    }
    const dest = path.join(pwNodeModulesDest, pkg)
    copyDirSync(src, dest)
    // Defensive: drop any in-package browser cache (browsers live in ~/.cache).
    fs.rmSync(path.join(dest, '.local-browsers'), { recursive: true, force: true })
    // Drop `fsevents` — a transitive, optional macOS-only native addon. Its
    // unsigned fsevents.node fails Apple notarization, and the browser-capture
    // path (launch + screencast + screenshot/DOM) never needs file watching.
    fs.rmSync(path.join(dest, 'node_modules', 'fsevents'), { recursive: true, force: true })
    console.log(`  ${src} → ${dest}`)
  }
  // Belt-and-suspenders: remove any remaining nested fsevents anywhere under the
  // copied node_modules (npm layout can vary across versions).
  removeDirsByName(pwNodeModulesDest, 'fsevents')

  // Step 4: Codesign sidecar + .node addons (macOS only, requires APPLE_SIGNING_IDENTITY)
  // Apple notarization rejects bundles with unsigned binaries or binaries missing
  // hardened runtime + secure timestamp. We sign all native artifacts here so Tauri can
  // either keep our signatures or re-sign them with the same identity.
  // The entitlements allow JIT (V8) + unsigned memory + library validation bypass
  // which are required for pkg-compiled Node.js binaries and native .node addons.
  const signingIdentity = process.env.APPLE_SIGNING_IDENTITY
  if (process.platform === 'darwin' && signingIdentity) {
    const entitlementsPath = path.join(ROOT, 'src-tauri', 'entitlements.plist')
    console.log('\n[4/4] Codesigning sidecar and native addons for notarization...')

    // Sign the sidecar binary with hardened runtime + entitlements
    run(`codesign --force --sign "${signingIdentity}" --options runtime --entitlements "${entitlementsPath}" --timestamp "${outputPath}"`)
    console.log(`  Signed: ${outputPath}`)

    // Sign the .node addons (native Mach-O shared libs) — must be signed for notarization
    run(`codesign --force --sign "${signingIdentity}" --timestamp "${addonDest}"`)
    console.log(`  Signed: ${addonDest}`)

    if (fs.existsSync(ptyAddonDest)) {
      run(`codesign --force --sign "${signingIdentity}" --timestamp "${ptyAddonDest}"`)
      console.log(`  Signed: ${ptyAddonDest}`)
    }

    // Sign node-pty's prebuild + spawn-helper binaries inside the extracted dir.
    // spawn-helper is a Mach-O executable that node-pty invokes via posix_spawnp.
    const ptyPrebuiltDir = path.join(nodePtyDest, 'prebuilds')
    if (fs.existsSync(ptyPrebuiltDir)) {
      for (const entry of fs.readdirSync(ptyPrebuiltDir)) {
        const dir = path.join(ptyPrebuiltDir, entry)
        const pty = path.join(dir, 'pty.node')
        const helper = path.join(dir, 'spawn-helper')
        if (fs.existsSync(pty)) {
          run(`codesign --force --sign "${signingIdentity}" --timestamp "${pty}"`)
          console.log(`  Signed: ${pty}`)
        }
        if (fs.existsSync(helper)) {
          run(`codesign --force --sign "${signingIdentity}" --options runtime --entitlements "${entitlementsPath}" --timestamp "${helper}"`)
          console.log(`  Signed: ${helper}`)
        }
      }
    }

    // Sign any remaining native addons under binaries/node_modules (e.g. a
    // transitive `*.node` pulled in by Playwright). fsevents is trimmed above,
    // but this future-proofs notarization against any other native dep.
    for (const addon of findNodeAddons(path.join(BINARIES_DIR, 'node_modules'))) {
      run(`codesign --force --sign "${signingIdentity}" --timestamp "${addon}"`)
      console.log(`  Signed: ${addon}`)
    }
  } else if (process.platform === 'darwin') {
    console.log('\n[4/4] Skipping codesign (APPLE_SIGNING_IDENTITY not set — local build)')
  }

  console.log(`\n=== Sidecar build complete ===`)
  console.log(`  Binary: ${outputPath}`)
  console.log('')
}

main().catch((err) => {
  console.error('\nSidecar build failed:', err.message || err)
  process.exit(1)
})
