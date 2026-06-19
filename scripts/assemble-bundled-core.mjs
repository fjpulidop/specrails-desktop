#!/usr/bin/env node
/**
 * Stage specrails-core into `src-tauri/core/` so Tauri bundles it as a resource
 * (`bundle.resources` glob `core/**\/*`). This is the offline source the desktop
 * FrameworkManager materializes from — eliminating the per-project
 * `npx specrails-core init` network round-trip.
 *
 * This MIRRORS `assemble-bundled-openspec.mjs` (and the runtimes-assembly steps
 * in `.github/workflows/desktop-release.yml`): CI stages a self-contained tree
 * under `src-tauri/<name>/` BEFORE `tauri build` runs.
 *
 * WHY `npm install` (not `npm pack`): the published specrails-core tarball does
 * NOT contain `node_modules`, but core has runtime dependencies (picocolors,
 * ajv, js-yaml, @inquirer/prompts). `npm pack` + extract therefore produced a
 * tree whose `node <cli>` invocation crashed with ERR_MODULE_NOT_FOUND on the
 * first `import 'picocolors'`. We `npm install specrails-core@<spec>` into a
 * temp prefix (which resolves the full dependency closure into node_modules) and
 * copy the WHOLE installed package tree — dist + templates + commands + bin +
 * package.json + pinned-versions.json + node_modules — into `src-tauri/core/`.
 *
 * Like the runtimes/openspec, this tree is PLAIN TEXT/JS — no Mach-O, no exec
 * bits, no codesigning (it is loaded with the bundled/system node via
 * `node <cli>`, not run as a standalone binary). Tauri's symlink-dereference
 * caveat (#13219) is a non-issue: a fresh `npm install` of a package free of
 * internal symlinks produces a plain tree (the `node_modules/.bin` symlinks are
 * never needed by our node-script invocation).
 *
 * A SMOKE CHECK at the end runs `node <staged>/dist/installer/cli.js --help` and
 * FAILS the script on a non-zero exit / ERR_MODULE_NOT_FOUND — so a missing
 * dependency can never silently ship into a release bundle.
 *
 * Usage:
 *   node scripts/assemble-bundled-core.mjs [<version|spec>] [--dest <dir>]
 *
 * Default version: `latest`. The version may be any npm spec
 * (`specrails-core@4.8.2`, `4.8.2`, `latest`, `^4.8.0`, or a local tarball path).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
 * WHY: npm populates `.bin` with symlinks to package executables. `cpSync`
 * rewrites those symlinks to ABSOLUTE paths pointing back into the (about-to-be
 * deleted) temp install prefix, so the staged copy ends up with DANGLING links.
 * Tauri then fails the build enumerating `bundle.resources` with
 * `resource path .../node_modules/.bin/<x> doesn't exist`. The `.bin` shims are
 * never used by our `node <cli>` invocation, so pruning them is safe and is the
 * stated intent of the assembly (see the symlink note in the file header).
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

const PACKAGE = 'specrails-core'
const DEFAULT_VERSION = 'latest'

function parseArgs(argv) {
  let spec = DEFAULT_VERSION
  let dest = path.join(repoRoot, 'src-tauri', 'core')
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dest') {
      dest = path.resolve(argv[++i])
    } else if (!a.startsWith('-')) {
      spec = a
    }
  }
  // Normalize a bare version / range to a package spec; leave a full spec
  // (`specrails-core@…`) or a local tarball path untouched.
  if (spec === 'latest' || /^[\d^~]/.test(spec)) {
    spec = `${PACKAGE}@${spec}`
  }
  return { spec, dest }
}

/**
 * Files/dirs the desktop bundled-core path needs at runtime. node_modules is
 * handled separately (it is the WHOLE point of the install-based assembly).
 */
const STAGED_ENTRIES = [
  'dist',
  'templates',
  'commands',
  'bin',
  'schemas',
  'integration-contract.json',
  'package.json',
  'pinned-versions.json',
]

function main() {
  const { spec, dest } = parseArgs(process.argv.slice(2))
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bundled-core-'))
  try {
    // npm install resolves core + its runtime deps into <tmp>/node_modules.
    // A minimal package.json keeps the install isolated (no workspace bleed).
    writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'bundled-core-stage', private: true, version: '0.0.0' }),
    )
    console.log(`[assemble-bundled-core] npm install ${spec} → ${tmp}`)
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [
        'install',
        spec,
        '--no-audit',
        '--no-fund',
        '--no-save',
        '--ignore-scripts',
        '--silent',
      ],
      { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
    )

    const nodeModules = path.join(tmp, 'node_modules')
    const pkgDir = path.join(nodeModules, PACKAGE)
    if (!existsSync(pkgDir)) {
      throw new Error(`bundled-core: npm install did not produce ${pkgDir}`)
    }

    // Stage the runtime-needed entries from the INSTALLED package into dest
    // (clean first).
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    for (const entry of STAGED_ENTRIES) {
      const src = path.join(pkgDir, entry)
      if (!existsSync(src)) {
        if (entry === 'package.json' || entry === 'dist') {
          throw new Error(`bundled-core: required entry "${entry}" missing from ${spec} install`)
        }
        console.log(`[assemble-bundled-core] (optional) ${entry} not present — skipping`)
        continue
      }
      cpSync(src, path.join(dest, entry), { recursive: true })
    }

    // Stage the FULL dependency tree. The package's own node_modules (nested
    // deps) plus the hoisted deps at the install root both matter — copy the
    // hoisted root tree, then overlay any package-local node_modules.
    cpSync(nodeModules, path.join(dest, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    })
    const pkgLocalModules = path.join(pkgDir, 'node_modules')
    if (existsSync(pkgLocalModules)) {
      cpSync(pkgLocalModules, path.join(dest, 'node_modules'), {
        recursive: true,
        verbatimSymlinks: true,
      })
    }
    // Drop the npm `.bin` shims — they are dangling after the copy and Tauri
    // refuses to bundle a non-existent resource path. Never used at runtime.
    pruneBinDirs(path.join(dest, 'node_modules'))
    // The staged node_modules must not contain the package itself referencing
    // its own stale copy — but cpSync of the hoisted tree already includes
    // `node_modules/specrails-core`; that is harmless (we run dist/ from dest,
    // not from node_modules). Leave it for npm-resolution completeness.

    // Sanity-check the staged CLI exists where bundled-core.ts expects it.
    const cliPath = path.join(dest, 'dist', 'installer', 'cli.js')
    if (!existsSync(cliPath)) {
      throw new Error(`bundled-core: staged tree is missing dist/installer/cli.js at ${cliPath}`)
    }

    // ─── SMOKE CHECK ──────────────────────────────────────────────────────────
    // Run the staged CLI with --help using the SAME node. This catches a missing
    // runtime dependency (ERR_MODULE_NOT_FOUND) that the old `npm pack` path
    // shipped silently. Fail the whole script on non-zero / module-not-found.
    console.log(`[assemble-bundled-core] smoke: node ${cliPath} --help`)
    const smoke = spawnSync(process.execPath, [cliPath, '--help'], {
      encoding: 'utf8',
      timeout: 60_000,
      // Run from the staged dest so node resolves node_modules from there.
      cwd: dest,
    })
    const smokeOut = `${smoke.stdout ?? ''}\n${smoke.stderr ?? ''}`
    if (smoke.error) {
      throw new Error(`bundled-core SMOKE failed to spawn: ${smoke.error.message}`)
    }
    if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(smokeOut)) {
      throw new Error(
        `bundled-core SMOKE detected a missing dependency in the staged tree:\n${smokeOut.trim()}`,
      )
    }
    if ((smoke.status ?? 1) !== 0) {
      throw new Error(
        `bundled-core SMOKE exited ${smoke.status} (expected 0):\n${smokeOut.trim()}`,
      )
    }

    const version = JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8')).version
    const staged = readdirSync(dest)
    const nmCount = existsSync(path.join(dest, 'node_modules'))
      ? readdirSync(path.join(dest, 'node_modules')).length
      : 0
    console.log(
      `[assemble-bundled-core] staged ${PACKAGE}@${version} → ${dest} ` +
        `(${staged.join(', ')}; node_modules: ${nmCount} entries; smoke OK)`,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main()
