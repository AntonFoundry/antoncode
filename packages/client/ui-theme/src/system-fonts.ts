/**
 * Installed system font family enumeration for the ui-theme host half.
 * Scans the standard macOS font directories, parses each TrueType/OpenType
 * font's `name` table (including .ttc collections) for the family name, and
 * returns the deduplicated sorted list. The result feeds the Font panel's
 * interface-family menu, so the user picks from the fonts actually
 * installed rather than a curated subset.
 * @module @deepseek-ai/dsh-client-theme/system-fonts
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Font directories scanned by default (macOS user, local, and system). */
export const SYSTEM_FONT_DIRECTORIES: readonly string[] = Object.freeze([
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  '/Library/Fonts',
  path.join(os.homedir(), 'Library', 'Fonts'),
])

/** Family names that mean "the platform default" and are offered as System. */
const SYSTEM_ALIASES = new Set(['.AppleSystemUIFont', 'System Font', 'SF NS Text', 'SF NS Display', 'LastResort'])

/** Upper bound on returned families (a few hundred families is typical). */
const MAX_FAMILIES = 2000

/** Bytes read for a table directory (covers every observed sfnt layout). */
const DIRECTORY_WINDOW = 4096

/** Strip control characters a lax name record may carry (NUL padding etc.). */
function cleanFamilyName(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

/**
 * Parse family names from one sfnt font buffer (TTF/OTF single font).
 * Reads the `name` table and prefers name ID 16 (typographic family),
 * falling back to name ID 1; prefers the English Windows record, then any
 * Unicode/Windows record, then the Macintosh Roman record (Apple's system
 * fonts often ship Macintosh-platform names only).
 * @param view - buffer positioned at a plain sfnt font start.
 * @param absoluteTables - true when the font lives inside a TrueType
 *   collection, whose table-directory offsets are absolute file offsets
 *   (OpenType spec) rather than font-relative.
 * @returns the family names found (usually one).
 */
function parseSfntFamilies(view: DataView, absoluteTables = false): string[] {
  if (view.byteLength < 12) return []
  // sfntVersion: 0x00010000 for TrueType, 'OTTO' (0x4f54544f) for CFF.
  const version = view.getUint32(0)
  if (version !== 0x00010000 && version !== 0x4f54544f) return []
  const numTables = view.getUint16(4)
  let nameOffset = -1
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16
    if (record + 16 > view.byteLength) return []
    if (view.getUint32(record) === 0x6e616d65) { // 'name'
      nameOffset = view.getUint32(record + 8)
      break
    }
  }
  if (nameOffset < 0) return []
  const tableAt = absoluteTables ? nameOffset : view.byteOffset + nameOffset
  if (tableAt + 6 > view.buffer.byteLength) return []
  return parseNameTableRecords(new DataView(view.buffer, tableAt))
}

/** Parse one `name` table buffer into its family-name records. */
function parseNameTableRecords(view: DataView): string[] {
  if (view.byteLength < 6) return []
  const nameOffset = 0
  const count = view.getUint16(nameOffset + 2)
  const storage = nameOffset + view.getUint16(nameOffset + 4)
  const latin: { id: number; text: string }[] = []
  const unicode: { id: number; text: string }[] = []
  const macintosh: { id: number; text: string }[] = []
  for (let i = 0; i < count; i++) {
    const record = nameOffset + 6 + i * 12
    if (record + 12 > view.byteLength) break
    const platform = view.getUint16(record)
    const nameId = view.getUint16(record + 6)
    if (nameId !== 1 && nameId !== 16) continue
    const length = view.getUint16(record + 8)
    const offset = storage + view.getUint16(record + 10)
    if (offset + length > view.byteLength) continue
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length)
    const text = cleanFamilyName(platform === 1
      ? new TextDecoder('latin1').decode(bytes)
      : new TextDecoder('utf-16be').decode(bytes))
    if (text === '') continue
    // Mac-platform records with non-Roman encodings cannot be decoded here
    // (MacJapanese etc. are not Web decoders' latin1); those fonts carry the
    // same names in their Unicode (platform 0/3) records.
    if (platform === 1 && view.getUint16(record + 2) !== 0) continue
    const entry = { id: nameId, text }
    if (platform === 1) macintosh.push(entry)
    else if (platform === 3 && view.getUint16(record + 4) === 0x0409) latin.push(entry)
    else unicode.push(entry)
  }
  // Typographic family (16) wins over legacy family (1) within each tier,
  // and English Windows beats other Unicode beats Mac Roman; a font
  // contributes its one primary name (localized alternates stay out of the
  // picker, which dedupes across all system fonts).
  const pick = (names: { id: number; text: string }[]): string | undefined => {
    return (names.find(n => n.id === 16) ?? names[0])?.text
  }
  const primary = pick(latin) ?? pick(unicode) ?? pick(macintosh)
  return primary === undefined ? [] : [primary]
}

/**
 * Parse family names from a font file buffer: single sfnt fonts directly;
 * TrueType collections (.ttc) by iterating their embedded font offsets.
 * @param buffer - raw .ttf/.otf/.ttc bytes.
 * @returns the family names in the file.
 */
export function parseFontFileFamilies(buffer: ArrayBuffer): string[] {
  const view = new DataView(buffer)
  if (view.byteLength < 4) return []
  if (view.getUint32(0) === 0x74746366) { // 'ttcf'
    if (view.byteLength < 12) return []
    const fonts = view.getUint32(8)
    const names = new Set<string>()
    for (let i = 0; i < fonts; i++) {
      const at = 12 + i * 4
      if (at + 4 > view.byteLength) break
      const fontOffset = view.getUint32(at)
      if (fontOffset >= view.byteLength) continue
      const fontView = new DataView(buffer, fontOffset)
      for (const name of parseSfntFamilies(fontView, true)) names.add(name)
    }
    return [...names]
  }
  return parseSfntFamilies(view)
}

/**
 * Read one sfnt font's name table starting at an absolute file offset.
 * @param absoluteTables - see {@link parseSfntFamilies}: TrueType-collection
 *   members address their tables in absolute file offsets.
 */
async function readSfntAt(handle: fs.FileHandle, size: number, fontOffset: number, absoluteTables: boolean): Promise<string[]> {
  const directory = Buffer.alloc(Math.min(DIRECTORY_WINDOW, size - fontOffset))
  await handle.read(directory, 0, directory.length, fontOffset)
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength)
  if (view.byteLength < 12) return []
  const version = view.getUint32(0)
  if (version !== 0x00010000 && version !== 0x4f54544f) return []
  const numTables = view.getUint16(4)
  let nameTableOffset = -1
  let nameLength = 0
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16
    if (record + 16 > directory.length) return []
    if (view.getUint32(record) === 0x6e616d65) { // 'name'
      nameTableOffset = view.getUint32(record + 8)
      nameLength = view.getUint32(record + 12)
      break
    }
  }
  if (nameTableOffset < 0 || nameTableOffset + nameLength > size || nameLength > 1 << 20) return []
  const table = Buffer.alloc(nameLength)
  await handle.read(table, 0, nameLength, absoluteTables ? nameTableOffset : fontOffset + nameTableOffset)
  return parseNameTableRecords(new DataView(table.buffer, table.byteOffset, table.byteLength))
}

/**
 * Read one font file with ranged reads and return its family names. Only
 * the table directory and the name-table bytes are read, not the whole
 * file (system CJK collections run to tens of megabytes).
 */
async function readFileFamilies(handle: fs.FileHandle, size: number): Promise<string[]> {
  const head = Buffer.alloc(Math.min(DIRECTORY_WINDOW, size))
  await handle.read(head, 0, head.length, 0)
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  if (view.byteLength < 4) return []

  // TrueType collection: parse each embedded font's directory separately.
  if (view.getUint32(0) === 0x74746366) {
    if (head.length < 12) return []
    const names = new Set<string>()
    const fonts = Math.min(view.getUint32(8), 64)
    for (let i = 0; i < fonts; i++) {
      const at = 12 + i * 4
      if (at + 4 > head.length) break
      const fontOffset = view.getUint32(at)
      if (fontOffset >= size) continue
      for (const name of await readSfntAt(handle, size, fontOffset, true)) names.add(name)
    }
    return [...names]
  }
  return readSfntAt(handle, size, 0, false)
}

/**
 * Enumerate the installed font families across the given directories
 * (recursive one level, which matches the system layout). Missing
 * directories and unreadable files are skipped; enumeration never throws.
 * @param directories - font directories to scan (defaults to {@link SYSTEM_FONT_DIRECTORIES}).
 * @returns deduplicated, sorted family names.
 */
export async function listSystemFontFamilies(
  directories: readonly string[] = SYSTEM_FONT_DIRECTORIES,
): Promise<string[]> {
  const names = new Set<string>()
  for (const directory of directories) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue // directory absent or unreadable (non-macOS host)
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      const targets = entry.isDirectory()
        ? (await fs.readdir(file, { withFileTypes: true }).catch((): import('node:fs').Dirent[] => []))
          .filter(child => /\.(ttf|otf|ttc)$/i.test(child.name))
          .map(child => path.join(file, child.name))
        : /\.(ttf|otf|ttc)$/i.test(entry.name) ? [file] : []
      for (const target of targets) {
        let families: string[]
        try {
          const handle = await fs.open(target, 'r')
          try {
            families = await readFileFamilies(handle, (await handle.stat()).size)
          } finally {
            await handle.close()
          }
        } catch {
          continue // unreadable font file
        }
        for (const family of families) {
          // Dot-prefixed families are Apple's private/hidden fonts.
          if (family !== '' && !family.startsWith('.') && !SYSTEM_ALIASES.has(family)) names.add(family)
        }
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b)).slice(0, MAX_FAMILIES)
}
