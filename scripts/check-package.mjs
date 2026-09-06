import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REQUIRED_FILES = [
  'package.json', 'README.md', 'LICENSE',
  'cli/dist/specrails-desktop.js', 'cli/dist/win-spawn.js',
  'server/dist/index.js', 'client/dist/index.html',
  'mcp-bridge/dist/specrails-mcp.js',
  'server/dist/schemas/profile.v1.json', 'server/dist/schemas/file-summary.v1.json',
  'server/dist/openspec-runtime-plugin-commands.json',
  'server/dist/chromium-archive.cjs',
  'server/dist/plugins/serena/templates/instructions.md',
  ...['bash-shim.bash', 'zsh-shim.zsh', 'fish-shim.fish', 'powershell-shim.ps1'].map(name => `server/dist/shell-integration/${name}`),
]

export function validatePackageInventory(info, expected) {
  assert.equal(info.name, expected.name, 'Packed name differs from package.json')
  assert.equal(info.version, expected.version, 'Packed version differs from package.json')
  assert.equal(info.filename, `${expected.name}-${expected.version}.tgz`, 'Unexpected package filename')
  assert.match(info.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, 'Missing npm package integrity')
  const files = new Set(info.files.map(file => file.path))
  for (const file of REQUIRED_FILES) assert(files.has(file), `npm package is missing ${file}`)
  assert([...files].some(file => /^client\/dist\/assets\/.+\.js$/.test(file)), 'Client JavaScript assets missing')
  assert([...files].some(file => file.startsWith('docs/guide/') && file.endsWith('.md')), 'User guide missing')
  for (const file of files) {
    assert(!path.posix.isAbsolute(file) && !file.split('/').includes('..') && !file.includes('\\'), `Unsafe package entry: ${file}`)
    assert(!/(^|\/)(node_modules|\.git|\.env(?:\.[^/]*)?|__fixtures__)(\/|$)|\.test\.[cm]?[jt]sx?$/.test(file), `Development/private file in npm package: ${file}`)
  }
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited ${result.status}:\n${result.stderr || result.stdout}`)
  return result.stdout
}

function npm(args, cwd) {
  // npm supplies its JS entrypoint on both Windows and POSIX. Calling it with
  // Node avoids .cmd quoting and shell interpretation of paths with spaces.
  assert(process.env.npm_execpath, 'Run this check with npm run check:package')
  return run(process.execPath, [process.env.npm_execpath, ...args], cwd)
}

export function checkPackage(root, output) {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'specrails-npm-check-'))
  try {
    const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root))
    assert.equal(packed.length, 1, 'Expected exactly one npm package')
    const info = packed[0]
    validatePackageInventory(info, expected)
    const tarball = path.join(temporary, info.filename)
    const bytes = fs.readFileSync(tarball)
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, info.integrity, 'Tarball integrity mismatch')
    const consumer = path.join(temporary, 'consumer')
    fs.mkdirSync(consumer)
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"name":"specrails-package-check","private":true,"version":"0.0.0"}')
    // Exercise a production dependency closure without project setup, native
    // postinstall scripts, model calls, a running server or user database access.
    npm(['install', tarball, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer)
    const installed = path.join(consumer, 'node_modules', expected.name)
    const executable = path.join(installed, expected.bin[expected.name])
    assert.equal(run(process.execPath, [executable, '--version'], consumer).trim(), `${expected.name} v${expected.version}`)
    assert.match(run(process.execPath, [executable, '--help'], consumer), /--status/)
    // Resolve from the installed package with an unrelated cwd, so a checkout
    // fallback cannot conceal omitted MCP or shell-integration resources.
    const probe = `const assert=require('node:assert/strict'); const path=require('node:path');
      const root=process.argv[1];
      const {validateWindowsArchiveTypes}=require(path.join(root,'server/dist/chromium-archive.cjs'));
      assert.throws(()=>validateWindowsArchiveTypes('lrwxrwxrwx 0 root root 0 Jan 1 1970 escape -> /outside'));
      const {resolveBridgeScript}=require(path.join(root,'server/dist/agent-mcp-config.js'));
      assert.equal(resolveBridgeScript(),path.join(root,'mcp-bridge/dist/specrails-mcp.js'));
      const {locateBundledShim}=require(path.join(root,'server/dist/terminal-shell-integration.js'));
      for(const name of ['bash-shim.bash','zsh-shim.zsh','fish-shim.fish','powershell-shim.ps1'])
        assert.equal(locateBundledShim(name),path.join(root,'server/dist/shell-integration',name));`
    const env = { ...process.env }
    delete env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH
    delete env.NODE_PATH
    run(process.execPath, ['-e', probe, installed], consumer, env)
    const report = { name: info.name, version: info.version, filename: info.filename, integrity: info.integrity, sha256: createHash('sha256').update(bytes).digest('hex') }
    if (output) {
      fs.mkdirSync(output, { recursive: true })
      fs.copyFileSync(tarball, path.join(output, info.filename))
      fs.writeFileSync(path.join(output, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n')
    }
    console.log(`Verified ${info.filename}: production install, CLI, MCP bridge, shell resources and integrity`)
    return report
  } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) throw new Error('Usage: npm run check:package -- [--output <directory>]')
  checkPackage(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), args[1] ? path.resolve(args[1]) : undefined)
}
