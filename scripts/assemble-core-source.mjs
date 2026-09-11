import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import crossSpawn from 'cross-spawn'

const ENTRIES = ['dist', 'templates', 'commands', 'bin', 'schemas', 'integration-contract.json', 'package.json', 'pinned-versions.json']
function pruneBins(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (entry.name === '.bin') rmSync(file, { recursive: true, force: true })
    else pruneBins(file)
  }
}

/** Development/paired-release assembly uses the checkout's reviewed npm lock,
 * including the complete production dependency closure. No registry release or
 * global installation is needed for the new Core runtime. */
export function assembleCoreSource(source, destination) {
  source = path.resolve(source)
  destination = path.resolve(destination)
  const relative = path.relative(destination, source)
  const inside = path.relative(source, destination)
  if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('Core destination must not contain the source checkout')
  if (!inside.startsWith('..' + path.sep) && inside !== '..' && !path.isAbsolute(inside)) throw new Error('Core destination must not be inside the source checkout')
  const pkg = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'))
  const lockText = readFileSync(path.join(source, 'package-lock.json'), 'utf8')
  const lock = JSON.parse(lockText)
  if (pkg.name !== 'specrails-core' || lock.packages?.['']?.version !== pkg.version) throw new Error('Source is not a matching, locked Specrails Core checkout')
  for (const entry of ['dist/installer/cli.js', 'dist/agent-runtime/index.js', 'dist/agent-runtime/cli.js']) {
    if (!existsSync(path.join(source, entry))) throw new Error('Build Core before source assembly: missing ' + entry)
  }
  const temp = mkdtempSync(path.join(tmpdir(), 'specrails-core-source-'))
  try {
    writeFileSync(path.join(temp, 'package.json'), JSON.stringify(pkg))
    writeFileSync(path.join(temp, 'package-lock.json'), lockText)
    const installed = crossSpawn.sync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temp, stdio: 'inherit', windowsHide: true })
    if (installed.error || installed.status !== 0) throw new Error('Locked Core dependency installation failed: ' + (installed.error?.message ?? installed.status))
    const stage = path.join(temp, 'stage')
    mkdirSync(stage)
    for (const entry of ENTRIES) {
      const file = path.join(source, entry)
      if (existsSync(file)) cpSync(file, path.join(stage, entry), { recursive: true, filter: () => true })
    }
    cpSync(path.join(temp, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true, verbatimSymlinks: true, filter: () => true })
    pruneBins(path.join(stage, 'node_modules'))
    const smoke = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import {pathToFileURL} from "node:url"; const r=await import(pathToFileURL(process.argv[1]).href); if(r.RUNTIME_API_VERSION!==1)throw Error("runtime API mismatch"); const state=await r.runWorkflow({directory:process.argv[2],runId:"bundle-smoke",input:null,workflow:{id:"smoke",version:"1",steps:[{id:"check",execute:async()=>({status:"succeeded",usage:{costUsd:0,inputTokens:0,outputTokens:0}})}]}}); if(state.status!=="succeeded")throw Error("workflow smoke failed");',
      path.join(stage, 'dist/agent-runtime/index.js'), path.join(temp, 'smoke-state'),
    ], { cwd: stage, encoding: 'utf8', timeout: 60_000 })
    if (smoke.error || smoke.status !== 0) throw new Error('Core runtime bundle smoke failed: ' + (smoke.error?.message ?? smoke.stderr))
    writeFileSync(path.join(stage, 'source-bundle.json'), JSON.stringify({ schemaVersion: 1, coreVersion: pkg.version, runtimeApiVersion: 1, packageLockSha256: createHash('sha256').update(lockText).digest('hex') }, null, 2) + '\n')
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    cpSync(stage, destination, { recursive: true, verbatimSymlinks: true, filter: () => true })
    console.log(`[assemble-bundled-core] source ${pkg.version} → ${destination}; locked dependencies and offline workflow smoke passed`)
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
