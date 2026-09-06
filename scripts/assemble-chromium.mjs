/** Stage Playwright's exact installed browser without mutating its managed cache. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { macSigningPlan, notarizationCredentials, signMacApplication, notarizeMacApplication, verifyMacApplication, runMacTool, assertReviewedChromiumVersion } from './sign-chromium-macos.mjs'

const require = createRequire(import.meta.url)
export function playwrightPlatformDirectory(executable) {
  let directory = path.resolve(executable)
  while (path.dirname(directory) !== directory) {
    if (/^chromium-\d+$/.test(path.basename(path.dirname(directory)))) return directory
    directory = path.dirname(directory)
  }
  throw new Error(`Cannot locate Playwright's versioned Chromium platform directory from ${executable}`)
}

export function topLevelMacApp(directory) {
  const apps = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  if (apps.length !== 1) throw new Error(`Expected one Chromium app in ${directory}, found ${apps.length}`)
  return path.join(directory, apps[0].name)
}

export function collectSymlinks(directory) {
  const links = []
  const root = fs.realpathSync(directory)
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file)
        const relative = path.relative(root, target)
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Browser symlink escapes staging: ${file}`)
        links.push([path.relative(root, file), fs.readlinkSync(file)])
      } else if (entry.isDirectory()) visit(file)
    }
  }
  visit(root)
  return links.sort((a, b) => a[0].localeCompare(b[0]))
}

export function archiveChromiumPlatform(source, archive, { run = runMacTool } = {}) {
  // No -h/--dereference: preserving Versions/Current and framework aliases is
  // essential to retaining the code signature. Apple tar also retains the
  // stapled ticket metadata; extraction verification confirms it survived.
  const environment = { ...process.env }
  delete environment.COPYFILE_DISABLE
  delete environment.COPY_EXTENDED_ATTRIBUTES_DISABLE
  run(process.platform === 'darwin' ? '/usr/bin/tar' : 'tar', ['-czf', archive, '-C', path.dirname(source), path.basename(source)], { timeout: 300_000, env: environment })
}

export function installChromiumArchive(archive, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const ready = fs.mkdtempSync(`${output}.ready-`)
  const previous = `${ready}.previous`
  let movedPrevious = false
  try {
    fs.copyFileSync(archive, path.join(ready, 'chromium.tar.gz'))
    if (fs.existsSync(output)) {
      fs.renameSync(output, previous)
      movedPrevious = true
    }
    try { fs.renameSync(ready, output) }
    catch (error) {
      if (movedPrevious) fs.renameSync(previous, output)
      throw error
    }
    // Replacing the directory also removes any old unpacked .app; leaving it
    // alongside the new archive would ship the obsolete unsigned code too.
    if (movedPrevious) fs.rmSync(previous, { recursive: true, force: true })
  } finally { fs.rmSync(ready, { recursive: true, force: true }) }
}

export function assembleChromium({ release = false, output = path.resolve('src-tauri/runtimes/chromium'), executable, diagnosticsDirectory = process.env.CHROMIUM_DIAGNOSTICS_DIR || path.resolve('artifacts/chromium-signing') } = {}) {
  const platform = process.platform
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error(`Unsupported browser platform ${platform}`)
  const credentials = release && platform === 'darwin' ? notarizationCredentials() : null
  const sourceExecutable = executable || require('playwright').chromium.executablePath()
  if (!fs.statSync(sourceExecutable, { throwIfNoEntry: false })?.isFile()) throw new Error('Playwright Chromium is missing; run npx playwright install chromium first')
  const source = playwrightPlatformDirectory(sourceExecutable)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-chromium-assembly-'))
  const staged = path.join(temp, 'staging', path.basename(source))
  const archive = path.join(temp, 'chromium.tar.gz')
  let signed
  try {
    fs.mkdirSync(path.dirname(staged), { recursive: true })
    if (platform === 'darwin') runMacTool('/usr/bin/ditto', [source, staged], { timeout: 300_000 })
    else fs.cpSync(source, staged, { recursive: true, dereference: false, verbatimSymlinks: true })
    const links = collectSymlinks(staged)
    if (credentials) {
      const app = topLevelMacApp(staged)
      const version = runMacTool('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]).trim()
      assertReviewedChromiumVersion(version)
      signed = signMacApplication(app, credentials.identity)
      signed = { ...signed, ...notarizeMacApplication(app, credentials, { diagnosticsDirectory }) }
    }
    archiveChromiumPlatform(staged, archive)
    const extracted = path.join(temp, 'extracted')
    fs.mkdirSync(extracted)
    runMacTool(platform === 'darwin' ? '/usr/bin/tar' : 'tar', ['-xzf', archive, '-C', extracted], { timeout: 300_000 })
    const restored = path.join(extracted, path.basename(source))
    if (JSON.stringify(links) !== JSON.stringify(collectSymlinks(restored))) throw new Error('Chromium archive round-trip changed framework symlinks')
    if (!fs.existsSync(path.join(restored, path.relative(source, sourceExecutable)))) throw new Error('Chromium executable did not survive archive extraction')
    if (credentials) verifyMacApplication(topLevelMacApp(restored), { requireNotarization: true, expectedTeam: signed.teamId })
    else if (platform === 'darwin') macSigningPlan(topLevelMacApp(restored)) // structural validation, not a distribution-signature claim
    const receipt = {
      schemaVersion: 1, platform, architecture: process.arch,
      playwrightVersion: require('playwright/package.json').version,
      browserRevision: path.basename(path.dirname(source)),
      format: 'tar.gz', sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
      distributionSigned: Boolean(credentials), ...(signed || {}),
    }
    // Publish only a fully assembled archive. No partially signed payload can
    // replace the previously staged bundle after an earlier step fails.
    installChromiumArchive(archive, output)
    if (credentials) {
      fs.mkdirSync(diagnosticsDirectory, { recursive: true })
      fs.writeFileSync(path.join(diagnosticsDirectory, 'chromium-bundle-verification.json'), JSON.stringify(receipt, null, 2) + '\n')
    }
    console.log(`Assembled transparent Chromium archive (${credentials ? 'Developer ID signed, notarized and stapled' : platform === 'win32' ? 'upstream Windows signatures preserved' : 'development; not distribution signed'}): ${path.join(output, 'chromium.tar.gz')}`)
    return receipt
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.some((arg) => arg !== '--release')) throw new Error('Usage: node scripts/assemble-chromium.mjs [--release]')
    assembleChromium({ release: args.includes('--release') })
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
