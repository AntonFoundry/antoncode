# Agent Note: Blueant wake listening on a device with no input stream

Status: implemented
Archived: 2026-10-30

English

## Problem

Ambient "hey Blueant" never reached `WakeWordListener.acceptWake()`. The wake indicator and the Gemini Live handoff are both downstream of `onWake`, so neither ran: over three hours the `blueant.wake-word` category logged 68 `input tap stalled` lines against one decode, and the `wake-indicator` category logged no `wake callback accepted` at all.

The listener attached its input node to the system default device, an AirPods Pro aggregate whose input stream was closed while its output stayed open. CoreAudio accepted the attachment and `AVAudioEngine.start()` succeeded with a valid 44.1 kHz two-channel format, so neither `startEngine()`'s sample-rate guard nor its `engine.start()` error path observed anything wrong; the tap rendered no buffer. `scheduleTapHealthCheck()` reads buffer silence as a stall, so every ~6.3 s the listener rebuilt its engine against the same device. Each rebuild called `stopEngine()` with its default `cancelDecodes: true`, discarding the rolling 5 s window and cancelling the in-flight decode, so a wake that had begun was destroyed before recognition. The loop was unbounded and self-sustaining: re-acquiring and releasing the same route is what keeps the device in flux. `AudioInputDevice.apply(uid:)` was a deliberate no-op for a nil uid on the reasoning that the input node already follows the system default, which holds only when that default has an input.

Two smaller defects sat behind it. `settings.json` selected `ggml-tiny-v2.bin`, a 77 MB Whisper Tiny resolved from the Vox fallback directory rather than Anton's own model directory; the single decode in the window transcribed speech as unrelated prose, and `matchesWake()` requires a `keywordVariants` substring or a token within one edit of a variant, so the keyword was unreachable even when audio flowed. Separately, `bridge.log` showed five cycles of `Gemini WebSocket connected` / `setup complete` / `closed (1008)`. Those were not wakes: `BlueantPanel.prepareWakeVoice()` opened the bridge voice socket at settings-apply time, after each conversation end, and on each status poll throttled to 10 s, the provider answered `setupComplete`, and then closed the idle session on its inactivity timeout.

## Decision

`AudioInputDevice` resolves a device instead of trusting the default. `resolveInput(uid:)` returns the configured device when it exposes an input stream, else the system default when it does, else the first device in CoreAudio order that does. `apply(uid:)` and `isRouted(uid:on:)` both route through it, so the two agree on which device is correct and a configuration change that left the listener where it asked rebuilds nothing. A nil uid is no longer a no-op.

`WakeWordListener` bounds recovery rather than looping. `scheduleTapHealthCheck()` rebuilds with `cancelDecodes: false`, keeping the rolling window and any in-flight decode, because the silence it observes belongs to the tap and not the decoder. When an explicitly selected device starts without delivering a buffer, the first rebuild tries the system input; a later device selection retries the requested device. `startEngine()` leaves the window intact; a real stop clears it even when the input engine is already inactive. `maxTapStallRebuilds` (3) caps consecutive rebuilds that render nothing; past the cap the listener calls `stopEngine()` and stands down. `ingest(level:samples:)` resets the counter on the first delivered buffer, so the budget is per stall episode rather than per process, and `restartAfterAudioChange()`, `setDesired(_:)`, and `setInputDevice(_:)` each reset it before re-arming.

`BlueantLiveVoiceSession.prepare()` is called only from `start()`, so the provider session opens at wake time. The listener hands off 3 s of pre-roll (`handoffPreRollSeconds`) to the selected local model, which transcribes during the cold handshake; completed text waits until `setupComplete`. The wake model default in `apps/anton-bridge/src/blueant-settings.ts` stays `ggml-small.bin`; the live selection moved there through `PUT /bridge/api/settings`. The [local text handoff decision](2026-09-25-blueant-local-text-handoff.md) owns the conversation path.

`AntonApp.scheduleWakeResume()` keeps one delayed check pending while a hidden wake conversation still owns the microphone. It resumes the ambient listener when that ownership clears, regardless of teardown duration. A visible popup supplies a close notification instead of a polling loop.

## Alternatives considered

**Pin a non-Bluetooth device in settings.** Fixes this machine, not the defect: the listener would still loop on any device that loses its input stream, and `inputDevice` records which microphone the user chose, not a workaround for an unusable one.

**Send keepalive audio on the preconnected session.** Rejected — it streams microphone audio to the provider before any wake phrase is heard, which is the one thing the wake listener's design forbids.

**Have the bridge reconnect and hold the session open.** Same provider timeout, and it moves the churn to the bridge while connecting at wake time costs only a handshake the existing buffers already absorb.

**Restart on every stall indefinitely.** The previous behavior and the defect: an unbounded rebuild discards the wake window on a fixed timer and keeps the microphone in-use indicator flickering.

**Tune the voice-activity thresholds.** The detector was not the blocker — it saw speech at −28.5 dB against a −38.2 dB floor and decoded the window correctly. Recognition was.

## Consequences

A default device with no open input stream is now replaced with one that has, with the substitution logged rather than silent. The cost is that a Bluetooth headset in output-only mode stops being the wake microphone; the settings pane's Microphone row remains the override.

Standing down after three fruitless rebuilds means ambient listening can stop until the audio route changes or a settings write re-arms it. Nothing re-arms it on a timer. That is a deliberate change from always-retry: the loop it replaces destroyed every wake attempt.

Wake recognition is more reliable with larger local models, though the settings pane keeps the model choice with the user. If a decoder drops "Hey", the exact name alone is accepted only at the transcript's beginning or end; approximate variants still require the explicit prefix.

The first spoken turn after a wake crosses one WebSocket handshake plus `setupComplete`; local transcription runs while the provider connects, and the completed text waits for setup.

Verification is `log show` on the `blueant.wake-word` category: `listener active` reports the selected model, and a delivered tap buffer resets the stall counter. The fallback route is logged when the selected input renders nothing. No snapshot covers this — the path is CoreAudio and microphone state, which the keyless snapshot harness has no fixture for.

Wake resume waits for microphone ownership to clear. A conversation that remains active keeps the listener suppressed and one delayed check pending; the popup close notification starts a new check after the user dismisses it.
