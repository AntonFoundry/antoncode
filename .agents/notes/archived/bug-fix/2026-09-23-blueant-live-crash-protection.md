# Agent Note: Blueant live crash protection

Status: implemented
Archived: 2026-10-30

English

## Problem

Gemini response playback could terminate Anton through a native Parakeet ggml scheduler fault, an audio player graph left disconnected after an engine reset, or AppKit and PCM memory being accessed from unsafe execution contexts.

## Decision

Blueant live voice and the always-on wake listener use the isolated Whisper context. Live WebSocket messages are handled on the main queue before invoking UI callbacks or scheduling player nodes. Audio installation reconnects the player output on every graph setup, including after a voice-processing fallback reset. PCM16 input and output are encoded bytewise as little-endian samples, avoiding alignment-dependent raw pointer binding. Stopping a live session also clears queued response state so the next session starts with an open microphone path.

## Alternatives considered

**Keep Parakeet as the live diagnostic transcriber.** Its shared native ggml context is the confirmed crash site when another audio path is active.

**Rely on `player.engine` to prove the output graph is connected.** An engine reset can leave the node attached while removing its output connection.

**Continue using `bindMemory(to:)` for PCM conversion.** Base64 decoded `Data` does not provide an alignment guarantee for an `Int16` view.

## Consequences

Whisper uses more CPU than Parakeet for local diagnostic transcripts, while live Gemini audio remains the user-facing response path. Reconnecting the output graph adds a small amount of setup work and makes audio fallback recoverable. The native Parakeet engine remains available to other explicitly selected local dictation paths until it has an isolated owner.
