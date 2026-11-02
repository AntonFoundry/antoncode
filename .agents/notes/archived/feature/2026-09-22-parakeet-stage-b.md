# Agent Note: Parakeet Stage B — native TDT engine as dictation default

Status: implemented
Archived: 2026-10-30

English

## Problem

Push-to-talk latency bounds the whole Blueant voice loop: whisper small's
autoregressive window loop decodes a 5.8 s utterance in ~286 ms on this
machine (Metal), and its raw output style and silence behavior lag the
product bar. The Stage B feasibility record (2026-09-21) sanctioned the
whisper.cpp ≥ 1.9.0 native Parakeet path; this is its implementation.

## Decision

- **Vendor**: `apps/anton-bridge/macos/vendor` rebuilt from a whisper.cpp
  v1.9.4 clone (cmake Metal + embedded metallib, arm64, static). The set
  now carries `libparakeet.a` beside `libwhisper.a`; `WhisperBridge.h`
  includes `parakeet.h` for the Swift module.
- **Engine**: `ParakeetEngine.swift` mirrors `WhisperEngine`'s contract —
  serial transcription queue, generation-counter cancellation, `available`
  on model presence. Model search:
  `<App Support>/Anton/blueant/models/parakeet/*.gguf|.bin` (668 MB
  Q8_0 TDT 0.6B v3 downloaded there).
- **Selection**: `SpeechController.makeEngine()` prefers Parakeet when its
  model file exists, else `WhisperEngine.shared`; both conform to the
  module-internal `TranscriptionEngine` protocol, whose `engineName`
  identifies the selected implementation in wake diagnostics. Removing the
  model file reverts to whisper — the fallback ships in the same binary.
  The wake-word listener stays on `WhisperEngine.shared`
  regardless: its lifetime is independent of dictation sessions (cost: both
  models resident when wake is enabled; acceptable on M-series).
- **Wake-word variant matching**: the A/B exposed that ASR renders the
  proper noun inconsistently — measured "Bluint" (whisper small) and
  "Bluent" (parakeet v3). Exact `contains("blueant")` would rarely fire;
  the listener now matches a derived variant set (joined form, vowel-swaps
  "bluint"/"bluent"), verified to reject "blueprint".

## Measured (ABHarness.swift, 5.82 s TTS utterance, 3 passes, Metal)

- whisper small: load 21.0 s (first-run shader compile included), decode
  median 286 ms.
- parakeet v3 q8_0: load 0.52 s, decode median **83 ms** — 3.4× faster,
  equal-or-better transcript, punctuated output.

## Alternatives considered

sherpa-onnx and Handy's transcribe.cpp (both need a second runtime) were
already rejected by the feasibility record; onnxruntime linkage is
unnecessary now that whisper.cpp speaks Parakeet natively.

## Testing

`ABHarness.swift` (repo, dev-only, excluded from the app binary) drives
both engines through the vendored static libs on real audio — the table
above is its output. Full-module `swiftc -typecheck` passes with the
build's exact flags; the canonical `anton:build:macos` boot-smoke gates
the deploy. Live push-to-talk verification happens on first use after
deploy (engine banner: "Blueant STT engine: parakeet TDT").

## Consequences

Dictation defaults to Parakeet when the model file is present; whisper
small remains the always-present fallback and the wake-word engine. RAM:
~1.1 GB combined when both are resident (dictation + wake enabled);
Parakeet alone is ~670 MB weights + ~410 MB compute buffers. English/EU
languages only (v3); multilingual users fall back by removing the model
file. The Parakeet C-API streaming path is young — the transcribe-on-
accumulation design (whole-buffer re-decodes for partials) sidesteps it.
