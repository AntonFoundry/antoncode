# Agent Note: GPU webcam background removal as a WM buffer (`M-x webcam`)

Status: implemented

## Problem

The harness's web GUI had no camera surface. Video-call tools (NVIDIA Broadcast et al.) replace or blur a webcam background with an on-device segmentation model, but nothing equivalent lived inside the app — and the two existing extension precedents (the `ui-terminal` xterm.js buffer and the window manager's slot system) had never carried a continuously rendering, GPU-composited media view. The question was where a camera pipeline belongs: a native macOS virtual-camera extension, a standalone app, or a first-class buffer in the existing window manager.

## Decision

A new client plugin package, `packages/client/ui-webcam`, occupies a new WM slot `webcam.view`. `M-x webcam` / `C-x v` opens a **shared** `buffer:webcam` buffer (fixed id, killable): one `getUserMedia` capture and one segmentation model behind any number of open panes, each pane compositing its own view. Effects — raw passthrough, remove (solid studio/green), blur (quarter-res separable gaussian), replace (bundled gradients or a custom image) — are shared settings-store state, so every pane shows the same mode and a split never re-opens the camera.

The pipeline layers degradation explicitly: MediaPipe `ImageSegmenter` with the selfie segmenter model at 256×256 (categories background=0, person=1; the engine reads the person plane directly), running on the **CPU (wasm SIMD) delegate by construction** — on the GPU delegate, MediaPipe serves mask typed arrays through a `readPixels(RED, FLOAT)` GPU readback that this WebKit build answers with near-constant junk, which washed the whole frame to a uniform mid-alpha and made every effect read as a whole-frame filter; on CPU the mask is a plain wasm-memory plane with no GL readback. WebGL2 compositor falling back to Canvas2D `destination-in` cutout; the model and WASM load lazily on the first non-raw effect, so raw passthrough costs no model memory. The mask carries person alpha in all four RGBA channels (GL samples `.r`, the 2D fallback's `destination-in` samples `.a`), and a temporal EMA on a scratch canvas stabilizes it against per-frame flicker before any pane reads it.

Model and WASM assets are vendored, not fetched at runtime: `apps/web/public/mediapipe/` (selfie segmenter model, tasks-vision WASM fileset), reproduced by `packages/client/ui-webcam/scripts/vendor-assets.sh`, and the engine's `/mediapipe/...` paths are assembly facts paired with that directory. `@mediapipe/tasks-vision` is inlined into the package's client bundle.

## Alternatives considered

- **Native CMIO virtual camera (system-wide)** — would feed Zoom/Meet directly, but requires a signed kernel-adjacent extension and a host-side process; deferred as a follow-up. The buffer keeps the capability inside the harness where the slot system already renders it.
- **One camera capture per pane** — rejected: multiple `getUserMedia` leases on one device cause renegotiation flicker and multiply segmentation cost; the shared-buffer design makes one capture the registry's shape, not a convention.
- **Fetching model/WASM from Google's CDN at runtime** — rejected: the GUI must work offline and deterministically; the vendoring script keeps the bytes reproducible.

## Consequences

- WKWebView (the packaged app shell) may still refuse `getUserMedia` — the shell's permission delegate has no camera hook, so the view renders its permission card and the browser GUI is the supported path until the shell gains one.
- ~33 MB of WASM binaries plus the ~250 KB model are git-tracked under `apps/web/public/`; the vendor script can rebuild them, but the tracked copies are what builds and offline boots consume.
- Segmentation runs only while at least one mounted view's effect is non-raw; closing the last webcam pane releases the camera but keeps the loaded model until the plugin unloads. The release path is total by construction: the last lease stops the tracks, then pauses the video and `load()`-resets its media pipeline (WebKit holds the camera light until that reset), and a start-generation guard drops any superseded or disposed start's late stream so a capture cannot orphan with the light on. `M-x webcam-stop` kills the shared buffer wherever it shows as the explicit kill switch.
- This surface's product copy is English (dock labels, error card, picker), a user decision overriding the repo-wide Chinese-copy convention for this plugin only.
- Coverage: the GL and camera-dependent arms of the compositor and engine are unreachable in jsdom and carry `v8 ignore` reasons; behavior contracts (lease refcount, mask math, store actions, view states, WM wiring) are covered in the package and ui-layout suites.
