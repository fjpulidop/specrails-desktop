import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { resolveHome } from './artifact-registry'
import templates from './openspec-runtime-plugin-commands.json'

/** The architect/developer contracts invoke Skill("opsx:ff"/"opsx:apply").
 * Core materializes specrails commands but not OpenSpec commands, and its npm
 * package excludes specrails-plugin. Load a minimal app-owned plugin explicitly
 * per Claude invocation, independent of user enabledPlugins/settings. No hooks,
 * agents, MCP configuration, or writes to the project's checkout are involved.
 * JSON import embeds the reviewed templates in both tsc and esbuild/sidecar. */
const manifest = JSON.stringify({ name: 'opsx', version: '1.0.0', description: 'OpenSpec workflows provided by Specrails Desktop.', license: 'MIT' }, null, 2) + '\n'
const files = new Map<string, string>([
  ['.claude-plugin/plugin.json', manifest],
  ['LICENSE', templates.licenseText],
  // Plugin commands use frontmatter.name, unlike the filename-based aliases
  // from project commands. "OPSX: Fast Forward" would register the broken
  // opsx:OPSX: Fast Forward. Keep the official body and normalize this name.
  ...Object.entries(templates.commands).map(([name, content]): [string, string] => [`commands/${name}.md`, content.replace(/^(---\r?\n)name:[^\r\n]*/, `$1name: ${name}`)]),
])
const digest = createHash('sha256').update(JSON.stringify([...files])).digest('hex')

/** Pure: adapter argument construction never touches disk or project state. */
export function getOpenSpecRuntimePluginArgs(home?: string): string[] {
  return ['--plugin-dir', path.join(resolveHome(home), '.specrails', 'runtime-plugins', 'opsx', digest)]
}

function assertPlugin(pluginDir: string): void {
  // Reject unexpected entries as well as modified/missing files. Otherwise a
  // tampered cache could introduce executable hooks or an MCP server at launch.
  const expected = new Set([...files.keys(), '.claude-plugin', 'commands'])
  const visit = (relative: string): void => {
    const absolute = path.join(pluginDir, relative)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error('symbolic links are not allowed')
    if (relative && !expected.has(relative)) throw new Error(`unexpected entry: ${relative}`)
    if (stat.isDirectory()) {
      if (relative && files.has(relative)) throw new Error(`expected a regular file: ${relative}`)
      for (const entry of fs.readdirSync(absolute)) visit(relative ? `${relative}/${entry}` : entry)
    } else if (!stat.isFile() || !files.has(relative) || fs.readFileSync(absolute, 'utf8') !== files.get(relative)) {
      throw new Error(`invalid content: ${relative}`)
    }
  }
  visit('')
  for (const relative of files.keys()) if (!fs.existsSync(path.join(pluginDir, relative))) throw new Error(`missing entry: ${relative}`)
}

/** Executed by spawnAiCli after process admission and before the real spawn.
 * Only an exact app-owned argv path is provisioned; unrelated --plugin-dir
 * options never grant authority to overwrite an arbitrary directory. */
export function ensureOpenSpecRuntimePluginForArgs(args: readonly string[], home?: string): void {
  const pluginDir = getOpenSpecRuntimePluginArgs(home)[1]
  if (!args.some((arg, index) => arg === '--plugin-dir' && args[index + 1] === pluginDir)) return
  let staging: string | undefined
  try {
    for (const directory of [path.join(resolveHome(home), '.specrails'), path.join(resolveHome(home), '.specrails', 'runtime-plugins'), path.dirname(pluginDir)]) {
      try {
        const stat = fs.lstatSync(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('plugin cache namespace must be a regular directory')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        try { fs.mkdirSync(directory, { mode: 0o700 }) }
        catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError }
        const stat = fs.lstatSync(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('plugin cache namespace must be a regular directory')
      }
    }
    if (fs.existsSync(pluginDir)) { assertPlugin(pluginDir); return }
    const parent = path.dirname(pluginDir)
    staging = fs.mkdtempSync(path.join(parent, '.prepare-'))
    for (const [relative, content] of files) {
      const target = path.join(staging, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    }
    assertPlugin(staging)
    try { fs.renameSync(staging, pluginDir); staging = undefined }
    catch (error) {
      // Concurrent starts can publish the same immutable plugin. Accept only
      // the complete, identical winner; never replace a corrupt cache in place.
      if (!fs.existsSync(pluginDir)) throw error
    }
    assertPlugin(pluginDir)
  } catch (error) {
    throw new Error(`The managed OpenSpec runtime plugin could not be prepared: ${error instanceof Error ? error.message : String(error)}. No AI process was started. Repair the Specrails runtime cache; do not install or copy skills into the project.`)
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true })
  }
}
