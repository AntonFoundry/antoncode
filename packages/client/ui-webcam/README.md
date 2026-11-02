# @deepseek-ai/dsh-client-ui-webcam

English

Webcam background-removal plugin: a live, GPU-composited camera view occupying the window manager's `webcam.view` slot — one refcounted capture per plugin, segmented by MediaPipe's selfie segmenter and composited on WebGL2, opened with `C-x v` / `M-x webcam`. The design mirrors the [terminal plugin](../ui-terminal): a WM buffer kind (`webcam`, the shared `buffer:webcam` registry entry), a view slot, and a keymap command.

The apply closure owns the two shared faces. The `CameraEngine` holds the single `getUserMedia` stream (720p-class, user-facing), runs the per-frame loop, loads the MediaPipe `ImageSegmenter` lazily on the first non-raw effect (CPU/wasm-SIMD delegate — the segmenter module records why the GPU delegate is not attempted), and converts each frame's person-confidence plane (selfie segmenter category 1) into a temporally EMA-stabilized person-alpha mask (`mask.ts`) — the Broadcast-style flicker suppression. Each mounted view holds one lease and one `Compositor`: a WebGL2 path (separable quarter-res gaussian for the background blur, 9-tap feathered mask sampling, gradient/image cover-fit replace, whole-output mirror) with a Canvas2D fallback when context creation fails. The camera stops when the last lease releases; plugin unload force-stops everything through the effect disposer.

Model and wasm assets are vendored into the web frontend's static dist under `/mediapipe/` (`apps/web/public/mediapipe/`: the Apache-2.0 `selfie_segmenter.tflite` plus the tasks-vision wasm fileset copied from the npm package), reproduced by `scripts/vendor-assets.sh`. The paths are an assembly pairing between this package's constants (`MODEL_URL`/`WASM_BASE`) and the frontend tree — the same assembly-fact treatment the webserver's dist index gets, not deployment config.

Effects are controlled per view (segmented Raw/Remove/Blur/Replace dock, blur strength, studio/green remove colors, six built-in gradient backdrops plus a custom image, mirror toggle, camera picker) and share one settings store across panes, so a mode change in one leaf applies everywhere. This surface's product copy is English — a user decision overriding the repo-wide Chinese-copy convention for this plugin. `M-x webcam` on an open view shows the same shared buffer in the new window — both panes composite the one capture. `M-x webcam-stop` kills the shared buffer wherever it shows: every pane unmounts, the last lease releases, and the engine stops the capture (track stop plus video `pause`/`load` pipeline reset — WebKit holds the camera light until the reset) so the menu-bar indicator goes dark.

## Model Experience

None, as the webcam is a direct user↔camera surface; nothing here reaches a model request. Segmentation inference runs locally in the process (MediaPipe wasm SIMD on the CPU delegate); no frame data leaves the process.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **WKWebView camera permission depends on the app shell** — `getUserMedia` inside the Anton.app shell requires the native `requestMediaCapturePermission` delegate; when the shell denies it the view renders the permission card and the GUI remains fully usable from Chrome/Safari at the same URL. Native shell support is a follow-up.
- **No persistence** — settings live in the in-memory store; reopening the app resets to blur/50 default. Persisting alongside the WM's localStorage snapshot is deferred.
- **Registry gap after restart** — like terminal buffers, a persisted leaf referencing `buffer:webcam` falls back to scratch after an app restart (camera leases are memory-only); open the view again with `M-x webcam`.
- **No mic processing** — NVIDIA Broadcast's noise-removal half is out of scope, as is the system-wide CMIO virtual camera that would let Zoom/Meet consume the composited feed; both are follow-ups.
- **Coverage gate** — the GL/`getUserMedia`/MediaPipe surfaces cannot run under jsdom; genuinely unreachable arms carry `v8 ignore` reasons and the pure layers (params, mask math, backdrops, settings store, view states) carry the behavioral specs.
