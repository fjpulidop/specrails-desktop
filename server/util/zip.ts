/**
 * Minimal ZIP writer (stored entries, no compression, no dependency). Shared by
 * the per-job diagnostic export and the app-wide problem report. Entries are
 * written in order; keep names ASCII (the UTF-8 name flag is not set).
 *
 * ZIP format is simple: local file headers + data + central directory + EOCD.
 */

export function crc32(buf: Buffer): number {
  // Standard CRC-32 polynomial table
  const table = crc32Table()
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

let _crcTable: Uint32Array | null = null
function crc32Table(): Uint32Array {
  if (_crcTable) return _crcTable
  _crcTable = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    _crcTable[i] = c
  }
  return _crcTable
}

export interface ZipEntry {
  name: string
  data: Buffer
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = []
  const centralDirs: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf-8')
    const data = entry.data
    const crc = crc32(data)
    const size = data.length

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)  // signature
    local.writeUInt16LE(20, 4)           // version needed
    local.writeUInt16LE(0, 6)            // flags
    local.writeUInt16LE(0, 8)            // compression = STORED
    local.writeUInt16LE(0, 10)           // mod time
    local.writeUInt16LE(0, 12)           // mod date
    local.writeUInt32LE(crc, 14)         // crc-32
    local.writeUInt32LE(size, 18)        // compressed size
    local.writeUInt32LE(size, 22)        // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26) // file name length
    local.writeUInt16LE(0, 28)           // extra field length
    nameBytes.copy(local, 30)

    // Central directory header (46 bytes + name)
    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0) // signature
    central.writeUInt16LE(20, 4)          // version made by
    central.writeUInt16LE(20, 6)          // version needed
    central.writeUInt16LE(0, 8)           // flags
    central.writeUInt16LE(0, 10)          // compression = STORED
    central.writeUInt16LE(0, 12)          // mod time
    central.writeUInt16LE(0, 14)          // mod date
    central.writeUInt32LE(crc, 16)        // crc-32
    central.writeUInt32LE(size, 20)       // compressed size
    central.writeUInt32LE(size, 24)       // uncompressed size
    central.writeUInt16LE(nameBytes.length, 28) // file name length
    central.writeUInt16LE(0, 30)          // extra field length
    central.writeUInt16LE(0, 32)          // file comment length
    central.writeUInt16LE(0, 34)          // disk number start
    central.writeUInt16LE(0, 36)          // int file attributes
    central.writeUInt32LE(0, 38)          // ext file attributes
    central.writeUInt32LE(offset, 42)     // relative offset of local header
    nameBytes.copy(central, 46)

    localHeaders.push(local, data)
    centralDirs.push(central)
    offset += local.length + size
  }

  const centralDirBuf = Buffer.concat(centralDirs)
  const centralDirSize = centralDirBuf.length
  const centralDirOffset = offset

  // End of central directory record
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)       // signature
  eocd.writeUInt16LE(0, 4)                 // disk number
  eocd.writeUInt16LE(0, 6)                 // disk with CD
  eocd.writeUInt16LE(entries.length, 8)    // entries on this disk
  eocd.writeUInt16LE(entries.length, 10)   // total entries
  eocd.writeUInt32LE(centralDirSize, 12)   // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16) // central dir offset
  eocd.writeUInt16LE(0, 20)                // comment length

  return Buffer.concat([...localHeaders, centralDirBuf, eocd])
}
