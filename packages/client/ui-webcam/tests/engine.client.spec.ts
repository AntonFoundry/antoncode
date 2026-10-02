// @vitest-environment jsdom
// Lease semantics of the shared camera engine: one capture per device across
// leases, refcounted release, lazy model load, and the failure→status mapping.
// The MediaPipe segmenter and the canvas stabilizer are stubbed — their own
// contracts are covered by segmenter-adjacent specs and mask.spec.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CameraEngine, type EngineFrame } from '../src/client/engine.js'

vi.mock('../src/client/segmenter.js', () => ({
  createSegmenter: vi.fn(async () => ({
    delegate: 'GPU' as const,
    segment: vi.fn(() => ({
      confidenceMasks: [{ getAsFloat32Array: () => new Float32Array(256 * 256) }],
      close: vi.fn(),
    })),
    close: vi.fn(),
  })),
}))

vi.mock('../src/client/mask.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  MaskStabilizer: class {
    canvas = { width: 256, height: 256 }
    push(): void {}
    reset(): void {}
  },
}))

/** A video element stub that reports live picture data immediately. */
function fakeVideoElement(): HTMLVideoElement {
  return {
    muted: false, playsInline: false, autoplay: false, srcObject: null, readyState: 4,
    play: vi.fn(async () => {}),
  } as unknown as HTMLVideoElement
}

describe('CameraEngine', () => {
  let videoStub: HTMLVideoElement
  let stopTrack: ReturnType<typeof vi.fn>
  let getUserMedia: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    videoStub = fakeVideoElement()
    stopTrack = vi.fn()
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
      getVideoTracks: () => [{ label: 'FaceTime HD Camera', getSettings: () => ({ width: 1280, height: 720 }) }],
    }
    getUserMedia = vi.fn(async () => stream)
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
      configurable: true,
    })
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'video' ? videoStub : document.createElement(tag)) as typeof document.createElement)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts one capture, publishes ready status, and streams frames to subscribers', async () => {
    const engine = new CameraEngine()
    const lease = await engine.acquire(undefined)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(engine.snapshot().camera.phase).toBe('ready')
    expect(engine.snapshot().camera.label).toBe('FaceTime HD Camera')
    const frames: EngineFrame[] = []
    lease.onFrame((frame) => { frames.push(frame) })
    await vi.advanceTimersByTimeAsync(50)
    expect(frames.length).toBeGreaterThanOrEqual(2)
    expect(frames[0]!.frameId).toBe(1)
    expect(frames[0]!.mask).toBeUndefined()
    expect(frames[0]!.video).toBe(videoStub)
    lease.release()
  })

  it('reuses the stream for a second lease on the same device; the last release stops the tracks', async () => {
    const engine = new CameraEngine()
    const first = await engine.acquire(undefined)
    const second = await engine.acquire(undefined)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    first.release()
    expect(stopTrack).not.toHaveBeenCalled()
    expect(engine.snapshot().camera.phase).toBe('ready')
    second.release()
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(engine.snapshot().camera.phase).toBe('idle')
  })

  it('restarts the capture when a lease names a different device', async () => {
    const engine = new CameraEngine()
    const first = await engine.acquire('cam-a')
    await engine.acquire('cam-b')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    first.release()
  })

  it('enableSegmentation lazily loads the model; frames then carry the mask and delegate', async () => {
    const engine = new CameraEngine()
    const lease = await engine.acquire(undefined)
    const frames: EngineFrame[] = []
    lease.onFrame((frame) => { frames.push(frame) })
    const releaseSeg = lease.enableSegmentation()
    await vi.advanceTimersByTimeAsync(50)
    expect(engine.snapshot().segmenter.phase).toBe('ready')
    expect(engine.snapshot().segmenter.delegate).toBe('GPU')
    const segmented = frames.filter(frame => frame.mask !== undefined)
    expect(segmented.length).toBeGreaterThan(0)
    expect(segmented[0]!.delegate).toBe('GPU')
    releaseSeg()
    lease.release()
  })

  it('maps permission denial to the denied phase and rethrows', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    const engine = new CameraEngine()
    await expect(engine.acquire(undefined)).rejects.toThrow('denied')
    expect(engine.snapshot().camera.phase).toBe('denied')
  })

  it('maps missing devices to the unavailable phase', async () => {
    getUserMedia.mockRejectedValue(new DOMException('no device', 'NotFoundError'))
    const engine = new CameraEngine()
    await expect(engine.acquire(undefined)).rejects.toThrow('no device')
    expect(engine.snapshot().camera.phase).toBe('unavailable')
  })

  it('dispose force-stops the capture and the loaded model regardless of leases', async () => {
    const engine = new CameraEngine()
    await engine.acquire(undefined)
    const releaseSeg = (await engine.acquire(undefined)).enableSegmentation()
    await vi.advanceTimersByTimeAsync(1)
    engine.dispose()
    expect(stopTrack).toHaveBeenCalled()
    expect(engine.snapshot().camera.phase).toBe('idle')
    expect(engine.snapshot().segmenter.phase).toBe('unloaded')
    releaseSeg()
  })
})
