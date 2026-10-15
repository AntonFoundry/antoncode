/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseRandomEffect, drawFrame, FishLogoAnimated } from '../src/FishLogoAnimated.tsx'
import type { AnimationClock, FishLogoAnimatedAdapters } from '../src/FishLogoAnimated.tsx'
import type { DrawSurface, ImageDomAdapter, PixelSource } from '../src/ttfx/image-grid.ts'
import type { GridCell } from '../src/ttfx/grid.ts'
import { EFFECT_IDS } from '../src/ttfx/effects.ts'

/** A deterministic clock that stores RAF callbacks until a test flushes. */
function makeClock() {
  let now = 0
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  const clock: AnimationClock = {
    request(callback) {
      const id = nextId
      nextId += 1
      callbacks.set(id, callback)
      return id
    },
    cancel(id) {
      callbacks.delete(id)
    },
    now: () => now,
  }
  return {
    clock,
    flush(timestamp: number) {
      now = timestamp
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback(timestamp)
    },
    get pending() { return callbacks.size },
  }
}

/** Tiny deterministic pixel source with one 2x2 colored square. */
const pixels: PixelSource = {
  width: 4,
  height: 4,
  pixel(x, y) {
    return x > 0 && x < 3 && y > 0 && y < 3 ? [30 + x * 10, 80 + y * 10, 150, 255] : [0, 0, 0, 0]
  },
}

/** Injected image decoder and canvas pixel provider. */
function makeAdapters(clock: AnimationClock): FishLogoAnimatedAdapters {
  const dom: ImageDomAdapter = {
    async loadImage() {
      return { width: pixels.width, height: pixels.height, drawTo: () => undefined }
    },
    createSurface(width, height) {
      return {
        drawImage: () => undefined,
        getImageData: () => ({ data: new Uint8ClampedArray(Array.from({ length: width * height }, (_, i) => {
          const x = i % width
          const y = Math.floor(i / width)
          return pixels.pixel(x, y)
        }).flat()) }),
      }
    },
  }
  const sampleGrid = (): GridCell[][] => [
    [{ sym: 'A', fg: [35, 90, 150], bg: [40, 100, 160] }, { sym: '▀', fg: [45, 110, 170], bg: [50, 120, 180] }],
    [{ sym: '▄', fg: [55, 130, 190], bg: null }, { sym: '█', fg: null, bg: [60, 140, 200] }],
  ]
  return { imageDom: dom, clock, sampleGrid, random: () => 0 }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mockCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    set fillStyle(_value: string) { /* canvas style storage is irrelevant */ },
  } as unknown as CanvasRenderingContext2D)
}

describe('FishLogoAnimated', () => {
  it('chooses opening effects across the full curated roster', () => {
    expect(chooseRandomEffect(() => 0)).toBe(EFFECT_IDS[0])
    expect(chooseRandomEffect(() => 0.5)).toBe(EFFECT_IDS[Math.floor(EFFECT_IDS.length / 2)])
    expect(chooseRandomEffect(() => 1)).toBe(EFFECT_IDS.at(-1))
  })

  it('chooses once per mount and keeps the effect through rerenders', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
    mockCanvas()
    const fake = makeClock()
    const adapters = makeAdapters(fake.clock)
    const random = vi.fn(() => 0.5)
    adapters.random = random
    const view = render(<FishLogoAnimated adapters={adapters} />)
    await act(async () => { await Promise.resolve() })
    expect(random).toHaveBeenCalledTimes(1)
    view.rerender(<FishLogoAnimated size={290} adapters={adapters} />)
    expect(random).toHaveBeenCalledTimes(1)
    view.unmount()
    render(<FishLogoAnimated adapters={adapters} />)
    await act(async () => { await Promise.resolve() })
    expect(random).toHaveBeenCalledTimes(2)
  })

  it('draws each supported character cell and leaves transparent halves alone', () => {
    const clearRect = vi.fn()
    const fillRect = vi.fn()
    const context = { clearRect, fillRect, fillStyle: '' } as unknown as CanvasRenderingContext2D
    const canvas = { width: 2, height: 4, getContext: () => context } as unknown as HTMLCanvasElement
    drawFrame(canvas, [
      { row: 2, col: 1, sym: '▀', fg: [1, 2, 3], bg: null },
      { row: 2, col: 2, sym: '▄', fg: [4, 5, 6], bg: [7, 8, 9] },
      { row: 1, col: 1, sym: '█', fg: [10, 11, 12], bg: null },
      { row: 1, col: 2, sym: 'x', fg: [13, 14, 15], bg: null },
      { row: 1, col: 2, sym: ' ', fg: [16, 17, 18], bg: [19, 20, 21] },
    ], 2, 2)
    expect(clearRect).toHaveBeenCalledWith(0, 0, 2, 4)
    expect(fillRect).toHaveBeenCalledTimes(5)
    const blank = { width: 1, height: 1, getContext: () => null } as unknown as HTMLCanvasElement
    drawFrame(blank, [], 1, 1)
  })

  it('renders the static mark and starts entrance animation when decoded', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
    mockCanvas()
    const fake = makeClock()
    const { container } = render(<FishLogoAnimated adapters={makeAdapters(fake.clock)} />)
    fireEvent.pointerEnter(container.firstElementChild as HTMLElement)
    const image = container.querySelector('img')
    const canvas = container.querySelector('canvas')
    expect(image?.getAttribute('src')).toBe('/anton-mark.png')
    expect(image?.getAttribute('aria-hidden')).toBe('true')
    expect(canvas?.getAttribute('aria-hidden')).toBe('true')
    await act(async () => { await Promise.resolve() })
    expect(fake.pending).toBe(1)
  })

  it('does not schedule animation when reduced motion is requested', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true }) })
    mockCanvas()
    const fake = makeClock()
    const { container } = render(<FishLogoAnimated adapters={makeAdapters(fake.clock)} />)
    await act(async () => { await Promise.resolve() })
    expect(fake.pending).toBe(0)
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('honors a reduced-motion change while the image is decoding', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
    mockCanvas()
    const fake = makeClock()
    const adapters = makeAdapters(fake.clock)
    let resolveImage: ((value: { width: number; height: number; drawTo(surface: DrawSurface): void }) => void) | undefined
    adapters.imageDom.loadImage = () => new Promise((resolve) => { resolveImage = resolve })
    render(<FishLogoAnimated adapters={adapters} />)
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true }) })
    resolveImage?.({ width: 4, height: 4, drawTo: () => undefined })
    await act(async () => { await Promise.resolve() })
    expect(fake.pending).toBe(0)
  })

  it('runs an effect on pointer enter after entrance is disabled', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
    mockCanvas()
    const fake = makeClock()
    const { container } = render(<FishLogoAnimated entrance={false} adapters={makeAdapters(fake.clock)} />)
    await act(async () => { await Promise.resolve() })
    const wrapper = container.firstElementChild as HTMLElement
    fireEvent.pointerEnter(wrapper)
    expect(fake.pending).toBe(1)
    act(() => { fake.flush(100) })
    expect(container.querySelector('canvas')?.style.opacity).toBe('1')
    fireEvent.pointerEnter(wrapper)
    expect(fake.pending).toBe(1)
    act(() => { fake.flush(110) })
    expect(fake.pending).toBe(1)
    act(() => { fake.flush(160) })
    expect(fake.pending).toBe(1)
    let timestamp = 210
    for (let i = 0; i < 1000 && fake.pending > 0; i += 1) {
      act(() => { fake.flush(timestamp) })
      timestamp += 50
    }
    expect(fake.pending).toBe(0)
    expect(container.querySelector('canvas')?.style.opacity).toBe('0')
    for (let effectIndex = 1; effectIndex < 11; effectIndex += 1) {
      fireEvent.pointerEnter(wrapper)
      for (let i = 0; i < 5000 && fake.pending > 0; i += 1) {
        act(() => { fake.flush(timestamp) })
        timestamp += 50
      }
      expect(fake.pending, `hover effect ${effectIndex}`).toBe(0)
      expect(container.querySelector('canvas')?.style.opacity).toBe('0')
    }
    fireEvent.pointerEnter(wrapper)
    expect(fake.pending).toBe(1)
  })

  it('uses default sampler and browser clock when overrides are omitted', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
    mockCanvas()
    let rafCallback: FrameRequestCallback | undefined
    const request = vi.fn((callback: FrameRequestCallback) => {
      rafCallback = callback
      return 9
    })
    vi.stubGlobal('requestAnimationFrame', request)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const now = vi.spyOn(performance, 'now').mockReturnValue(123)
    const fake = makeClock()
    const adapters = makeAdapters(fake.clock)
    delete adapters.clock
    delete adapters.sampleGrid
    const { container, unmount } = render(<FishLogoAnimated entrance={false} adapters={adapters} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.pointerEnter(container.firstElementChild as HTMLElement)
    expect(request).toHaveBeenCalledTimes(1)
    expect(now).toHaveBeenCalled()
    act(() => rafCallback?.(0))
    expect(request).toHaveBeenCalledTimes(2)
    act(() => rafCallback?.(100))
    expect(request).toHaveBeenCalledTimes(3)
    expect(container.querySelector('canvas')?.style.opacity).toBe('1')
    unmount()
    act(() => rafCallback?.(200))
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('unmount before image decode prevents the entrance from starting', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
    const fake = makeClock()
    let resolveImage: ((value: { width: number; height: number; drawTo(surface: DrawSurface): void }) => void) | undefined
    const adapters = makeAdapters(fake.clock)
    adapters.imageDom.loadImage = () => new Promise((resolve) => { resolveImage = resolve })
    const { unmount } = render(<FishLogoAnimated adapters={adapters} />)
    unmount()
    resolveImage?.({ width: 4, height: 4, drawTo: () => undefined })
    await act(async () => { await Promise.resolve() })
    expect(fake.pending).toBe(0)
  })

  it('uses only the image when the decoded source fails', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
    const fake = makeClock()
    const adapters = makeAdapters(fake.clock)
    adapters.imageDom.loadImage = async () => { throw new Error('decode failed') }
    const { container } = render(<FishLogoAnimated adapters={adapters} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(container.querySelector('img')).not.toBeNull()
    expect(fake.pending).toBe(0)
  })

  it('uses shipped adapters when no overrides are supplied', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
    const { container } = render(<FishLogoAnimated entrance={false} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('supports static mode with hover disabled', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
    mockCanvas()
    const fake = makeClock()
    const { container } = render(<FishLogoAnimated entrance={false} disableHover adapters={makeAdapters(fake.clock)} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.pointerEnter(container.firstElementChild as HTMLElement)
    expect(fake.pending).toBe(0)
  })
})
