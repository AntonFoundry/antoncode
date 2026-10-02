/**
 * MediaPipe ImageSegmenter wrapper: loads the vendored selfie multiclass
 * model (256×256, six classes) through the vendored wasm fileset, preferring
 * the GPU (WebGL2) delegate and falling back to CPU when delegate creation
 * fails. Per-frame `segment()` returns the raw MediaPipe result — the caller
 * owns closing it.
 * @module @deepseek-ai/dsh-client-ui-webcam/client/segmenter
 */

import { FilesetResolver, ImageSegmenter, type ImageSegmenterResult } from '@mediapipe/tasks-vision'

/** Which delegate the segmenter ended up on. */
export type SegmenterDelegate = 'GPU' | 'CPU'

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
 * @param modelUrl - same-origin URL of `selfie_multiclass_256x256.tflite`.
 * @param wasmBase - directory serving the tasks-vision wasm fileset.
 * @returns the segmenter handle.
 */
export async function createSegmenter(modelUrl: string, wasmBase: string): Promise<SegmenterHandle> {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase)
  const options = {
    baseOptions: { modelAssetPath: modelUrl },
    runningMode: 'VIDEO',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  } as const
  let delegate: SegmenterDelegate = 'GPU'
  let segmenter: ImageSegmenter
  try {
    segmenter = await ImageSegmenter.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } })
  } catch {
    // GPU delegate creation can fail on stubbed WebGL contexts and older
    // WebKit builds; CPU answers the same contract, just slower.
    delegate = 'CPU'
    segmenter = await ImageSegmenter.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } })
  }
  return {
    delegate,
    segment: (video, timestampMs) => segmenter.segmentForVideo(video, timestampMs),
    close: () => { segmenter.close() },
  }
}
