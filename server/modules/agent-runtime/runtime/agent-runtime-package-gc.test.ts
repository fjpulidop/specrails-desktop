import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectUnreferencedRuntimePackages as collect } from './agent-runtime-package-gc'
let root: string, pipeline: string, cache: string
const now = Date.parse('2026-09-27T00:00:00Z'), old = new Date(now - 40 * 86_400_000)
const options = { dryRun: false, minimumAgeMs: 30 * 86_400_000, now }
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime gc '))); pipeline = path.join(root, 'pipeline'); cache = path.join(pipeline, 'runtime-packages'); fs.mkdirSync(cache, { recursive: true }) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
function pkg(digit: string) { const digest = digit.repeat(64), directory = path.join(cache, digest); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'cli.js'), 'original'); fs.utimesSync(directory, old, old); return digest }
function pin(run: string, digest: string) { const directory = path.join(pipeline, run); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'desktop-runtime-package.json'), JSON.stringify({ schemaVersion: 1, integrity: digest, root: path.join(cache, digest), cli: 'cli.js' })); return directory }
it('retains every shared run reference and collects only expired orphans', () => {
  const referenced = pkg('a'), orphan = pkg('b'); pin('one', referenced); pin('two', referenced)
  expect(collect(pipeline, { ...options, dryRun: true })).toEqual([orphan])
  expect(fs.existsSync(path.join(cache, orphan))).toBe(true)
  expect(collect(pipeline, options)).toEqual([orphan])
  expect(fs.readFileSync(path.join(cache, referenced, 'cli.js'), 'utf8')).toBe('original')
  expect(collect(pipeline, options)).toEqual([])
})
it.each(['corrupt', 'missing', 'scope'])('fails closed before deleting anything when a surviving pin is %s', mode => {
  const orphan = pkg('b'), directory = pin('run', pkg('a'))
  const file = path.join(directory, 'desktop-runtime-package.json')
  if (mode === 'corrupt') fs.writeFileSync(file, '{')
  if (mode === 'scope') { const value = JSON.parse(fs.readFileSync(file, 'utf8')); value.root = root; fs.writeFileSync(file, JSON.stringify(value)) }
  if (mode === 'missing') { fs.rmSync(file); fs.writeFileSync(path.join(directory, 'agent-runtime-request.json'), '{}') }
  expect(() => collect(pipeline, options)).toThrow()
  expect(fs.existsSync(path.join(cache, orphan))).toBe(true)
})
it('preserves newly published and future-dated packages', () => {
  const digest = pkg('a'); fs.utimesSync(path.join(cache, digest), new Date(now), new Date(now))
  expect(collect(pipeline, options)).toEqual([])
  fs.utimesSync(path.join(cache, digest), new Date(now + 1000), new Date(now + 1000))
  expect(collect(pipeline, options)).toEqual([])
})
it('refuses collection while interrupted journal quarantine remains', () => {
  pkg('a'); fs.mkdirSync(path.join(pipeline, '.retention', 'pending'), { recursive: true })
  expect(() => collect(pipeline, options)).toThrow('quarantine')
})
it('does not traverse a linked run or delete its external files', () => {
  pkg('a'); const external = path.join(root, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'keep'), 'value')
  fs.symlinkSync(external, path.join(pipeline, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => collect(pipeline, options)).toThrow('link')
  expect(fs.readFileSync(path.join(external, 'keep'), 'utf8')).toBe('value')
})
it('retries a previously interrupted package deletion without exposing it as a digest', () => {
  const digest = pkg('a'), garbage = `.garbage-${digest}-00000000-0000-4000-8000-000000000000`
  fs.renameSync(path.join(cache, digest), path.join(cache, garbage))
  expect(collect(pipeline, options)).toEqual([garbage])
  expect(fs.existsSync(path.join(cache, garbage))).toBe(false)
})
it('rejects unsafe policy bounds and handles missing storage without creating it', () => {
  expect(() => collect(pipeline, { ...options, minimumAgeMs: 0 })).toThrow('age')
  const missing = path.join(root, 'missing')
  expect(collect(missing, options)).toEqual([]); expect(fs.existsSync(missing)).toBe(false)
})

it('collects expired abandoned staging but preserves a new unpublished package', () => {
  const oldStage = '.staged-00000000-0000-4000-8000-000000000000'
  const newStage = '.staged-11111111-1111-4111-8111-111111111111'
  for (const stage of [oldStage, newStage]) fs.mkdirSync(path.join(cache, stage))
  fs.utimesSync(path.join(cache, oldStage), old, old)
  fs.utimesSync(path.join(cache, newStage), new Date(now), new Date(now))
  expect(collect(pipeline, options)).toEqual([oldStage])
  expect(fs.existsSync(path.join(cache, newStage))).toBe(true)
})
