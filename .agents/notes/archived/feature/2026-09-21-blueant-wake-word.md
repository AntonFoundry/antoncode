# Agent Note: Blueant ambient wake word (Phase 7b)

Status: implemented
Archived: 2026-10-30

English

## Problem

Blueant's voice path required a keystroke (⌥Space) before every ask — fine
at a desk, useless across the room. Arivu's reach is ambient: the agent
should hear its name and open, hands-free, without new cloud dependencies
or an always-on ASR battery drain.

## Decision

`WakeWordListener.swift` (new, ~230 lines): an opt-in ambient listener that
combines the cheap always-on layer (energy VAD) with the existing whisper
engine, so nothing new ships to the binary:

- **VAD**: an input tap feeds a rolling 16 kHz mono ring buffer (6 s).
  Speech onset = RMS above `max(noiseFloor + 9 dB, -42 dB)` for ~12
  consecutive taps. The noise floor adapts down to quiet rooms and is never
  raised by speech.
- **Keyword spotting**: on onset, only then, the trailing 3 s window is
  decoded by the shared `WhisperEngine` (Metal, ~100-300 ms) and matched
  case-insensitively for "blueant". Whisper runs only on speech activity —
  never continuously.
- **Trigger**: fires `onWake` (5 s cooldown) → AntonApp opens the popup and
  starts hands-free dictation; the command the user speaks after the keyword
  lands in the existing push-to-talk path. Audio-level and transcript-state
  notifications animate the wake indicator, and `blueantWakeDictationDidEnd`
  closes the indicator and re-arms ambient listening on every exit path.
- **Coordination**: the listener posts/suspends on panel visibility
  (`blueantPanelVisibilityDidChange`) — it never taps the input while the
  popup is up, and suspends while dictation runs, so the shared engine's
  serial queue never interleaves wake decodes with live transcription.
- **Shared engine**: `WhisperEngine.shared` (one ~466 MB model resident,
  previously one per controller). The generation-counter cancellation is
  safe because suspension prevents overlap.
- **Settings**: `wakeWordEnabled` in the bridge settings store (default
  **off** — ambient mic listening is opt-in), surfaced as a settings-pane
  switch and a tray "Wake Word" toggle; the app learns changes via
  `blueantWakeWordDidChange` and retries the launch-time settings fetch
  until the bridge answers.

## Alternatives considered

A dedicated KWS model (sherpa-onnx / openWakeWord): zero whisper cost while
idle, but a second runtime + model lifecycle for a v0. True streaming
SFSpeechRecognizer watch: capped ~1 min per task and cloud-dependent.
On-device SFSpeech partials: needs speech-recognition authorization and
runs a full ASR loop continuously. All deferred behind the same
`onWake` seam — the listener is replaceable without touching the app.

## Testing

`swiftc -typecheck` with the vendored whisper headers and all frameworks
(the build's exact invocation) passes; the canonical `anton:build:macos`
boot-smoke gates the deploy. Runtime verification is physical: enable Wake
Word in the tray, say "hey Blueant" from across the room, popup opens
recording. False-trigger posture: cooldown plus onset gating; tunables are
single-sourced in `WakeWordListener.Config`.

## Consequences

The app now holds one whisper context for its whole lifetime when wake is
on (memory steady-state ~500 MB with the small model). The keyword is
English-model-bound ("blueant" decodes reliably on whisper small;
multilingual wake would revisit with the Parakeet engine — see the Stage B
feasibility note, verdict GO, whisper.cpp ≥ 1.9.0 native Parakeet).
