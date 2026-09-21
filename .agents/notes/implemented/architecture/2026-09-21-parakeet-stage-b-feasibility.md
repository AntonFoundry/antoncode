# Agent Note: Parakeet Stage B feasibility — GO via whisper.cpp native support

Status: implemented

English

## Problem

The Blueant Stage B backlog item asked whether Parakeet ASR could replace
or supplement whisper.cpp small for push-to-talk: the plan's premise was
"stock whisper.cpp cannot load Parakeet GGUF; needs a Handy transcribe-cpp
feasibility pass", implying a second runtime (onnxruntime / sherpa-onnx).

## Decision

**GO — and the premise is outdated.** Upstream whisper.cpp (≥ 1.9.0) merged
native Parakeet TDT support: a `parakeet.h` C API, a `parakeet-cli` example,
and quantization tooling live in master, with official GGUF conversions at
ggml-org/parakeet-GGUF (TDT 0.6B v2/v3; Q8_0 ≈ 0.6-0.7 GB on disk). No
onnxruntime, no sherpa-onnx, no Handy dependency — Stage B is a vendored
whisper.cpp upgrade plus one Swift engine class.

Integration shape (when pursued):
- Bump `apps/anton-bridge/macos/vendor/` to whisper.cpp ≥ 1.9.0; build
  `libparakeet.a` alongside `libwhisper.a` (same CMake, Metal-embedded
  pattern).
- `ParakeetEngine.swift` (~120 lines) mirroring `WhisperEngine`:
  `parakeet_init_from_file_with_params` → `parakeet_full` → segments;
  model search adds a `models/parakeet/` dir.
- `SpeechController` picks Parakeet when the model file exists, whisper
  otherwise — behind the existing engine contract, zero plumbing changes.

Expected wins (cited in the research): v3 beats Whisper large-v3 WER at a
quarter of the size (~6.3% vs 7.4%); single-pass TDT decoder gives
sub-100 ms first-token latency for 1-15 s clips on Apple Silicon; punctuated
output; no silence hallucination. Costs: ~3× RAM vs small, English/EU-only
(v3: 25 languages), young C-API streaming path (the transcribe-on-
accumulation design sidesteps streaming).

## Testing

Research method: local inspection (vendored header exposes
`whisper_vad_params` — a recent 1.7.x+ checkout predating the Parakeet
merge), upstream whisper.cpp release notes, ggml-org/parakeet-GGUF model
cards, and third-party WER/latency comparisons; all external claims carry
URLs in the research transcript. The engine-agnostic buffer contract in
`SpeechController` was confirmed as the insertion point.

## Alternatives considered

sherpa-onnx (mature Parakeet int8 onnx, but drags onnxruntime + a second
model zoo) and Handy's extracted transcribe.cpp (reusable C++ engine, same
second-runtime cost). Both redundant now that whisper.cpp speaks Parakeet
natively; they remain the fallback if the vendored-upgrade path hits
packaging walls.

## Consequences

The backlog item closes as a decision record; implementation is a 2-4 day
follow-up (vendor upgrade + engine class + on-device A/B), shipped behind a
model-file-present check with whisper retained as fallback. Memory note:
running both engines simultaneously would double model residency — the
engine pick is exclusive per session.
