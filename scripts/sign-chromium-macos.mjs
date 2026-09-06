/** Distribution signing for the Chromium payload, never the user's browser cache.
 * Policy reviewed against Chromium 148.0.7778.96 chrome/app/*entitlements.plist
 * and chrome/installer/mac/signing/parts.py. See docs/ci-cd.md.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENTITLEMENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chromium-entitlements')
export function assertReviewedChromiumVersion(version) {
  if (!/^148\.\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`Chromium ${version ?? 'unknown'} needs a signing-policy review; current entitlements cover major 148`)
}
export function runMacTool(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (${result.status ?? result.error?.code}): ${(result.stderr || result.stdout || result.error?.message || '').trim()}`)
  }
  // Structured JSON from notarytool must not be polluted by stderr progress.
  // codesign's display mode writes its metadata to stderr instead.
  return result.stdout || result.stderr || ''
}

export function chromiumRole(bundle, root) {
  if (bundle === root) return 'browser'
  if (bundle.endsWith('.framework')) return 'library'
  const name = path.basename(bundle)
  if (/ Helper \((?:Aperitif )?Renderer\)\.app$/.test(name)) return 'renderer'
  if (/ Helper \((?:Aperitif )?GPU\)\.app$/.test(name)) return 'gpu'
  if (/ Helper(?: \((?:Aperitif(?: Alerts)?|Alerts)\))?\.app$/.test(name)) return 'helper'
  throw new Error(`Unsupported Chromium code bundle: ${bundle}; review its signing policy before releasing`)
}

export function readMachOType(filename) {
  const fd = fs.openSync(filename, 'r')
  try {
    const header = Buffer.alloc(32)
    const readAt = (offset) => { header.fill(0); return fs.readSync(fd, header, 0, header.length, offset) }
    if (readAt(0) < 16) return null
    let magic = header.readUInt32BE(0)
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      // Universal Mach-O: inspect the first slice's file type. codesign verifies
      // every architecture; all slices must also report the expected identity.
      const offset = magic === 0xcafebabf ? Number(header.readBigUInt64BE(16)) : header.readUInt32BE(16)
      if (!Number.isSafeInteger(offset) || readAt(offset) < 16) throw new Error(`Invalid Mach-O slice: ${filename}`)
      magic = header.readUInt32BE(0)
    }
    if (magic === 0xcffaedfe || magic === 0xcefaedfe) return header.readUInt32LE(12)
    if (magic === 0xfeedfacf || magic === 0xfeedface) return header.readUInt32BE(12)
    return null
  } finally { fs.closeSync(fd) }
}

function inside(root, filename) {
  const relative = path.relative(root, filename)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function macSigningPlan(app, { run = runMacTool } = {}) {
  const root = fs.realpathSync(app)
  if (!root.endsWith('.app') || !fs.statSync(root).isDirectory()) throw new Error('Expected a macOS .app bundle')
  const binaries = []
  const bundles = []
  const links = []
  const visit = (directory) => {
    if (/\.(?:app|framework|xpc|bundle)$/.test(directory)) bundles.push(directory)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        if (!inside(root, fs.realpathSync(filename))) throw new Error(`Chromium symlink escapes its app: ${filename}`)
        links.push({ path: path.relative(root, filename), target: fs.readlinkSync(filename) })
      } else if (entry.isDirectory()) visit(filename)
      else if (entry.isFile()) {
        const type = readMachOType(filename)
        if (type !== null) {
          if (type !== 2 && type !== 6 && type !== 8) throw new Error(`Unsupported Mach-O type ${type}: ${filename}`)
          binaries.push({ path: filename, executable: type === 2 })
        }
      }
    }
  }
  visit(root)
  const ownedBinaries = new Set()
  const products = bundles.map((bundle) => {
    const role = chromiumRole(bundle, root)
    const framework = bundle.endsWith('.framework')
    const plist = path.join(bundle, framework ? 'Resources/Info.plist' : 'Contents/Info.plist')
    const executable = run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist]).trim()
    if (!executable || executable.includes('/') || executable.includes('\\') || executable === '..') throw new Error(`Invalid bundle executable in ${plist}`)
    const binary = fs.realpathSync(path.join(bundle, framework ? executable : `Contents/MacOS/${executable}`))
    const found = binaries.find((item) => item.path === binary)
    if (!found || found.executable === framework) throw new Error(`Invalid Mach-O bundle executable: ${binary}`)
    ownedBinaries.add(binary)
    return { path: bundle, binary, role, executable: !framework }
  })
  for (const binary of binaries) {
    if (!ownedBinaries.has(binary.path)) products.push({ ...binary, role: binary.executable ? 'helper' : 'library' })
  }
  // Paths deeper in the tree always precede the bundle that contains them.
  products.sort((a, b) => b.path.split(path.sep).length - a.path.split(path.sep).length || a.path.localeCompare(b.path))
  if (!binaries.length || products.at(-1)?.path !== root) throw new Error('Invalid Chromium signing inventory')
  return { root, products, binaries, links }
}

export function signingArguments(product, identity, { development = false } = {}) {
  if (!identity || (!development && identity === '-')) throw new Error('A Developer ID Application identity is required')
  const args = ['--force', development ? '--timestamp=none' : '--timestamp', '--sign', identity]
  if (product.executable) {
    args.push('--options', ['renderer', 'gpu'].includes(product.role) ? 'runtime,kill,restrict' : 'runtime,kill,restrict,library')
  }
  if (['browser', 'renderer', 'gpu'].includes(product.role)) args.push('--entitlements', path.join(ENTITLEMENTS, `${product.role}.plist`))
  args.push(product.path)
  return args
}

export function verifySignatureDescription(description, { executable, expectedTeam } = {}) {
  const teams = [...description.matchAll(/^TeamIdentifier=([A-Z0-9]{10})$/gm)].map((match) => match[1])
  if (!teams.length || new Set(teams).size !== 1 || (expectedTeam && teams[0] !== expectedTeam)) throw new Error('Chromium signature has a missing or inconsistent Team ID')
  if (!/^Authority=Developer ID Application: .+/m.test(description)) throw new Error('Chromium is not signed with Developer ID Application')
  if (/^Signature=adhoc$/m.test(description) || !/^Timestamp=.+/m.test(description)) throw new Error('Chromium signature requires a secure timestamp')
  if (executable && !/flags=0x[0-9a-f]+\([^\n]*\bruntime\b/.test(description)) throw new Error('Chromium executable is missing Hardened Runtime')
  return teams[0]
}

export function verifyMacApplication(app, { requireNotarization = false, expectedTeam, run = runMacTool } = {}) {
  const plan = macSigningPlan(app, { run })
  let team = expectedTeam
  // Check every Mach-O, including files outside Apple's standard nested-code
  // locations. A successful outer --deep verification alone is insufficient.
  for (const binary of plan.binaries) {
    run('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', '-R=anchor apple generic', binary.path])
    const description = run('/usr/bin/codesign', ['--display', '--verbose=4', binary.path])
    team = verifySignatureDescription(description, { executable: binary.executable, expectedTeam: team })
    run('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', `-R=anchor apple generic and certificate leaf[subject.OU] = "${team}"`, binary.path])
  }
  for (const product of plan.products) {
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', product.path])
  }
  if (requireNotarization) {
    run('/usr/bin/xcrun', ['stapler', 'validate', plan.root])
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', plan.root])
  }
  return { teamId: team, binaries: plan.binaries.length, bundles: plan.products.filter((item) => item.binary).length }
}

export function signMacApplication(app, identity, { development = false, run = runMacTool } = {}) {
  const plan = macSigningPlan(app, { run })
  for (const product of plan.products) run('/usr/bin/codesign', signingArguments(product, identity, { development }))
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', plan.root])
  const after = macSigningPlan(app, { run })
  if (JSON.stringify(plan.links) !== JSON.stringify(after.links)) throw new Error('Signing changed Chromium framework symlinks')
  // Ad-hoc signing is exposed only for disposable local fixture tests. It is
  // never a fallback from a failed distribution signature.
  return development ? { development: true, binaries: plan.binaries.length } : verifyMacApplication(app, { run })
}

export function notarizationCredentials(env = process.env) {
  const identity = env.APPLE_SIGNING_IDENTITY?.trim()
  const keyId = env.APPLE_API_KEY?.trim()
  const issuer = env.APPLE_API_ISSUER?.trim()
  const keyPath = env.APPLE_API_KEY_PATH?.trim()
  if (!identity || identity === '-') throw new Error('APPLE_SIGNING_IDENTITY must identify a Developer ID Application certificate')
  if (!keyId || !/^[A-Za-z0-9]+$/.test(keyId) || !issuer || !/^[0-9a-f-]{36}$/i.test(issuer) || !keyPath || !fs.statSync(keyPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Chromium release requires APPLE_API_KEY, APPLE_API_ISSUER and a readable APPLE_API_KEY_PATH')
  }
  return { identity, keyId, issuer, keyPath }
}

export function notarizeMacApplication(app, credentials, { run = runMacTool, diagnosticsDirectory } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-chromium-notary-'))
  const diagnostics = diagnosticsDirectory ?? temp
  fs.mkdirSync(diagnostics, { recursive: true })
  const auth = ['--key', credentials.keyPath, '--key-id', credentials.keyId, '--issuer', credentials.issuer]
  let submission
  try {
    const zip = path.join(temp, 'chromium.zip')
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip], { timeout: 300_000 })
    // Submit separately from waiting so an interrupted/timeout wait still leaves
    // the submission ID for diagnostics; never submit a duplicate retry blindly.
    submission = JSON.parse(run('/usr/bin/xcrun', ['notarytool', 'submit', zip, ...auth, '--output-format', 'json'], { timeout: 300_000 }))
    if (!/^[0-9a-f-]{36}$/i.test(submission.id ?? '')) throw new Error('Notary service did not return a submission ID')
    fs.writeFileSync(path.join(diagnostics, 'chromium-notary-submission.json'), JSON.stringify({ id: submission.id }, null, 2))
    const result = JSON.parse(run('/usr/bin/xcrun', ['notarytool', 'wait', submission.id, ...auth, '--timeout', '30m', '--output-format', 'json'], { timeout: 31 * 60_000 }))
    fs.writeFileSync(path.join(diagnostics, 'chromium-notary-result.json'), JSON.stringify(result, null, 2))
    // Inspect and retain the service log even after successful notarization.
    run('/usr/bin/xcrun', ['notarytool', 'log', submission.id, ...auth, path.join(diagnostics, 'chromium-notary-log.json')])
    if (result.status !== 'Accepted') throw new Error(`Chromium notarization ${result.status ?? 'unknown'} (submission ${submission.id})`)
    run('/usr/bin/xcrun', ['stapler', 'staple', app])
    const verified = verifyMacApplication(app, { requireNotarization: true, run })
    return { ...verified, notarizationId: submission.id }
  } catch (error) {
    if (submission?.id && !fs.existsSync(path.join(diagnostics, 'chromium-notary-log.json'))) {
      try { run('/usr/bin/xcrun', ['notarytool', 'log', submission.id, ...auth, path.join(diagnostics, 'chromium-notary-log.json')]) }
      catch { /* the service may not have a log yet; retain the original failure and submission ID */ }
    }
    throw new Error(`${error.message}${submission?.id ? `; notary submission ${submission.id}` : ''}`)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}
