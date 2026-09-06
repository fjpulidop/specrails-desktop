import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildUpdaterManifest } from './build-updater-manifest.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails update release '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const inputs = ['dmg-aarch64/Specrails.app.tar.gz', 'windows-x64/nsis/Specrails-setup.exe', 'windows-x64/msi/Specrails.msi', 'windows-arm64/nsis/Specrails-setup.exe', 'windows-arm64/msi/Specrails.msi']
  for (const file of inputs) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), `artifact: ${file}`)
    fs.writeFileSync(path.join(root, `${file}.sig`), `${Buffer.from(`signature: ${file}`).toString('base64')}\r\n`)
  }
  return { root, inputs, args: { artifacts: root, output: path.join(root, 'output'), version: '2.40.0', releaseUrl: 'https://example.com/v2.40.0' } }
}

test('retains both installer families and architecture, copies exact paired artifacts', t => {
  const { root, args } = fixture(t)
  const result = buildUpdaterManifest(args)
  for (const arch of ['x86_64', 'aarch64']) {
    assert.match(result.platforms[`windows-${arch}-msi`].url, /\.msi$/)
    assert.match(result.platforms[`windows-${arch}-nsis`].url, /-setup\.exe$/)
    assert.deepEqual(result.platforms[`windows-${arch}`], result.platforms[`windows-${arch}-nsis`])
  }
  assert.equal(Object.keys(result.platforms).length, 7)
  assert.equal(fs.readFileSync(path.join(args.output, 'specrails-desktop-2.40.0-windows-aarch64.msi'), 'utf8'), fs.readFileSync(path.join(root, 'windows-arm64/msi/Specrails.msi'), 'utf8'))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(args.output, 'latest.json'), 'utf8')), result)
})

for (const defect of ['missing signature', 'missing installer', 'empty installer', 'empty signature', 'duplicate signature']) {
  test(`refuses ${defect} without writing a manifest or replacing previous output`, t => {
    const { root, args } = fixture(t)
    const pkg = path.join(root, 'windows-arm64/nsis/Specrails-setup.exe')
    if (defect === 'missing signature') fs.unlinkSync(`${pkg}.sig`)
    if (defect === 'missing installer') fs.unlinkSync(pkg)
    if (defect === 'empty installer') fs.writeFileSync(pkg, '')
    if (defect === 'empty signature') fs.writeFileSync(`${pkg}.sig`, '\r\n')
    if (defect === 'duplicate signature') fs.copyFileSync(`${pkg}.sig`, path.join(path.dirname(pkg), 'Stale-setup.exe.sig'))
    fs.mkdirSync(args.output)
    fs.writeFileSync(path.join(args.output, 'latest.json'), 'previous release')
    assert.throws(() => buildUpdaterManifest(args))
    assert.equal(fs.readFileSync(path.join(args.output, 'latest.json'), 'utf8'), 'previous release')
    assert.equal(fs.readdirSync(args.output).length, 1)
  })
}
