// The generated part of a client feature README (scripts/audit-client-features.mjs).
// Only the block between the markers is owned by the generator: everything
// else in the README (feature guides, seams, invariants) is written by hand
// and must survive `--write`.

export const README_BLOCK_BEGIN = '<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->'
export const README_BLOCK_END = '<!-- audit-client-features:end -->'

// Pre-marker READMEs: the generated span ran from this heading through the
// closing sentence of the dependencies paragraph.
const LEGACY_START = '## Public subpaths'
const LEGACY_END = 'React, network or native-shell dependencies. Bind effects in hooks and adapters.'

/** The generated block (markers included) for one feature. */
export function readmeBlock({ publicEntries, dependencies }) {
  return [
    README_BLOCK_BEGIN,
    '## Public subpaths',
    '',
    'These are the explicit entry points consumed by application composition or other',
    'features. Keep imports focused on a subpath so importing a model does not eagerly',
    'load every UI component. Changes to this surface require updating the boundary manifest.',
    '',
    publicEntries.map(file => `- [${file}](${file})`).join('\n') || 'No external consumers.',
    '',
    '## Feature dependencies',
    '',
    dependencies.map(dep => `- [${dep}](../${dep}/README.md)`).join('\n') || 'No direct feature dependencies.',
    '',
    'Dependencies record existing collaboration; they do not claim every feature is',
    'independent or that this is a hexagonal frontend. Pure models should not gain',
    LEGACY_END,
    README_BLOCK_END,
  ].join('\n')
}

/** A README for a feature that has none yet. */
export function newReadme(name, entry) {
  return [
    `# ${name}`,
    '',
    'This capability owns its UI, state, feature utilities and adjacent tests.',
    'Shared rendering primitives, API origin/auth and project cache remain outside features.',
    '',
    readmeBlock(entry),
    '',
    `Run the adjacent tests with \`npm run test --prefix client -- src/features/${name}\`.`,
    'For moves, update imports and mocks together, then run client coverage and typecheck.',
    'Validate navigation with `node scripts/audit-client-features.mjs --check`.',
    '',
  ].join('\n')
}

/**
 * The README with its generated block brought up to date and every other
 * line kept byte for byte. Order of preference: the marked block; the legacy
 * unmarked span (converted to a marked block once); otherwise the block is
 * inserted after the first heading paragraph. `existing` null ⇒ a new README.
 */
export function updateReadme(existing, name, entry) {
  if (existing === null || existing === undefined) return newReadme(name, entry)
  const text = existing.replace(/\r\n/g, '\n')
  const block = readmeBlock(entry)
  const begin = text.indexOf(README_BLOCK_BEGIN)
  const end = text.indexOf(README_BLOCK_END)
  if (begin !== -1 && end > begin) {
    return text.slice(0, begin) + block + text.slice(end + README_BLOCK_END.length)
  }
  if (begin !== -1 || end !== -1) throw new Error(`features/${name}/README.md has an unbalanced generated block; restore both markers`)
  const legacyStart = text.indexOf(LEGACY_START)
  const legacyEnd = legacyStart === -1 ? -1 : text.indexOf(LEGACY_END, legacyStart)
  if (legacyStart !== -1 && legacyEnd !== -1) {
    return text.slice(0, legacyStart) + block + text.slice(legacyEnd + LEGACY_END.length)
  }
  // No generated span at all: insert it after the title paragraph.
  const lines = text.split('\n')
  const blank = lines.findIndex((line, index) => index > 0 && line.trim() === '')
  const at = blank === -1 ? lines.length : blank
  return [...lines.slice(0, at), '', block, ...lines.slice(at)].join('\n').replace(/\n*$/, '\n')
}

/** Whether a README's generated block is current (a README without a block is stale). */
export function readmeIsCurrent(existing, name, entry) {
  if (existing === null || existing === undefined) return false
  try {
    return updateReadme(existing, name, entry) === existing.replace(/\r\n/g, '\n') && existing.includes(README_BLOCK_BEGIN)
  } catch {
    return false
  }
}
