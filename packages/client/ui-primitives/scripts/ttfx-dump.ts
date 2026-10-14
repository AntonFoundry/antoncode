/**
 * Node QA dump: sample the real anton-mark.png into the half-block grid,
 * run every roster effect to completion, and dump representative frames as
 * PNGs for visual read_image verification. Not shipped source — a dev
 * script run with tsx (`node --import tsx/esm scripts/ttfx-dump.ts`).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { sampleImageGrid } from '../src/ttfx/image-grid.ts'
import type { PixelSource } from '../src/ttfx/image-grid.ts'
import { RevealRunner } from '../src/ttfx/run.ts'
import { EFFECT_IDS } from '../src/ttfx/effects.ts'
import type { FrameCell } from '../src/ttfx/scene.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const MARK = path.join(ROOT, 'apps/web/public/anton-mark.png')
const OUT_DIR = path.join(ROOT, 'packages/client/ui-primitives/.ttfx-qa')
const COLS = 96
const CORNER = 0.28
const SCALE = 4

/** Decode a non-interlaced 8-bit PNG (color types 0/2/4/6) into a pixel source. */
function decodePng(buf: Buffer): PixelSource {
  if (buf.readUInt32BE(0) !== 0x89_50_4e_47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * channels)
  let src = 0
  let prev = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src]
    src += 1
    const rowStart = y * stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[rowStart + x - channels] : 0
      const up = y > 0 ? out[rowStart - stride + x] : 0
      const upLeft = y > 0 && x >= channels ? out[rowStart - stride + x - channels] : 0
      const v = raw[src + x]
      let f: number
      if (filter === 0) f = v
      else if (filter === 1) f = v + left
      else if (filter === 2) f = v + up
      else if (filter === 3) f = v + Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        f = v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
      } else throw new Error(`bad filter ${filter}`)
      out[rowStart + x] = f & 0xff
    }
    src += stride
  }
  return {
    width,
    height,
    pixel(x: number, y: number) {
      const i = (y * width + x) * channels
      if (channels === 1) return [out[i], out[i], out[i], 255]
      if (channels === 3) return [out[i], out[i + 1], out[i + 2], 255]
      if (channels === 2) return [out[i], out[i], out[i], out[i + 1]]
      return [out[i], out[i + 1], out[i + 2], out[i + 3]]
    },
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xff_ff_ff_ff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xff_ff_ff_ff) >>> 0
}

/** Encode an RGB raster as an 8-bit PNG. */
function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Render one frame's cells into the pixel raster (1 cell = 1x2 px, scaled). */
function renderFrame(cells: readonly FrameCell[], rows: number, cols: number): Buffer {
  const rgb = Buffer.alloc(cols * 2 * rows * 3 * SCALE * SCALE)
  const put = (x: number, y: number, c: readonly [number, number, number] | null): void => {
    if (c === null) return
    for (let sy = 0; sy < SCALE; sy += 1) {
      for (let sx = 0; sx < SCALE; sx += 1) {
        const px = (x * SCALE + sx) * 3 + (y * SCALE + sy) * cols * SCALE * 3
        rgb[px] = c[0]
        rgb[px + 1] = c[1]
        rgb[px + 2] = c[2]
      }
    }
  }
  for (const cell of cells) {
    const x = cell.col - 1
    const yTop = (rows - cell.row) * 2
    if (cell.sym === '▄') {
      put(x, yTop, cell.bg)
      put(x, yTop + 1, cell.fg)
    } else if (cell.sym === '█') {
      put(x, yTop, cell.fg)
      put(x, yTop + 1, cell.fg)
    } else {
      put(x, yTop, cell.sym === ' ' || cell.fg === null ? null : cell.fg)
      put(x, yTop + 1, cell.bg)
    }
  }
  return rgb
}

mkdirSync(OUT_DIR, { recursive: true })
const mark = decodePng(readFileSync(MARK))
console.log(`mark: ${mark.width}x${mark.height}`)
const grid = sampleImageGrid(mark, { cols: COLS, cornerRadiusRatio: CORNER })
const rows = grid.length
console.log(`grid: ${rows} rows x ${COLS} cols, cells=${rows * COLS}`)
const keptCells = grid.flat().filter(c => c.sym !== ' ').length
console.log(`kept cells (non-space): ${keptCells}`)

/** The resting mark: grid cells at home positions with home colors. */
function restCells(): FrameCell[] {
  const out: FrameCell[] = []
  for (let r = 0; r < grid.length; r += 1) {
    const line = grid[r] as (typeof grid)[number]
    for (let c = 0; c < line.length; c += 1) {
      const cell = line[c] as (typeof line)[number]
      if (cell.sym === ' ') continue
      out.push({ row: rows - r, col: c + 1, sym: cell.sym, fg: cell.fg, bg: cell.bg })
    }
  }
  return out
}
const REST = renderFrame(restCells(), rows, COLS)

const summary: string[] = []
let failures = 0
for (const effect of EFFECT_IDS) {
  const runner = new RevealRunner(grid, { effect, seed: 42 })
  const frames: FrameCell[][] = []
  let count = 0
  let cells = runner.next()
  let last: FrameCell[] | null = null
  while (cells !== null && count < 3000) {
    count += 1
    if (count === 1 || count % 30 === 0) frames.push(cells)
    last = cells
    cells = runner.next()
  }
  if (cells !== null) console.warn(`${effect}: hit 3000-frame cap!`)
  if (last === null) {
    summary.push(`${effect}: no frames`)
    failures += 1
    continue
  }
  const picks = [frames[0], frames[Math.floor(frames.length / 2)], frames[frames.length - 1], last]
  for (let i = 0; i < picks.length; i += 1) {
    const frame = picks[i]
    if (frame === undefined || frame === null) continue
    const png = encodePng(COLS * SCALE, rows * 2 * SCALE, renderFrame(frame, rows, COLS))
    const label = ['first', 'mid', 'last', 'final'][i]
    writeFileSync(path.join(OUT_DIR, `${effect}-${label}.png`), png)
  }
  const finalRaster = renderFrame(last, rows, COLS)
  const mid = frames[Math.floor(frames.length / 2)]
  const midRaster = renderFrame(mid ?? last, rows, COLS)
  let finalMatches = true
  for (let i = 0; i < REST.length; i += 1) {
    if (REST[i] !== finalRaster[i]) {
      finalMatches = false
      break
    }
  }
  let animationDiffers = false
  for (const candidate of frames) {
    const raster = renderFrame(candidate as never, rows, COLS)
    for (let i = 0; i < REST.length; i += 1) {
      if (REST[i] !== raster[i]) {
        animationDiffers = true
        break
      }
    }
    if (animationDiffers) break
  }
  if (!finalMatches || !animationDiffers) {
    failures += 1
    console.error(`${effect}: finalMatchesRest=${finalMatches} hasAnimatedFrame=${animationDiffers}`)
  } else {
    console.log(`${effect}: final frame matches the resting mark; an earlier frame differs`)
  }
  summary.push(`${effect}: ${count} frames`)
  console.log(`${effect}: ${count} frames`)
}
writeFileSync(path.join(OUT_DIR, 'summary.txt'), summary.join('\n'))
console.log(`dumped to ${OUT_DIR}`)
if (failures > 0) {
  console.error(`${failures} effect(s) failed the resting-mark contract`)
  process.exit(1)
}
console.log('all effects: final frame == resting mark')
