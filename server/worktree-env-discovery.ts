import fs from 'fs'
import path from 'path'
import { WORKTREE_ENV_NAME_RE } from './db'

export type EnvDiscoveryConfidence = 'high' | 'medium'

export interface EnvDiscoveryCandidate {
  name: string
  confidence: EnvDiscoveryConfidence
  reasons: string[]
  files: string[]
}

export interface EnvDiscoveryResult {
  candidates: EnvDiscoveryCandidate[]
  scannedFiles: string[]
  skipped: string[]
}

const MAX_FILES = 250
const MAX_DEPTH = 4
const MAX_FILE_BYTES = 512 * 1024

const SCANNED_FILENAMES = new Set([
  '.npmrc',
  '.yarnrc.yml',
  '.yarnrc',
  '.pnpmrc',
  'package.json',
  'pnpm-workspace.yaml',
  'npm-shrinkwrap.json',
])

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.specrails',
])

const ENV_REF_RE =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g

function addCandidate(
  map: Map<string, EnvDiscoveryCandidate>,
  name: string,
  confidence: EnvDiscoveryConfidence,
  reason: string,
  file: string,
): void {
  if (!WORKTREE_ENV_NAME_RE.test(name)) return
  const existing = map.get(name)
  if (!existing) {
    map.set(name, { name, confidence, reasons: [reason], files: [file] })
    return
  }
  if (confidence === 'high') existing.confidence = 'high'
  if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
  if (!existing.files.includes(file)) existing.files.push(file)
}

function walk(root: string): { files: string[]; skipped: string[] } {
  const files: string[] = []
  const skipped: string[] = []
  const visit = (dir: string, depth: number): void => {
    if (files.length >= MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      skipped.push(path.relative(root, dir) || '.')
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH || SKIP_DIRS.has(entry.name)) continue
        visit(abs, depth + 1)
      } else if (entry.isFile() && SCANNED_FILENAMES.has(entry.name)) {
        files.push(abs)
      }
    }
  }
  visit(root, 0)
  return { files, skipped }
}

function readSmallText(file: string): string | null {
  try {
    const st = fs.statSync(file)
    if (st.size > MAX_FILE_BYTES) return null
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function scanEnvReferences(raw: string, rel: string, candidates: Map<string, EnvDiscoveryCandidate>): void {
  for (const match of raw.matchAll(ENV_REF_RE)) {
    const name = match[1] ?? match[2] ?? match[3]
    if (!name) continue
    addCandidate(candidates, name, 'high', 'Referenced explicitly by the repository configuration', rel)
  }
}

function packageScopes(pkg: Record<string, unknown>): Set<string> {
  const scopes = new Set<string>()
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[key]
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      const m = /^(@[^/]+)\//.exec(name)
      if (m) scopes.add(m[1])
    }
  }
  return scopes
}

function scanPackageJson(raw: string, rel: string, candidates: Map<string, EnvDiscoveryCandidate>): void {
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return
  }
  const scopes = packageScopes(pkg)
  if (scopes.has('@busuu')) {
    addCandidate(candidates, 'NODE_AUTH_TOKEN', 'medium', 'Package dependencies include @busuu/* scoped packages', rel)
    addCandidate(candidates, 'NPM_TOKEN', 'medium', 'Package dependencies include @busuu/* scoped packages', rel)
  }
}

export function scanWorktreeEnvRequirements(repoDir: string): EnvDiscoveryResult {
  const { files, skipped } = walk(repoDir)
  const candidates = new Map<string, EnvDiscoveryCandidate>()
  const scannedFiles: string[] = []

  for (const file of files) {
    const raw = readSmallText(file)
    if (raw === null) {
      skipped.push(path.relative(repoDir, file) || path.basename(file))
      continue
    }
    const rel = path.relative(repoDir, file) || path.basename(file)
    scannedFiles.push(rel)
    scanEnvReferences(raw, rel, candidates)
    if (path.basename(file) === 'package.json') scanPackageJson(raw, rel, candidates)
  }

  return {
    candidates: Array.from(candidates.values()).sort((a, b) => a.name.localeCompare(b.name)),
    scannedFiles,
    skipped,
  }
}
