# Agent Note: Blueant local transcription and Gemini text handoff

Status: implemented
Archived: 2026-10-30

English

## Problem

The wake listener recognized speech with the selected Whisper or Parakeet model, but the conversation then opened a second, fixed Whisper context and streamed microphone audio to Gemini. Gemini's server VAD could remain silent after that audio turn, the selected model did not determine the request transcript, and a provider handshake could outlast the speech that followed the wake phrase. The saved wake flag was also off on the affected installation, so no wake phrase could trigger while that setting remained disabled.

## Decision

`WakeWordListener.acceptWake()` stops its input tap and hands its selected transcription engine and the trailing audio window to `BlueantLiveVoiceSession`. The live session captures subsequent microphone audio locally, detects the end of each utterance, and sends each completed transcript as a `clientContent` text turn after Gemini reports `setupComplete`. The first turn may contain only the confirmed wake phrase; an empty local transcript becomes `Hey Blueant` for that first turn. Gemini returns audio, and the Mac app plays it. The bridge disables provider audio VAD because it receives text turns; a new completed text turn interrupts an active Gemini response, while local barge-in stops queued speaker playback when the microphone detects sustained speech. Anton termination stops the conversation capture and synchronously releases the wake input tap before the process exits.

The bridge's system instruction identifies Blueant as a helpful desktop assistant, asks it to greet a wake phrase, and reserves `delegate_task` for questions needing current information, saved context, or tools. A delegated task uses the saved Harness model on both reused and new sessions; the tool response returns to Gemini for spoken delivery. If two Gemini connection attempts fail, Blueant routes already transcribed speech through the Harness popup and speaks that answer locally. The [wake input stream decision](2026-09-25-blueant-wake-input-stream-and-idle-preconnect.md) owns microphone selection, stall recovery, and wake time connection.

## Alternatives considered

**Stream microphone audio to Gemini and keep local transcription as a fallback.** This let server VAD decide turn boundaries despite the selected local model already recognizing speech, and it produced silent turns on the affected path. Text turns make the local transcript the single request sent to Gemini.

**Load a fixed Whisper model after wake.** This ignored a user-selected Parakeet model and loaded a second context during the handoff. Reusing the selected context keeps recognition consistent and avoids that load.

**Send every voice request directly to Harness.** Harness can answer tool-heavy questions, but the normal voice path needs Gemini's audio response and conversational turn handling. Delegation remains a tool call made by Gemini when a question needs it.

## Consequences

Local VAD and transcription determine when Gemini receives a user turn. Gemini's audio VAD settings do not govern that text path, and interruption of provider generation waits for a completed local text turn; local speaker playback stops earlier on a sustained barge-in. The selected model must remain available for the whole wake conversation, and the wake setting must be enabled for ambient listening. Swift typechecking and bridge bundling cover source integration; microphone capture, selected-model decoding, and Gemini's spoken response require a live macOS session and provider connection.
