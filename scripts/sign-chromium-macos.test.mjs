import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { macSigningPlan, signingArguments, readMachOType, verifySignatureDescription, signMacApplication, notarizationCredentials, notarizeMacApplication, assertReviewedChromiumVersion } from './sign-chromium-macos.mjs'

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium signing fixture '))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const app = path.join(temp, 'Chromium.app')
  const macho = (name, type = 2) => {
    const target = path.join(app, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const bytes = Buffer.alloc(64); bytes.writeUInt32BE(0xcffaedfe); bytes.writeUInt32LE(type, 12)
    fs.writeFileSync(target, bytes)
    return target
  }
  macho('Contents/MacOS/Chromium')
  macho('Contents/Frameworks/Test.framework/Test', 6)
  macho('Contents/Frameworks/Test.framework/Libraries/Example.dylib', 6)
  macho('Contents/Frameworks/Test.framework/Helpers/Chromium Helper (Renderer).app/Contents/MacOS/Renderer')
  macho('Contents/Frameworks/Test.framework/Helpers/Chromium Helper (GPU).app/Contents/MacOS/GPU')
  macho('Contents/Frameworks/Test.framework/Helpers/chrome_crashpad_handler')
  const calls = []
  const run = (command, args) => {
    calls.push([command, args])
    if (command.endsWith('plutil')) {
      const plist = args.at(-1)
      return plist.includes('(Renderer)') ? 'Renderer' : plist.includes('(GPU)') ? 'GPU' : plist.includes('Test.framework') ? 'Test' : 'Chromium'
    }
    return ''
  }
  return { temp, app, macho, calls, run }
}

test('a browser major upgrade must review its entitlement policy before distribution', () => {
  assert.doesNotThrow(() => assertReviewedChromiumVersion('148.0.7778.96'))
  assert.throws(() => assertReviewedChromiumVersion('149.0.7827.0'), /signing-policy review/)
  assert.throws(() => assertReviewedChromiumVersion(undefined), /signing-policy review/)
})

test('inventory signs inner code before containing bundles and every Mach-O exactly once', (t) => {
  const { app, run } = fixture(t)
  const plan = macSigningPlan(app, { run })
  assert.equal(plan.binaries.length, 6)
  assert.equal(plan.products.length, 6)
  assert.equal(plan.products.at(-1).role, 'browser')
  const framework = plan.products.findIndex((item) => item.path.endsWith('.framework'))
  assert.ok(plan.products.findIndex((item) => item.role === 'renderer') < framework)
  assert.ok(plan.products.findIndex((item) => item.path.endsWith('.dylib')) < framework)
  assert.equal(new Set(plan.products.map((item) => item.binary ?? item.path)).size, 6)
})

test('renderer and GPU get JIT policy without the normal library-validation flag', (t) => {
  const { app, run } = fixture(t)
  for (const product of macSigningPlan(app, { run }).products) {
    const args = signingArguments(product, 'Developer ID Application: Example (ABCDE12345)')
    assert.ok(args.includes('--timestamp'))
    assert.ok(!args.includes('--deep'))
    if (product.role === 'gpu' || product.role === 'renderer') {
      assert.equal(args[args.indexOf('--options') + 1], 'runtime,kill,restrict')
      const plist = fs.readFileSync(args[args.indexOf('--entitlements') + 1], 'utf8')
      assert.match(plist, /com.apple.security.cs.allow-jit/)
      assert.doesNotMatch(plist, /<key>com.apple.security.cs.allow-unsigned-executable-memory/)
    } else if (product.role === 'library') assert.ok(!args.includes('--options'))
    else if (product.role === 'helper') assert.ok(!args.includes('--entitlements'))
  }
  assert.throws(() => signingArguments({ path: 'browser' }, '-'), /Developer ID/)
})

test('unknown helper bundles and escaping symlinks are rejected before signing', (t) => {
  const { app, macho, run } = fixture(t)
  const unknown = macho('Contents/Frameworks/Unknown.app/Contents/MacOS/Unknown')
  assert.throws(() => macSigningPlan(app, { run }), /Unsupported Chromium code bundle/)
  fs.rmSync(path.dirname(path.dirname(path.dirname(unknown))), { recursive: true })
  if (process.platform !== 'win32') {
    fs.symlinkSync(os.tmpdir(), path.join(app, 'outside'))
    assert.throws(() => macSigningPlan(app, { run }), /symlink escapes/)
  }
})

test('signature checks reject ad-hoc, wrong teams, absent timestamp and absent runtime', () => {
  const valid = 'Authority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\nTimestamp=Sep 6, 2026\nCodeDirectory flags=0x10000(runtime)\n'
  assert.equal(verifySignatureDescription(valid, { executable: true }), 'ABCDE12345')
  assert.throws(() => verifySignatureDescription(valid, { expectedTeam: 'OTHER12345' }), /Team ID/)
  assert.throws(() => verifySignatureDescription(valid.replace('Timestamp=', 'Signed Time=')), /timestamp/)
  assert.throws(() => verifySignatureDescription(valid.replace('(runtime)', '(none)'), { executable: true }), /Hardened/)
  assert.throws(() => verifySignatureDescription(valid.replace('Authority=Developer ID Application: Example (ABCDE12345)', 'Signature=adhoc')), /Developer ID/)
})

test('failed component signing stops immediately before the outer app is sealed', (t) => {
  const f = fixture(t)
  assert.throws(() => signMacApplication(f.app, 'Example', { run(command, args) {
    if (command.endsWith('codesign') && args.includes('--force')) throw new Error('component signing failure')
    return f.run(command, args)
  } }), /component signing failure/)
  assert.ok(!f.calls.some(([, args]) => args.includes('--force')))
})

test('Mach-O detection handles native and universal headers but ignores data', (t) => {
  const { temp } = fixture(t)
  const file = path.join(temp, 'binary')
  const fat = Buffer.alloc(128); fat.writeUInt32BE(0xcafebabe); fat.writeUInt32BE(64, 16)
  fat.writeUInt32BE(0xcffaedfe, 64); fat.writeUInt32LE(6, 76)
  fs.writeFileSync(file, fat)
  assert.equal(readMachOType(file), 6)
  fs.writeFileSync(file, 'ordinary resource content')
  assert.equal(readMachOType(file), null)
})

test('release credentials cannot silently downgrade into ad-hoc development', (t) => {
  const { temp } = fixture(t)
  assert.throws(() => notarizationCredentials({}), /APPLE_SIGNING_IDENTITY/)
  assert.throws(() => notarizationCredentials({ APPLE_SIGNING_IDENTITY: '-' }), /APPLE_SIGNING_IDENTITY/)
  const env = { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (ABCDE12345)', APPLE_API_KEY: 'AB12', APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000', APPLE_API_KEY_PATH: path.join(temp, 'key.p8') }
  assert.throws(() => notarizationCredentials(env), /readable/)
  fs.writeFileSync(env.APPLE_API_KEY_PATH, 'fixture only')
  assert.equal(notarizationCredentials(env).keyId, 'AB12')
})

test('rejected notarization retains its submission diagnostics and never staples', (t) => {
  const f = fixture(t)
  const diagnostics = path.join(f.temp, 'diagnostics')
  const calls = []
  assert.throws(() => notarizeMacApplication(f.app, { keyId: 'ID', issuer: 'issuer', keyPath: '/fake/key' }, { diagnosticsDirectory: diagnostics, run(command, args) {
    calls.push(args)
    if (args[0] === 'notarytool' && args[1] === 'submit') return JSON.stringify({ id: '11111111-1111-1111-1111-111111111111' })
    if (args[0] === 'notarytool' && args[1] === 'wait') return JSON.stringify({ status: 'Invalid' })
    return ''
  } }), /notarization Invalid/)
  assert.ok(fs.existsSync(path.join(diagnostics, 'chromium-notary-submission.json')))
  assert.ok(fs.existsSync(path.join(diagnostics, 'chromium-notary-result.json')))
  assert.ok(!calls.some((args) => args.includes('staple')))
})

test('accepted notarization staples and verifies identity plus Gatekeeper before returning', (t) => {
  const f = fixture(t)
  const calls = []
  const result = notarizeMacApplication(f.app, { keyId: 'ID', issuer: 'issuer', keyPath: '/fake/key' }, { diagnosticsDirectory: path.join(f.temp, 'diagnostics'), run(command, args) {
    calls.push([command, args])
    if (args[0] === 'notarytool' && args[1] === 'submit') return JSON.stringify({ id: '11111111-1111-1111-1111-111111111111' })
    if (args[0] === 'notarytool' && args[1] === 'wait') return JSON.stringify({ status: 'Accepted' })
    if (command.endsWith('codesign') && args.includes('--display')) return 'Authority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\nTimestamp=Sep 6, 2026\nCodeDirectory flags=0x10000(runtime)\n'
    return f.run(command, args)
  } })
  assert.equal(result.teamId, 'ABCDE12345')
  assert.equal(result.binaries, 6)
  const staple = calls.findIndex(([, args]) => args.includes('staple'))
  const validate = calls.findIndex(([, args]) => args.includes('validate'))
  assert.ok(staple > calls.findIndex(([, args]) => args.includes('wait')) && validate > staple)
  assert.ok(calls.some(([command, args]) => command.endsWith('spctl') && args.includes('--assess')))
  assert.equal(calls.filter(([, args]) => args.some((arg) => arg.includes('certificate leaf[subject.OU]'))).length, 6)
})

test('failed notary wait still retrieves a diagnostic log when available', (t) => {
  const f = fixture(t)
  let logged = false
  assert.throws(() => notarizeMacApplication(f.app, { keyId: 'ID', issuer: 'issuer', keyPath: '/fake/key' }, { diagnosticsDirectory: path.join(f.temp, 'diagnostics'), run(command, args) {
    if (args[0] === 'notarytool' && args[1] === 'submit') return JSON.stringify({ id: '11111111-1111-1111-1111-111111111111' })
    if (args[0] === 'notarytool' && args[1] === 'wait') throw new Error('wait timed out')
    if (args[0] === 'notarytool' && args[1] === 'log') logged = true
    return ''
  } }), /wait timed out; notary submission/)
  assert.equal(logged, true)
})
