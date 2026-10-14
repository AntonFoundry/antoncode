import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserImageDom, loadPixelSource, sampleImageGrid } from '../src/ttfx/image-grid.ts'
import type { DrawSurface, PixelSource, Rgba } from '../src/ttfx/image-grid.ts'

afterEach(() => vi.unstubAllGlobals())

function source(width: number, height: number, pixel: (x: number, y: number) => Rgba): PixelSource {
  return { width, height, pixel }
}

describe('ttfx image grid', () => {
  it('samples top and bottom pixels, thresholds alpha, and masks rounded corners', () => {
    const pixels = source(4, 4, (x, y) => [x * 10, y * 20, 99, 8])
    const grid = sampleImageGrid(pixels, { cols: 2, alphaThreshold: 8 })
    expect(grid).toHaveLength(1)
    expect(grid[0]?.[0]).toEqual({ sym: '▀', fg: [10, 20, 99], bg: [10, 60, 99] })
    const belowThreshold = sampleImageGrid(source(4, 4, (_x, y) => [1, 2, 3, y === 1 ? 7 : 8]), { cols: 2 })
    expect(belowThreshold[0]?.[0]?.fg).toBeNull()
    expect(sampleImageGrid(source(4, 1, () => [1, 2, 3, 255]), { cols: 2 })[0]?.map(cell => cell.sym)).toEqual([' ', ' '])
    expect(() => sampleImageGrid(pixels, { cols: 0 })).toThrow(RangeError)
    const rounded = sampleImageGrid(source(4, 4, (x, y) => [x, y, 3, 255]), { cols: 4, cornerRadiusRatio: 0.28 })
    expect(rounded.flat().some(cell => cell.sym === ' ')).toBe(true)
    expect(rounded.flat().some(cell => cell.sym === '▀')).toBe(true)
  })

  it('loads decoded pixels through the injected adapter', async () => {
    const drawImage = vi.fn()
    const rgba = [11, 22, 33, 44, 55, 66, 77, 88, 99, 111, 122, 133, 144, 155, 166, 177]
    const surface: DrawSurface = {
      drawImage,
      getImageData: vi.fn(() => ({ data: rgba })),
    }
    const dom = {
      loadImage: vi.fn(async (url: string) => ({
        width: 2,
        height: 2,
        drawTo: (target: DrawSurface) => { target.drawImage(url, 0, 0) },
      })),
      createSurface: vi.fn(() => surface),
    }
    const loaded = await loadPixelSource('/mark.png', dom)
    expect(dom.loadImage).toHaveBeenCalledWith('/mark.png')
    expect(dom.createSurface).toHaveBeenCalledWith(2, 2)
    expect(drawImage).toHaveBeenCalledWith('/mark.png', 0, 0)
    expect(loaded.pixel(0, 0)).toEqual([11, 22, 33, 44])
    expect(loaded.pixel(1, 1)).toEqual([144, 155, 166, 177])
  })

  it('uses browser Image and OffscreenCanvas adapters at call time', async () => {
    class FakeImage {
      src = ''
      naturalWidth = 2
      naturalHeight = 2
      decode = vi.fn(async () => undefined)
    }
    const drawImage = vi.fn()
    const surface: DrawSurface = { drawImage, getImageData: () => ({ data: new Array(16).fill(255) }) }
    class FakeCanvas {
      constructor(readonly width: number, readonly height: number) {}
      getContext = vi.fn((_kind: string) => surface)
    }
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('OffscreenCanvas', FakeCanvas)
    const dom = browserImageDom()
    const image = await dom.loadImage('/mark.png')
    expect(image.width).toBe(2)
    expect(image.height).toBe(2)
    const canvas = dom.createSurface(2, 2)
    image.drawTo(canvas)
    expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0)
    const pixelSource = await loadPixelSource('/mark.png', dom)
    expect(pixelSource.pixel(1, 1)).toEqual([255, 255, 255, 255])
  })
})
