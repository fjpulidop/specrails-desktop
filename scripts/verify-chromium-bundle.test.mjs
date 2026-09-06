import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { browserLaunchOptions, discoverBrowser, parseArguments, probeBrowser, runCommand, validateArchiveNames, validateExtractedTree, verifyChromiumBundle } from './verify-chromium-bundle.mjs'
import { validateWindowsArchiveTypes } from '../server/chromium-archive.cjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-chromium-test-'))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
function write(root, file, text = 'fixture') {
  const full = path.join(root, file)
  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text, { mode: 0o755 })
  return full
}
function macApp(root) {
  const app = 'chrome-mac-arm64/Google Chrome for Testing.app'
  write(root, `${app}/Contents/MacOS/Browser Main`)
  write(root, `${app}/Contents/Info.plist`, '<plist><dict><key>CFBundleExecutable</key><string>Browser Main</string></dict></plist>')
  write(root, `${app}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper`)
  return path.join(root, app)
}
const plistRun = async () => 'Browser Main\n'

test('CLI flags and exact env policy make notarization imply signature', () => {
  assert.deepEqual(parseArguments(['/tmp/runtime', '--require-notarization'], {}).options, { requireSignature: true, requireNotarization: true })
  assert.deepEqual(parseArguments(['/tmp/runtime'], { SPECRAILS_REQUIRE_CHROMIUM_SIGNATURE: '1' }).options, { requireSignature: true, requireNotarization: false })
  assert.equal(parseArguments(['/tmp/runtime'], { SPECRAILS_REQUIRE_CHROMIUM_SIGNATURE: 'true' }).options.requireSignature, false)
  for (const args of [[], ['/tmp/runtime', '--unknown'], ['/tmp/runtime', '/second']]) assert.throws(() => parseArguments(args, {}))
})

test('macOS and Windows launch explicitly enable the sandbox without unsafe overrides', () => {
  for (const platform of ['darwin', 'win32']) {
    const options = browserLaunchOptions('/fixture/browser', platform)
    assert.equal(options.chromiumSandbox, true); assert.deepEqual(options.args, ['--enable-automation'])
    assert.equal(options.headless, true); assert.equal(options.timeout, 30_000)
  }
  assert.equal(browserLaunchOptions('/fixture/browser', 'linux').chromiumSandbox, false)
})

test('archive admission rejects traversal, absolute paths, Windows drives and empty listings', () => {
  validateArchiveNames('./chrome-mac/\n./chrome-mac/Google Chrome for Testing.app/Contents/Info.plist\n')
  for (const name of ['', '../secret', 'a/../secret', '/secret', 'C:/secret', 'a\\secret', 'a\x00b']) assert.throws(() => validateArchiveNames(name))
})

test('Windows admission uses the fixed entry type, not locale-dependent owners, dates or link text', () => {
  validateWindowsArchiveTypes('-rw-r--r--  0 propriétaire groupe 42 sept. 6 2026 chrome.exe\ndrwxr-xr-x 0 owner group 0 Jan 1 1970 folder/\n')
  for (const listing of ['', 'lrwxrwxrwx 0 owner group 0 Jan 1 1970 symlink -> external', 'hrw-r--r-- 0 owner group 0 Jan 1 1970 hardlink link to external', 'brw-r--r-- 0 owner group 0 Jan 1 1970 device', '?rw-r--r-- 0 owner group 0 Jan 1 1970 unknown']) {
    assert.throws(() => validateWindowsArchiveTypes(listing))
  }
})

test('Windows archive names reject filesystem aliases, ADS and device names before extraction', () => {
  validateArchiveNames('./\n./chrome-win64/\n./chrome-win64/chrome.exe\n./chrome-win64/resources.pak\n', { platform: 'win32' })
  for (const name of ['dir/file:stream', 'dir/.. /escape', 'dir/final.', 'dir/final ', 'dir/CON', 'dir/nul.txt', 'AUX.log', 'dir/COM1.exe', 'dir/LPT9', 'dir/com¹.txt', 'dir/NUL .txt', 'CONOUT$.txt', 'dir/question?.txt']) {
    assert.throws(() => validateArchiveNames(name, { platform: 'win32' }), /Windows Chromium archive path/)
  }
  // These POSIX filenames must not be banned by the Windows-only alias policy.
  validateArchiveNames('framework/version:1\nframework/AUX.txt\nframework/final.\n', { platform: 'darwin' })
})

test('application discovery reads CFBundleExecutable and never selects nested helper apps', async () => {
  const f = fixture()
  try {
    const app = macApp(f.root)
    const found = await discoverBrowser(f.root, { platform: 'darwin', run: plistRun })
    assert.equal(found.app, app); assert.equal(found.executable, path.join(app, 'Contents/MacOS/Browser Main'))
    write(f.root, 'second.app/Contents/MacOS/Other')
    await assert.rejects(discoverBrowser(f.root, { platform: 'darwin', run: plistRun }), /exactly one/)
  } finally { f.cleanup() }
})

test('discovery rejects malformed bundle executable names and ambiguous Windows browsers', async () => {
  const f = fixture()
  try {
    macApp(f.root)
    await assert.rejects(discoverBrowser(f.root, { platform: 'darwin', run: async () => '../../escape' }), /CFBundleExecutable/)
    write(f.root, 'a/chrome.exe'); write(f.root, 'b/chrome.exe')
    await assert.rejects(discoverBrowser(f.root, { platform: 'win32' }), /exactly one/)
  } finally { f.cleanup() }
})

test('extracted links may stay internal but cannot point outside the verification tree', { skip: process.platform === 'win32' }, () => {
  const f = fixture()
  try {
    const inside = path.join(f.root, 'inside'); fs.mkdirSync(inside)
    write(inside, 'version/file'); fs.symlinkSync('version', path.join(inside, 'Current'))
    validateExtractedTree(inside)
    write(f.root, 'outside'); fs.symlinkSync('../outside', path.join(inside, 'escape'))
    assert.throws(() => validateExtractedTree(inside), /escapes/)
  } finally { f.cleanup() }
})

test('signature policy rejects obfuscated artifacts before extraction or browser launch', async () => {
  const f = fixture()
  try {
    write(f.root, 'chromium/chromium.pak')
    await assert.rejects(verifyChromiumBundle(f.root, { platform: 'darwin', requireSignature: true, probe: () => assert.fail('must not launch') }), /obfuscated/)
    await assert.rejects(verifyChromiumBundle(f.root, { platform: 'win32', requireSignature: true }), /must run on macOS/)
  } finally { f.cleanup() }
})

test('signature and notarization verification precede the probe and temporary copies are cleaned', async () => {
  const f = fixture(); let copiedApp, executable, profile
  try {
    macApp(path.join(f.root, 'chromium'))
    const calls = []
    const report = await verifyChromiumBundle(f.root, { platform: 'darwin', requireNotarization: true, run: plistRun,
      verifyApplication: (app, options) => { copiedApp = app; calls.push('signature'); assert.equal(options.requireNotarization, true) },
      probe: async (file, options) => { executable = file; profile = options.profileDirectory; calls.push('probe'); assert(fs.existsSync(file)); return { version: 'fixture' } },
    })
    assert.deepEqual(calls, ['signature', 'probe']); assert.equal(report.notarizationVerified, true)
    assert(!copiedApp.startsWith(f.root)); assert(!fs.existsSync(executable)); assert(!fs.existsSync(path.dirname(profile)))
    assert(fs.existsSync(path.join(f.root, 'chromium')))
  } finally { f.cleanup() }
})

test('signature failure prevents launching and preserves the source bundle', async () => {
  const f = fixture(); let copiedApp
  try {
    const sourceApp = macApp(path.join(f.root, 'chromium'))
    await assert.rejects(verifyChromiumBundle(f.root, { platform: 'darwin', requireSignature: true, run: plistRun,
      verifyApplication: app => { copiedApp = app; throw new Error('invalid Developer ID') },
      probe: () => assert.fail('must not launch after verification failure'),
    }), /invalid Developer ID/)
    assert(fs.existsSync(sourceApp)); assert(!fs.existsSync(copiedApp))
  } finally { f.cleanup() }
})

test('real transparent archive extraction prefers tar.gz over a stale legacy pak', async () => {
  const f = fixture(); let extracted
  try {
    const source = path.join(f.root, 'source'); write(source, 'chrome-win/chrome.exe')
    const rt = path.join(f.root, 'runtime'); fs.mkdirSync(path.join(rt, 'chromium'), { recursive: true })
    const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
    await runCommand(tar, ['-czf', path.join(rt, 'chromium/chromium.tar.gz'), '-C', source, '.'])
    write(rt, 'chromium/chromium.pak', 'invalid legacy bytes')
    const report = await verifyChromiumBundle(rt, { platform: 'win32', run: (cmd, args) => runCommand(cmd === 'tar.exe' ? tar : cmd, args), probe: async file => { extracted = file; assert.equal(fs.readFileSync(file, 'utf8'), 'fixture'); return {} } })
    assert.equal(report.format, 'chromium.tar.gz'); assert(!fs.existsSync(extracted))
    fs.writeFileSync(path.join(rt, 'chromium/chromium.tar.gz'), 'truncated')
    await assert.rejects(verifyChromiumBundle(rt, { platform: 'win32', run: (cmd, args) => runCommand(cmd === 'tar.exe' ? tar : cmd, args), probe: () => assert.fail('must not launch corrupt archive') }))
  } finally { f.cleanup() }
})

test('caller TAR_OPTIONS cannot inject arguments into admission or extraction', async () => {
  const f = fixture(), prior = process.env.TAR_OPTIONS
  try {
    write(f.root, 'chromium/chromium.tar', tarBytes([{ name: 'chrome-win/chrome.exe', data: 'fixture' }]))
    process.env.TAR_OPTIONS = '--absolute-names --unlink-first'
    const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
    const calls = []
    await verifyChromiumBundle(f.root, { platform: 'win32', run: (cmd, args, options) => {
      calls.push(args[0]); assert.equal(options.env.TAR_OPTIONS, undefined)
      return runCommand(cmd === 'tar.exe' ? tar : cmd, args, options)
    }, probe: async () => ({}) })
    assert.deepEqual(calls, ['-tf', '-tvf', '-xf'])
  } finally {
    if (prior === undefined) delete process.env.TAR_OPTIONS
    else process.env.TAR_OPTIONS = prior
    f.cleanup()
  }
})

test('empty or missing bundles fail instead of silently reporting success', async () => {
  const f = fixture()
  try {
    await assert.rejects(verifyChromiumBundle(f.root))
    fs.mkdirSync(path.join(f.root, 'chromium'))
    await assert.rejects(verifyChromiumBundle(f.root, { platform: 'win32' }), /exactly one/)
  } finally { f.cleanup() }
})

function fakePlaywright({ args = [], failScreenshot = false } = {}) {
  let closed = 0
  const session = { send: async name => name === 'Browser.getBrowserCommandLine' ? { arguments: args } : { gpu: { devices: [], featureStatus: {} } }, detach: async () => {} }
  const page = { setContent: async () => {}, locator: () => ({ click: async () => {}, textContent: async () => '42' }), evaluate: async () => ({ pixel: [255, 0, 0, 255], webgl: false }), screenshot: async () => { if (failScreenshot) throw new Error('renderer failed'); return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(128)]) } }
  const context = { setDefaultTimeout() {}, newPage: async () => page, browser: () => ({ newBrowserCDPSession: async () => session, version: () => 'fixture' }), close: async () => { closed++ } }
  return { loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => context } }), closed: () => closed }
}

test('functional probe rejects an unexpectedly disabled sandbox and closes the browser', async () => {
  const fake = fakePlaywright({ args: ['--no-sandbox'] })
  await assert.rejects(probeBrowser('/fixture', { platform: 'darwin', profileDirectory: '/fixture/profile', loadPlaywright: fake.loadPlaywright }), /disabled a sandbox/)
  assert.equal(fake.closed(), 1)
})

test('functional probe closes after renderer errors and reports unavailable WebGL honestly', async () => {
  const failed = fakePlaywright({ failScreenshot: true })
  await assert.rejects(probeBrowser('/fixture', { platform: 'win32', profileDirectory: '/fixture/profile', loadPlaywright: failed.loadPlaywright }), /renderer failed/)
  assert.equal(failed.closed(), 1)
  const successful = fakePlaywright()
  const report = await probeBrowser('/fixture', { platform: 'win32', profileDirectory: '/fixture/profile', loadPlaywright: successful.loadPlaywright })
  assert.equal(report.graphics.webgl, false); assert.equal(report.sandboxRequested, true); assert.equal(successful.closed(), 1)
  assert.equal(report.gpu.processObserved, false)
  assert(report.limitations.some(message => message.includes('GPU startup is not verified')))
})

test('external command timeouts fail and reap the owned child', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /timed out/)
})

test('a symlinked CLI entry still executes validation instead of silently exiting successfully', async t => {
  const f = fixture()
  try {
    const link = path.join(f.root, 'verify.mjs')
    try { fs.symlinkSync(fileURLToPath(new URL('./verify-chromium-bundle.mjs', import.meta.url)), link, 'file') }
    catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows file symlinks require developer mode or symlink permission'); throw error }
    await assert.rejects(runCommand(process.execPath, [link, '--invalid']), /Usage: verify-chromium-bundle/)
  } finally { f.cleanup() }
})

function tarBytes(entries) {
  const chunks = []
  for (const entry of entries) {
    const header = Buffer.alloc(512); const data = Buffer.from(entry.data ?? '')
    const field = (value, offset, length) => header.write(value, offset, length, 'utf8')
    field(entry.name, 0, 100); field('0000755\0', 100, 8); field('0000000\0', 108, 8); field('0000000\0', 116, 8)
    field(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12); field('00000000000\0', 136, 12)
    header.fill(32, 148, 156); field(entry.type ?? '0', 156, 1); field(entry.link ?? '', 157, 100)
    field('ustar\0', 257, 6); field('00', 263, 2)
    field(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8)
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)])
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let size = Buffer.byteLength(body) + 1
  while (size !== Buffer.byteLength(body) + String(size).length) size = Buffer.byteLength(body) + String(size).length
  return `${size}${body}`
}

for (const encoding of ['ustar', 'pax', 'gnu']) {
  for (const type of ['1', '2']) {
    test(`Windows preflight rejects ${encoding} ${type === '1' ? 'hardlinks' : 'symlinks'} before extraction or external mutation`, async () => {
      const f = fixture()
      try {
        const rt = path.join(f.root, 'runtime'), outside = path.join(f.root, 'outside')
        fs.mkdirSync(outside)
        const existing = path.join(outside, 'existing.txt')
        fs.writeFileSync(existing, 'preserve original')
        const target = type === '1' ? existing : outside
        const name = encoding === 'ustar' ? 'jump' : `safe-${'long-name-'.repeat(14)}`
        const extensions = encoding === 'pax'
          ? [{ name: 'PaxHeader', type: 'x', data: paxRecord('path', name) + paxRecord('linkpath', target) }]
          : encoding === 'gnu'
            ? [{ name: '././@LongLink', type: 'L', data: `${name}\0` }, { name: '././@LongLink', type: 'K', data: `${target}\0` }]
            : []
        write(rt, 'chromium/chromium.tar', tarBytes([...extensions, { name: encoding === 'ustar' ? name : 'placeholder', type, link: encoding === 'ustar' ? target : 'placeholder' }, { name: 'jump/escaped.txt', data: 'must not escape' }]))
        const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
        const calls = []
        await assert.rejects(verifyChromiumBundle(rt, { platform: 'win32',
          run: (cmd, args, options) => {
            calls.push(args[0])
            assert.notEqual(args[0], '-xf', 'unsafe archive reached the extraction command')
            assert.equal(options.env.LC_ALL, 'C')
            return runCommand(cmd === 'tar.exe' ? tar : cmd, args, options)
          },
          probe: () => assert.fail('unsafe archive reached browser launch'),
        }), /only regular files and directories/)
        assert.deepEqual(calls, ['-tf', '-tvf'])
        assert.equal(fs.readFileSync(existing, 'utf8'), 'preserve original')
        assert.deepEqual(fs.readdirSync(outside), ['existing.txt'])
      } finally { f.cleanup() }
    })
  }
}

test('system extraction cannot write through an archive symlink outside its temporary tree', async () => {
  const f = fixture()
  try {
    const rt = path.join(f.root, 'runtime'), outside = path.join(f.root, 'outside')
    fs.mkdirSync(outside)
    const archive = tarBytes([{ name: 'jump', type: '2', link: outside }, { name: 'jump/escaped.txt', data: 'must not escape' }])
    write(rt, 'chromium/chromium.tar', archive)
    await assert.rejects(verifyChromiumBundle(rt, { probe: () => assert.fail('must not launch unsafe archive') }))
    assert.equal(fs.existsSync(path.join(outside, 'escaped.txt')), false)
  } finally { f.cleanup() }
})

test('legacy pak still decodes for functional compatibility without signature claims', async () => {
  const f = fixture()
  try {
    const key = Buffer.from('specrails-desktop-chromium-pack-v1')
    const archive = gzipSync(tarBytes([{ name: 'chrome-win/chrome.exe', data: 'legacy fixture' }]))
    const encoded = Buffer.from(archive.map((byte, i) => byte ^ key[i % key.length]))
    write(f.root, 'chromium/chromium.pak', encoded)
    const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
    const report = await verifyChromiumBundle(f.root, { platform: 'win32', run: (cmd, args, opts) => runCommand(cmd === 'tar.exe' ? tar : cmd, args, opts), probe: async file => { assert.equal(fs.readFileSync(file, 'utf8'), 'legacy fixture'); return {} } })
    assert.equal(report.format, 'chromium.pak'); assert.equal(report.signatureVerified, false)
  } finally { f.cleanup() }
})
