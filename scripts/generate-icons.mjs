/**
 * generate-icons.mjs
 *
 * Generates all required Tauri app icons from src-tauri/icons/icon.svg
 * using the @tauri-apps/cli `tauri icon` command.
 *
 * Usage:
 *   npm run generate-icons
 *
 * Prerequisites:
 *   @tauri-apps/cli must be installed (it is added as a devDependency in
 *   package.json). Rust toolchain must be available for the tauri command.
 *
 * Output:
 *   src-tauri/icons/32x32.png
 *   src-tauri/icons/128x128.png
 *   src-tauri/icons/128x128@2x.png
 *   src-tauri/icons/icon.icns   (macOS)
 *   src-tauri/icons/icon.ico    (Windows)
 *   src-tauri/icons/icon.png    (Linux)
 *   src-tauri/icons/dev/*       (development build, from icon-dev.svg: the
 *                                same icon with an amber DEV band, used by
 *                                `npm run dev:desktop`)
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const svgPath = path.join(root, 'src-tauri', 'icons', 'icon.svg')

console.log('Generating Tauri icons from', svgPath)

try {
  execSync(`npx tauri icon "${svgPath}"`, {
    cwd: root,
    stdio: 'inherit',
  })
  // The development icon set keeps only the formats tauri.conf.json lists.
  const devSvg = path.join(root, 'src-tauri', 'icons', 'icon-dev.svg')
  const devOut = path.join(root, 'src-tauri', 'icons', 'dev')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-dev-icons-'))
  execSync(`npx tauri icon "${devSvg}" -o "${scratch}"`, { cwd: root, stdio: 'inherit' })
  fs.mkdirSync(devOut, { recursive: true })
  for (const file of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico', 'icon.png']) {
    fs.copyFileSync(path.join(scratch, file), path.join(devOut, file))
  }
  fs.rmSync(scratch, { recursive: true, force: true })
  console.log('Icons generated successfully in src-tauri/icons/ and src-tauri/icons/dev/')
} catch (err) {
  console.error('Icon generation failed:', err.message)
  console.error(
    'Ensure @tauri-apps/cli is installed and the Rust toolchain is available.'
  )
  process.exit(1)
}
