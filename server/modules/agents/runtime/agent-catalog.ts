import fs from 'node:fs'
import path from 'node:path'
import { getAdapter } from '../../../providers'

/** Provider-native role storage shared by Agent Studio and runtime projection. */
export function nativeAgentFile(root: string, agentId: string, provider: string): string {
  const adapter = getAdapter(provider)
  return adapter.customRolePath?.(root, agentId) ?? path.join(root, adapter.projectDirName, 'agents', `${agentId}.md`)
}
export function nativeAgentsDirectory(root: string, provider: string): string {
  const probe = nativeAgentFile(root, '__catalog_probe__', provider)
  return path.basename(probe) === 'SKILL.md' ? path.dirname(path.dirname(probe)) : path.dirname(probe)
}
export function listNativeAgentFiles(root: string, provider: string): Array<{ id: string; file: string }> {
  const directory = nativeAgentsDirectory(root, provider)
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const id = entry.isDirectory() ? entry.name : entry.isFile() && entry.name.endsWith('.md') ? entry.name.slice(0, -3) : undefined
    if (!id) return []
    const file = nativeAgentFile(root, id, provider)
    return fs.existsSync(file) ? [{ id, file }] : []
  }).sort((a, b) => a.id.localeCompare(b.id))
}
