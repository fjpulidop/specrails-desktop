const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const MAX_ENTRIES = 100_000
const MAX_DEPTH = 24

function validateArchiveNames(listing, { platform = process.platform } = {}) {
  const names = listing.split(/\r?\n/).filter(Boolean)
  assert(names.length > 0 && names.length <= MAX_ENTRIES, 'Chromium archive is empty or exceeds its entry limit.')
  for (const name of names) {
    assert(!/^[\\/]|^[A-Za-z]:|[\x00-\x1f\x7f]/.test(name) && !name.includes('\\') && !name.split('/').includes('..'), `Unsafe Chromium archive path: ${name}`)
    if (platform === 'win32') {
      for (const component of name.split('/').filter(part => part !== '' && part !== '.')) {
        assert(!/[:<>"|?*]|[ .]$/.test(component), `Unsafe Windows Chromium archive path: ${name}`)
        const stem = component.split('.')[0].replace(/[ .]+$/g, '')
        assert(!/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(stem), `Reserved Windows Chromium archive path: ${name}`)
      }
    }
  }
}

function validateWindowsArchiveTypes(listing) {
  const entries = listing.split(/\r?\n/).filter(Boolean)
  assert(entries.length > 0 && entries.length <= MAX_ENTRIES, 'Chromium archive is empty or exceeds its entry limit.')
  for (const entry of entries) {
    // bsdtar (the Windows system tar) resolves GNU/PAX extensions before listing
    // the entry type. Only the fixed permission field matters, never translated
    // dates/owners or a textual link target. Windows Chromium needs no links.
    assert(/^[-d][rwxStTs-]{9}[+@.]?\s/.test(entry), 'Windows Chromium archives must contain only regular files and directories; links and special entries are not allowed.')
  }
}

function runTar(binary, args, { timeout = 180_000, maxBytes = 12 * 1024 * 1024, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout, maxBuffer: maxBytes, env, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** Admission must finish before any extraction. Windows tar.exe does not
 * reliably reject writes through an archive-created link, unlike POSIX tar. */
async function validateChromiumArchive(archivePath, { platform = process.platform, run = runTar } = {}) {
  assert(fs.lstatSync(archivePath).isFile(), 'Chromium archive must be a regular file.')
  const size = fs.statSync(archivePath).size
  assert(size > 0 && size <= 3 * 1024 ** 3, 'Chromium archive is empty or exceeds 3 GiB.')
  const tar = platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' }
  delete env.TAR_OPTIONS
  validateArchiveNames(await run(tar, ['-tf', archivePath], { env }), { platform })
  if (platform === 'win32') validateWindowsArchiveTypes(await run(tar, ['-tvf', archivePath], { env }))
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Validate without following directories through links. macOS versioned
 * framework symlinks are allowed only when their resolved target stays inside. */
function validateChromiumTree(root) {
  const realRoot = fs.realpathSync(root)
  let count = 0
  const walk = (directory, depth) => {
    assert(depth <= MAX_DEPTH, 'Chromium tree exceeds its depth limit.')
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert(++count <= MAX_ENTRIES, 'Chromium tree exceeds its entry limit.')
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) assert(inside(realRoot, fs.realpathSync(file)), `Chromium link escapes the extracted tree: ${file}`)
      else if (entry.isDirectory()) walk(file, depth + 1)
      else assert(entry.isFile(), `Unsupported Chromium entry: ${file}`)
    }
  }
  walk(realRoot, 0)
}

exports.validateArchiveNames = validateArchiveNames
exports.validateWindowsArchiveTypes = validateWindowsArchiveTypes
exports.validateChromiumArchive = validateChromiumArchive
exports.validateChromiumTree = validateChromiumTree
