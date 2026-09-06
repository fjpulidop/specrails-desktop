/**
 * Legacy compatibility utility: obfuscate-chromium.mjs <in> <out>.
 *
 * Symmetric XOR conversion for inspecting old chromium.pak bundles and producing
 * regression fixtures. New runtime assembly must use assemble-chromium.mjs and
 * transparent chromium.tar.gz archives, with release signing and notarization.
 * This encoding provides no authenticity, integrity or distribution approval.
 * Keep the key compatible with the legacy decoder in chromium-resolver.ts.
 */
import fs from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Keep in sync with OBFUSCATION_KEY in server/chromium-resolver.ts.
const KEY = Buffer.from('specrails-desktop-chromium-pack-v1', 'utf8')

function xorTransform() {
  let offset = 0
  return new Transform({
    transform(chunk, _enc, cb) {
      const out = Buffer.allocUnsafe(chunk.length)
      for (let i = 0; i < chunk.length; i++) {
        out[i] = chunk[i] ^ KEY[(offset + i) % KEY.length]
      }
      offset += chunk.length
      cb(null, out)
    },
  })
}

async function main() {
  const [, , input, output] = process.argv
  if (!input || !output) {
    console.error('usage: obfuscate-chromium.mjs <in> <out>')
    process.exit(1)
  }
  await pipeline(fs.createReadStream(input), xorTransform(), fs.createWriteStream(output))
  console.log(`obfuscated ${input} → ${output}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
