import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { load as loadYaml } from 'js-yaml'

const SAFE_SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const OPSX_TO_KIMI_SKILL: Readonly<Record<string, string>> = {
  propose: 'openspec-propose',
  ff: 'openspec-ff-change',
  new: 'openspec-new-change',
  apply: 'openspec-apply-change',
  continue: 'openspec-continue-change',
  archive: 'openspec-archive-change',
  'bulk-archive': 'openspec-bulk-archive-change',
  sync: 'openspec-sync-specs',
  verify: 'openspec-verify-change',
  explore: 'openspec-explore',
  onboard: 'openspec-onboard',
}

interface SkillInvocation {
  skillName: string
  rawArgs: string
}

export interface KimiSkillDocument {
  body: string
  metadataName: string
  description: string
  argumentNames: readonly string[]
}

/**
 * Raised before a provider process is spawned when a Kimi headless command
 * cannot be resolved safely. Sending the original `/skill:*` text to `kimi -p`
 * would be a silent no-op: Kimi 0.27 intercepts slash skills in its TUI/ACP
 * clients, while print mode sends its prompt straight to `session.prompt()`.
 */
export class KimiSkillResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KimiSkillResolutionError'
  }
}

function parseInvocation(command: string): SkillInvocation | null {
  const match = command.match(/^\/(skill|specrails|sr|opsx):([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null

  const namespace = match[1]
  const rawName = match[2]
  const rawArgs = (match[3] ?? '').trim()
  let skillName: string | undefined

  if (namespace === 'skill') skillName = rawName
  else if (namespace === 'specrails' || namespace === 'sr') {
    skillName = `specrails-${rawName}`
  } else {
    skillName = OPSX_TO_KIMI_SKILL[rawName]
    if (!skillName) return null
  }

  if (!SAFE_SKILL_NAME_RE.test(skillName)) {
    throw new KimiSkillResolutionError(
      `Unsafe Kimi skill name "${skillName}". Expected letters, digits, "_" or "-".`,
    )
  }
  return { skillName, rawArgs }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function skillArgumentNames(value: unknown): readonly string[] {
  const isValid = (name: string): boolean =>
    name.trim() !== '' && !/^\d+$/.test(name)
  if (typeof value === 'string') return value.split(/\s+/).filter(isValid)
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is string => typeof item === 'string' && isValid(item),
  )
}

/** Parse a directory SKILL.md with Kimi 0.27's frontmatter requirements.
 *
 * This is intentionally exported as the single parser for both execution and
 * Profiles CRUD. Keeping the js-yaml parse and type checks here prevents the
 * editor from accepting a role that the headless execution path would later
 * reject.
 */
export function parseKimiSkillDocument(
  source: string,
  skillPath = '<memory>',
): KimiSkillDocument {
  const lines = source.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    throw new KimiSkillResolutionError(`Missing frontmatter in ${skillPath}`)
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close < 0) {
    throw new KimiSkillResolutionError(`Invalid frontmatter in ${skillPath}: missing closing fence`)
  }

  const yamlText = lines.slice(1, close).join('\n').trim()
  let parsed: unknown
  try {
    parsed = yamlText === '' ? {} : (loadYaml(yamlText) ?? {})
  } catch (error) {
    throw new KimiSkillResolutionError(
      `Invalid frontmatter in ${skillPath}: ` +
      (error instanceof Error ? error.message : String(error)),
    )
  }
  if (!isRecord(parsed)) {
    throw new KimiSkillResolutionError(
      `Frontmatter in ${skillPath} must be a mapping at the top level`,
    )
  }

  const name = nonEmptyString(parsed.name)
  const description = nonEmptyString(parsed.description)
  if (!name || !description) {
    throw new KimiSkillResolutionError(
      `Missing required frontmatter field ${!name ? '"name"' : '"description"'} in ${skillPath}`,
    )
  }
  const hasType = Object.prototype.hasOwnProperty.call(parsed, 'type')
  if (
    hasType
    && (typeof parsed.type !== 'string' || parsed.type.trim() === '')
  ) {
    throw new KimiSkillResolutionError(
      `Skill type "${String(parsed.type)}" is not supported in ${skillPath}`,
    )
  }
  const type = nonEmptyString(parsed.type)
  if (
    type !== undefined &&
    type !== 'prompt' &&
    type !== 'inline' &&
    type !== 'flow' &&
    type !== 'reference'
  ) {
    throw new KimiSkillResolutionError(
      `Skill type "${type}" is not supported in ${skillPath}`,
    )
  }
  if (type === 'reference') {
    throw new KimiSkillResolutionError(
      `Kimi skill "${name}" has type "reference" and cannot be activated by the user.`,
    )
  }

  return {
    body: lines.slice(close + 1).join('\n').trim(),
    metadataName: name,
    description,
    argumentNames: skillArgumentNames(parsed.arguments),
  }
}

/**
 * Validate a user-authored role against the same document contract used at
 * execution time. The expected-name check is a Profiles invariant: the
 * provider-native metadata must identify the direct-child role directory.
 */
export function validateKimiRoleDocument(
  source: string,
  expectedName: string,
  skillPath = '<memory>',
): string[] {
  let document: KimiSkillDocument
  try {
    document = parseKimiSkillDocument(source, skillPath)
  } catch (error) {
    return [
      error instanceof Error
        ? error.message
        : `Invalid Kimi skill document in ${skillPath}`,
    ]
  }

  const errors: string[] = []
  if (document.metadataName !== expectedName) {
    errors.push(`frontmatter.name must exactly match '${expectedName}'`)
  }
  if (!document.body) {
    errors.push(`Kimi skill "${expectedName}" has an empty body.`)
  }
  return errors
}

function tokenizeArgs(raw: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let hasContent = false

  for (const char of raw) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
        hasContent = true
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasContent = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        out.push(current)
        current = ''
        hasContent = false
      }
      continue
    }
    current += char
    hasContent = true
  }
  if (hasContent) out.push(current)
  return out
}

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeXmlTags(value: string): string {
  return value.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function expandSkillParameters(
  body: string,
  rawArgs: string,
  skillDir: string,
  argumentNames: readonly string[],
  sessionId?: string,
): string {
  const tokens = tokenizeArgs(rawArgs)
  let content = body

  for (let index = 0; index < argumentNames.length; index += 1) {
    const escaped = regexpEscape(argumentNames[index])
    content = content.replace(
      new RegExp(`\\$${escaped}(?![\\[\\w])`, 'g'),
      escapeXmlTags(tokens[index] ?? ''),
    )
  }

  content = content
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, indexText: string) =>
      escapeXmlTags(tokens[Number.parseInt(indexText, 10)] ?? ''))
    .replace(/\$(\d+)(?!\w)/g, (_match, indexText: string) =>
      escapeXmlTags(tokens[Number.parseInt(indexText, 10)] ?? ''))
    .replaceAll('$ARGUMENTS', escapeXmlTags(rawArgs))

  const hasArgumentPlaceholder = content !== body
  content = content
    .replaceAll('${KIMI_SKILL_DIR}', skillDir)
    .replaceAll('${KIMI_SESSION_ID}', sessionId ?? '')

  if (!hasArgumentPlaceholder && rawArgs.length > 0) {
    return `${content}\n\nARGUMENTS: ${escapeXmlTags(rawArgs)}`
  }
  return content
}

function toKimiPath(nativePath: string): string {
  const slashPath = nativePath.replaceAll('\\', '/')
  return /^[a-z]:\//.test(slashPath)
    ? slashPath[0].toUpperCase() + slashPath.slice(1)
    : slashPath
}

function loadProjectSkill(
  cwd: string,
  requestedName: string,
): { document: KimiSkillDocument; skillDir: string } {
  const skillsRoot = path.resolve(cwd, '.kimi-code', 'skills')
  const directDir = path.join(skillsRoot, requestedName)
  let directError: Error | undefined
  let mismatchedDirectName: string | undefined
  const loadCandidate = (
    skillDir: string,
  ): { document: KimiSkillDocument; skillDir: string } | null => {
    const skillPath = path.join(skillDir, 'SKILL.md')
    if (!existsSync(skillPath)) return null
    try {
      const document = parseKimiSkillDocument(readFileSync(skillPath, 'utf8'), skillPath)
      if (document.metadataName.toLowerCase() === requestedName.toLowerCase()) {
        // Kimi resolves each discovered skill root through fs.realpath before
        // parsing SKILL.md. Match that behavior so `${KIMI_SKILL_DIR}` and the
        // activation envelope are identical for Desktop framework symlinks.
        return { document, skillDir: toKimiPath(realpathSync(skillDir)) }
      }
      if (skillDir === directDir) mismatchedDirectName = document.metadataName
    } catch (error) {
      // Kimi discovery skips unrelated malformed entries. Preserve the exact
      // direct candidate error so the requested broken skill remains
      // actionable instead of being reported as generically missing.
      if (skillDir === directDir) {
        directError = error instanceof Error ? error : new Error(String(error))
      }
    }
    return null
  }

  const direct = loadCandidate(directDir)
  if (direct) return direct

  if (existsSync(skillsRoot)) {
    let entries
    try {
      entries = readdirSync(skillsRoot, { withFileTypes: true })
    } catch (error) {
      throw new KimiSkillResolutionError(
        `Cannot scan Kimi skills at ${skillsRoot}: ` +
        (error instanceof Error ? error.message : String(error)),
      )
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const candidate = path.join(skillsRoot, entry.name)
      if (candidate === directDir) continue
      const resolved = loadCandidate(candidate)
      if (resolved) return resolved
    }
  }

  if (directError) throw directError
  if (mismatchedDirectName) {
    throw new KimiSkillResolutionError(
      `Kimi skill directory "${requestedName}" declares name "${mismatchedDirectName}".`,
    )
  }
  throw new KimiSkillResolutionError(
    `Kimi skill "${requestedName}" is not installed under ${skillsRoot}. ` +
    'Run the SpecRails Core update for provider "kimi" before retrying.',
  )
}

/**
 * Resolve a provider/Core slash invocation into the same user-activated-skill
 * prompt shape used by Kimi 0.27's `Session.activateSkill()` path.
 */
export function formatKimiCoreCommand(
  command: string,
  cwd?: string,
  sessionId?: string,
): string {
  const invocation = parseInvocation(command)
  if (!invocation) return command
  if (!cwd) {
    throw new KimiSkillResolutionError(
      `Cannot resolve Kimi skill "${invocation.skillName}" without a project working directory.`,
    )
  }

  const { document, skillDir } = loadProjectSkill(cwd, invocation.skillName)
  if (!document.body) {
    throw new KimiSkillResolutionError(`Kimi skill "${invocation.skillName}" has an empty body.`)
  }
  const effectiveSessionId = sessionId?.trim() || undefined
  if (document.body.includes('${KIMI_SESSION_ID}') && !effectiveSessionId) {
    throw new KimiSkillResolutionError(
      `Kimi skill "${document.metadataName}" requires \${KIMI_SESSION_ID}, ` +
      'which is unavailable before a fresh `kimi -p` session emits its resume hint.',
    )
  }

  const renderedName = document.metadataName
  const skillContent = expandSkillParameters(
    document.body,
    invocation.rawArgs,
    skillDir,
    document.argumentNames,
    effectiveSessionId,
  )
  return [
    `User activated the skill "${escapeXml(renderedName)}". Follow the loaded skill instructions.`,
    '',
    `<kimi-skill-loaded name="${escapeXml(renderedName)}" trigger="user-slash" source="project" ` +
      `dir="${escapeXml(skillDir)}" args="${escapeXml(invocation.rawArgs)}">`,
    skillContent,
    '</kimi-skill-loaded>',
  ].join('\n')
}

export const _test = {
  parseInvocation,
  parseSkillDocument: parseKimiSkillDocument,
  expandSkillParameters,
  tokenizeArgs,
  toKimiPath,
}
