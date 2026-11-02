// @vitest-environment jsdom
// Lease semantics of the shared camera engine: one capture per device across
// leases, refcounted release, lazy model load, and the failure→status mapping.
// The MediaPipe segmenter and the canvas stabilizer are stubbed — their own
// contracts are covered by segmenter-adjacent specs and mask.spec.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CameraEngine, type EngineFrame } from '../src/client/engine.js'

vi.mock('../src/client/segmenter.js', () => ({
  createSegmenter: vi.fn(async () => ({
    delegate: 'CPU' as const,
    segment: vi.fn(() => ({
      // selfie_segmenter contract: ONE person-confidence plane (proven
      // against the vendored model — a two-plane stub once hid a regression
      // where the engine read plane [1] of a one-plane result).
      confidenceMasks: [
        { getAsFloat32Array: () => new Float32Array(256 * 256).fill(0.8) },
      ],
      close: vi.fn(),
    })),
    close: vi.fn(),
  })),
}))

const pushedFrames = vi.hoisted(() => [] as Float32Array[])

vi.mock('../src/client/mask.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  MaskStabilizer: class {
    canvas = { width: 256, height: 256 }
    /** Records the plane the engine fed — the person plane, not background. */
    push(frame: Uint8ClampedArray<ArrayBuffer>): void {
      pushedFrames.push(new Float32Array([frame[0]! / 255]))
    }
    reset(): void {}
  },
}))

/** A video element stub that reports live picture data immediately. */
function fakeVideoElement(): HTMLVideoElement {
  return {
    muted: false, playsInline: false, autoplay: false, srcObject: null, readyState: 4,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    load: vi.fn(),
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

  it('the last release resets the media pipeline so WebKit drops the capture', async () => {
    const engine = new CameraEngine()
    const lease = await engine.acquire(undefined)
    lease.release()
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(videoStub.pause).toHaveBeenCalled()
    expect(videoStub.srcObject).toBeNull()
    expect(videoStub.load).toHaveBeenCalled()
    expect(engine.snapshot().camera.phase).toBe('idle')
  })

  it('a superseded start stops its own late stream so the capture cannot orphan', async () => {
    let resolveFirst!: (stream: unknown) => void
    let calls = 0
    const lateStop = vi.fn()
    getUserMedia.mockImplementation(async () => {
      calls += 1
      if (calls === 1) {
        return await new Promise((resolve) => { resolveFirst = resolve })
      }
      return {
        getTracks: () => [{ stop: stopTrack }],
        getVideoTracks: () => [{ label: 'Other Camera', getSettings: () => ({ width: 1280, height: 720 }) }],
      }
    })
    const engine = new CameraEngine()
    const superseded = engine.acquire('cam-a') // parks on the deferred getUserMedia
    const live = await engine.acquire('cam-b') // gen 2 completes first
    resolveFirst({
      getTracks: () => [{ stop: lateStop }],
      getVideoTracks: () => [{ label: 'FaceTime HD Camera', getSettings: () => ({ width: 1280, height: 720 }) }],
    })
    await superseded
    // The gen-1 stream landed after a newer start published: dropped, not orphaned.
    expect(lateStop).toHaveBeenCalledTimes(1)
    expect(engine.snapshot().camera.phase).toBe('ready')
    live.release()
    engine.dispose()
    expect(stopTrack).toHaveBeenCalled()
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
    expect(engine.snapshot().segmenter.delegate).toBe('CPU')
    const segmented = frames.filter(frame => frame.mask !== undefined)
    expect(segmented.length).toBeGreaterThan(0)
    expect(segmented[0]!.delegate).toBe('CPU')
    // The stabilizer is fed the person plane (the single plane, 0.8) —
    // 0.8 → alpha 204 — proving the engine consumes the one real plane.
    const pushed = pushedFrames.at(-1)
    expect(pushed?.[0]).toBeCloseTo(204 / 255)
    releaseSeg()
    lease.release()
  })

  it('surfaces consecutive segmentation failures on the frame instead of failing silently', async () => {
    const { createSegmenter } = await import('../src/client/segmenter.js')
    vi.mocked(createSegmenter).mockResolvedValueOnce({
      delegate: 'CPU',
      // Every frame throws — the engine must count and publish the issue,
      // never composite silently without a person cutout.
      segment: () => { throw new Error('Graph has errors: Calculator::Open() failed') },
      close: vi.fn(),
    })
    const engine = new CameraEngine()
    const lease = await engine.acquire(undefined)
    const frames: EngineFrame[] = []
    lease.onFrame((frame) => { frames.push(frame) })
    const releaseSeg = lease.enableSegmentation()
    await vi.advanceTimersByTimeAsync(50)
    const failing = frames.filter(frame => frame.segmenterIssue !== undefined)
    expect(failing.length).toBeGreaterThan(0)
    expect(failing[0]!.segmenterIssue).toContain('dropped')
    expect(failing[0]!.segmenterIssue).toContain('Calculator::Open()')
    expect(failing[0]!.mask).toBeUndefined()
    releaseSeg()
    // Retired with the segmentation request: the issue clears for raw views.
    await vi.advanceTimersByTimeAsync(20)
    expect(frames.at(-1)!.segmenterIssue).toBeUndefined()
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
