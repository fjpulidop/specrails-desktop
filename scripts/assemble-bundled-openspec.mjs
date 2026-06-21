#!/usr/bin/env node
/**
 * Stage `@fission-ai/openspec` into `src-tauri/openspec/` so Tauri bundles it as
 * a resource (`bundle.resources` glob `openspec/**\/*`). This is the offline
 * source for the LAST network step of project-add: the bundled specrails-core
 * `init` runs `openspec init` from this tree instead of `npx @fission-ai/openspec`
 * — making project-add FULLY OFFLINE.
 *
 * This MIRRORS `assemble-bundled-core.mjs` (Phase 3) and the runtimes-assembly
 * steps in `.github/workflows/desktop-release.yml`: CI stages a self-contained
 * tree under `src-tauri/<name>/` BEFORE `tauri build` runs.
 *
 * UNLIKE specrails-core (a single published tarball with no runtime deps),
 * openspec is an ESM CLI WITH runtime dependencies (commander, zod, chalk, …).
 * So we cannot just `npm pack` + extract — we resolve its node_modules into a
 * temp prefix and copy the whole `node_modules` tree. The bundled CLI entry is:
 *   src-tauri/openspec/node_modules/@fission-ai/openspec/bin/openspec.js
 * (the `bin.openspec` field from openspec's own package.json).
 *
 * WHY `npm ci` against a VENDORED lockfile (not `npm install`): a bare
 * `npm install <top-level>` resolves the entire transitive closure against the
 * live registry every build with NO captured integrity, so a compromised
 * transitive version published before a build would be silently bundled into the
 * signed+notarized installer, and builds are non-reproducible (BUG-CI-03). We
 * commit `assemble-bundled-openspec.lock.json` (a real npm v3 lockfile with
 * resolved versions + integrity for the WHOLE closure) next to this script, write
 * it + a matching `package.json` into the temp prefix, and run `npm ci` — which
 * installs EXACTLY the locked tree (pinned + integrity) and fails if package.json
 * and the lockfile disagree. Lock changes are reviewed in PRs. The vendored
 * lockfile is the source of truth for the bundled-openspec version; the CLI
 * `<version>` arg (and OPENSPEC_BUNDLE_VERSION in CI) MUST match it or this script
 * fails fast.
 *
 * Like the runtimes/core, this tree is PLAIN JS — no Mach-O, no exec bits, no
 * codesigning. It is run with `node <cli> init …` (the desktop bundled-core init
 * sets SPECRAILS_OPENSPEC_NODE so specrails-core invokes it as a node script,
 * since Tauri strips exec bits from bundled resources). Tauri's
 * symlink-dereference caveat (#13219) is a non-issue: a fresh `npm install` of a
 * dep-free-of-internal-symlinks package produces a plain tree (npm bin symlinks
 * under node_modules/.bin are not needed by our node-script invocation).
 *
 * Usage:
 *   node scripts/assemble-bundled-openspec.mjs [<version>] [--dest <dir>]
 *
 * The version, when given, MUST be the exact version the vendored lockfile pins
 * (1.4.1, matching specrails-core's pinned-versions.json). It is a consistency
 * assertion, NOT a resolution input — `npm ci` always installs exactly the locked
 * closure. Omitting it installs the locked version. Floating specs (`latest`,
 * `^1.4`) are rejected: the whole point is a pinned, reproducible bundle.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

/**
 * Recursively remove every `node_modules/.bin` directory under `root`.
 *
 * WHY: `cpSync` rewrites npm's `.bin` symlinks to ABSOLUTE paths into the
 * (about-to-be deleted) temp install prefix, leaving DANGLING links that make
 * Tauri fail enumerating `bundle.resources` ("resource path ... doesn't exist").
 * The `.bin` shims are never used by our `node <cli>` invocation.
 */
function pruneBinDirs(root) {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (!entry.isDirectory()) continue
    if (entry.name === '.bin') {
      rmSync(full, { recursive: true, force: true })
      continue
    }
    pruneBinDirs(full)
  }
}

const PACKAGE = '@fission-ai/openspec'
// The committed lockfile + its matching package.json that `npm ci` consumes.
const LOCKFILE = path.join(__dirname, 'assemble-bundled-openspec.lock.json')

/**
 * Read the EXACT version the vendored lockfile pins for the top-level package.
 * This is the single source of truth for the bundled-openspec version.
 */
function lockedVersion() {
  const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'))
  const declared = lock.packages?.['']?.dependencies?.[PACKAGE]
  const resolved = lock.packages?.[`node_modules/${PACKAGE}`]?.version
  if (!resolved) {
    throw new Error(
      `bundled-openspec: lockfile ${LOCKFILE} does not resolve ${PACKAGE} — regenerate it`,
    )
  }
  if (declared !== resolved) {
    throw new Error(
      `bundled-openspec: lockfile declares ${PACKAGE}@${declared} but resolves ${resolved} — regenerate it`,
    )
  }
  return resolved
}

/**
 * Accept a bare version (`1.4.1`) or a `@fission-ai/openspec@<version>` spec;
 * reject floating ranges/tags — a reproducible bundle requires an exact pin that
 * matches the vendored lockfile.
 */
function normalizeRequestedVersion(raw) {
  let v = raw
  if (v.startsWith(`${PACKAGE}@`)) v = v.slice(PACKAGE.length + 1)
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v)) {
    throw new Error(
      `bundled-openspec: version "${raw}" is not an exact version. Pass the exact ` +
        `version the lockfile pins (e.g. ${PACKAGE}@<x.y.z>), or omit it. ` +
        `Floating specs (latest, ^, ~, ranges) are rejected for reproducibility.`,
    )
  }
  return v
}

function parseArgs(argv) {
  let requested = null
  let dest = path.join(repoRoot, 'src-tauri', 'openspec')
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dest') {
      dest = path.resolve(argv[++i])
    } else if (!a.startsWith('-')) {
      requested = a
    }
  }
  const locked = lockedVersion()
  if (requested !== null) {
    const want = normalizeRequestedVersion(requested)
    if (want !== locked) {
      throw new Error(
        `bundled-openspec: requested ${PACKAGE}@${want} but the vendored lockfile ` +
          `pins ${locked}. Update assemble-bundled-openspec.lock.json (and ` +
          `OPENSPEC_BUNDLE_VERSION) together so the bundle stays reproducible.`,
      )
    }
  }
  return { version: locked, dest }
}

function main() {
  const { version, dest } = parseArgs(process.argv.slice(2))
  const spec = `${PACKAGE}@${version}`
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bundled-openspec-'))
  try {
    // `npm ci` requires BOTH a package.json and a package-lock.json that agree.
    // We write a package.json declaring the locked top-level dep and copy the
    // VENDORED lockfile (resolved versions + integrity for the whole closure)
    // next to it, then `npm ci` installs EXACTLY that locked tree — pinned +
    // integrity-verified + reproducible (BUG-CI-03). A minimal package.json keeps
    // the install isolated (no workspace bleed).
    writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'bundled-openspec-stage',
        private: true,
        version: '0.0.0',
        dependencies: { [PACKAGE]: version },
      }),
    )
    cpSync(LOCKFILE, path.join(tmp, 'package-lock.json'))
    console.log(`[assemble-bundled-openspec] npm ci ${spec} (vendored lock) → ${tmp}`)
    // On Windows npm is `npm.cmd`; Node 20.12+ (CVE-2024-27980) refuses to
    // spawn a `.cmd` without a shell (EINVAL), so run through the shell there —
    // the shell resolves `npm` → `npm.cmd` from PATH. POSIX spawns directly.
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [
        'ci',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--silent',
      ],
      {
        cwd: tmp,
        encoding: 'utf8',
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: process.platform === 'win32',
      },
    )

    const nodeModules = path.join(tmp, 'node_modules')
    const pkgDir = path.join(nodeModules, '@fission-ai', 'openspec')
    if (!existsSync(pkgDir)) {
      throw new Error(`bundled-openspec: npm install did not produce ${pkgDir}`)
    }
    // Resolve the CLI entry from the package's own bin field.
    const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const binField = pkgJson.bin
    const binRel = typeof binField === 'string' ? binField : binField?.openspec
    if (!binRel) {
      throw new Error('bundled-openspec: package.json has no bin.openspec entry')
    }

    // Stage the whole node_modules tree (deps included) into dest (clean first).
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    cpSync(nodeModules, path.join(dest, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    })
    // Drop the npm `.bin` shims — they are dangling after the copy and Tauri
    // refuses to bundle a non-existent resource path. Never used at runtime.
    pruneBinDirs(path.join(dest, 'node_modules'))

    // Assert the CLI entry exists where bundled-openspec.ts will look for it.
    const stagedCli = path.join(dest, 'node_modules', '@fission-ai', 'openspec', binRel)
    if (!existsSync(stagedCli)) {
      throw new Error(`bundled-openspec: staged tree is missing CLI entry at ${stagedCli}`)
    }
    const staged = readdirSync(path.join(dest, 'node_modules'))
    console.log(
      `[assemble-bundled-openspec] staged ${spec} → ${dest} ` +
        `(node_modules: ${staged.length} entries; cli=${path.relative(dest, stagedCli)})`,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main()
