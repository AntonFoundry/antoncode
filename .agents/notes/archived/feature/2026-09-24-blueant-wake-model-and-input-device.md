# Agent Note: Blueant wake model and microphone selection

Status: implemented
Archived: 2026-10-30

English

## Problem

Blueant's ambient wake word answered only sometimes, and two settings that were supposed to control it did not.

The "Wake detector" picker in the settings pane stored `wakeEngine`, but `AntonApp.applyWake` forced the always-on listener onto `WhisperEngine.wake` regardless of the stored value, with a comment explaining that Parakeet's native decoder can abort the host process when another audio path holds Metal. The picker was therefore decorative.

No capture path could choose a microphone: the wake listener, push-to-talk dictation, and the Gemini live session each built their own `AVAudioEngine` and tapped `inputNode`, which always follows the system default.

The intermittency had four separate causes in `WakeWordListener`:

- `WhisperEngine.transcribe` and `ParakeetEngine.transcribe` returned without invoking their completion when the model context was nil, so the listener's `decoding` flag stayed true and every later onset was dropped.
- `startEngine` returned silently when the input format reported a zero sample rate — normal during a device or route switch — and nothing retried, leaving the listener dead until an unrelated event.
- A configuration change ran `stopEngine()`, which cancelled the in-flight decode and reset `decoding`, dropping a wake that was already being transcribed.
- Keyword matching accepted only a fixed variant list, so any other rendering of the proper noun was a miss.

State was also unsynchronised: the audio tap ran on the render thread while lifecycle calls mutated the same fields from the main thread.

## Decision

**Model selection is real and wake-only.** `wakeModel` persists one valid `{ engine, file }` pair. `LocalSpeechModelCatalog` discovers Whisper and Parakeet files, deduplicates equal filenames in favor of Anton's own model directory, excludes the ambiguous `default.bin` alias, and exposes display names with file sizes. `applyWake` resolves the selection to a local path, loads exactly that context, and rebuilds the listener only when its catalog id changes. One serial `LocalSpeechQueue` carries every local decode for both engines, so a selectable wake context cannot overlap native Whisper/Parakeet work from another audio path — the condition the old Parakeet guard addressed. Selectable Whisper wake contexts carry the initial prompt "Hey Blueant"; physical tests showed base returning `[BLANK_AUDIO]` and sound-effect captions while small recognized better, which is why the default remains `ggml-small.bin`. Push-to-talk and the live voice session keep fixed contexts, so tuning wake recognition does not alter dictation or conversation transcription.

**Microphone selection applies to all three paths.** A new `inputDevice` uid in the Blueant settings store, a `Microphone` picker in the settings pane filled from CoreAudio, and `AudioInputDevice.apply(uid:to:)` routing each engine's input node through `kAudioOutputUnitProperty_CurrentDevice`. A nil uid means the system default and applies nothing, because the input node already follows it; a uid that is already in effect is also skipped. Only a change that actually moves the route sets the property, because setting it posts `AVAudioEngineConfigurationChange`, which is the notification the listener uses to notice another client taking the device.

**Reliability follows from owned state.** The listener keeps every mutable field on one `stateQueue`; the tap converts its buffer and hands samples over. Engine completions always fire (with an empty string when the context is unavailable), a decode watchdog releases `decoding` if an engine never answers, engine start retries a bounded number of times after a zero-rate or failed start, and a configuration change keeps the in-flight decode and the rolling buffer. Matching accepts a variant or a single-edit token match against it, which covers the spellings the fixed list does not enumerate. A matched wake presents its indicator on the main thread on the screen under the pointer, falling back to the main or first screen rather than requiring Anton to own a main window. Indicator acknowledgement is independent of microphone/dictation eligibility; a rejected dictation handoff displays its reason briefly and still re-arms ambient listening. Closing the indicator manually ends the wake conversation, and the app retries listener re-arming until live-voice and dictation teardown are clear, so speech input recovers without restarting Anton.

`WakeWordListener.restartAfterAudioChange` rebuilds only when `AudioInputDevice.isRouted` reports the engine is no longer on the device the listener asked for — the difference between following a real route change and reacting to its own device selection.

## Alternatives considered

**Keep the listener on Whisper and make the picker meaningful some other way.** Rejected once the shared speech queue existed: serializing the decodes removed the actual hazard, so suppressing the choice would have been a permanent workaround for a solved problem.

**A dedicated keyword-spotting model (sherpa-onnx / openWakeWord).** Still deferred: it needs a second runtime and model lifecycle, which the [wake-word Agent Note](2026-09-21-blueant-wake-word.md) already weighed.

**Suppress self-caused configuration changes with a time window.** A debounce would also discard a genuine route change from another client that landed inside the window. Comparing the engine's actual device against the requested one is exact.

**Give each engine its own serial queue.** Two engines each serial with itself still lets whisper and parakeet decode concurrently, which is the case that matters.

## Consequences

Only one selectable wake context stays loaded, so moving from Tiny to Large trades memory and load/decode latency directly for recognition quality rather than accumulating contexts. Whisper Small remains the default; physical testing decides which available variant is the best lightweight choice for a microphone and room.

A chosen device that is unplugged leaves the engine on the system default with a log line rather than failing to start, so the microphone picker degrades instead of breaking capture.

The listener logs a decode per utterance, sparse decibel-only input diagnostics, and restarts its input engine if CoreAudio stops delivering buffers. Recognition uses a five-second audio window so a quiet wake phrase remains in view before a louder request; if the minimum input window is not ready, it waits for more audio rather than dropping the wake attempt. Only the latest three seconds pass to dictation. Physical verification still requires speaking the phrase from across the room and confirming the popup opens.
