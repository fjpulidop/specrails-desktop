import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { retainAgentRuntime, resolveRetainedAgentRuntime, runtimeEntryFingerprint } from './agent-runtime-package'

let root: string
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'runtime pin '))) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
function file(relative: string, contents: string): string {
  const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); return target
}
function fixture() {
  file('active/package.json', JSON.stringify({ name: 'specrails-core', version: '5.3.0', dependencies: { fixture: '1' } }))
  file('active/node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js' }))
  file('active/node_modules/fixture/index.js', 'module.exports="original dependency"')
  const cli = file('active/dist/agent-runtime/cli.js', 'console.log(require("fixture"))')
  const context = file('pipeline/run/desktop-context.json', '{}')
  return { cli, context }
}
it('retains the executable and dependency contents across replacement of the active package', () => {
  const { cli, context } = fixture()
  const retained = retainAgentRuntime(cli, context)
  fs.writeFileSync(cli, 'throw Error("new executable")')
  fs.writeFileSync(path.join(root, 'active/node_modules/fixture/index.js'), 'throw Error("changed dependency")')
  expect(resolveRetainedAgentRuntime(context)).toBe(retained)
  expect(execFileSync(process.execPath, [retained], { encoding: 'utf8' }).trim()).toBe('original dependency')
  expect(retainAgentRuntime(cli, context)).toBe(retained)
})
it('detects same-length edits with preserved timestamps and refuses a corrupt retained dependency', () => {
  const { cli, context } = fixture()
  const before = runtimeEntryFingerprint(cli), stat = fs.statSync(cli)
  fs.writeFileSync(cli, 'console.log(require("fixturX"))'); fs.utimesSync(cli, stat.atime, stat.mtime)
  expect(runtimeEntryFingerprint(cli)).not.toBe(before)
  fs.writeFileSync(cli, 'console.log(require("fixture"))')
  const retained = retainAgentRuntime(cli, context)
  fs.writeFileSync(path.resolve(retained, '../../../node_modules/fixture/index.js'), 'module.exports="tampered"')
  expect(() => resolveRetainedAgentRuntime(context)).toThrow('integrity')
})
it('never guesses an unrecorded original runtime from the active installation', () => {
  const { context } = fixture()
  expect(() => resolveRetainedAgentRuntime(context)).toThrow('unrecorded')
})
it('retains nested dependency versions without copying development packages', () => {
  const { cli, context } = fixture()
  file('active/node_modules/dev-only/index.js', 'throw Error("not runtime")')
  file('active/package.json', JSON.stringify({ name: 'specrails-core', version: '5.3.0', dependencies: { fixture: '1', common: '2' } }))
  file('active/node_modules/common/package.json', JSON.stringify({ name: 'common', version: '2.0.0', main: 'index.js' }))
  file('active/node_modules/common/index.js', 'module.exports="root"')
  file('active/node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js', dependencies: { common: '1' } }))
  file('active/node_modules/fixture/index.js', 'module.exports=require("common")')
  file('active/node_modules/fixture/node_modules/common/package.json', JSON.stringify({ name: 'common', version: '1.0.0', main: 'index.js' }))
  file('active/node_modules/fixture/node_modules/common/index.js', 'module.exports="nested"')
  fs.writeFileSync(cli, 'console.log(require("fixture"), require("common"))')
  const retained = retainAgentRuntime(cli, context)
  expect(fs.existsSync(path.resolve(retained, '../../../node_modules/dev-only'))).toBe(false)
  expect(execFileSync(process.execPath, [retained], { encoding: 'utf8' }).trim()).toBe('nested root')
})


it.skipIf(!process.env.SPECRAILS_EFFICIENCY_CORE_ROOT)('boots the actual paired Core from its retained production dependency closure', () => {
  const cli = path.join(process.env.SPECRAILS_EFFICIENCY_CORE_ROOT!, 'dist/agent-runtime/cli.js')
  const context = file('pipeline/paired/desktop-context.json', '{}')
  const retained = retainAgentRuntime(cli, context)
  const api = JSON.parse(execFileSync(process.execPath, [retained, 'api'], { encoding: 'utf8', timeout: 30000 }))
  expect(api).toMatchObject({ type: 'runtime-api', apiVersion: 1, workflowVersions: ['5'] })
  expect(resolveRetainedAgentRuntime(context)).toBe(retained)
}, 120000)


it('retains a package reached through a directory alias using its real CLI path', () => {
  const { context } = fixture()
  const alias = path.join(root, 'alias')
  fs.symlinkSync(path.join(root, 'active'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const retained = retainAgentRuntime(path.join(alias, 'dist/agent-runtime/cli.js'), context)
  expect(resolveRetainedAgentRuntime(context)).toBe(retained)
  expect(execFileSync(process.execPath, [retained], { encoding: 'utf8' }).trim()).toBe('original dependency')
})
