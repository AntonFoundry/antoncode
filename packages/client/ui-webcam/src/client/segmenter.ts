/**
 * MediaPipe ImageSegmenter wrapper: loads the vendored selfie segmenter
 * (256×256, single person-confidence plane) through the vendored wasm fileset
 * on the CPU (wasm SIMD) delegate. Per-frame `segment()` returns the raw
 * MediaPipe result — the caller owns closing it.
 *
 * The GPU delegate is deliberately not attempted: on it, mask typed arrays
 * are served by a `readPixels(RED, FLOAT)` GPU readback that this WebKit
 * build answers with near-constant junk (the mask arrives washed to a
 * uniform mid value). On CPU the mask is a plain wasm-memory plane with no
 * GL readback, which is why `delegate` is always `'CPU'` — visible in the
 * view status line.
 * @module @deepseek-ai/dsh-client-ui-webcam/client/segmenter
 */

import { FilesetResolver, ImageSegmenter, type ImageSegmenterResult } from '@mediapipe/tasks-vision'

/** Which delegate the segmenter runs on (CPU-only by construction, see above). */
export type SegmenterDelegate = 'CPU'

/** A live segmenter: one per engine, VIDEO running mode, confidence masks. */
export interface SegmenterHandle {
  /** The delegate this instance actually initialized on. */
  readonly delegate: SegmenterDelegate
  /**
   * Segment one video frame. `timestampMs` must be strictly increasing.
   * @param video - the camera video element.
   * @param timestampMs - monotonic frame timestamp.
   * @returns the segmentation result; close it after reading the masks.
   */
  segment(video: HTMLVideoElement, timestampMs: number): ImageSegmenterResult
  /** Release the underlying MediaPipe resources. */
  close(): void
}

/**
 * Create a segmenter over the vendored model + wasm assets (same-origin
 * `/mediapipe/…` paths built by the web frontend — an assembly pairing, not
 * deployment config).
 * @param modelUrl - same-origin URL of `selfie_segmenter.tflite`.
 * @param wasmBase - directory serving the tasks-vision wasm fileset.
 * @returns the segmenter handle.
 */
export async function createSegmenter(modelUrl: string, wasmBase: string): Promise<SegmenterHandle> {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase)
  const segmenter = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
    runningMode: 'VIDEO',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  })
  return {
    delegate: 'CPU',
    segment: (video, timestampMs) => segmenter.segmentForVideo(video, timestampMs),
    close: () => { segmenter.close() },
  }
}
