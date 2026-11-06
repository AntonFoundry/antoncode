---
description: "Interactive webcam buffers in the GUI and their lifecycle and resource limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-webcam

English

## Summary

Open a live camera view with background removal, blur, replacement backdrops, and mirroring. Multiple panes share one capture and one set of in-memory settings. Segmentation runs locally, and closing the last view releases the camera. Camera permission and browser rendering support determine whether capture is available.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Webcam background-removal plugin: a live, GPU-composited camera view occupying the window manager's `webcam.view` slot — one refcounted capture per plugin, segmented by MediaPipe's selfie segmenter and composited on WebGL2, opened with `C-x v` / `M-x webcam`. The design mirrors the [terminal plugin](../ui-terminal): a WM buffer kind (`webcam`, the shared `buffer:webcam` registry entry), a view slot, and a keymap command.

The apply closure registers `webcam.view` through ui-renderer and creates the shared settings handle with dsh-client-store. The `CameraEngine` holds the single `getUserMedia` stream (720p-class, user-facing), runs the per-frame loop, loads the MediaPipe `ImageSegmenter` lazily on the first non-raw effect (CPU/wasm-SIMD delegate — the segmenter module records why the GPU delegate is not attempted), and converts each frame's person-confidence plane (selfie segmenter category 1) into a temporally EMA-stabilized person-alpha mask (`mask.ts`) — the Broadcast-style flicker suppression. Each mounted view holds one lease and one `Compositor`: a WebGL2 path (separable quarter-res gaussian for the background blur, 9-tap feathered mask sampling, gradient/image cover-fit replace, whole-output mirror) with a Canvas2D fallback when context creation fails. The camera stops when the last lease releases; plugin unload force-stops everything through the effect disposer.

Model and wasm assets are vendored into the web frontend's static dist under `/mediapipe/` (`apps/web/public/mediapipe/`: the Apache-2.0 `selfie_segmenter.tflite` plus the tasks-vision wasm fileset copied from the npm package), reproduced by `scripts/vendor-assets.sh`. The paths are an assembly pairing between this package's constants (`MODEL_URL`/`WASM_BASE`) and the frontend tree — the same assembly-fact treatment the webserver's dist index gets, not deployment config.

Effects are controlled per view (segmented Raw/Remove/Blur/Replace dock, blur strength, studio/green remove colors, six built-in gradient backdrops plus a custom image, mirror toggle, camera picker) and share one settings store across panes, so a mode change in one leaf applies everywhere. `M-x webcam` on an open view shows the same shared buffer in the new window — both panes composite the one capture. `M-x webcam-stop` kills the shared buffer wherever it shows: every pane unmounts, the last lease releases, and the engine stops the capture (track stop plus video `pause`/`load` pipeline reset — WebKit holds the camera light until the reset) so the menu-bar indicator goes dark.

</details>

-----

## Model Experience

### User webcam view

#### What the model sees

No camera frames or settings enter model context. The `webcam.view` contribution performs local capture, segmentation, and composition without registering a model tool or prompt.

#### Token effect

None; this package adds no model-input tokens.

#### KV Cache effect

None; browser presentation does not change provider requests or their reusable prefixes.

## Known Limitations and Deferred Work

- **WKWebView camera permission depends on the app shell** — `getUserMedia` inside the Anton.app shell requires the native `requestMediaCapturePermission` delegate; when the shell denies it the view renders the permission card and the GUI remains fully usable from Chrome/Safari at the same URL.
- **No persistence** — settings live in the in-memory store; reopening the app resets to blur/50 default. Persisting alongside the WM's localStorage snapshot is deferred.
- **Registry gap after restart** — like terminal buffers, a persisted leaf referencing `buffer:webcam` falls back to scratch after an app restart (camera leases are memory-only); open the view again with `M-x webcam`.
- **No mic processing** — NVIDIA Broadcast's noise-removal half is out of scope, as is the system-wide CMIO virtual camera that would let Zoom/Meet consume the composited feed; both are follow-ups.
- **Coverage gate** — the GL/`getUserMedia`/MediaPipe surfaces cannot run under jsdom; genuinely unreachable arms carry `v8 ignore` reasons and the pure layers (params, mask math, backdrops, settings store, view states) carry the behavioral specs.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
