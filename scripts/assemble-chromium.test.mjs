import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { archiveChromiumPlatform, collectSymlinks, playwrightPlatformDirectory, topLevelMacApp, installChromiumArchive } from './assemble-chromium.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('browser platform discovery handles names with spaces and rejects unmanaged paths', () => {
  const base = path.join(os.tmpdir(), 'browser cache', 'chromium-1223', 'chrome-mac-arm64')
  assert.equal(playwrightPlatformDirectory(path.join(base, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), base)
  assert.throws(() => playwrightPlatformDirectory(path.join(os.tmpdir(), 'chrome.exe')), /versioned Chromium/)
})

test('CLI invocation via symlink still executes its validation', { skip: process.platform === 'win32' }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium cli fixture '))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const link = path.join(temp, 'assembly.mjs')
  fs.symlinkSync(fileURLToPath(new URL('./assemble-chromium.mjs', import.meta.url)), link)
  const result = spawnSync(process.execPath, [link, '--invalid'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage:/)
})

test('transparent archive round-trip preserves framework symlinks and file bytes', { skip: process.platform === 'win32' }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium archive fixture '))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const source = path.join(temp, 'platform folder')
  fs.mkdirSync(path.join(source, 'Test.framework/Versions/A'), { recursive: true })
  fs.writeFileSync(path.join(source, 'Test.framework/Versions/A/binary'), 'fixture payload')
  fs.symlinkSync('A', path.join(source, 'Test.framework/Versions/Current'))
  fs.symlinkSync('Versions/Current/binary', path.join(source, 'Test.framework/binary'))
  const archive = path.join(temp, 'chromium.tar.gz')
  archiveChromiumPlatform(source, archive)
  assert.equal(fs.readFileSync(archive).subarray(0, 2).toString('hex'), '1f8b')
  const out = path.join(temp, 'out'); fs.mkdirSync(out)
  const result = spawnSync('tar', ['-xzf', archive, '-C', out], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(collectSymlinks(path.join(out, 'platform folder')), collectSymlinks(source))
  assert.equal(fs.readFileSync(path.join(out, 'platform folder/Test.framework/binary'), 'utf8'), 'fixture payload')
})

test('ambiguous top-level browser apps cannot select an arbitrary executable', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium discovery fixture '))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  assert.throws(() => topLevelMacApp(temp), /found 0/)
  fs.mkdirSync(path.join(temp, 'Chromium.app'))
  assert.equal(topLevelMacApp(temp), path.join(temp, 'Chromium.app'))
  fs.mkdirSync(path.join(temp, 'Other.app'))
  assert.throws(() => topLevelMacApp(temp), /found 2/)
})

test('publishing a new archive removes stale unpacked unsigned code and preserves the old bundle on staging failure', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium replacement fixture '))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const output = path.join(temp, 'runtimes/chromium')
  fs.mkdirSync(path.join(output, 'chrome-mac/Old.app'), { recursive: true })
  fs.writeFileSync(path.join(output, 'chromium.pak'), 'legacy')
  assert.throws(() => installChromiumArchive(path.join(temp, 'missing.tar.gz'), output))
  assert.equal(fs.readFileSync(path.join(output, 'chromium.pak'), 'utf8'), 'legacy')
  const tar = path.join(temp, 'new.tar.gz'); fs.writeFileSync(tar, 'new')
  installChromiumArchive(tar, output)
  assert.deepEqual(fs.readdirSync(output), ['chromium.tar.gz'])
  assert.equal(fs.readFileSync(path.join(output, 'chromium.tar.gz'), 'utf8'), 'new')
})
