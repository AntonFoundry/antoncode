# Agent Note: Blueant Live transcript fallback

Status: implemented
Archived: 2026-10-30

English

## Problem

Blueant could finish local speech recognition while Gemini Live stayed silent. The bridge accepted the final local transcript but ignored it after setup completed, so the user saw Listening indefinitely despite a recognized question.

## Decision

The macOS microphone session updates its local speech state on the main queue, where transcription completions run, and commits a turn after silence or ten seconds of sustained detected speech. The bridge waits briefly for Gemini response audio after the final local transcript. If no response audio starts, it sends the text as a completed user turn through the existing Live socket. Audio that was still queued during setup is discarded when text takes over that turn.

## Alternatives considered

**Rely only on Gemini audio VAD.** This left locally recognized questions without replies when the provider did not detect the audio turn.

**Always send both audio and transcript.** This could produce duplicate spoken answers when Gemini already responds to the audio.

## Consequences

The fallback preserves Gemini speech output and its active conversation, while a missed audio detection can add a short delay before the reply. It does not establish that every physical microphone device produces usable audio; that still requires a spoken app test.
