/**
 * The camera engine: one refcounted capture (getUserMedia → detached video
 * element) per plugin, the lazy-loaded MediaPipe segmenter, and the per-frame
 * loop that converts background confidence into the temporally stabilized
 * person-alpha mask shared by every mounted view. Views acquire a lease,
 * subscribe to frames, and enable segmentation only while an effect is
 * active; the camera stops when the last lease releases.
 * @module @deepseek-ai/dsh-client-ui-webcam/client/engine
 */

import type { MaskCanvas } from './mask.js'
import { MaskStabilizer, personAlphaFromConfidence } from './mask.js'
import { createSegmenter, type SegmenterDelegate, type SegmenterHandle } from './segmenter.js'

/** Same-origin URL of the vendored selfie segmenter model (web frontend dist). */
export const MODEL_URL = '/mediapipe/selfie_segmenter.tflite'
/** Directory serving the vendored tasks-vision wasm fileset (web frontend dist). */
export const WASM_BASE = '/mediapipe/wasm'

/** Camera lifecycle phase. */
export type CameraPhase = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable' | 'error'

/** Segmentation-model lifecycle phase. */
export type SegmenterPhase = 'unloaded' | 'loading' | 'ready' | 'failed'

/** Immutable status snapshot the views read through the hooks compartment. */
export interface EngineSnapshot {
  camera: {
    phase: CameraPhase
    /** Device label once capture is live. */
    label?: string | undefined
    /** Live capture dimensions. */
    width?: number | undefined
    height?: number | undefined
    /** Error detail for the error phase. */
    message?: string | undefined
  }
  segmenter: {
    phase: SegmenterPhase
    /** The delegate actually initialized (ready phase). */
    delegate?: SegmenterDelegate | undefined
    /** Failure detail for the failed phase. */
    message?: string | undefined
  }
  /** Smoothed processing fps over the recent frame window. */
  fps: number
}

/** One processed frame published to subscribers. */
export interface EngineFrame {
  /** Monotonic frame counter. */
  frameId: number
  /** The live video element (the compositor's frame source). */
  video: HTMLVideoElement
  /** The stabilized person-alpha canvas, or undefined before the first segmentation. */
  mask: MaskCanvas | undefined
  /** Smoothed fps at publish time. */
  fps: number
  /** The loaded segmenter's delegate, or undefined while unloaded/failed. */
  delegate: SegmenterDelegate | undefined
  /**
   * Human-readable segmentation-health issue while frames are being dropped
   * (consecutive segment() throws with the last error), undefined when the
   * mask pipeline is current or segmentation is inactive.
   */
  segmenterIssue: string | undefined
}

/** Per-view capture lease; `release` stops the camera when it is the last one. */
export interface CameraLease {
  /** The live video element (rendered detached, never in the DOM). */
  readonly video: HTMLVideoElement
  /**
   * Subscribe to processed frames. The callback runs on the frame loop —
   * imperative consumers only (canvas drawing), never render-state writes.
   * @param cb - frame listener.
   * @returns the unsubscribe disposer.
   */
  onFrame(cb: (frame: EngineFrame) => void): () => void
  /**
   * Request segmentation while active: the engine loads the model on the
   * first request and segments per frame while at least one request stands.
   * @returns the release disposer.
   */
  enableSegmentation(): () => void
  /**
   * List video input devices (labels populated after permission is granted).
   * @returns the device list.
   */
  refreshDevices(): Promise<MediaDeviceInfo[]>
  /** Drop this lease; stops the camera when it is the last one. */
  release(): void
}

/** getUserMedia constraints: 720p-class, 30fps, user-facing default. */
function videoConstraints(deviceId: string | undefined): MediaTrackConstraints {
  return {
    ...(deviceId !== undefined ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
    facingMode: 'user',
  }
}

/**
 * Shared camera + segmentation engine for one plugin instance. Created in the
 * apply closure; `dispose()` in the plugin's effect cleanup force-stops
 * everything regardless of outstanding leases.
 */
export class CameraEngine {
  #snapshot: EngineSnapshot = {
    camera: { phase: 'idle' },
    segmenter: { phase: 'unloaded' },
    fps: 0,
  }

  #leases = 0
  #disposed = false
  #stream: MediaStream | undefined
  #video: HTMLVideoElement | undefined
  #activeDeviceId: string | undefined
  #segmenter: SegmenterHandle | undefined
  #segmenterLoad: Promise<void> | undefined
  #stabilizer: MaskStabilizer | undefined
  #frameListeners = new Set<(frame: EngineFrame) => void>()
  #statusListeners = new Set<() => void>()
  #segmentationTokens = new Set<object>()
  #segFailures = 0
  #segLastError: string | undefined
  #timer: number | undefined
  #ts = 0
  #frameId = 0
  #lastFrameAt = 0
  #fps = 0
  #startGen = 0

  /**
   * The current immutable status snapshot.
   * @returns the snapshot (stable reference between changes).
   */
  snapshot(): EngineSnapshot {
    return this.#snapshot
  }

  /**
   * Subscribe to status changes.
   * @param cb - called after each snapshot replacement.
   * @returns the unsubscribe disposer.
   */
  subscribe(cb: () => void): () => void {
    this.#statusListeners.add(cb)
    return () => { this.#statusListeners.delete(cb) }
  }

  /**
   * Acquire one camera lease, (re)starting capture when needed. A lease
   * naming a different device than the live capture restarts the stream.
   * @param deviceId - preferred device id; undefined = OS default.
   * @returns the lease.
   */
  async acquire(deviceId: string | undefined): Promise<CameraLease> {
    if (this.#disposed) throw new Error('webcam: engine disposed')
    if (this.#leases === 0 || deviceId !== this.#activeDeviceId) await this.#start(deviceId)
    this.#leases += 1
    const video = this.#video
    if (video === undefined) throw new Error('webcam: capture did not yield a video element')
    return {
      video,
      onFrame: (cb) => {
        this.#frameListeners.add(cb)
        return () => { this.#frameListeners.delete(cb) }
      },
      enableSegmentation: () => {
        const token = {}
        this.#segmentationTokens.add(token)
        void this.#ensureSegmenter()
        return () => { this.#segmentationTokens.delete(token) }
      },
      refreshDevices: () => this.#listDevices(),
      release: () => { this.#releaseOne() },
    }
  }

  /** Force-stop capture, the frame loop, and the loaded model. */
  dispose(): void {
    this.#disposed = true
    this.#leases = 0
    this.#segFailures = 0
    this.#segLastError = undefined
    this.#stopCapture()
    this.#segmenter?.close()
    this.#segmenter = undefined
    this.#segmenterLoad = undefined
    this.#setSnapshot({ camera: { phase: 'idle' }, segmenter: { phase: 'unloaded' }, fps: 0 })
  }

  async #start(deviceId: string | undefined): Promise<void> {
    const generation = ++this.#startGen
    this.#stopCapture()
    this.#setSnapshot({ camera: { phase: 'requesting' }, fps: 0 })
    if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
      this.#setSnapshot({ camera: { phase: 'unavailable' } })
      throw new Error('webcam: getUserMedia unavailable in this context')
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(deviceId), audio: false })
    } catch (error) {
      const name = error instanceof DOMException ? error.name : undefined
      if (name === 'NotAllowedError' || name === 'SecurityError') this.#setSnapshot({ camera: { phase: 'denied' } })
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') this.#setSnapshot({ camera: { phase: 'unavailable' } })
      else this.#setSnapshot({ camera: { phase: 'error', message: error instanceof Error ? error.message : String(error) } })
      throw error
    }
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.autoplay = true
    video.srcObject = stream
    await new Promise<void>((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) { resolve(); return }
      video.addEventListener('loadeddata', () => { resolve() }, { once: true })
    })
    try { await video.play() } catch { /* detached autoplay rejection: the loop still receives frames once playing */ }
    // A newer start (device switch racing a remount) or dispose() superseded
    // this one while it awaited the stream: stop the fresh tracks here or
    // they would orphan with the capture running and the light on.
    if (generation !== this.#startGen || this.#disposed) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    this.#stream = stream
    this.#video = video
    this.#activeDeviceId = deviceId
    this.#stabilizer?.reset()
    this.#segFailures = 0
    this.#segLastError = undefined
    this.#lastFrameAt = 0
    this.#fps = 0
    const track = stream.getVideoTracks()[0]
    const settings = track?.getSettings()
    this.#setSnapshot({
      camera: {
        phase: 'ready',
        label: track?.label ?? '',
        width: settings?.width,
        height: settings?.height,
      },
    })
    this.#startLoop()
  }

  #startLoop(): void {
    const step = (): void => {
      if (this.#disposed || this.#leases === 0 || this.#video === undefined) return
      this.#processFrame()
      this.#timer = window.setTimeout(step, 1000 / 60)
    }
    // Scheduled, not called synchronously: #start runs before the caller's
    // lease is counted and before any onFrame subscriber exists, so a direct
    // call would both no-op on the lease guard and skip the first listener.
    this.#timer = window.setTimeout(step, 1000 / 60)
  }

  #stopLoop(): void {
    if (this.#timer !== undefined) {
      window.clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  #processFrame(): void {
    const video = this.#video
    if (video === undefined || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    const now = performance.now()
    let mask: MaskCanvas | undefined
    let segmenterIssue: string | undefined
    if (this.#segmentationTokens.size > 0 && this.#segmenter !== undefined) {
      // MediaPipe VIDEO mode requires strictly increasing timestamps.
      this.#ts = Math.max(this.#ts + 1, Math.round(now))
      try {
        const result = this.#segmenter.segment(video, this.#ts)
        // selfie_segmenter emits ONE confidence plane — the sigmoid person
        // probability (proven against the vendored model: confidenceMasks
        // length 1, values ≈0 off-person, rising on a person-shaped region).
        // The model card's background=0/person=1 indexing describes the
        // CATEGORY mask, not the confidence planes; reading plane [1] here
        // was always undefined and silently blanked every effect. The last
        // plane also stays correct for a multi-category model, whose
        // foreground category is enumerated last.
        const masks = result.confidenceMasks
        const person = masks !== undefined && masks.length > 0 ? masks[masks.length - 1] : undefined
        if (person !== undefined) {
          // Lazily built: raw-only sessions never pay the canvas setup.
          this.#stabilizer ??= new MaskStabilizer()
          this.#stabilizer.push(personAlphaFromConfidence(person.getAsFloat32Array()))
          mask = this.#stabilizer.canvas
          this.#segFailures = 0
        } else {
          this.#segFailures += 1
          this.#segLastError = 'segmenter returned no confidence planes'
        }
        result.close()
      } catch (error) {
        // A dropped frame keeps the last stabilized mask; consecutive drops
        // surface on the frame so the view can show a failing pipeline
        // instead of silently compositing without a person cutout.
        this.#segFailures += 1
        const message = error instanceof Error ? error.message : String(error)
        this.#segLastError = message === this.#segLastError ? this.#segLastError : message
      }
      segmenterIssue = this.#segFailures > 0
        ? `${this.#segFailures} dropped · ${this.#segLastError?.slice(0, 80) ?? 'unknown error'}`
        : undefined
    } else if (this.#segFailures > 0) {
      // Segmentation switched off: retire the stale issue with the counters.
      this.#segFailures = 0
      this.#segLastError = undefined
    }
    if (this.#lastFrameAt > 0) {
      const instant = 1000 / Math.max(1, now - this.#lastFrameAt)
      this.#fps = Math.round(this.#fps * 0.85 + instant * 0.15)
    }
    this.#lastFrameAt = now
    const frame: EngineFrame = {
      frameId: this.#frameId + 1, video, mask, fps: this.#fps,
      delegate: this.#segmenter?.delegate, segmenterIssue,
    }
    this.#frameId = frame.frameId
    for (const cb of this.#frameListeners) cb(frame)
  }

  async #ensureSegmenter(): Promise<void> {
    if (this.#segmenter !== undefined || this.#disposed) return
    this.#segmenterLoad ??= (async () => {
      this.#setSnapshot({ segmenter: { phase: 'loading' } })
      try {
        this.#segmenter = await createSegmenter(MODEL_URL, WASM_BASE)
        this.#setSnapshot({ segmenter: { phase: 'ready', delegate: this.#segmenter.delegate } })
      } catch (error) {
        this.#setSnapshot({ segmenter: { phase: 'failed', message: error instanceof Error ? error.message : String(error) } })
        this.#segmenterLoad = undefined
      }
    })()
    await this.#segmenterLoad
  }

  #listDevices(): Promise<MediaDeviceInfo[]> {
    if (typeof navigator === 'undefined' || navigator.mediaDevices?.enumerateDevices === undefined) return Promise.resolve([])
    return navigator.mediaDevices.enumerateDevices().then(devices => devices.filter(d => d.kind === 'videoinput'))
  }

  #releaseOne(): void {
    if (this.#leases === 0) return
    this.#leases -= 1
    if (this.#leases === 0) {
      this.#stopLoop()
      this.#stopCapture()
      this.#setSnapshot({ camera: { phase: 'idle' }, fps: 0 })
    }
  }

  #stopCapture(): void {
    this.#stopLoop()
    for (const track of this.#stream?.getTracks() ?? []) track.stop()
    const video = this.#video
    if (video !== undefined) {
      // WebKit holds the capture session until the element's media pipeline
      // resets: pause, detach the stream, and load() to force that reset —
      // track.stop() alone can leave the menu-bar camera light lit while the
      // element waits for garbage collection.
      video.pause()
      video.srcObject = null
      video.load()
    }
    this.#stream = undefined
    this.#video = undefined
    this.#activeDeviceId = undefined
  }

  #setSnapshot(patch: Partial<EngineSnapshot>): void {
    this.#snapshot = {
      camera: patch.camera ?? this.#snapshot.camera,
      segmenter: patch.segmenter ?? this.#snapshot.segmenter,
      fps: patch.fps ?? this.#snapshot.fps,
    }
    for (const cb of this.#statusListeners) cb()
  }
}
