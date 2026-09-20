# Agent Note: Blueant persona app on the Anton menubar (Phases 1–3)

Status: implemented

English

## Context

The Anton menubar app (accessory app, `dev.antoncode.anton`) gained "Blueant": a
Spotlight-style popup agent backed by a dedicated harness session through the
anton-bridge. The loop boundary is unchanged — the bridge (Bun, 127.0.0.1:3742)
proxies the harness apiproxy; the Swift app speaks the `client-request` envelope
over `POST /api/<method>` and consumes streamed assistant deltas over the
downlink-only `/api/events.mux` WebSocket.

## Decisions

- **No fork of the harness.** The Blueant persona is an agent preset authored at
  bridge startup (`apps/anton-bridge/src/blueant-preset.ts`: complete persona,
  memory/search tools only). Sessions roll daily via
  `UserDefaults "blueant.session.<yyyy-MM-dd>"`.
- **Carbon `RegisterEventHotKey` for ⇧⌥Space, not CGEventFlags.** Carbon numbers
  its modifier mask differently (`shiftKey = 1<<9`, `optionKey = 1<<11`); the
  first implementation used CG values (`1<<17`/`1<<19`), which Carbon accepted
  without error and registered a hotkey nobody could press. Named Carbon
  constants (`shiftKey | optionKey`) prevent the class of bug.
- **Editable entry is `NSTextField(string:)`, never `labelWithString:`** — label
  fields are non-editable and cannot become first responder, which made the
  popup visibly render but not accept typing.
- **Single instance guard** in `applicationDidFinishLaunching` (bundle-id
  `NSRunningApplication` check, first instance wins). A second launch — double
  `open`, or a script launching the binary directly — otherwise registers a
  duplicate status item and a competing hotkey.
- **Session promotion (⌘P)** = `session.fork` (refuses blank sessions; the
  Blueant popup guards with a non-empty answer) + `session.rename` to
  "Blueant: <question>" + open the web GUI at its root — the GUI has no
  per-session URL; its only deep link is the `#ws=<workspaceId>` board pin.
- **Spotlight UX**: compact 640×100 card until the answer area has content, then
  an animated grow to 640×420 with the top edge anchored; drag via
  `isMovableByWindowBackground`; the dragged origin persists (UserDefaults) but
  the panel always reopens compact because height is content-driven.
- **Voice**: `SpeechController` owns an engine-agnostic
  start/stop/abort/partials/level surface consumed by the panel's waveform tile
  (hold ≥250 ms = push-to-talk, quicker click = toggle) and a panel-local ⌥Space
  monitor (no global event tap, so no Accessibility permission). Engine order:
  whisper.cpp (Metal) primary, SFSpeechRecognizer fallback when the GGML model is
  missing or context init fails.
- **whisper.cpp linking**: static libs built once with cmake
  (`GGML_METAL=ON GGML_METAL_EMBED_LIBRARY=ON`, arm64) from the vendored checkout
  in `Vox/voxkit/ext/whisper.cpp`, staged under
  `apps/anton-bridge/macos/vendor/` (lib/ + include/ committed; build/ ignored).
  Swift reaches the C API through `-import-objc-header WhisperBridge.h`. The
  Metal library is embedded in `libggml-metal.a`, so no `.metallib` resource
  lookup at runtime. Link needs `-lc++` (first link failed without it) and
  frameworks Metal/MetalKit/Accelerate.
- **Model resolution**: `~/Library/Application Support/Anton/blueant/models/whisper/*.bin`
  (prefer `ggml-small.bin`) → `Vox/voxkit/.models/whisper/`. Partials
  re-transcribe the accumulated buffer every ≥1.2 s on a serial queue with
  generation-counter cancellation; `stop()` emits a full-buffer final,
  `abort()` cancels silently.

## Consequences

- `session.fork`'s "no completed turn" refusal is a contract the popup relies
  on; any future server tightening of fork admission must keep the error shape.
- The vendor static libs pin a whisper.cpp snapshot; refreshing them means
  re-running the cmake build from the Vox checkout and re-staging lib/ + include/.
- Handy (`cjpais/Handy`) remains the reference for a future Parakeet TDT GGUF
  stage, but stock whisper.cpp cannot load those GGUFs — that stage needs
  Handy's transcribe-cpp runtime first.
