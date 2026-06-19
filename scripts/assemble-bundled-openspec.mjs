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
 * So we cannot just `npm pack` + extract — we `npm install` it into a temp
 * prefix (which resolves its node_modules) and copy the whole `node_modules`
 * tree. The bundled CLI entry is therefore:
 *   src-tauri/openspec/node_modules/@fission-ai/openspec/bin/openspec.js
 * (the `bin.openspec` field from openspec's own package.json).
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
 * Default version: 1.4.1 (pinned to match specrails-core's pinned-versions.json).
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
const DEFAULT_VERSION = '1.4.1'

function parseArgs(argv) {
  let version = DEFAULT_VERSION
  let dest = path.join(repoRoot, 'src-tauri', 'openspec')
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dest') {
      dest = path.resolve(argv[++i])
    } else if (!a.startsWith('-')) {
      version = a
    }
  }
  return { version, dest }
}

function main() {
  const { version, dest } = parseArgs(process.argv.slice(2))
  const spec = `${PACKAGE}@${version}`
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bundled-openspec-'))
  try {
    // npm install resolves openspec + its runtime deps into <tmp>/node_modules.
    // A minimal package.json keeps the install isolated (no workspace bleed).
    writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'bundled-openspec-stage', private: true, version: '0.0.0' }),
    )
    console.log(`[assemble-bundled-openspec] npm install ${spec} → ${tmp}`)
    // On Windows npm is `npm.cmd`; Node 20.12+ (CVE-2024-27980) refuses to
    // spawn a `.cmd` without a shell (EINVAL), so run through the shell there —
    // the shell resolves `npm` → `npm.cmd` from PATH. POSIX spawns directly.
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
