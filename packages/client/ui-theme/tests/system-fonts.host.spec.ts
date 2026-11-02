/** System font enumeration: sfnt name-table parsing (TTF + TTC) and the
 * directory scan's tolerance of missing directories. */
import { describe, expect, it } from 'vitest'
import { listSystemFontFamilies, parseFontFileFamilies } from '../src/system-fonts.ts'

/** Minimal writer for big-endian fields over a growable buffer. */
class Bin {
  readonly bytes: number[] = []
  u16(v: number): this { this.bytes.push((v >> 8) & 0xff, v & 0xff); return this }
  u32(v: number): this {
    this.bytes.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
    return this
  }
  tag(text: string): this {
    for (const ch of text) this.bytes.push(ch.charCodeAt(0))
    return this
  }
  utf16(text: string): this {
    for (const ch of text) this.u16(ch.charCodeAt(0))
    return this
  }
  done(): ArrayBuffer { return Uint8Array.from(this.bytes).buffer }
}

/**
 * Build one sfnt font whose name table carries the given (nameId, text)
 * Windows-English records.
 */
function buildFont(names: { id: number; text: string }[]): ArrayBuffer {
  // name table: format, count, stringOffset=6+12*count, then records+storage
  const storage: number[] = []
  const records: { id: number; offset: number; length: number }[] = []
  for (const name of names) {
    const utf: number[] = []
    for (const ch of name.text) { utf.push((ch.charCodeAt(0) >> 8) & 0xff, ch.charCodeAt(0) & 0xff) }
    records.push({ id: name.id, offset: storage.length, length: utf.length })
    storage.push(...utf)
  }
  const name = new Bin()
  name.u16(0).u16(records.length).u16(6 + records.length * 12)
  for (const record of records) {
    name.u16(3).u16(1).u16(0x0409).u16(record.id).u16(record.length).u16(record.offset)
  }
  for (const byte of storage) name.bytes.push(byte)
  const nameBytes = name.done()
  const header = new Bin()
  // sfntVersion + numTables + searchRange/entrySelector/rangeShift = 12
  // bytes, then the table record.
  header.u32(0x00010000).u16(1).u16(16).u16(0).u16(0)
  header.tag('name').u32(0).u32(28).u32(nameBytes.byteLength)
  const out = new Uint8Array(28 + nameBytes.byteLength)
  out.set(new Uint8Array(header.done()), 0)
  out.set(new Uint8Array(nameBytes), 28)
  return out.buffer
}

describe('parseFontFileFamilies', () => {
  it('reads the Windows-English family from a TTF name table', () => {
    const families = parseFontFileFamilies(buildFont([
      { id: 1, text: 'Georgia' },
      { id: 16, text: 'Georgia Pro' },
    ]))
    // Typographic family (16) wins over the legacy family (1).
    expect(families).toEqual(['Georgia Pro'])
  })

  it('falls back to the legacy family when no typographic family exists', () => {
    expect(parseFontFileFamilies(buildFont([{ id: 1, text: 'Menlo' }]))).toEqual(['Menlo'])
  })

  it('iterates every font in a TrueType collection using absolute table offsets', () => {
    const a = new Uint8Array(buildFont([{ id: 16, text: 'Songti SC' }]))
    const b = new Uint8Array(buildFont([{ id: 16, text: 'Songti TC' }]))
    // Per the OpenType spec a collection member's table-directory offsets
    // address the TTC file, not the member font, so each member's `name`
    // table offset is rewritten to its absolute file position
    // (member start + 12-byte header + one 16-byte table record).
    const ttc = new Bin()
    // tag(4) + version(4) + fontCount(4) + two offsets(4 each) = 20 bytes.
    ttc.tag('ttcf').u32(0x00010000).u32(2).u32(20).u32(20 + a.byteLength)
    const out = new Uint8Array(20 + a.byteLength + b.byteLength)
    out.set(new Uint8Array(ttc.done()), 0)
    out.set(a, 20)
    out.set(b, 20 + a.byteLength)
    const aView = new DataView(out.buffer, 20)
    const bView = new DataView(out.buffer, 20 + a.byteLength)
    aView.setUint32(20, 20 + 28) // font A's name-table offset, absolute
    bView.setUint32(20, 20 + a.byteLength + 28) // font B's name-table offset, absolute
    expect(parseFontFileFamilies(out.buffer)).toEqual(['Songti SC', 'Songti TC'])
  })

  it('rejects buffers that are not sfnt fonts', () => {
    expect(parseFontFileFamilies(new TextEncoder().encode('not a font').buffer as ArrayBuffer)).toEqual([])
    expect(parseFontFileFamilies(new ArrayBuffer(2))).toEqual([])
  })
})

describe('listSystemFontFamilies', () => {
  it('returns a sorted list and skips missing directories without throwing', async () => {
    const families = await listSystemFontFamilies(['/nonexistent-fonts-dir'])
    expect(families).toEqual([])
  })
})
